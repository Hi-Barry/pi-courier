/**
 * Attachment storage (issue #66) — the bridge is a porter, not a translator:
 * it downloads media bytes from the homeserver to a global on-disk directory
 * and hands the ABSOLUTE PATH to the router, which injects it into the next
 * prompt. The pi subprocess reads files with its own `read` tool (no sandbox,
 * absolute paths fine) — no base64 over the RPC wire.
 *
 * The download seam (MediaSource) is injectable: tests use fakes, the
 * composition root backs it with a streaming, byte-capped authenticated
 * media download (matrix.ts) plus local AES-CTR decryption for E2EE
 * attachments — the cap is enforced DURING the transfer, never after.
 *
 * The media-input shape (EncryptedMediaFile) and filename sanitization
 * (sanitizeMediaFilename) live here too — the module that writes files owns
 * the filename contract (spec #99/#101: formerly matrix-utils.ts).
 */

import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage } from "../errors.js";
import { t } from "../i18n/index.js";

// ─── 附件输入(issue #66)────────────────────────────────────────

/** 加密附件块(EncryptedFileInfo)的最小结构视图 — 与 matrix-bot-sdk 的
 *  MessageEvent.EncryptedFile 结构兼容,避免本模块依赖 SDK。 */
export interface EncryptedMediaFile {
  url: string;
  key: { k: string };
  iv: string;
  hashes: { sha256: string };
  v?: string;
}

/**
 * 文件名消毒(issue #66 票1):防路径穿越/分隔符注入,输出确定性的
 * "<mxc mediaId 哈希前缀>-<安全化原名>"。body 为空时回退 "file"。
 */
export function sanitizeMediaFilename(body: string | undefined, mxcUrl: string): string {
  const hash = createHash("sha256").update(mxcUrl).digest("hex").slice(0, 12);
  const base = (body ?? "").split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .replace(/[\x00-\x1f\x7f]/g, "") // 控制字符
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "") // 防 ".."/"."(必须先 trim —— " .." 形式会绕过前导点剥离,fast-check 反例)
    .replace(/\.{2,}/g, ".") // 折叠连续点:".." 永不出现在文件名里(fast-check 反例 "!..")
    .trim();
  const safe = cleaned.length > 0 ? cleaned : "file";
  return `${hash}-${safe.slice(0, 150)}`;
}

/** Where bytes come from — the transport-specific half (Matrix client).
 *
 *  大小硬上限(sec 下载 OOM 修复):两个方法都携带 maxBytes,实现方必须在
 *  传输过程中逐块计数并在累计超过 maxBytes 时中止(掐断连接),成功返回
 *  隐含「字节数 ≤ maxBytes」。上限只在下载完成后复检无法防 OOM —— 恶意
 *  房间成员/联邦媒体服务器谎报 sizeHint,或分块传输不声明 Content-Length,
 *  都能把任意大的 body 先读进内存。 */
export interface MediaSource {
  downloadPlaintext(mxcUrl: string, maxBytes: number): Promise<Buffer>;
  /** Present only when the deployment runs with E2EE crypto available. */
  downloadEncrypted?(file: EncryptedMediaFile, maxBytes: number): Promise<Buffer>;
}

export interface AttachmentStoreConfig {
  /** Root directory; one subdirectory per room. */
  rootDir: string;
  /** Hard cap per attachment in bytes (pre-checked against the event's
   *  declared size, enforced by the MediaSource DURING the download, and
   *  re-checked against real bytes afterwards — belt and braces). */
  maxBytes: number;
}

export interface SavedAttachment {
  /** Absolute path of the file on disk */
  path: string;
  /** Sanitized filename (hash prefix + safe body) */
  filename: string;
  /** Real byte count as written */
  bytes: number;
}

/** Input for one save: the classified media payload of a Matrix event. */
export interface IncomingMedia {
  mxcUrl?: string;
  encryptedFile?: EncryptedMediaFile;
  /** Raw event body (Element sends the filename here). */
  body: string;
  /** Declared size from info.size — a hint, never trusted (servers lie). */
  sizeHint?: number;
}

/** 附件超过大小上限 — 带上预检用的声明值与实际上限,文案在 message 里。 */
export class AttachmentTooLargeError extends Error {
  constructor(declaredBytes: number, maxBytes: number) {
    super(t("attach.tooLarge", { declared: formatBytes(declaredBytes), max: formatBytes(maxBytes) }));
    this.name = "AttachmentTooLargeError";
  }
}

/** 下载/解密 I/O 失败 — message 直接可用于房间回执。 */
export class AttachmentDownloadError extends Error {
  constructor(detail: string) {
    super(t("attach.downloadFailed", { detail }));
    this.name = "AttachmentDownloadError";
  }
}

/** 单附件下载超时(ms):挂起的下载不能让"失败必回执"变成"永不回执"。
 *  导出给 matrix.ts 的流式下载做 socket 级中止(同一时刻,同一语义)。 */
export const DOWNLOAD_TIMEOUT_MS = 60_000;

/** 房间 ID → 安全子目录名("!abc:server" 含 ! 与 :,全部替换 + 哈希防碰撞)。 */
export function sanitizeRoomKey(roomId: string): string {
  const hash = createHash("sha256").update(roomId).digest("hex").slice(0, 8);
  const safe = roomId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safe}-${hash}`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/**
 * 逐块读取一个字节流并实施 maxBytes 硬上限(sec 下载 OOM 修复):累计超过
 * 上限立刻抛 AttachmentTooLargeError。从 for-await 中抛出走迭代器的
 * return() —— web ReadableStream 的 return 即 cancel(),连接会被掐断,
 * 服务端再大也只进过内存 maxBytes+一个分块。
 */
export async function readCapped(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new AttachmentTooLargeError(total, maxBytes);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * 按 Matrix 规范(v2 加密附件)本地解密:先校验密文的 SHA-256(防 homeserver
 * 换包),再用 AES-256-CTR 解密 —— key 取 EncryptedFile.key.k(URL-safe 无
 * 填充 base64,32 字节),16 字节 iv 字段本身就是初始计数块(低 64 位为 0)。
 *
 * 自 matrix-bot-sdk 的 crypto.decryptMedia 拆出来:decryptMedia = 整包下载 +
 * 纯解密,下载段无法带上限;下载改由 MediaSource 的流式上限承担后,解密是
 * 无网络参与的字节变换,用 node:crypto 就地完成。算法与
 * @matrix-org/matrix-sdk-crypto-nodejs(Rust Attachment)经双向互认验证。
 */
export async function decryptEncryptedMedia(file: EncryptedMediaFile, ciphertext: Buffer): Promise<Buffer> {
  const expected = Buffer.from(file.hashes.sha256, "base64");
  const actual = createHash("sha256").update(ciphertext).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error(t("attach.hashMismatch"));
  }
  const key = Buffer.from(file.key.k, "base64url");
  const iv = Buffer.from(file.iv, "base64");
  const decipher = createDecipheriv("aes-256-ctr", key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export class AttachmentStore {
  /** roomId → (mxc:// → 已存绝对路径)(票3):同一张图在本房间被转发/重发时
   *  不二次下载。键带房间维度(sec-attachment-dedup-room):同一 mxc 在不同
   *  房间各自落盘,绝不把别的房间子目录的绝对路径交给本房间——跨房命中会
   *  泄漏对方 roomId 的净化形+哈希,击穿房间存储隔离。用两级 Map 而非拼接
   *  键,免掉分隔符碰撞论证。 */
  private dedup = new Map<string, Map<string, string>>();

  constructor(
    private config: AttachmentStoreConfig,
    private source: MediaSource,
    /** 磁盘类写失败(ENOSPC/EDQUOT)的聚合可见性缝(spec #247 票04):
     *  组合根注入 recorder 包装;缺省不接,save 的错误类型契约不变。 */
    private readonly onDiskWriteFailure?: (err: unknown) => void
  ) {}

  /** Download (or reuse) and persist one media payload. Throws
   *  AttachmentTooLargeError / AttachmentDownloadError with user-ready
   *  messages; callers forward the message verbatim to the room receipt. */
  async save(roomId: string, media: IncomingMedia): Promise<SavedAttachment> {
    const mxcKey = media.encryptedFile?.url ?? media.mxcUrl;
    if (!mxcKey) {
      throw new AttachmentDownloadError(t("attach.noMediaUrl"));
    }

    // Dedup (ticket 3): a forwarded/re-sent mxc maps to the existing file —
    // scoped to THIS room (sec-attachment-dedup-room): a cross-room hit would
    // hand out another room's subdirectory path. A mapped file that vanished
    // from disk (manual cleanup) re-downloads.
    const roomDedup = this.dedup.get(roomId);
    const known = roomDedup?.get(mxcKey);
    if (known) {
      const bytes = await statSize(known).catch(() => -1);
      if (bytes >= 0) {
        return { path: known, filename: path.basename(known), bytes };
      }
      roomDedup?.delete(mxcKey);
    }

    // Pre-check against the DECLARED size (cheap rejection before download).
    if (media.sizeHint !== undefined && media.sizeHint > this.config.maxBytes) {
      throw new AttachmentTooLargeError(media.sizeHint, this.config.maxBytes);
    }

    let data: Buffer;
    try {
      if (media.encryptedFile) {
        if (!this.source.downloadEncrypted) {
          throw new Error(t("attach.e2eeRequired"));
        }
        // 上限随缝下发:实现方在传输中途掐断,不是下完再看(防 OOM)。
        data = await withTimeout(this.source.downloadEncrypted(media.encryptedFile, this.config.maxBytes));
      } else {
        data = await withTimeout(this.source.downloadPlaintext(mxcKey, this.config.maxBytes));
      }
    } catch (err) {
      // 实现方传输中途超上限抛 TooLarge —— 这就是大小判定,原样上抛,
      // 不许包装成"下载失败";其余(含非 Error 拒绝,审计工程批 票20/24)
      // 照旧包成可读的下载错误。
      if (err instanceof AttachmentTooLargeError) throw err;
      throw new AttachmentDownloadError(errorMessage(err));
    }

    // Re-check against REAL bytes — info.size is a hint, servers lie.
    // (主防线已前移:实现方传输中途按 maxBytes 掐断,这里是兜底,拦住
    // 未遵守上限语义的自定义 MediaSource。)
    if (data.length > this.config.maxBytes) {
      throw new AttachmentTooLargeError(data.length, this.config.maxBytes);
    }

    const dir = path.join(this.config.rootDir, sanitizeRoomKey(roomId));
    const filename = sanitizeMediaFilename(media.body, mxcKey);
    // 落盘段(建目录 + 独占写)整体过磁盘写失败缝(spec #247 票04):ENOSPC
    // 可能打在 mkdir 也可能打在 writeFile。原错误照抛(类型契约不变,调用方
    // 照常给房间回执);缝自身抛错不放大。
    let target: string;
    try {
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      target = await writeExclusive(dir, filename, data);
    } catch (err) {
      try {
        this.onDiskWriteFailure?.(err);
      } catch {
        // 可见性通道失败不影响回执契约
      }
      throw err;
    }

    const byRoom = this.dedup.get(roomId) ?? new Map<string, string>();
    this.dedup.set(roomId, byRoom);
    byRoom.set(mxcKey, target);
    return { path: target, filename: path.basename(target), bytes: data.length };
  }
}

/** 同名不覆盖:哈希前缀已使碰撞近乎不可能,仍按 -1/-2 递增兜底(确定性)。
 *  独占创建(flag "wx")封死「存在性检查后写入」的窗口——并发写者命中
 *  EEXIST 即递增后缀重试,任何已存在文件(含 0 字节)都不会被覆盖
 *  (审计稳定性批 票16)。 */
async function writeExclusive(dir: string, filename: string, data: Buffer): Promise<string> {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  let target = path.join(dir, filename);
  for (let i = 1; ; i++) {
    try {
      await fs.promises.writeFile(target, data, { mode: 0o600, flag: "wx" });
      return target;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      target = path.join(dir, `${stem}-${i}${ext}`);
    }
  }
}

async function statSize(p: string): Promise<number> {
  const st = await fs.promises.stat(p);
  return st.size;
}

function withTimeout(p: Promise<Buffer>): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(t("attach.downloadTimeout", { seconds: DOWNLOAD_TIMEOUT_MS / 1000 }))), DOWNLOAD_TIMEOUT_MS);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}
