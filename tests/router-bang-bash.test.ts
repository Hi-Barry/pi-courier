/**
 * `!`/`!!` bash 快捷执行(≈ pi TUI 的 !/!!):
 *  - parseBangCommand 的触发规则(全角/半角感叹号、空格要求、误触防线)
 *  - bashBang 管道阶段:即时回执、结果回帖、不阻塞管道、不落 prompt
 *  - /bashstop:在跑记账的列出 + abortBash 全停 + 销账
 *  - formatBashReply 的统一回帖形态
 */
import { describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config";
import {
  createBashTracker,
  formatBashPreview,
  formatBashReply,
  parseBangCommand,
} from "../src/rpc/command-map";
import type { BashResultView, PiRpc } from "../src/rpc/pi-rpc";
import { BashTimeoutError } from "../src/rpc/pi-rpc";
import { makeMsg, makeRouterFixture } from "./helpers";

describe("parseBangCommand — 触发规则", () => {
  it("半角 ! 加空格触发,结果写入上下文", () => {
    expect(parseBangCommand("! git status")).toEqual({ excluded: false, command: "git status" });
  });

  it("半角 !! 触发 excluded 语义", () => {
    expect(parseBangCommand("!! git status")).toEqual({ excluded: true, command: "git status" });
  });

  it("全角 ！ 与 ！！ 同权处理", () => {
    expect(parseBangCommand("！ ls")).toEqual({ excluded: false, command: "ls" });
    expect(parseBangCommand("！！ ls")).toEqual({ excluded: true, command: "ls" });
  });

  it("全半角混用的两个感叹号也算 excluded", () => {
    expect(parseBangCommand("!！ x")).toEqual({ excluded: true, command: "x" });
  });

  it("无空格(!git)、光杆 !、纯空白、!! 单发都不触发", () => {
    expect(parseBangCommand("!git status")).toBeNull();
    expect(parseBangCommand("!")).toBeNull();
    expect(parseBangCommand("!!")).toBeNull();
    expect(parseBangCommand("!   ")).toBeNull();
  });

  it("三个以上感叹号(聊天感叹句)不触发", () => {
    expect(parseBangCommand("!!! 好厉害")).toBeNull();
  });

  it("感叹句开头不带空格的中文不受影响", () => {
    expect(parseBangCommand("!太棒了")).toBeNull();
  });

  it("全角空格(U+3000)也算空白分隔", () => {
    expect(parseBangCommand("！　ls")).toEqual({ excluded: false, command: "ls" });
  });

  it("命令首尾空白被裁掉", () => {
    expect(parseBangCommand("!   echo hi  ")).toEqual({ excluded: false, command: "echo hi" });
  });
});

describe("formatBashReply — 统一回帖形态", () => {
  const ok: BashResultView = { output: "file1\nfile2", exitCode: 0, cancelled: false, truncated: false };

  it("正常完成:命令行 + 输出 + 退出码", () => {
    const text = formatBashReply("ls", ok);
    expect(text).toContain("$ ls");
    expect(text).toContain("file1\nfile2");
    expect(text).toContain("退出码: 0");
  });

  it("!! 结果附『未写入上下文』标注", () => {
    expect(formatBashReply("ls", ok, true)).toContain("(结果未写入上下文)");
  });

  it("被中止:显示部分输出、无退出码行", () => {
    const text = formatBashReply("htop", { output: "partial", exitCode: undefined, cancelled: true, truncated: false });
    expect(text).toContain("⏹ 已中止: htop");
    expect(text).toContain("partial");
    expect(text).not.toContain("退出码");
  });

  it("默认上限(30000)之内不截断 —— 0.7.2 前的 3000 旧上限已放开", () => {
    const text = formatBashReply("big", { ...ok, output: "x".repeat(4000) });
    expect(text).not.toContain("…(已截断)");
    expect(text).toContain("x".repeat(4000));
  });

  it("超默认上限(30000)截断", () => {
    const text = formatBashReply("big", { ...ok, output: "x".repeat(30001) });
    expect(text).toContain("…(已截断)");
  });

  it("自定义 limit 生效:超过即按传入值截断", () => {
    const text = formatBashReply("big", { ...ok, output: "x".repeat(51) }, false, 50);
    expect(text).toContain("…(已截断)");
    expect(text).toContain("x".repeat(50));
    expect(text).not.toContain("x".repeat(51));
  });

  it("limit 传 undefined 落回默认值", () => {
    const text = formatBashReply("big", { ...ok, output: "x".repeat(4000) }, false, undefined);
    expect(text).not.toContain("…(已截断)");
  });

  it("空输出显示占位符", () => {
    expect(formatBashReply("true", { ...ok, output: "" })).toContain("(无输出)");
  });
});

describe("bashBang 管道阶段", () => {
  function makeFixtures() {
    const replies: string[] = [];
    const prompt = vi.fn().mockResolvedValue(undefined);
    const bash = vi.fn();
    const abortBash = vi.fn();
    const rpc = {
      prompt,
      bash,
      label: undefined,
      onEvent: vi.fn(),
      requireClient: () => ({ abortBash }),
    } as unknown as PiRpc;
    const { router } = makeRouterFixture({
      rpc,
      sendReply: async (_chatId: string, _transport: string, text: string) => {
        replies.push(text);
      },
    });
    return { router, prompt, bash, abortBash, replies };
  }

  /** 微任务 + 一个宏任务:让 .then 回帖链跑完。 */
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("! 触发即时回执并以写入上下文语义调用 bash,不落 prompt", async () => {
    const { router, bash, prompt, replies } = makeFixtures();
    bash.mockResolvedValue({ output: "", exitCode: 0, cancelled: false, truncated: false });
    await router.handleIncoming(makeMsg({ text: "! echo hi", messageId: "m1" }));
    expect(bash).toHaveBeenCalledWith("echo hi", { excludeFromContext: false });
    expect(prompt).not.toHaveBeenCalled();
    expect(replies.join("\n")).toContain("⏳ 正在执行: echo hi");
  });

  it("!! 以 excludeFromContext=true 调用,回执带标注", async () => {
    const { router, bash, replies } = makeFixtures();
    bash.mockResolvedValue({ output: "", exitCode: 0, cancelled: false, truncated: false });
    await router.handleIncoming(makeMsg({ text: "!! echo hi", messageId: "m1" }));
    expect(bash).toHaveBeenCalledWith("echo hi", { excludeFromContext: true });
    expect(replies.join("\n")).toContain("(结果不写入上下文)");
  });

  it("全角 ！ 同样触发", async () => {
    const { router, bash, prompt } = makeFixtures();
    bash.mockResolvedValue({ output: "", exitCode: 0, cancelled: false, truncated: false });
    await router.handleIncoming(makeMsg({ text: "！ echo hi", messageId: "m1" }));
    expect(bash).toHaveBeenCalledTimes(1);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("!git(无空格)不触发,照常落 prompt", async () => {
    const { router, bash, prompt } = makeFixtures();
    await router.handleIncoming(makeMsg({ text: "!git status", messageId: "m1" }));
    expect(bash).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledWith("!git status");
  });

  it("完成后回帖结果与退出码", async () => {
    const { router, bash, replies } = makeFixtures();
    bash.mockResolvedValue({ output: "file1\nfile2", exitCode: 0, cancelled: false, truncated: false });
    await router.handleIncoming(makeMsg({ text: "! ls", messageId: "m1" }));
    await flush();
    const text = replies.join("\n");
    expect(text).toContain("$ ls");
    expect(text).toContain("file1\nfile2");
    expect(text).toContain("退出码: 0");
  });

  it("bash 抛错回帖失败原因,不炸管道", async () => {
    const { router, bash, replies } = makeFixtures();
    bash.mockRejectedValue(new Error("pi RPC not connected"));
    await router.handleIncoming(makeMsg({ text: "! boom", messageId: "m1" }));
    await flush();
    expect(replies.join("\n")).toContain("❌ bash 执行失败: pi RPC not connected");
  });

  it("bash 超时弃权回帖人话(含已等待分钟数与调法),不再走通用报错", async () => {
    const { router, bash, replies } = makeFixtures();
    bash.mockRejectedValue(new BashTimeoutError("make all", 10 * 60_000));
    await router.handleIncoming(makeMsg({ text: "!! make all", messageId: "m1" }));
    await flush();
    const text = replies.join("\n");
    expect(text).toContain("bash 执行超时");
    expect(text).toContain("10 分钟");
    expect(text).toContain("make all");
    expect(text).toContain("bashTimeoutMinutes");
    expect(text).not.toContain("❌");
  });

  it("被中止的结果回帖『已中止』", async () => {
    const { router, bash, replies } = makeFixtures();
    bash.mockResolvedValue({ output: "partial", exitCode: undefined, cancelled: true, truncated: false });
    await router.handleIncoming(makeMsg({ text: "! htop", messageId: "m1" }));
    await flush();
    expect(replies.join("\n")).toContain("⏹ 已中止: htop");
  });

  it("/bashstop 空跑时回复没有在跑的命令", async () => {
    const { router, replies } = makeFixtures();
    await router.handleIncoming(makeMsg({ text: "/bashstop", messageId: "m1" }));
    expect(replies.join("\n")).toContain("没有在跑的 bash 命令");
    expect(replies.join("\n")).not.toContain("abortBash");
  });

  it("/bashstop 列出在跑命令并全停,完成后销账", async () => {
    const { router, bash, abortBash, replies } = makeFixtures();
    let release!: (result: BashResultView) => void;
    bash.mockReturnValue(new Promise<BashResultView>((resolve) => { release = resolve; }));

    await router.handleIncoming(makeMsg({ text: "! sleep 100", messageId: "m1" }));
    await router.handleIncoming(makeMsg({ text: "/bashstop", messageId: "m2" }));
    expect(abortBash).toHaveBeenCalledTimes(1);
    const stopText = replies.join("\n");
    expect(stopText).toContain("已请求中止 1 条在跑命令");
    expect(stopText).toContain("`sleep 100`");

    // 中止后的原请求返回 cancelled:各命令随后收到已中止回帖
    release({ output: "partial", exitCode: undefined, cancelled: true, truncated: false });
    await flush();
    expect(replies.join("\n")).toContain("⏹ 已中止: sleep 100");

    // 销账:再次 /bashstop 回到空跑
    await router.handleIncoming(makeMsg({ text: "/bashstop", messageId: "m3" }));
    expect(replies.slice(-1)[0]).toContain("没有在跑的 bash 命令");
  });

  it("/bash 也纳入同一份记账,/bashstop 同样能停", async () => {
    const { router, bash, abortBash, replies } = makeFixtures();
    bash.mockReturnValue(new Promise<BashResultView>(() => {}));
    // /bash 是阻塞语义(管道等它完成):挂起时 handleIncoming 不返回,测试里不等待
    void router.handleIncoming(makeMsg({ text: "/bash sleep 100", messageId: "m1" }));
    await flush();
    await router.handleIncoming(makeMsg({ text: "/bashstop", messageId: "m2" }));
    expect(abortBash).toHaveBeenCalledTimes(1);
    expect(replies.join("\n")).toContain("`sleep 100`");
  });
});

describe("bashOutputLimit 配置接线(默认 30000,64KB 钳制)", () => {
  /** 微任务 + 一个宏任务:让 .then 回帖链跑完。 */
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  /** 带 bash mock 的小工厂:store 注入自定义 bashOutputLimit。 */
  function makeFixtureWithLimit(limit: number) {
    const replies: string[] = [];
    const bash = vi.fn().mockResolvedValue({ output: "y".repeat(30), exitCode: 0, cancelled: false, truncated: false });
    const rpc = {
      prompt: vi.fn().mockResolvedValue(undefined),
      bash,
      label: undefined,
      onEvent: vi.fn(),
      requireClient: () => ({ abortBash: vi.fn() }),
    } as unknown as PiRpc;
    const { router } = makeRouterFixture({
      rpc,
      store: new ConfigStore({ bashOutputLimit: limit }),
      sendReply: async (_chatId: string, _transport: string, text: string) => {
        replies.push(text);
      },
    });
    return { router, bash, replies };
  }

  it("`!` 回帖按配置值截断(30 字符输出、上限 20 → 留 20 + 截断标记)", async () => {
    const { router, replies } = makeFixtureWithLimit(20);
    await router.handleIncoming(makeMsg({ text: "! gen", messageId: "m1" }));
    await flush();
    const text = replies.join("\n");
    expect(text).toContain("…(已截断)");
    expect(text).toContain("y".repeat(20));
    expect(text).not.toContain("y".repeat(21));
  });

  it("`!!` 与 /bash 共用同一份配置值(/bash 阻塞路径也截断)", async () => {
    const { router, replies } = makeFixtureWithLimit(10);
    await router.handleIncoming(makeMsg({ text: "/bash gen", messageId: "m1" }));
    const text = replies.join("\n");
    expect(text).toContain("…(已截断)");
    expect(text).toContain("y".repeat(10));
    expect(text).not.toContain("y".repeat(11));
  });

  it("不配置时走默认上限(30 字符输出 < 30000 → 不截断)", async () => {
    const replies: string[] = [];
    const bash = vi.fn().mockResolvedValue({ output: "z".repeat(30), exitCode: 0, cancelled: false, truncated: false });
    const rpc = {
      prompt: vi.fn().mockResolvedValue(undefined),
      bash,
      label: undefined,
      onEvent: vi.fn(),
      requireClient: () => ({ abortBash: vi.fn() }),
    } as unknown as PiRpc;
    const { router } = makeRouterFixture({
      rpc,
      sendReply: async (_chatId: string, _transport: string, text: string) => {
        replies.push(text);
      },
    });
    await router.handleIncoming(makeMsg({ text: "! gen", messageId: "m1" }));
    await flush();
    expect(replies.join("\n")).not.toContain("…(已截断)");
  });
});

describe("createBashTracker — 记账语义", () => {
  it("list 返回快照(改快照不影响内部),track 销账幂等", () => {
    const tracker = createBashTracker();
    const rpc = {} as PiRpc;
    const release = tracker.track(rpc, "a");
    tracker.track(rpc, "b");
    expect(tracker.list(rpc).map((e) => e.command)).toEqual(["a", "b"]);

    const snapshot = tracker.list(rpc);
    snapshot.length = 0;
    expect(tracker.list(rpc)).toHaveLength(2);

    release();
    release();
    expect(tracker.list(rpc).map((e) => e.command)).toEqual(["b"]);
  });

  it("按 pi 进程分账:互不可见", () => {
    const tracker = createBashTracker();
    const rpcA = {} as PiRpc;
    const rpcB = {} as PiRpc;
    tracker.track(rpcA, "a-only");
    expect(tracker.list(rpcB)).toHaveLength(0);
    expect(tracker.list(rpcA)).toHaveLength(1);
  });
});

describe("formatBashReply — win32 未加引号路径提示(spec #256)", () => {
  const winFail: BashResultView = {
    output: "dir: cannot access 'd:shareProjects': No such file or directory",
    exitCode: 2,
    cancelled: false,
    truncated: false,
  };
  const winOk: BashResultView = { output: "项目A\n项目B", exitCode: 0, cancelled: false, truncated: false };

  it("win32 + 非零退出码 + 未加引号 X:\\ 路径 → 附提示", () => {
    const text = formatBashReply("dir d:\\share\\Projects", winFail, false, 30000, "win32");
    expect(text).toContain("退出码: 2");
    expect(text).toContain("/d/share/Projects");
    expect(text).toContain("'d:\\share\\Projects'");
  });

  it("win32 但退出码 0 → 不提示", () => {
    expect(formatBashReply("dir d:\\share\\Projects", winOk, false, 30000, "win32")).not.toContain("/d/share/Projects");
  });

  it("非 win32 平台 → 恒不提示", () => {
    expect(formatBashReply("dir d:\\share\\Projects", winFail, false, 30000, "linux")).not.toContain("/d/share/Projects");
    expect(formatBashReply("dir d:\\share\\Projects", winFail, false, 30000, "darwin")).not.toContain("/d/share/Projects");
  });

  it("缺省 platform 参数即当前进程 → 提示行为随运行平台(linux 不提示 / win32 提示)", () => {
    const out = formatBashReply("dir d:\\share\\Projects", winFail);
    if (process.platform === "win32") {
      expect(out).toContain("/d/share/Projects");
    } else {
      expect(out).not.toContain("/d/share/Projects");
    }
  });

  it("win32 失败但路径已写对(引号/正斜杠/双反斜杠)→ 不提示", () => {
    expect(formatBashReply("dir 'd:\\share\\Projects'", winFail, false, 30000, "win32")).not.toContain("💡");
    expect(formatBashReply("dir d:/share/Projects", winFail, false, 30000, "win32")).not.toContain("💡");
    expect(formatBashReply("dir d:\\\\share", winFail, false, 30000, "win32")).not.toContain("💡");
  });

  it("cancelled 回帖形态不变(本就不打退出码)", () => {
    const cancelled: BashResultView = { output: "partial", exitCode: undefined, cancelled: true, truncated: false };
    const text = formatBashReply("dir d:\\share", cancelled, false, 30000, "win32");
    expect(text).toContain("已中止");
    expect(text).not.toContain("/d/share/Projects");
  });

  it("提示不影响 excluded/截断等既有形态", () => {
    const text = formatBashReply("dir d:\\share", winFail, true, 30000, "win32");
    expect(text).toContain("(结果未写入上下文)");
    expect(text).toContain("/d/share/Projects");
  });
});

describe("formatBashPreview — 流式预览形态(spec #193)", () => {
  it("头部 + 代码块输出;空输出用占位", () => {
    const text = formatBashPreview("ls", "", false, 100);
    expect(text).toContain("⏳ 正在执行: ls");
    expect(text).toContain("(无输出)");
  });

  it("!! 附未写入上下文标注(沿用 excludedNote)", () => {
    const text = formatBashPreview("ls", "out", true, 100);
    expect(text).toContain("(结果不写入上下文)");
    expect(text).toContain("out");
  });

  it("超限保尾:截断标记在代码块首行,尾部保留", () => {
    const text = formatBashPreview("build", `${"a".repeat(60)}TAIL`, false, 10);
    expect(text).toContain("…(已截断)");
    expect(text).toContain("TAIL");
    expect(text).not.toContain("a".repeat(60));
  });

  it("恰好超一字符(limit+1)才截断,尾部保留 limit 字符", () => {
    const out = `${"a".repeat(10)}B`; // limit 10,超 1 字符 → 保尾 10 字符
    const text = formatBashPreview("c", out, false, 10);
    expect(text).toContain("已截断");
    expect(text).toContain("a".repeat(9) + "B");
    expect(text).not.toContain(out);
  });

  it("恰好等于 limit 不截断", () => {
    const out = "x".repeat(10);
    expect(formatBashPreview("c", out, false, 10)).toContain(out);
    expect(formatBashPreview("c", out, false, 10)).not.toContain("已截断");
  });
});

describe("bashBang 流式活卡(spec #193)", () => {
  function makeLiveFixtures() {
    const replies: string[] = [];
    const edits: Array<{ messageId: string; text: string }> = [];
    const bash = vi.fn();
    const rpc = {
      prompt: vi.fn().mockResolvedValue(undefined),
      bash,
      label: undefined,
      onEvent: vi.fn(),
      requireClient: () => ({ abortBash: vi.fn() }),
    } as unknown as PiRpc;
    const sendLiveCard = vi.fn(
      async (_chatId: string, _transport: string, text: string): Promise<string | undefined> => text,
    );
    const editReply = vi.fn(async (_chatId: string, _transport: string, messageId: string, text: string) => {
      edits.push({ messageId, text });
    });
    const { router } = makeRouterFixture({
      rpc,
      sendReply: async (_chatId: string, _transport: string, text: string) => {
        replies.push(text);
      },
      extra: { sendLiveCard, editReply },
    });
    return { router, bash, replies, edits, sendLiveCard, editReply };
  }

  /** 微任务 + 一个宏任务:让开卡/编辑/终态链跑完。 */
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  /** 挂一手动释放的 bash 假件,捕获 onUpdate 供增量驱动。 */
  function mockManualBash(bash: ReturnType<typeof vi.fn>) {
    let onUpdate: ((d: string) => void) | undefined;
    let release!: (r: BashResultView) => void;
    bash.mockImplementation((_cmd: string, opts?: { onUpdate?: (d: string) => void }) => {
      onUpdate = opts?.onUpdate;
      return new Promise<BashResultView>((resolve) => {
        release = resolve;
      });
    });
    return {
      push: (d: string) => onUpdate?.(d),
      done: (r: BashResultView) => release(r),
    };
  }

  it("开卡 → 增量预览编辑 → 终态变形为最终回帖,全程不落新消息", async () => {
    const { router, bash, replies, edits, sendLiveCard } = makeLiveFixtures();
    const drive = mockManualBash(bash);
    await router.handleIncoming(makeMsg({ text: "! tail -f log", messageId: "m1" }));
    await flush();
    expect(sendLiveCard).toHaveBeenCalledTimes(1);
    expect(String(sendLiveCard.mock.calls[0]?.[2])).toContain("⏳ 正在执行: tail -f log");
    expect(bash).toHaveBeenCalledWith(
      "tail -f log",
      expect.objectContaining({ excludeFromContext: false, onUpdate: expect.any(Function) })
    );
    expect(replies).toHaveLength(0); // 卡已开,不落 plain 即时回执

    drive.push("chunk1\n");
    await flush();
    expect(edits).toHaveLength(1);
    expect(edits[0]!.text).toContain("⏳ 正在执行: tail -f log");
    expect(edits[0]!.text).toContain("chunk1");

    drive.done({ output: "chunk1\nchunk2", exitCode: 0, cancelled: false, truncated: false });
    await flush();
    expect(edits).toHaveLength(2);
    expect(edits[1]!.text).toContain("$ tail -f log");
    expect(edits[1]!.text).toContain("退出码: 0");
    expect(edits[1]!.text).toContain("chunk2");
    expect(replies).toHaveLength(0); // 终态走编辑,不落新消息
  });

  it("节流窗口内的后续增量跳过编辑,终态立即变形", async () => {
    const { router, bash, edits } = makeLiveFixtures();
    const drive = mockManualBash(bash);
    await router.handleIncoming(makeMsg({ text: "! gen", messageId: "m1" }));
    await flush();
    drive.push("a\n");
    drive.push("b\n"); // 同一节流窗口(默认 3s)内 → 跳过
    await flush();
    expect(edits).toHaveLength(1);
    drive.done({ output: "a\nb\ndone", exitCode: 0, cancelled: false, truncated: false });
    await flush();
    expect(edits).toHaveLength(2); // 终态不节流
    expect(edits[1]!.text).toContain("done");
  });

  it("editReply 失败 → 终态降级新消息回帖,结果永不丢", async () => {
    const { router, bash, replies, editReply } = makeLiveFixtures();
    editReply.mockRejectedValue(new Error("rate limited"));
    bash.mockResolvedValue({ output: "out", exitCode: 0, cancelled: false, truncated: false });
    await router.handleIncoming(makeMsg({ text: "! ok", messageId: "m1" }));
    await flush();
    expect(replies.join("\n")).toContain("$ ok");
    expect(replies.join("\n")).toContain("退出码: 0");
  });

  it("开卡失败(resolve undefined)→ 退回旧两条消息路径", async () => {
    const { router, bash, replies, sendLiveCard } = makeLiveFixtures();
    sendLiveCard.mockResolvedValue(undefined);
    bash.mockResolvedValue({ output: "", exitCode: 0, cancelled: false, truncated: false });
    await router.handleIncoming(makeMsg({ text: "! ls", messageId: "m1" }));
    await flush();
    expect(replies.join("\n")).toContain("⏳ 正在执行: ls");
    expect(replies.join("\n")).toContain("退出码: 0");
  });

  it("终态先到、卡迟到 → 卡落地后直接变形为终态,不落新消息", async () => {
    const { router, bash, replies, edits, sendLiveCard } = makeLiveFixtures();
    let resolveCard!: (id: string) => void;
    sendLiveCard.mockImplementation(() => new Promise<string>((resolve) => { resolveCard = resolve; }));
    bash.mockResolvedValue({ output: "fast", exitCode: 0, cancelled: false, truncated: false });
    await router.handleIncoming(makeMsg({ text: "! fast", messageId: "m1" }));
    await flush();
    expect(replies).toHaveLength(0); // 卡在路上,终态等待卡落地
    resolveCard("$card-1");
    await flush();
    expect(edits).toHaveLength(1);
    expect(edits[0]!.text).toContain("退出码: 0");
    expect(replies).toHaveLength(0);
  });

  it("开卡失败(reject)与终态竞速 → 终态降级新消息,结果不丢(评审 P1 回归钉)", async () => {
    const { router, bash, replies, sendLiveCard, editReply } = makeLiveFixtures();
    let rejectCard!: (err: Error) => void;
    sendLiveCard.mockImplementation(
      () => new Promise<string>((_resolve, reject) => { rejectCard = reject; }),
    );
    bash.mockResolvedValue({ output: "fast", exitCode: 0, cancelled: false, truncated: false });
    await router.handleIncoming(makeMsg({ text: "! fast", messageId: "m1" }));
    await flush();
    expect(replies).toHaveLength(0); // 卡仍在路上,终态暂存
    rejectCard(new Error("rate limited"));
    await flush();
    expect(replies.join("\n")).toContain("退出码: 0"); // 结果永不丢
    expect(editReply).not.toHaveBeenCalled(); // 无卡可编辑
  });

  it("!! 流式预览同样带 excludedNote 标注", async () => {
    const { router, bash, edits } = makeLiveFixtures();
    const drive = mockManualBash(bash);
    await router.handleIncoming(makeMsg({ text: "!! tail -f log", messageId: "m1" }));
    await flush();
    drive.push("line\n");
    await flush();
    expect(edits[0]!.text).toContain("(结果不写入上下文)");
    drive.done({ output: "line", exitCode: 0, cancelled: false, truncated: false });
    await flush();
  });
});
