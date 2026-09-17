/**
 * `!`/`!!` bash 快捷执行(≈ pi TUI 的 !/!!):
 *  - parseBangCommand 的触发规则(全角/半角感叹号、空格要求、误触防线)
 *  - bashBang 管道阶段:即时回执、结果回帖、不阻塞管道、不落 prompt
 *  - /bashstop:在跑记账的列出 + abortBash 全停 + 销账
 *  - formatBashReply 的统一回帖形态
 */
import { describe, expect, it, vi } from "vitest";
import { ChallengeAuth } from "../src/auth/challenge-auth";
import { ConfigStore } from "../src/config";
import {
  createBashTracker,
  formatBashReply,
  parseBangCommand,
} from "../src/rpc/command-map";
import { createMessageRouter } from "../src/rpc/message-router";
import { PmctlController } from "../src/rpc/pmctl-controller";
import type { BashResultView, PiRpc } from "../src/rpc/pi-rpc";
import type { ProjectManager } from "../src/rpc/project-manager";
import type { RoomOps } from "../src/transports/interface";
import type { ExternalMessage } from "../src/types";

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

  it("超 3000 字符截断", () => {
    const text = formatBashReply("big", { ...ok, output: "x".repeat(4000) });
    expect(text).toContain("…(已截断)");
  });

  it("空输出显示占位符", () => {
    expect(formatBashReply("true", { ...ok, output: "" })).toContain("(无输出)");
  });
});

describe("bashBang 管道阶段", () => {
  function makeMsg(overrides: Partial<ExternalMessage> & { text?: string } = {}): ExternalMessage {
    const { text = "hi", ...rest } = overrides;
    return {
      chatId: "!dm:server",
      transport: "matrix",
      userId: "@barry:server",
      username: "barry",
      payload: { kind: "text", text },
      isGroupChat: false,
      wasMentioned: false,
      messageId: "m1",
      timestamp: new Date(),
      ...rest,
    };
  }

  function makeFixtures() {
    const replies: string[] = [];
    const sendReply = async (_chatId: string, _transport: string, text: string) => {
      replies.push(text);
    };
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
    const projectManager = {
      getRpcForRoom: vi.fn().mockReturnValue(rpc),
      isProjectRoom: vi.fn().mockReturnValue(false),
      labelForRoom: vi.fn().mockReturnValue(undefined),
      isMultiProject: false,
      allRpcs: vi.fn().mockReturnValue([rpc]),
    } as unknown as ProjectManager;
    const store = new ConfigStore({});
    const auth = new ChallengeAuth(() => {}, () => {});
    auth.loadFromConfig({ trustedUsers: ["matrix:@barry:server"], adminUserId: "matrix:@barry:server", channels: {} });
    const roomOps = { getBotUserId: vi.fn().mockReturnValue("@bot:server") } as unknown as RoomOps;
    const pmctl = new PmctlController({ projectManager, roomOps, store });
    const router = createMessageRouter({ projectManager, auth, sendReply, sendTyping: vi.fn(), roomOps, store, pmctl });
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
