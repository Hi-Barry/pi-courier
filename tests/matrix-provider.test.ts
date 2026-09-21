/**
 * MatrixProvider 直测(spec #99/#100 票1):经 clientFactory 注入假客户端,
 * 不触碰真实 ~/.pi 路径与网络(缺省生产工厂永不使用)。钉住启动回放隔离
 * (spec #93 票1 语义)、事件接线与成员缓存的传输层语义。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentStore, type MediaSource } from "../src/transports/attachments.js";
import { MatrixProvider } from "../src/transports/matrix.js";
import type { MatrixClientPort } from "../src/transports/matrix-client.js";
import { buildGroupJoinHint } from "../src/management-room.js";
import type { ExternalMessage } from "../src/types.js";
import { fakeCrypto, fakeMatrixClient, type FakeMatrixClient } from "./matrix-fakes.js";
import { captureConsole } from "./helpers.js";

const CFG = { homeserverUrl: "https://matrix.example.org", accessToken: "tok" };
const ROOM = "!room:server";
const BOT = "@bot:server";
const ALICE = "@alice:server";

/** 等待 fire-and-forget 异步链跑完(负向断言:什么都没发生)。 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

/** 等待 fire-and-forget 异步链产生结果(正向断言)。 */
async function until(predicate: () => boolean) {
  await vi.waitFor(() => {
    if (!predicate()) throw new Error("condition not met yet");
  });
}

interface ProviderOptions {
  encryption?: boolean;
  isRoomEnabled?: (chatId: string) => boolean;
  /** 依次投入连接队列的客户端;空缺时工厂补一个默认假客户端。 */
  queue?: FakeMatrixClient[];
  attachments?: AttachmentStore;
}

function makeProvider(opts: ProviderOptions = {}) {
  const clients: FakeMatrixClient[] = [];
  const provider = new MatrixProvider(
    { ...CFG, ...(opts.encryption === false ? { encryption: false } : {}) },
    opts.isRoomEnabled ?? (() => false),
    () => {
      const c = opts.queue?.shift() ?? fakeMatrixClient();
      clients.push(c);
      return c as unknown as MatrixClientPort;
    }
  );
  if (opts.attachments) provider.setAttachmentStore(opts.attachments);
  return { provider, clients };
}

function textEvent(sender: string, body: string, extra: Record<string, unknown> = {}) {
  return {
    sender,
    origin_server_ts: Date.now(),
    event_id: `$evt-${Math.random().toString(36).slice(2)}`,
    content: { msgtype: "m.text", body, ...extra },
  };
}

/** 数到消息的挂点:messageHandler 收到的 ExternalMessage 列表。 */
function collectMessages() {
  const received: ExternalMessage[] = [];
  return { received, wire: (provider: MatrixProvider) => provider.onMessage((m) => received.push(m)) };
}

/** 附件管线用的假 MediaSource(计数)+ 临时目录 store。 */
function storeWithSource() {
  const source: MediaSource & { calls: string[] } = {
    calls: [],
    downloadPlaintext: async (mxcUrl) => {
      source.calls.push(mxcUrl);
      return Buffer.from("PNGDATA");
    },
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mx-provider-"));
  return { source, store: new AttachmentStore({ rootDir: root, maxBytes: 10 * 1024 * 1024 }, source) };
}

describe("MatrixProvider.connect", () => {
  let lines: string[];
  beforeEach(() => {
    lines = captureConsole();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("连接成功:缓存 botUserId、播种已加入房间与成员数、注册四类事件", async () => {
    const { provider, clients } = makeProvider({
      queue: [
        fakeMatrixClient({ getJoinedRooms: vi.fn(async () => [ROOM, "!other:server"]) }),
      ],
    });
    await provider.connect();

    expect(provider.isConnected).toBe(true);
    const client = clients[0];
    expect(client.start).toHaveBeenCalledTimes(1);
    expect(client.getUserId).toHaveBeenCalledTimes(1);
    expect(client.getJoinedRooms).toHaveBeenCalledTimes(1);
    // 成员数播种:每个已加入房间各查一次
    expect(client.getJoinedRoomMembers).toHaveBeenCalledWith(ROOM);
    expect(client.getJoinedRoomMembers).toHaveBeenCalledWith("!other:server");
    // 四类事件全部接线
    expect(client.on).toHaveBeenCalledWith("room.join", expect.any(Function));
    expect(client.on).toHaveBeenCalledWith("room.leave", expect.any(Function));
    expect(client.on).toHaveBeenCalledWith("room.message", expect.any(Function));
    expect(client.on).toHaveBeenCalledWith("room.event", expect.any(Function));
  });

  it("botUserId 缓存生效:自己的消息跳过,同形消息正常放行", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();
    const client = clients[0];
    const { received, wire } = collectMessages();
    wire(provider);

    client.emit("room.message", ROOM, textEvent(BOT, "自言自语"));
    await flush();
    expect(received).toEqual([]);

    client.emit("room.message", ROOM, textEvent(ALICE, "你好"));
    await until(() => received.length === 1);
    expect(received[0].username).toBe("alice");
  });

  it("encryptionAvailable 跟随端口 crypto 成员的有无", async () => {
    const withCrypto = makeProvider({ queue: [fakeMatrixClient({ crypto: fakeCrypto() })] });
    await withCrypto.provider.connect();
    expect(withCrypto.provider.roomOps.encryptionAvailable).toBe(true);

    const without = makeProvider();
    await without.provider.connect();
    expect(without.provider.roomOps.encryptionAvailable).toBe(false);
  });

  it("start 失败:清理悬空状态并可直接重试", async () => {
    const failing = fakeMatrixClient({
      start: vi.fn(async () => {
        throw new Error("initial sync failed");
      }),
    });
    const { provider, clients } = makeProvider({ queue: [failing] });

    await expect(provider.connect()).rejects.toThrow("initial sync failed");
    expect(provider.isConnected).toBe(false);
    expect(provider.roomOps.getBotUserId()).toBeNull(); // botUserId 已清理
    await expect(provider.sendMessage(ROOM, "hello")).rejects.toThrow("Matrix client not connected");

    // 重试:工厂再次被调用,新客户端连接成功
    await provider.connect();
    expect(provider.isConnected).toBe(true);
    expect(clients).toHaveLength(2);
    expect(clients[1].start).toHaveBeenCalledTimes(1);
    expect(provider.roomOps.getBotUserId()).toBe(BOT);
  });

  it("重复 connect 幂等:不重复建连、不重复播种", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();
    await provider.connect();

    expect(clients).toHaveLength(1);
    expect(clients[0].start).toHaveBeenCalledTimes(1);
    expect(clients[0].getUserId).toHaveBeenCalledTimes(1);
    expect(clients[0].getJoinedRooms).toHaveBeenCalledTimes(1);
  });

  it("连接成功日志带上房间数与 E2EE 状态", async () => {
    const { provider } = makeProvider();
    await provider.connect();
    const connected = lines.find((l) => l.includes("Matrix connected"));
    expect(connected).toContain("1 rooms");
    expect(connected).toContain("E2EE disabled");

    const crypted = makeProvider({ queue: [fakeMatrixClient({ crypto: fakeCrypto() })] });
    await crypted.provider.connect();
    const connectedLines = lines.filter((l) => l.includes("Matrix connected"));
    expect(connectedLines).toHaveLength(2);
    expect(connectedLines[1]).toContain("E2EE enabled");
  });
});

describe("MatrixProvider 事件接线", () => {
  let lines: string[];
  beforeEach(() => {
    lines = captureConsole();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("room.join:刷新成员数;未启用的多人群发一次性入群提示", async () => {
    const groupMembers = [BOT, "@a:server", "@b:server"];
    const { provider, clients } = makeProvider({
      isRoomEnabled: () => false,
      queue: [
        fakeMatrixClient({
          getJoinedRoomMembers: vi.fn(async (roomId: string) =>
            roomId === "!group:server" ? groupMembers : [BOT, ALICE]
          ),
        }),
      ],
    });
    await provider.connect();
    const client = clients[0];

    client.emit("room.join", "!group:server");
    await until(() => client.sendMessage.mock.calls.length === 1);
    expect(client.getJoinedRoomMembers).toHaveBeenCalledWith("!group:server");
    const [roomId, content] = client.sendMessage.mock.calls[0];
    expect(roomId).toBe("!group:server");
    expect(content.body).toBe(buildGroupJoinHint());
  });

  it("room.join:已启用的多人群不发提示;两人房也发不出提示", async () => {
    const { provider, clients } = makeProvider({ isRoomEnabled: () => true });
    await provider.connect();
    const client = clients[0];
    // 多人群 + 已启用 → 不发
    client.getJoinedRoomMembers.mockResolvedValue([BOT, "@a:server", "@b:server"]);
    client.emit("room.join", "!group:server");
    await flush();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("room.leave:清除房间缓存,后续消息按未加入跳过;重新入群后恢复", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();
    const client = clients[0];
    const { received, wire } = collectMessages();
    wire(provider);

    client.emit("room.leave", ROOM);
    client.emit("room.message", ROOM, textEvent(ALICE, "离开后的消息"));
    await flush();
    expect(received).toEqual([]);

    client.emit("room.join", ROOM);
    client.emit("room.message", ROOM, textEvent(ALICE, "重新入群后的消息"));
    await until(() => received.length === 1);
    expect(received[0].payload.kind === "text" && received[0].payload.text).toBe("重新入群后的消息");
  });

  it("room.message:经 shouldSkipEvent + translator 抵达 messageHandler", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();
    const client = clients[0];
    const { received, wire } = collectMessages();
    wire(provider);

    client.emit("room.message", ROOM, textEvent(ALICE, "你好"));
    await until(() => received.length === 1);
    expect(received[0].transport).toBe("matrix");
    expect(received[0].chatId).toBe(ROOM);
    expect(received[0].payload).toEqual({ kind: "text", text: "你好" });
  });

  it("回放隔离:connectedAt 之前的初始同步事件被丢弃(spec #93 票1 语义)", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();
    const client = clients[0];
    const { received, wire } = collectMessages();
    wire(provider);

    // 初始同步回放的历史事件:时间戳早于连接点 → 丢弃
    client.emit("room.message", ROOM, {
      sender: ALICE,
      origin_server_ts: Date.now() - 60_000,
      event_id: "$old1",
      content: { msgtype: "m.text", body: "积压的旧消息" },
    });
    await flush();
    expect(received).toEqual([]);

    // 连接后的实时事件照常处理
    client.emit("room.message", ROOM, textEvent(ALICE, "实时消息"));
    await until(() => received.length === 1);
  });

  it("m.sticker 经 room.event 进消息路径(附件管线);非 sticker 的 room.event 不进", async () => {
    const { source, store } = storeWithSource();
    const { provider, clients } = makeProvider({ attachments: store });
    await provider.connect();
    const client = clients[0];
    const { received, wire } = collectMessages();
    wire(provider);

    client.emit("room.event", ROOM, {
      sender: ALICE,
      origin_server_ts: Date.now(),
      event_id: "$sticker1",
      type: "m.sticker",
      content: { body: "sticker.png", url: "mxc://s/sticker" },
    });
    await until(() => received.length === 1);
    expect(source.calls).toEqual(["mxc://s/sticker"]);
    expect(received[0].payload.kind === "media" && received[0].payload.saved[0]?.filename).toMatch(
      /sticker\.png$/
    );

    // 非 sticker 事件(type 不匹配)不进消息路径
    client.emit("room.event", ROOM, {
      sender: ALICE,
      origin_server_ts: Date.now(),
      event_id: "$enc1",
      type: "m.room.encryption",
      content: { algorithm: "m.megolm.v1.aes-sha2" },
    });
    await flush();
    expect(received).toHaveLength(1);
  });

  it("成员数缺失且查询失败时按 DM 兜底(成员数按 2,不剥离提及)", async () => {
    const { provider, clients } = makeProvider({
      queue: [
        fakeMatrixClient({
          getJoinedRoomMembers: vi.fn(async () => {
            throw new Error("M_LIMIT_EXCEEDED");
          }),
        }),
      ],
    });
    await provider.connect(); // 播种阶段取成员失败 → roomMemberCount 无值
    const client = clients[0];
    const { received, wire } = collectMessages();
    wire(provider);

    client.emit("room.message", ROOM, textEvent(ALICE, "@bot:server 你好"));
    await until(() => received.length === 1);
    expect(received[0].wasMentioned).toBe(false); // 群聊判定为否 → DM 兜底
    expect(received[0].payload.kind === "text" && received[0].payload.text).toBe("@bot:server 你好");
  });

  it("roomOps.leaveRoom 经 onLeftRoom 清除 provider 的房间缓存", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();
    const client = clients[0];
    const { received, wire } = collectMessages();
    wire(provider);

    await provider.roomOps.leaveRoom(ROOM, "pmctl rm");
    expect(client.leaveRoom).toHaveBeenCalledWith(ROOM, "pmctl rm");
    client.emit("room.message", ROOM, textEvent(ALICE, "主动离开后的消息"));
    await flush();
    expect(received).toEqual([]);
  });
});

describe("MatrixProvider 出站", () => {
  beforeEach(() => {
    captureConsole();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sendMessage:markdown 渲染为 HTML,正文原样透传", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();

    await provider.sendMessage(ROOM, "**加粗** 与 `code`");
    const [roomId, content] = clients[0].sendMessage.mock.calls[0];
    expect(roomId).toBe(ROOM);
    expect(content.msgtype).toBe("m.text");
    expect(content.body).toBe("**加粗** 与 `code`");
    expect(content.format).toBe("org.matrix.custom.html");
    expect(content.formatted_body).toContain("<strong>加粗</strong>");
    expect(content.formatted_body).toContain("<code>code</code>");
  });

  it("sendMessage:空白文本不发送", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();

    await provider.sendMessage(ROOM, "   ");
    expect(clients[0].sendMessage).not.toHaveBeenCalled();
  });

  it("sendMessage:未连接抛『not connected』", async () => {
    const { provider } = makeProvider();
    await expect(provider.sendMessage(ROOM, "hi")).rejects.toThrow("Matrix client not connected");
  });

  it("sendTyping:已连接设置打字状态,失败静默;未连接直接忽略", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();
    clients[0].setTyping.mockRejectedValue(new Error("M_LIMIT_EXCEEDED"));
    await expect(provider.sendTyping(ROOM)).resolves.toBeUndefined();
    expect(clients[0].setTyping).toHaveBeenCalledWith(ROOM, true, 10000);

    const offline = makeProvider();
    await expect(offline.provider.sendTyping(ROOM)).resolves.toBeUndefined();
    expect(offline.clients).toHaveLength(0); // 未连接:连工厂都不该被调
  });
});

describe("MatrixProvider.mediaSource", () => {
  beforeEach(() => {
    captureConsole();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("明文路径:经端口 downloadContent 取回字节", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();

    const data = await provider.mediaSource.downloadPlaintext("mxc://s/abc");
    expect(data).toEqual(Buffer.from("BYTES"));
    expect(clients[0].downloadContent).toHaveBeenCalledWith("mxc://s/abc");
  });

  it("加密路径:crypto 在场时经 decryptMedia 解密", async () => {
    const crypto = fakeCrypto();
    const { provider } = makeProvider({ queue: [fakeMatrixClient({ crypto })] });
    await provider.connect();

    const file = { url: "mxc://s/enc", key: { k: "k" }, iv: "iv", hashes: { sha256: "h" } };
    const out = await provider.mediaSource.downloadEncrypted!(file);
    expect(out).toEqual(Buffer.from("DECRYPTED"));
    expect(crypto.decryptMedia).toHaveBeenCalledWith(file);
  });

  it("加密路径:crypto 缺失时抛『原生库不可用』", async () => {
    const { provider } = makeProvider();
    await provider.connect();

    const file = { url: "mxc://s/enc", key: { k: "k" }, iv: "iv", hashes: { sha256: "h" } };
    await expect(provider.mediaSource.downloadEncrypted!(file)).rejects.toThrow("原生库不可用");
  });

  it("encryption:false 不暴露 downloadEncrypted", () => {
    const { provider } = makeProvider({ encryption: false });
    expect(provider.mediaSource.downloadEncrypted).toBeUndefined();
  });
});
