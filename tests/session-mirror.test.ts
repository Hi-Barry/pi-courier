/**
 * SessionMirror 单测:TUI ↔ Matrix 会话镜像的机制面。
 * 覆盖:header 解析、user 文本提取、tail 增量(半行缓冲)、自身写入去重、
 * cwd 过滤、分叉检测、新文件跟踪、ensureFreshContext 接力状态机。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type MirrorCallbacks,
  type MirroredEntry,
  MirrorManager,
  SessionMirror,
  extractUserText,
  parseSessionHeaderLine,
  type RelayRpc,
} from "../src/rpc/session-mirror.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mirror-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const HEADER_CWD = (): string => fs.realpathSync(dir);

/** 建一个带 header 的会话文件,可选写入历史条目。返回绝对路径。 */
function seedSessionFile(name: string, entries: string[] = []): string {
  const full = path.join(dir, name);
  const lines = [JSON.stringify({ type: "session", version: 3, id: "sess-1", cwd: HEADER_CWD() }), ...entries];
  fs.writeFileSync(full, lines.map((l) => `${l}\n`).join(""));
  return full;
}

/** 构造一条 message entry 行。 */
function messageLine(id: string, parentId: string | null, role: "user" | "assistant" | "toolResult", text: string): string {
  return JSON.stringify({ type: "message", id, parentId, timestamp: new Date().toISOString(), message: { role, content: text } });
}

function modelChangeLine(id: string, parentId: string | null): string {
  return JSON.stringify({ type: "model_change", id, parentId, timestamp: new Date().toISOString(), provider: "p", modelId: "m" });
}

/** 收集回调的 mirror + spy 工厂。 */
function makeMirror(opts?: { cwd?: string; initialLeafId?: string | null }): {
  mirror: SessionMirror;
  external: MirroredEntry[];
  forks: MirroredEntry[];
} {
  const external: MirroredEntry[] = [];
  const forks: MirroredEntry[] = [];
  const callbacks: MirrorCallbacks = {
    onExternalMessage: (entry) => external.push(entry),
    onFork: (entry) => forks.push(entry),
  };
  const mirror = new SessionMirror({ sessionDir: dir, cwd: opts?.cwd ?? HEADER_CWD(), callbacks, initialLeafId: opts?.initialLeafId });
  return { mirror, external, forks };
}

const flush = async (ms = 120): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
};

describe("parseSessionHeaderLine", () => {
  it("解析合法 header", () => {
    const header = parseSessionHeaderLine('{"type":"session","version":3,"id":"x","cwd":"/a/b"}');
    expect(header?.cwd).toBe("/a/b");
    expect(header?.id).toBe("x");
  });

  it("非 session 类型与坏 JSON 返回 undefined", () => {
    expect(parseSessionHeaderLine('{"type":"message","id":"e1"}')).toBeUndefined();
    expect(parseSessionHeaderLine("not json")).toBeUndefined();
  });
});

describe("extractUserText", () => {
  it("string content 直取", () => {
    expect(extractUserText({ content: "  hello  " })).toBe("hello");
  });

  it("数组 content 提取 text,图片占位", () => {
    expect(
      extractUserText({ content: [{ type: "text", text: "看这个" }, { type: "image", data: "..." }] })
    ).toBe("看这个\n[图片]");
  });

  it("空内容返回 null", () => {
    expect(extractUserText({ content: "" })).toBeNull();
    expect(extractUserText({ content: [{ type: "image", data: "x" }] })).toBe("[图片]");
    expect(extractUserText(undefined)).toBeNull();
  });
});

describe("SessionMirror tail", () => {
  it("外部写入的 user/assistant message 触发回调;既有文件只看增量", async () => {
    seedSessionFile("old.jsonl", [messageLine("e0", null, "user", "历史消息")]);
    const { mirror, external } = makeMirror({ initialLeafId: "e0" });
    mirror.start();
    try {
      const file = path.join(dir, "old.jsonl");
      fs.appendFileSync(file, messageLine("e1", "e0", "user", "TUI 里发的消息") + "\n");
      fs.appendFileSync(file, messageLine("e2", "e1", "assistant", "TUI agent 的回复") + "\n");
      await vi.waitFor(() => expect(external.length).toBe(2));
      expect(external[0]?.role).toBe("user");
      expect(extractUserText(external[0]?.message)).toBe("TUI 里发的消息");
      expect(external[1]?.role).toBe("assistant");
      expect(mirror.isDirty()).toBe(true);
    } finally {
      mirror.stop();
    }
  });

  it("自身写入(noteSelfEntry)不触发回调", async () => {
    seedSessionFile("s.jsonl");
    const { mirror, external } = makeMirror({ initialLeafId: "e0" });
    mirror.noteSelfEntry("self-1");
    mirror.start();
    try {
      fs.appendFileSync(path.join(dir, "s.jsonl"), messageLine("self-1", "e0", "user", "Matrix 自己的消息") + "\n");
      await flush(150);
      expect(external.length).toBe(0);
      expect(mirror.isDirty()).toBe(false);
    } finally {
      mirror.stop();
    }
  });

  it("非对话 entry 不转发但推进 leaf;toolResult 不转发", async () => {
    seedSessionFile("s.jsonl");
    const { mirror, external } = makeMirror({ initialLeafId: "e0" });
    mirror.start();
    try {
      const file = path.join(dir, "s.jsonl");
      fs.appendFileSync(file, modelChangeLine("m1", "e0") + "\n");
      fs.appendFileSync(file, messageLine("t1", "m1", "toolResult", "工具结果") + "\n");
      await flush(150);
      expect(external.length).toBe(0);
      // leaf 已推进到 t1:接下来正常接力的 user 消息不该被判分叉。
      fs.appendFileSync(file, messageLine("u1", "t1", "user", "继续") + "\n");
      await vi.waitFor(() => expect(external.length).toBe(1));
      expect(extractUserText(external[0]?.message)).toBe("继续");
    } finally {
      mirror.stop();
    }
  });

  it("半行缓冲:分两次追加同一行只回调一次", async () => {
    seedSessionFile("s.jsonl");
    const { mirror, external } = makeMirror({ initialLeafId: "e0" });
    mirror.start();
    try {
      const file = path.join(dir, "s.jsonl");
      const line = messageLine("h1", "e0", "user", "半行消息");
      const mid = Math.floor(line.length / 2);
      fs.appendFileSync(file, line.slice(0, mid));
      await flush(80);
      fs.appendFileSync(file, line.slice(mid) + "\n");
      await vi.waitFor(() => expect(external.length).toBe(1));
      expect(extractUserText(external[0]?.message)).toBe("半行消息");
    } finally {
      mirror.stop();
    }
  });

  it("分叉检测:parentId 断裂触发 onFork(一次)并停用 dirty", async () => {
    seedSessionFile("s.jsonl");
    const { mirror, external, forks } = makeMirror({ initialLeafId: "e0" });
    mirror.start();
    try {
      const file = path.join(dir, "s.jsonl");
      // TUI 从更早的节点分叉(如树切换):parentId != 已见 leaf e0。
      fs.appendFileSync(file, messageLine("f1", "old-branch", "user", "分叉消息") + "\n");
      await vi.waitFor(() => expect(forks.length).toBe(1));
      fs.appendFileSync(file, messageLine("f2", "f1", "assistant", "分叉回复") + "\n");
      await vi.waitFor(() => expect(external.length).toBe(2));
      expect(mirror.isForked()).toBe(true);
      expect(mirror.isDirty()).toBe(false); // 分叉后不再置 dirty(接力停用)。
    } finally {
      mirror.stop();
    }
  });

  it("新文件(TUI /new 产物)从头跟踪并按 cwd 过滤", async () => {
    seedSessionFile("old.jsonl");
    const { mirror, external } = makeMirror({ initialLeafId: null });
    mirror.start();
    try {
      // cwd 不匹配的新文件:不跟踪。
      const otherDir = path.join(dir, "other-cwd");
      fs.mkdirSync(otherDir, { recursive: true });
      const otherFile = path.join(otherDir, "nope.jsonl");
      fs.writeFileSync(otherFile, JSON.stringify({ type: "session", id: "s2", cwd: "/somewhere/else" }) + "\n");
      fs.appendFileSync(otherFile, messageLine("x1", null, "user", "别的项目") + "\n");
      // cwd 匹配的新文件:从头读(header 跳过)。
      const newFile = path.join(dir, "new-session.jsonl");
      fs.writeFileSync(newFile, JSON.stringify({ type: "session", version: 3, id: "s3", cwd: HEADER_CWD() }) + "\n");
      fs.appendFileSync(newFile, messageLine("n1", null, "user", "新会话首条") + "\n");
      await vi.waitFor(() => expect(external.length).toBe(1));
      expect(extractUserText(external[0]?.message)).toBe("新会话首条");
      await flush(100);
      expect(external.length).toBe(1); // 别的项目的消息永不进来。
    } finally {
      mirror.stop();
    }
  });

  it("stop 之后不再回调", async () => {
    seedSessionFile("s.jsonl");
    const { mirror, external } = makeMirror({ initialLeafId: "e0" });
    mirror.start();
    mirror.stop();
    fs.appendFileSync(path.join(dir, "s.jsonl"), messageLine("z1", "e0", "user", "stop 后写入") + "\n");
    await flush(150);
    expect(external.length).toBe(0);
  });
});

describe("MirrorManager.ensureFreshContext", () => {
  /** 可编程 mock:记录 switchSession 调用,getState 按脚本应答。 */
  function mockRpc(state: { isStreaming?: boolean; pendingMessageCount?: number; sessionFile?: string; sessionId?: string }, switchError?: Error) {
    const switches: string[] = [];
    const rpc = {
      cwd: HEADER_CWD(),
      requireClient: () => ({
        getState: async () => state,
        switchSession: async (p: string) => {
          if (switchError) throw switchError;
          switches.push(p);
          return { cancelled: false };
        },
      }),
    } as unknown as RelayRpc & { cwd: string };
    return { rpc, switches };
  }

  /** 经真实 MirrorManager + SessionMirror 造 dirty(跑一遍 tail)。 */
  async function makeDirty(rpc: ReturnType<typeof mockRpc>["rpc"]): Promise<MirrorManager> {
    const manager = new MirrorManager();
    const mirror = manager.attach(rpc, dir, { onExternalMessage: () => {}, onFork: () => {} }, "e0");
    // 模拟 TUI /new 的真实产物:header + 首条 entry 一次写入(新树根 parentId=null)。
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "s-relay", cwd: HEADER_CWD() }),
      messageLine("d1", null, "user", "TUI 干的活"),
    ];
    fs.writeFileSync(path.join(dir, "relay.jsonl"), lines.map((l) => `${l}\n`).join(""));
    await vi.waitFor(() => expect(mirror.isDirty()).toBe(true));
    return manager;
  }

  it("无镜像 / 未 dirty → clean,不调 switchSession", async () => {
    const { rpc, switches } = mockRpc({ sessionFile: "/x.jsonl" });
    const manager = new MirrorManager();
    expect(await manager.ensureFreshContext(rpc)).toEqual({ kind: "clean" });
    const mirror = manager.attach(rpc, dir, { onExternalMessage: () => {}, onFork: () => {} }, null);
    expect(await manager.ensureFreshContext(rpc)).toEqual({ kind: "clean" });
    expect(switches).toEqual([]);
    mirror.stop();
  });

  it("dirty + 空闲 → relayed(switchSession 带同一文件),dirty 清除", async () => {
    const { rpc, switches } = mockRpc({ isStreaming: false, pendingMessageCount: 0, sessionFile: "/x/sess.jsonl" });
    const manager = await makeDirty(rpc);
    expect(await manager.ensureFreshContext(rpc)).toEqual({ kind: "relayed" });
    expect(switches).toEqual(["/x/sess.jsonl"]);
    expect(await manager.ensureFreshContext(rpc)).toEqual({ kind: "clean" });
  });

  it("dirty + 流式中 → busy 跳过且 dirty 保留", async () => {
    const { rpc, switches } = mockRpc({ isStreaming: true, sessionFile: "/x.jsonl" });
    const manager = await makeDirty(rpc);
    expect(await manager.ensureFreshContext(rpc)).toEqual({ kind: "busy" });
    expect(switches).toEqual([]);
    expect(mirrorStillDirty(manager, rpc)).toBe(true);
  });

  it("dirty + 队列非空 → busy", async () => {
    const { rpc, switches } = mockRpc({ pendingMessageCount: 2, sessionFile: "/x.jsonl" });
    const manager = await makeDirty(rpc);
    expect(await manager.ensureFreshContext(rpc)).toEqual({ kind: "busy" });
    expect(switches).toEqual([]);
  });

  it("分叉 → forked,永不接力", async () => {
    const { rpc } = mockRpc({ sessionFile: "/x.jsonl" });
    const manager = new MirrorManager();
    // attach 时文件已存在且已跟踪(基线 leaf e0),之后 TUI 从旧节点接枝 → 断裂。
    seedSessionFile("forked.jsonl", [messageLine("e0", null, "user", "基线")]);
    manager.attach(rpc, dir, { onExternalMessage: () => {}, onFork: () => {} }, "e0");
    fs.appendFileSync(path.join(dir, "forked.jsonl"), messageLine("fk1", "old-branch", "user", "分叉") + "\n");
    await vi.waitFor(() => expect(manager.has(rpc) && managerEnsureForked(manager, rpc)).toBe(true));
    expect(await manager.ensureFreshContext(rpc)).toEqual({ kind: "forked" });
  });

  it("switchSession 抛错 → failed 带消息,dirty 保留", async () => {
    const { rpc, switches } = mockRpc({ sessionFile: "/x.jsonl" }, new Error("boom"));
    const manager = await makeDirty(rpc);
    const result = await manager.ensureFreshContext(rpc);
    expect(result).toEqual({ kind: "failed", message: "boom" });
    expect(switches).toEqual([]);
  });

  it("detach 后不再接力", async () => {
    const { rpc } = mockRpc({ sessionFile: "/x.jsonl" });
    const manager = await makeDirty(rpc);
    expect(manager.detach(rpc)).toBe(true);
    expect(await manager.ensureFreshContext(rpc)).toEqual({ kind: "clean" });
  });
});

/** 从 manager 里摸出 mirror 的 dirty 状态(测试辅助,不进生产面)。 */
function mirrorStillDirty(manager: MirrorManager, rpc: object): boolean {
  return (manager as unknown as { mirrors: WeakMap<object, { isDirty(): boolean }> }).mirrors.get(rpc)?.isDirty() ?? false;
}

function managerEnsureForked(manager: MirrorManager, rpc: object): boolean {
  return (manager as unknown as { mirrors: WeakMap<object, { isForked(): boolean }> }).mirrors.get(rpc)?.isForked() ?? false;
}
