/**
 * Attachment storage (issue #66 票1, 接缝3): a fake MediaSource + temp dir —
 * real disk writes, no Matrix. Covers save/dedup/size-cap/filename rules.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AttachmentStore,
  AttachmentTooLargeError,
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
  it("saves a plaintext media payload to <root>/<roomKey>/<hash>-<name>", async () => {
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
