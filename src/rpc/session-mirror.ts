/**
 * SessionMirror — TUI ↔ Matrix 双端会话镜像(issue: TUI 双端协同)。
 *
 * 背景:pi 会话是一个纯追加的 JSONL 文件(每条 entry appendFileSync 即时落盘),
 * TUI 与 RPC 进程各自打开同一文件后互不感知(上游无文件锁、无 watch、只在启动
 * 时读一次)。镜像器补上跨进程的缺口:
 *
 *  1. 显示(给眼睛):对 sessionDir 递归 watch + 按文件 offset 增量 tail。tail
 *     读到的 entry 若 id 不在本端已知集合(= RPC 自己写入的,经 entry_appended
 *     事件喂进来)即为 TUI 侧写入 → 渲染成文本回调给 router 转发 Matrix 房间。
 *  2. 上下文接力(给脑子):外部写入置 dirty;Matrix 下次 prompt 前由 router
 *     调 ensureFreshContext() —— 空闲则 switchSession(同一文件)让 RPC 进程重读
 *     文件,agent 的对话历史追上 TUI 写入的内容。
 *  3. 分叉检测:tail entry 的 parentId ≠ 已见 leaf(双端同时写 / TUI 切分支)
 *     → 一次性回调警告,并停用自动接力(分叉后接谁都不对,留给用户处理)。
 *
 * 边界(有意不做):不转发 TUI 流式 delta(落盘即完整消息)、不转发工具调用、
 * 不反向实时驱动 TUI(TUI 重进即见,接力语义已覆盖)。
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** pi 会话文件首行 header:{"type":"session","version":3,"id":...,"cwd":...} */
export interface SessionHeader {
  cwd?: string;
  id?: string;
}

/** tail 解析出的最小 entry 视图(只需要路由判断字段,不依赖上游类型)。 */
export interface MirroredEntry {
  type: string;
  id: string;
  parentId: string | null;
  /** 仅 onExternalMessage 回调里有效:handleLine 从 message.role 提取后回填
   *  (会话文件里 role 不在 entry 顶层),恒为 "user" | "assistant"。 */
  role?: string;
  /** type === "message" 时有效:上游 AgentMessage(role/content 在其中)。 */
  message?: unknown;
}

/** mirror 对外回调:外部(TUI)写入的对话消息,router 负责渲染与发送。 */
export interface MirrorCallbacks {
  onExternalMessage: (entry: MirroredEntry) => void;
  /** 分叉检测命中(一次性):之后自动接力停用。 */
  onFork: (entry: MirroredEntry) => void;
  /** TUI 侧另开了新会话(外部 message 落在一个非 attach 时会话文件里,每文件
   *  提醒一次):接力不会跨会话文件,router 提示用户如何跟上。 */
  onForeignSession: (file: string) => void;
}

interface TrackedFile {
  path: string;
  /** 下一次读取的绝对字节偏移;尾部不足一整行的字节留在这里重试。 */
  offset: number;
  /** 尾部半行缓冲(等下一次 change 拼全)。 */
  pending: string;
  /** 非 attach 时会话文件(TUI 另开/切换的会话):首条外部对话提醒一次。 */
  foreignNew: boolean;
  foreignNotified: boolean;
}

/** 解析会话文件首行 header;不是合法 JSON 或非 session 类型返回 undefined。 */
export function parseSessionHeaderLine(line: string): SessionHeader | undefined {
  try {
    const parsed = JSON.parse(line) as { type?: string; cwd?: string; id?: string };
    if (parsed.type !== "session") return undefined;
    return { cwd: parsed.cwd, id: parsed.id };
  } catch {
    return undefined;
  }
}

/**
 * 从 user message 提取要转发到房间的文本。content 是 string 或
 * (TextContent | ImageContent)[];图片占位显示,空内容返回 null(不转发)。
 */
export function extractUserText(message: unknown): string | null {
  const m = message as { content?: unknown } | undefined;
  const content = m?.content;
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content as Array<{ type?: string; text?: string }>) {
    if (part?.type === "text" && part.text) parts.push(part.text);
    else if (part?.type === "image") parts.push("[图片]");
  }
  return parts.join("\n").trim() || null;
}

/**
 * 一个房间 ↔ 一个 pi 进程的镜像器。职责:watch + tail + 去重 + 分叉检测 +
 * dirty 标记;接力动作本身(ensureFreshContext)由 manager 统一编排。
 */
export class SessionMirror {
  private readonly callbacks: MirrorCallbacks;
  private readonly sessionDir: string;
  /** 只跟踪 header.cwd 匹配此值的文件(undefined = 不过滤,测试用)。 */
  private readonly cwd: string | undefined;
  private readonly knownIds = new Set<string>();
  private readonly files = new Map<string, TrackedFile>();
  private watcher: fs.FSWatcher | undefined;
  private lastSeenLeafId: string | null = null;
  private forkDetected = false;
  private stopped = false;
  /** 外部写入标记(ensureFreshContext 的触发依据)。 */
  private dirty = false;
  /** attach 时刻 RPC 进程的会话文件:之外的都是 TUI 侧另开的会话。 */
  private readonly initialSessionFile: string | undefined;

  constructor(opts: {
    sessionDir: string;
    cwd?: string;
    callbacks: MirrorCallbacks;
    initialLeafId?: string | null;
    initialSessionFile?: string;
  }) {
    this.sessionDir = opts.sessionDir;
    this.cwd = opts.cwd;
    this.callbacks = opts.callbacks;
    this.lastSeenLeafId = opts.initialLeafId ?? null;
    this.initialSessionFile = opts.initialSessionFile;
  }

  /** RPC 自身写入记账(entry_appended 事件的 entry id,tail 去重依据)。 */
  noteSelfEntry(entryId: string): void {
    this.knownIds.add(entryId);
    // 自身写入也推进 leaf 视角(与 tail 读到等价)。
    this.lastSeenLeafId = entryId;
  }

  isDirty(): boolean {
    return this.dirty && !this.forkDetected;
  }

  isForked(): boolean {
    return this.forkDetected;
  }

  /** 清 dirty(接力成功后由 manager 调)。 */
  clearDirty(): void {
    this.dirty = false;
  }

  /** 启动目录监听并扫描既有 *.jsonl(只看增量:offset = 当前文件大小)。 */
  start(): void {
    this.stopped = false;
    this.scanExistingFiles();
    try {
      this.watcher = fs.watch(this.sessionDir, { recursive: true }, (_event, filename) => {
        this.onWatchEvent(filename);
      });
      this.watcher.on("error", () => {
        // 目录消失等错误:静默停摆 —— mirror 是附加能力,不打扰主链路。
        this.stop();
      });
    } catch {
      // watch 建不起来(目录不存在等):mirror 不可用,保持静默。
    }
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = undefined;
    this.files.clear();
  }

  /** 扫描既有文件:header.cwd 匹配的全部纳入跟踪,offset 从当前末尾起。 */
  private scanExistingFiles(): void {
    let relative: string[];
    try {
      relative = fs.readdirSync(this.sessionDir, { recursive: true }) as unknown as string[];
    } catch {
      return;
    }
    for (const rel of relative) {
      if (typeof rel !== "string" || !rel.endsWith(".jsonl")) continue;
      const full = path.join(this.sessionDir, rel);
      const header = readSessionHeader(full);
      if (!header || !this.cwdMatches(header)) continue;
      try {
        this.files.set(full, this.newTrackedFile(full, fs.statSync(full).size));
      } catch {
        // 读 size 失败(竞态删除):跳过,后续 watch 事件会再试。
      }
    }
  }

  /** 构建跟踪记录:attach 时会话文件之外的都是 TUI 侧的「另开会话」。 */
  private newTrackedFile(fullPath: string, offset: number): TrackedFile {
    return {
      path: fullPath,
      offset,
      pending: "",
      foreignNew: this.initialSessionFile !== undefined && fullPath !== this.initialSessionFile,
      foreignNotified: false,
    };
  }

  private cwdMatches(header: SessionHeader): boolean {
    if (!this.cwd) return true;
    if (!header.cwd) return false;
    try {
      return fs.realpathSync(header.cwd) === fs.realpathSync(this.cwd);
    } catch {
      return path.resolve(header.cwd) === path.resolve(this.cwd);
    }
  }

  private onWatchEvent(filename: string | Buffer | null): void {
    if (this.stopped || !filename) return;
    const rel = filename.toString();
    if (!rel.endsWith(".jsonl")) return;
    const full = path.join(this.sessionDir, rel);
    if (this.files.has(full)) {
      this.tailFile(full);
      return;
    }
    // 未跟踪的新文件(TUI /new /resume 产物):读 header,cwd 匹配则从头跟踪。
    const header = readSessionHeader(full);
    if (!header || !this.cwdMatches(header)) return;
    this.files.set(full, this.newTrackedFile(full, 0));
    this.tailFile(full);
  }

  /** 增量读 [offset, size),整行解析;半行留在 pending。 */
  private tailFile(filePath: string): void {
    const file = this.files.get(filePath);
    if (!file) return;
    let size: number;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return;
    }
    if (size <= file.offset) return;
    let text: string;
    try {
      const fd = fs.openSync(filePath, "r");
      try {
        const length = size - file.offset;
        const buffer = Buffer.alloc(length);
        const read = fs.readSync(fd, buffer, 0, length, file.offset);
        text = buffer.toString("utf-8", 0, read);
        file.offset += read;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
    let accumulated = file.pending + text;
    const lines = accumulated.split("\n");
    // 最后一段可能是半行:留回 pending 等下一次拼全。
    file.pending = lines.pop() ?? "";
    for (const line of lines) {
      this.handleLine(line, file);
    }
  }

  private handleLine(line: string, file: TrackedFile): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let entry: MirroredEntry;
    try {
      const parsed = JSON.parse(trimmed) as MirroredEntry;
      if (typeof parsed?.id !== "string" || typeof parsed?.type !== "string") return;
      entry = parsed;
    } catch {
      return; // 坏行跳过(与上游加载器同一容忍语义)。
    }
    // 分叉检测:entry 的父不是我们已见的最后一条 = 有别端从旧节点接枝
    // (双端同时写 / TUI 切树分支)。一次性警告,之后自动接力停用。
    // header 行(type "session")没有 parentId,必须跳过 —— undefined ≠ null
    // 会在新文件首条上误报。
    if (
      !this.forkDetected &&
      this.lastSeenLeafId !== null &&
      typeof entry.parentId === "string" &&
      entry.parentId !== this.lastSeenLeafId
    ) {
      this.forkDetected = true;
      this.callbacks.onFork(entry);
    }
    this.lastSeenLeafId = entry.id;
    if (this.knownIds.has(entry.id)) return; // 自身写入,不转发。
    if (entry.type !== "message") return;
    // role 在 message 里(会话文件结构:message:{role,content}),不在顶层。
    const role = (entry.message as { role?: string } | undefined)?.role;
    if (role !== "user" && role !== "assistant") return;
    this.dirty = true;
    // TUI 另开的会话首条对话:提醒一次(接力不跨会话文件,用户需要指引)。
    if (file.foreignNew && !file.foreignNotified) {
      file.foreignNotified = true;
      this.callbacks.onForeignSession(path.basename(file.path));
    }
    this.callbacks.onExternalMessage({ ...entry, role });
  }
}

/** 读会话文件首行 header;文件不存在/为空/首行非 header 返回 undefined。 */
export function readSessionHeader(filePath: string): SessionHeader | undefined {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(4096);
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const firstLine = buffer.toString("utf-8", 0, read).split("\n")[0] ?? "";
      return parseSessionHeaderLine(firstLine);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** ensureFreshContext 的最小 RPC 面(结构类型,PiRpc 天然满足;mock 直测)。 */
export interface RelayRpc {
  requireClient(): {
    getState(): Promise<{ isStreaming?: boolean; pendingMessageCount?: number; sessionFile?: string; sessionId?: string }>;
    switchSession(sessionPath: string): Promise<{ cancelled?: boolean }>;
  };
}

/** ensureFreshContext 的结果(房间提示与测试断言用)。 */
export type RelayOutcome =
  | { kind: "relayed" }
  | { kind: "clean" } // 没有 dirty,无需接力
  | { kind: "busy" } // 流式中/队列非空,跳过(dirty 保留)
  | { kind: "forked" } // 分叉停用
  | { kind: "failed"; message: string };

/**
 * MirrorManager — router 持有的镜像簿记:按 pi 进程挂 SessionMirror,
 * 提供 /attach /detach 的机制面与 prompt 前的自动接力。
 */
export class MirrorManager {
  private readonly mirrors = new WeakMap<object, SessionMirror>();

  attach(
    rpc: RelayRpc & { cwd?: string },
    sessionDir: string,
    callbacks: MirrorCallbacks,
    initialLeafId: string | null,
    initialSessionFile?: string
  ): SessionMirror {
    this.detach(rpc);
    const mirror = new SessionMirror({
      sessionDir,
      cwd: rpc.cwd,
      callbacks,
      initialLeafId,
      initialSessionFile,
    });
    mirror.start();
    this.mirrors.set(rpc, mirror);
    return mirror;
  }

  detach(rpc: object): boolean {
    const mirror = this.mirrors.get(rpc);
    if (!mirror) return false;
    mirror.stop();
    this.mirrors.delete(rpc);
    return true;
  }

  has(rpc: object): boolean {
    return this.mirrors.has(rpc);
  }

  /** entry_appended 记账(router 的事件路径喂)。 */
  noteSelfEntry(rpc: object, entryId: string): void {
    this.mirrors.get(rpc)?.noteSelfEntry(entryId);
  }

  /**
   * prompt 前自动接力:有未接力外部写入且进程空闲(不在流式、队列空)时,
   * switchSession(同一文件)让 agent 重新读盘 —— 脑子追上 TUI 的对话。
   * 任何失败都不阻断 prompt(警告由调用方决定是否展示)。
   */
  async ensureFreshContext(rpc: RelayRpc): Promise<RelayOutcome> {
    const mirror = this.mirrors.get(rpc);
    if (!mirror) return { kind: "clean" };
    if (mirror.isForked()) return { kind: "forked" };
    if (!mirror.isDirty()) return { kind: "clean" };
    try {
      const state = await rpc.requireClient().getState();
      if (state.isStreaming || (state.pendingMessageCount ?? 0) > 0) {
        return { kind: "busy" }; // dirty 保留,下一轮再试。
      }
      if (!state.sessionFile) return { kind: "clean" };
      const result = await rpc.requireClient().switchSession(state.sessionFile);
      if (result.cancelled) return { kind: "busy" };
      mirror.clearDirty();
      return { kind: "relayed" };
    } catch (err) {
      return { kind: "failed", message: (err as Error).message };
    }
  }
}
