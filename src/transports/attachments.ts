/**
 * Attachment storage (issue #66) — the bridge is a porter, not a translator:
 * it downloads media bytes from the homeserver to a global on-disk directory
 * and hands the ABSOLUTE PATH to the router, which injects it into the next
 * prompt. The pi subprocess reads files with its own `read` tool (no sandbox,
 * absolute paths fine) — no base64 over the RPC wire.
 *
 * The download seam (MediaSource) is injectable: tests use fakes, the
 * composition root backs it with matrix-bot-sdk downloadContent /
 * crypto.decryptMedia.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { EncryptedMediaFile } from "./matrix-utils.js";
import { sanitizeMediaFilename } from "./matrix-utils.js";

/** Where bytes come from — the transport-specific half (Matrix client). */
export interface MediaSource {
  downloadPlaintext(mxcUrl: string): Promise<Buffer>;
  /** Present only when the deployment runs with E2EE crypto available. */
  downloadEncrypted?(file: EncryptedMediaFile): Promise<Buffer>;
}

export interface AttachmentStoreConfig {
  /** Root directory; one subdirectory per room. */
  rootDir: string;
  /** Hard cap per attachment in bytes (pre-checked against the event's
   *  declared size, re-checked against real bytes after download). */
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
    super(`附件过大(${formatBytes(declaredBytes)} > 上限 ${formatBytes(maxBytes)}),未保存。请压缩后重发,或让管理员调大 attachments.maxMb 配置。`);
    this.name = "AttachmentTooLargeError";
  }
}

/** 下载/解密 I/O 失败 — message 直接可用于房间回执。 */
export class AttachmentDownloadError extends Error {
  constructor(detail: string) {
    super(`附件下载失败: ${detail}`);
    this.name = "AttachmentDownloadError";
  }
}

/** 单附件下载超时(ms):挂起的下载不能让"失败必回执"变成"永不回执"。 */
const DOWNLOAD_TIMEOUT_MS = 60_000;

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

export class AttachmentStore {
  /** mxc:// → 已存绝对路径(票3):同一张图被转发/重发时不二次下载。 */
  private dedup = new Map<string, string>();

  constructor(
    private config: AttachmentStoreConfig,
    private source: MediaSource
  ) {}

  /** Download (or reuse) and persist one media payload. Throws
   *  AttachmentTooLargeError / AttachmentDownloadError with user-ready
   *  messages; callers forward the message verbatim to the room receipt. */
  async save(roomId: string, media: IncomingMedia): Promise<SavedAttachment> {
    const mxcKey = media.encryptedFile?.url ?? media.mxcUrl;
    if (!mxcKey) {
      throw new AttachmentDownloadError("事件中没有可下载的媒体地址");
    }

    // Dedup (ticket 3): a forwarded/re-sent mxc maps to the existing file.
    // A mapped file that vanished from disk (manual cleanup) re-downloads.
    const known = this.dedup.get(mxcKey);
    if (known) {
      const bytes = await statSize(known).catch(() => -1);
      if (bytes >= 0) {
        return { path: known, filename: path.basename(known), bytes };
      }
      this.dedup.delete(mxcKey);
    }

    // Pre-check against the DECLARED size (cheap rejection before download).
    if (media.sizeHint !== undefined && media.sizeHint > this.config.maxBytes) {
      throw new AttachmentTooLargeError(media.sizeHint, this.config.maxBytes);
    }

    let data: Buffer;
    try {
      if (media.encryptedFile) {
        if (!this.source.downloadEncrypted) {
          throw new Error("加密附件需要启用 E2EE(部署未开启加密或 crypto 原生库不可用)");
        }
        data = await withTimeout(this.source.downloadEncrypted(media.encryptedFile));
      } else {
        data = await withTimeout(this.source.downloadPlaintext(mxcKey));
      }
    } catch (err) {
      if (err instanceof AttachmentTooLargeError) throw err;
      throw new AttachmentDownloadError((err as Error).message);
    }

    // Re-check against REAL bytes — info.size is a hint, servers lie.
    if (data.length > this.config.maxBytes) {
      throw new AttachmentTooLargeError(data.length, this.config.maxBytes);
    }

    const dir = path.join(this.config.rootDir, sanitizeRoomKey(roomId));
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });

    const filename = sanitizeMediaFilename(media.body, mxcKey);
    const target = await uniqueTarget(dir, filename);
    await fs.promises.writeFile(target, data, { mode: 0o600 });

    this.dedup.set(mxcKey, target);
    return { path: target, filename: path.basename(target), bytes: data.length };
  }
}

/** 同名不覆盖:哈希前缀已使碰撞近乎不可能,仍按 -1/-2 递增兜底(确定性)。 */
async function uniqueTarget(dir: string, filename: string): Promise<string> {
  let target = path.join(dir, filename);
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  // 存在性判定用 stat 成败而非字节数 — 0 字节的同名文件同样不许被覆盖。
  for (let i = 1; await pathExists(target); i++) {
    target = path.join(dir, `${stem}-${i}${ext}`);
  }
  return target;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function statSize(p: string): Promise<number> {
  const st = await fs.promises.stat(p);
  return st.size;
}

function withTimeout(p: Promise<Buffer>): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`下载超时(${DOWNLOAD_TIMEOUT_MS / 1000}s)`)), DOWNLOAD_TIMEOUT_MS);
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
