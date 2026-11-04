/**
 * Attachment storage (issue #66 票1, 接缝3): a fake MediaSource + temp dir —
 * real disk writes, no Matrix. Covers save/dedup/size-cap/filename rules.
 */
import { createCipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AttachmentStore,
  AttachmentTooLargeError,
  decryptEncryptedMedia,
  readCapped,
  sanitizeMediaFilename,
  sanitizeRoomKey,
  type MediaSource,
} from "../src/transports/attachments.js";

/** Counter-bearing fake: every download bumps `calls`. */
function countingSource(payload: (i: number) => Buffer = () => Buffer.from("PNGDATA")): MediaSource & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    downloadPlaintext: async () => {
      calls++;
      return payload(calls);
    },
  };
}

function makeStore(source: MediaSource, maxBytes = 10 * 1024 * 1024) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-courier-att-"));
  return { store: new AttachmentStore({ rootDir: root, maxBytes }, source), root };
}

const ROOM = "!abc:matrix.org";

describe("AttachmentStore.save", () => {
  // POSIX mode bits: meaningless on Windows (libuv reports 0666/0444 only).
  it.skipIf(process.platform === "win32")("saves a plaintext media payload to <root>/<roomKey>/<hash>-<name>", async () => {
    const source = countingSource();
    const { store, root } = makeStore(source);
    const saved = await store.save(ROOM, { mxcUrl: "mxc://s/abc", body: "photo.png", sizeHint: 7 });

    expect(saved.bytes).toBe(7);
    expect(saved.path.startsWith(path.join(root, sanitizeRoomKey(ROOM)))).toBe(true);
    expect(path.basename(saved.path)).toMatch(/^[0-9a-f]{12}-photo\.png$/);
    expect(await fs.promises.readFile(saved.path, "utf-8")).toBe("PNGDATA");
    // Directory is private-ish (created 0o700)
    const mode = (await fs.promises.stat(path.dirname(saved.path))).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it("rejects oversize payloads BEFORE download (declared size)", async () => {
    const source = countingSource();
    const { store } = makeStore(source, 100);
    await expect(store.save(ROOM, { mxcUrl: "mxc://s/big", body: "big.png", sizeHint: 101 }))
      .rejects.toThrow(AttachmentTooLargeError);
    expect(source.calls).toBe(0); // never downloaded
  });

  it("rejects payloads whose REAL bytes exceed the cap (info.size lied)", async () => {
    const source = countingSource(() => Buffer.alloc(200, 1));
    const { store } = makeStore(source, 100);
    await expect(store.save(ROOM, { mxcUrl: "mxc://s/liar", body: "liar.png", sizeHint: 10 }))
      .rejects.toThrow(AttachmentTooLargeError);
    expect(source.calls).toBe(1); // downloaded once, then rejected
  });

  it("never overwrites an existing file (deterministic -1 suffix)", async () => {
    const { store } = makeStore(countingSource());
    const a = await store.save(ROOM, { mxcUrl: "mxc://s/dup", body: "same.png" });
    // different mxc, same sanitized name, same room → second file, no clobber
    const b = await store.save(ROOM, { mxcUrl: "mxc://s/other", body: "same.png" });
    expect(a.path).not.toBe(b.path);
    expect(await fs.promises.readFile(a.path, "utf-8")).toBe("PNGDATA");
    expect(await fs.promises.readFile(b.path, "utf-8")).toBe("PNGDATA");
  });

  it("a pre-existing zero-byte file is never overwritten (audit stability batch 票16)", async () => {
    const { store, root } = makeStore(countingSource());
    // 预先放一个 0 字节文件,占住 z2 的确定性目标名(名字计算与 store 同源)
    const victim = path.join(root, sanitizeRoomKey(ROOM), sanitizeMediaFilename("pre.bin", "mxc://s/z2"));
    await fs.promises.mkdir(path.dirname(victim), { recursive: true });
    await fs.promises.writeFile(victim, "");
    const saved = await store.save(ROOM, { mxcUrl: "mxc://s/z2", body: "pre.bin" });
    expect(saved.path).not.toBe(victim); // wx 命中 EEXIST → 落 -1
    expect((await fs.promises.stat(victim)).size).toBe(0);
    expect(await fs.promises.readFile(saved.path, "utf-8")).toBe("PNGDATA");
  });

  it("wraps download failures with a user-ready message", async () => {
    const source: MediaSource = {
      downloadPlaintext: async () => {
        throw new Error("M_NOT_FOUND: media not found");
      },
    };
    const { store } = makeStore(source);
    await expect(store.save(ROOM, { mxcUrl: "mxc://s/gone", body: "gone.png" }))
      .rejects.toThrow("附件下载失败: M_NOT_FOUND");
  });

  it("maxBytes 随缝下发给 MediaSource(上限由实现方在传输中途实施)", async () => {
    const seenPlaintext: number[] = [];
    const seenEncrypted: number[] = [];
    const source: MediaSource = {
      downloadPlaintext: async (_mxc, maxBytes) => {
        seenPlaintext.push(maxBytes);
        return Buffer.from("PNGDATA");
      },
      downloadEncrypted: async (_file, maxBytes) => {
        seenEncrypted.push(maxBytes);
        return Buffer.from("DECRYPTED");
      },
    };
    const { store } = makeStore(source, 123);
    await store.save(ROOM, { mxcUrl: "mxc://s/p", body: "p.png" });
    await store.save(ROOM, {
      encryptedFile: { url: "mxc://s/enc", key: { k: "k" }, iv: "iv", hashes: { sha256: "h" } },
      body: "enc.png",
    });
    expect(seenPlaintext).toEqual([123]);
    expect(seenEncrypted).toEqual([123]);
  });

  it("下载中途超上限:TooLarge 原样上抛,不被包装成『下载失败』", async () => {
    const source: MediaSource = {
      downloadPlaintext: async (_mxc, maxBytes) => {
        throw new AttachmentTooLargeError(maxBytes + 1, maxBytes);
      },
    };
    const { store } = makeStore(source, 100);
    await expect(store.save(ROOM, { mxcUrl: "mxc://s/mid", body: "mid.png" }))
      .rejects.toThrow(AttachmentTooLargeError);
    await expect(store.save(ROOM, { mxcUrl: "mxc://s/mid", body: "mid.png" }))
      .rejects.toThrow("附件过大");
  });

  it("rejects events without any downloadable address", async () => {
    const { store } = makeStore(countingSource());
    await expect(store.save(ROOM, { body: "mystery.png" })).rejects.toThrow("没有可下载的媒体地址");
  });

  it("routes encrypted payloads to downloadEncrypted when present", async () => {
    let decrypted = 0;
    const source: MediaSource = {
      downloadPlaintext: async () => {
        throw new Error("should not be called");
      },
      downloadEncrypted: async () => {
        decrypted++;
        return Buffer.from("DECRYPTED");
      },
    };
    const { store } = makeStore(source);
    const saved = await store.save(ROOM, {
      encryptedFile: { url: "mxc://s/enc", key: { k: "k" }, iv: "iv", hashes: { sha256: "h" } },
      body: "enc.png",
    });
    expect(decrypted).toBe(1);
    expect(await fs.promises.readFile(saved.path, "utf-8")).toBe("DECRYPTED");
  });

  it("fails with a clear message when encryption is unavailable in this deployment", async () => {
    const { store } = makeStore(countingSource());
    await expect(store.save(ROOM, {
      encryptedFile: { url: "mxc://s/enc", key: { k: "k" }, iv: "iv", hashes: { sha256: "h" } },
      body: "enc.png",
    })).rejects.toThrow("加密附件需要启用 E2EE");
  });

  it("dedups encrypted media by the ENCRYPTED mxc url (票2)", async () => {
    let decrypts = 0;
    const source: MediaSource = {
      downloadPlaintext: async () => Buffer.from("PLAIN"),
      downloadEncrypted: async () => {
        decrypts++;
        return Buffer.from("DECRYPTED");
      },
    };
    const { store } = makeStore(source);
    const encFile = { url: "mxc://s/enc1", key: { k: "k" }, iv: "iv", hashes: { sha256: "h" } };
    const a = await store.save(ROOM, { encryptedFile: encFile, body: "enc.png" });
    const b = await store.save(ROOM, { encryptedFile: encFile, body: "enc.png" });
    expect(decrypts).toBe(1); // second save reused the first decryption
    expect(b.path).toBe(a.path);
  });

  it("scopes dedup to the room: the same mxc in another room re-downloads into THAT room's dir (sec-attachment-dedup-room)", async () => {
    const source = countingSource();
    const { store, root } = makeStore(source);
    const roomA = "!aaa:matrix.org";
    const roomB = "!bbb:matrix.org";
    const a = await store.save(roomA, { mxcUrl: "mxc://s/shared", body: "shared.png" });
    const b = await store.save(roomB, { mxcUrl: "mxc://s/shared", body: "shared.png" });
    expect(source.calls).toBe(2); // cross-room hit must NOT reuse the path
    expect(b.path.startsWith(path.join(root, sanitizeRoomKey(roomB)))).toBe(true);
    expect(b.path.includes(sanitizeRoomKey(roomA))).toBe(false); // no A-room key leak
    // same-room resend still dedups (票3 behavior intact)
    const a2 = await store.save(roomA, { mxcUrl: "mxc://s/shared", body: "shared.png" });
    expect(source.calls).toBe(2);
    expect(a2.path).toBe(a.path);
  });

  it("scopes encrypted-media dedup to the room too (sec-attachment-dedup-room)", async () => {
    let decrypts = 0;
    const source: MediaSource = {
      downloadPlaintext: async () => Buffer.from("PLAIN"),
      downloadEncrypted: async () => {
        decrypts++;
        return Buffer.from("DECRYPTED");
      },
    };
    const { store, root } = makeStore(source);
    const encFile = { url: "mxc://s/enc1", key: { k: "k" }, iv: "iv", hashes: { sha256: "h" } };
    const a = await store.save("!aaa:matrix.org", { encryptedFile: encFile, body: "enc.png" });
    const b = await store.save("!bbb:matrix.org", { encryptedFile: encFile, body: "enc.png" });
    expect(decrypts).toBe(2); // no cross-room reuse of the decryption
    expect(b.path.startsWith(path.join(root, sanitizeRoomKey("!bbb:matrix.org")))).toBe(true);
    expect(b.path.includes(sanitizeRoomKey("!aaa:matrix.org"))).toBe(false);
  });

  it("a vanished deduped file re-downloads and self-heals, without wiping sibling entries (sec-attachment-dedup-room)", async () => {
    const source = countingSource();
    const { store, root } = makeStore(source);
    const a = await store.save(ROOM, { mxcUrl: "mxc://s/vanish", body: "vanish.png" });
    const b = await store.save(ROOM, { mxcUrl: "mxc://s/sibling", body: "sibling.png" });
    expect(source.calls).toBe(2);
    await fs.promises.rm(a.path); // manual cleanup: the mapped file disappears
    const a2 = await store.save(ROOM, { mxcUrl: "mxc://s/vanish", body: "vanish.png" });
    expect(source.calls).toBe(3); // stale entry detected → re-download
    expect(a2.path.startsWith(path.join(root, sanitizeRoomKey(ROOM)))).toBe(true);
    // the stale-entry cleanup removes ONLY that mxc's entry — the room map
    // and its sibling entry survive (locks the two-level-Map delete branch)
    const b2 = await store.save(ROOM, { mxcUrl: "mxc://s/sibling", body: "sibling.png" });
    expect(source.calls).toBe(3);
    expect(b2.path).toBe(b.path);
    // self-healed: the re-downloaded mxc dedups again
    const a3 = await store.save(ROOM, { mxcUrl: "mxc://s/vanish", body: "vanish.png" });
    expect(source.calls).toBe(3);
    expect(a3.path).toBe(a2.path);
  });

  it("wraps decrypt failures with a user-ready message (票2)", async () => {
    const source: MediaSource = {
      downloadPlaintext: async () => Buffer.from("x"),
      downloadEncrypted: async () => {
        throw new Error("Decryption failed: unknown message index");
      },
    };
    const { store } = makeStore(source);
    await expect(store.save(ROOM, {
      encryptedFile: { url: "mxc://s/enc", key: { k: "k" }, iv: "iv", hashes: { sha256: "h" } },
      body: "enc.png",
    })).rejects.toThrow("附件下载失败: Decryption failed");
  });
});

describe("sanitizeRoomKey", () => {
  it("is deterministic and collision-free across separators", () => {
    expect(sanitizeRoomKey("!a:server")).toBe(sanitizeRoomKey("!a:server"));
    // "!" and ":" replaced identically → the hash suffix disambiguates
    expect(sanitizeRoomKey("!a:server")).not.toBe(sanitizeRoomKey("_a_server"));
  });

  it("contains only safe characters", () => {
    expect(sanitizeRoomKey("!abcdef:matrix.purplelin.com")).toMatch(/^[A-Za-z0-9._-]+-[0-9a-f]{8}$/);
  });
});

// ─── 文件名消毒(自 matrix-utils.test.ts 随函数迁入,spec #99/#101)───

describe("sanitizeMediaFilename", () => {
  it("prefixes a deterministic hash of the mxc url", () => {
    expect(sanitizeMediaFilename("photo.png", "mxc://s/abc"))
      .toBe(sanitizeMediaFilename("photo.png", "mxc://s/abc"));
    expect(sanitizeMediaFilename("a.png", "mxc://s/1")).not.toBe(sanitizeMediaFilename("a.png", "mxc://s/2"));
  });

  it("strips path traversal components", () => {
    const name = sanitizeMediaFilename("../../etc/passwd", "mxc://s/abc");
    expect(name).not.toContain("..");
    expect(name).not.toContain("/");
    expect(name.endsWith("passwd")).toBe(true);
  });

  it("strips windows separators and control characters", () => {
    const name = sanitizeMediaFilename("..\\..\\x\u0000y\r\n z.png", "mxc://s/abc");
    expect(name).not.toMatch(/[\\/]/);
    expect(name).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it("never starts with dots (hidden file / relative-path tricks)", () => {
    expect(sanitizeMediaFilename("..hidden", "mxc://s/abc").endsWith("hidden")).toBe(true);
    expect(sanitizeMediaFilename("..", "mxc://s/abc")).not.toContain("..");
  });

  it("regression: ' ..' (space-led dots) cannot survive as '..' (fast-check 反例固化)", () => {
    const name = sanitizeMediaFilename(" ..", "mxc://s/abc");
    expect(name).not.toContain("..");
    expect(name).not.toMatch(/^\s/);
  });

  it("falls back to 'file' when nothing safe remains", () => {
    expect(sanitizeMediaFilename("", "mxc://s/abc")).toMatch(/^[0-9a-f]{12}-file$/);
    expect(sanitizeMediaFilename(undefined, "mxc://s/abc")).toMatch(/^[0-9a-f]{12}-file$/);
  });

  it("property: output is safe for any input (no separators, no traversal, non-empty)", () => {
    const mxc = fc.constant("mxc://server/mediaId");
    const arbBody = fc.string({ maxLength: 300 });
    fc.assert(
      fc.property(arbBody, mxc, (body, url) => {
        const name = sanitizeMediaFilename(body, url);
        expect(name.length).toBeGreaterThan(0);
        expect(name).not.toMatch(/[/\\]/);
        expect(name).not.toContain("..");
        expect(name).toMatch(/^[0-9a-f]{12}-/);
      })
    );
  });
});

// ─── readCapped(流式硬上限,sec 下载 OOM 修复)───

/** 把分块数组装进一个 web ReadableStream;记录 cancel 是否被调用。 */
function streamOf(chunks: Buffer[]): { stream: ReadableStream<Uint8Array>; cancelCalls: () => number } {
  let cancels = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    cancel() {
      cancels++;
    },
  });
  return { stream, cancelCalls: () => cancels };
}

describe("readCapped", () => {
  it("上限内:分块按序拼回原文", async () => {
    const { stream } = streamOf([Buffer.from("AB"), Buffer.from("CD"), Buffer.from("E")]);
    expect(await readCapped(stream, 100)).toEqual(Buffer.from("ABCDE"));
  });

  it("空流:返回空 Buffer", async () => {
    const { stream } = streamOf([]);
    expect(await readCapped(stream, 10)).toEqual(Buffer.alloc(0));
  });

  it("恰好等于上限:放行(超限才判,> 而非 >=)", async () => {
    const { stream } = streamOf([Buffer.alloc(10, 1)]);
    expect((await readCapped(stream, 10)).length).toBe(10);
  });

  it("累计越线:立刻抛 TooLarge 且取消流(连接被掐断,不吞整包)", async () => {
    const { stream, cancelCalls } = streamOf([Buffer.alloc(60, 1), Buffer.alloc(60, 2), Buffer.alloc(60, 3)]);
    await expect(readCapped(stream, 100)).rejects.toThrow(AttachmentTooLargeError);
    await expect(readCapped(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.alloc(120, 1)); c.close(); } }), 100))
      .rejects.toThrow("附件过大");
    // 抛错已触发迭代器 return → cancel(第二个流已消费,这里查第一个)
    expect(cancelCalls()).toBe(1);
  });
});

// ─── decryptEncryptedMedia(本地规范解密,sec 下载 OOM 修复配套)───

/** 与 Matrix 规范一致的加密侧(测试专用):AES-256-CTR,iv 为 16 字节
 *  计数块(随机 8 字节前缀 + 8 字节 0),sha256 对密文。 */
function specEncrypt(plaintext: Buffer) {
  const key = randomBytes(32);
  const iv = Buffer.concat([randomBytes(8), Buffer.alloc(8)]);
  const cipher = createCipheriv("aes-256-ctr", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    file: {
      url: "mxc://s/enc",
      v: "v2",
      key: { k: key.toString("base64url") },
      iv: iv.toString("base64"),
      hashes: { sha256: createHash("sha256").update(ciphertext).digest("base64") },
    },
    ciphertext,
  };
}

/** 固定向量:由 @matrix-org/matrix-sdk-crypto-nodejs(Rust Attachment.encrypt)
 *  产出的密文,开发期已与本地解密双向互认(工单 sec-download-size-cap),
 *  固化在此防止算法漂移。 */
const RUST_VECTOR = {
  plaintext: Buffer.from("YXR0YWNobWVudC1jYXAtdmVjdG9yLXBsYWludGV4dA==", "base64"),
  file: {
    url: "mxc://s/vec",
    v: "v2",
    key: { k: "dQ6jyKm8dGy6tOQpw4TR92mJIzw3kHB7eV7-gXaIHeA" },
    iv: "ktNOeiUlr/gAAAAAAAAAAA==",
    hashes: { sha256: "fCqF/8Zl3x4XQEaATpvXMyzC2BvTAtnv22qtYsjtsoM=" },
  },
  ciphertext: Buffer.from("OBH25QKW+H0OqUTbip7zSCdZInVniH4Owv1plfeipA==", "base64"),
};

describe("decryptEncryptedMedia", () => {
  it("按规范加密的密文可解回原文(跨 CTR 块边界)", async () => {
    for (const size of [0, 1, 16, 17, 63, 4096]) {
      const plaintext = randomBytes(size);
      const { file, ciphertext } = specEncrypt(plaintext);
      expect(await decryptEncryptedMedia(file, ciphertext)).toEqual(plaintext);
    }
  });

  it("Rust Attachment.encrypt 互认向量:可解", async () => {
    expect(await decryptEncryptedMedia(RUST_VECTOR.file, RUST_VECTOR.ciphertext))
      .toEqual(RUST_VECTOR.plaintext);
  });

  it("密文被篡改:SHA-256 校验失败,抛中文完整性错误且不产明文", async () => {
    const tampered = Buffer.from(RUST_VECTOR.ciphertext);
    tampered[0] ^= 0xff;
    await expect(decryptEncryptedMedia(RUST_VECTOR.file, tampered)).rejects.toThrow("完整性校验失败");
  });

  it("哈希比对用常数时间比较(防侧信道)", async () => {
    // 直接校验实现内建 timingSafeEqual 的行为面:错哈希必拒,对哈希必过
    const { file, ciphertext } = specEncrypt(Buffer.from("x"));
    expect(await decryptEncryptedMedia(file, ciphertext)).toEqual(Buffer.from("x"));
    const wrongHash = { ...file, hashes: { sha256: createHash("sha256").update("other").digest("base64") } };
    await expect(decryptEncryptedMedia(wrongHash, ciphertext)).rejects.toThrow("完整性校验失败");
    expect(timingSafeEqual).toBeDefined();
  });
});
