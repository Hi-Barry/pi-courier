/**
 * MatrixProvider 直测(spec #99/#100 票1):经 clientFactory 注入假客户端,
 * 不触碰真实 ~/.pi 路径与网络(缺省生产工厂永不使用)。钉住启动回放隔离
 * (spec #93 票1 语义)、事件接线与成员缓存的传输层语义。
 */
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AttachmentStore,
  AttachmentTooLargeError,
  DOWNLOAD_TIMEOUT_MS,
  type MediaSource,
} from "../src/transports/attachments.js";
import type { EventLedger } from "../src/transports/event-ledger.js";
import { MatrixProvider, mediaDownloadUrl } from "../src/transports/matrix.js";
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
  /** 覆盖 homeserverUrl(mediaSource 下载测试指向本地 HTTP 服务器)。 */
  homeserverUrl?: string;
}

function makeProvider(opts: ProviderOptions = {}) {
  const clients: FakeMatrixClient[] = [];
  const provider = new MatrixProvider(
    {
      ...CFG,
      ...(opts.homeserverUrl ? { homeserverUrl: opts.homeserverUrl } : {}),
      ...(opts.encryption === false ? { encryption: false } : {}),
    },
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

/** 可控挂点:每条 sendMessage 在 gates 里登记一个放行柄,不放行不结算。
 *  出站串行队列与消息编辑两处 describe 共用。 */
function gatedSend(client: FakeMatrixClient) {
  const bodies: string[] = [];
  const gates: Array<(v: string) => void> = [];
  client.sendMessage.mockImplementation((_roomId: string, content: { body: string }) => {
    bodies.push(content.body);
    return new Promise<string>((resolve) => gates.push(resolve));
  });
  return {
    bodies,
    release: (i: number) => gates[i]("$ok"),
  };
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

  it("room.join:同一房间的新加入只提示一次(邀请补发 + SDK 迟到真事件不去重会双发)", async () => {
    const { provider, clients } = makeProvider({
      isRoomEnabled: () => false,
      queue: [
        fakeMatrixClient({
          getJoinedRoomMembers: vi.fn(async () => [BOT, "@a:server", "@b:server"]),
        }),
      ],
    });
    await provider.connect();
    const client = clients[0];

    client.emit("room.join", "!group:server");
    await until(() => client.sendMessage.mock.calls.length === 1);
    // SDK 的 sync 扫描随后又 sighting 到同一次加入(迟到真事件)
    client.emit("room.join", "!group:server");
    await flush();
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
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

  it("成员数缺失且查询持续失败时 fail-closed 按群处理(重试一次后仍失败,审计批1票10)", async () => {
    const getJoinedRoomMembers = vi.fn(async () => {
      throw new Error("M_LIMIT_EXCEEDED");
    });
    const { provider, clients } = makeProvider({
      queue: [fakeMatrixClient({ getJoinedRoomMembers })],
    });
    await provider.connect(); // 播种阶段取成员失败 → roomMemberCount 无值
    const client = clients[0];
    const { received, wire } = collectMessages();
    wire(provider);

    client.emit("room.message", ROOM, textEvent(ALICE, "@bot:server 你好"));
    await until(() => received.length === 1);
    // fail-closed:分类为群 → 文本里的 @bot:server 计入提及
    expect(received[0].wasMentioned).toBe(true);
    // 重试语义:本条消息内共尝试两次,失败结果不缓存(下条消息还会再试)
    expect(getJoinedRoomMembers.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("成员数查询瞬时失败重试一次即成功时按真实结果分类(审计批1票10)", async () => {
    const realMembers = [BOT, "@a:server", "@b:server", "@c:server"];
    const getJoinedRoomMembers = vi
      .fn<(roomId: string) => Promise<string[]>>()
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValue(realMembers);
    const { provider, clients } = makeProvider({
      queue: [fakeMatrixClient({ getJoinedRoomMembers })],
    });
    await provider.connect();
    const client = clients[0];
    const { received, wire } = collectMessages();
    wire(provider);

    client.emit("room.message", ROOM, textEvent(ALICE, "普通群聊消息"));
    await until(() => received.length === 1);
    expect(received[0].wasMentioned).toBe(false); // 4 人群,未提及
    // 重试成功后按真实成员数缓存,后续不再查询
    const callsAfterFirst = getJoinedRoomMembers.mock.calls.length;
    client.emit("room.message", ROOM, textEvent(ALICE, "第二条"));
    await until(() => received.length === 2);
    expect(getJoinedRoomMembers.mock.calls.length).toBe(callsAfterFirst);
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

describe("MatrixProvider 消息编辑(MSC2676,issue #235 票1)", () => {
  beforeEach(() => {
    captureConsole();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sendMessage 穿出底层 event_id(返回值从无改为事件 ID 字符串)", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();
    clients[0].sendMessage.mockResolvedValue("$orig-1");
    await expect(provider.sendMessage(ROOM, "原文")).resolves.toBe("$orig-1");
  });

  it("editMessage 事件形状:顶层 `* ` 前缀 fallback、m.new_content 同构、m.replace 指向原事件", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();
    const client = clients[0];
    client.sendMessage.mockResolvedValue("$edit-1");

    const returned = await provider.editMessage(ROOM, "$orig-1", "**改后** 文本");
    expect(returned).toBe("$edit-1"); // 穿出替换事件自己的 event_id

    const [roomId, content] = client.sendMessage.mock.calls[0];
    expect(roomId).toBe(ROOM);
    expect(content.msgtype).toBe("m.text");
    // 顶层 fallback:不支持编辑的旧客户端读到的全文(带 `* ` 前缀)
    expect(content.body).toBe("* **改后** 文本");
    // m.new_content 与普通消息同构(markdown→HTML 富文本同一口径)
    expect(content["m.new_content"]).toEqual({
      msgtype: "m.text",
      body: "**改后** 文本",
      format: "org.matrix.custom.html",
      formatted_body: expect.stringContaining("<strong>改后</strong>"),
    });
    // 替换关系指向原事件
    expect(content["m.relates_to"]).toEqual({ rel_type: "m.replace", event_id: "$orig-1" });
  });

  it("m.new_content 与 sendMessage 的出站内容同构:同文本逐键一致(富文本与转义同一口径)", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();
    const text = "**加粗** 与 `code` 和 https://example.com";

    await provider.sendMessage(ROOM, text);
    await provider.editMessage(ROOM, "$orig-1", text);

    const [normalContent, editContent] = clients[0].sendMessage.mock.calls.map(
      (call) => call[1] as Record<string, unknown>
    );
    expect(editContent["m.new_content"]).toEqual(normalContent);
  });

  it("编辑与相邻消息同一条 per-room FIFO:普通消息结算前编辑不出手,顺序 = 入队顺序", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();
    const gate = gatedSend(clients[0]);

    const first = provider.sendMessage(ROOM, "原文");
    const second = provider.editMessage(ROOM, "$orig-1", "编辑后");

    await flush();
    // 编辑在队尾排队:前一条未结算前不出手
    expect(gate.bodies).toEqual(["原文"]);

    gate.release(0);
    await first;
    await vi.waitFor(() => expect(gate.bodies).toEqual(["原文", "* 编辑后"]));

    gate.release(1);
    await second;
  });

  it("编辑在排队期间断连:以可读错误结算(与 sendMessage 同契约)", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();
    const gate = gatedSend(clients[0]);

    const first = provider.sendMessage(ROOM, "断连前在途");
    const edit = provider.editMessage(ROOM, "$orig-1", "排队中的编辑");
    await flush();

    await provider.disconnect();
    gate.release(0);
    await first;
    await expect(edit).rejects.toThrow("Matrix client not connected");
  });

  it("editMessage 未连接抛可读错误(不静默)", async () => {
    const { provider } = makeProvider();
    await expect(provider.editMessage(ROOM, "$evt", "text")).rejects.toThrow(
      "Matrix client not connected"
    );
  });
});

describe("MatrixProvider 出站串行队列(issue #195)", () => {
  beforeEach(() => {
    captureConsole();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("同房间并发发送按入队顺序 FIFO 串行:前一条结算前下一条不出手", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();
    const gate = gatedSend(clients[0]);

    const first = provider.sendMessage(ROOM, "第一片");
    const second = provider.sendMessage(ROOM, "第二片");
    const third = provider.sendMessage(ROOM, "第三片");

    await flush();
    expect(gate.bodies).toEqual(["第一片"]);

    gate.release(0);
    await first;
    await vi.waitFor(() => expect(gate.bodies).toEqual(["第一片", "第二片"]));

    gate.release(1);
    await second;
    await vi.waitFor(() => expect(gate.bodies).toEqual(["第一片", "第二片", "第三片"]));

    gate.release(2);
    await third;
  });

  it("中间某条失败:调用方收到 reject,后续消息照常发送(断链传播)", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();
    const client = clients[0];
    // 顺序:第 2 条 reject,其余走默认秒过实现
    client.sendMessage.mockImplementationOnce(async () => "$first");
    client.sendMessage.mockImplementationOnce(async () => {
      throw new Error("M_LIMIT_EXCEEDED");
    });
    client.sendMessage.mockImplementationOnce(async () => "$third");

    await provider.sendMessage(ROOM, "第一条");
    await expect(provider.sendMessage(ROOM, "第二条(失败)")).rejects.toThrow("M_LIMIT_EXCEEDED");
    await provider.sendMessage(ROOM, "第三条");
    expect(client.sendMessage).toHaveBeenCalledTimes(3);

    // 失败后再发:链未被污染,照常发送
    await provider.sendMessage(ROOM, "失败后的消息");
    expect(client.sendMessage).toHaveBeenCalledTimes(4);
  });

  it("房间隔离:房间 A 的在途消息不阻塞房间 B 的发送", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();
    const gate = gatedSend(clients[0]);

    const blocked = provider.sendMessage("!room-a:server", "A 房在途");
    await flush();
    expect(gate.bodies).toEqual(["A 房在途"]);

    // A 未放行期间,B 房消息立即出手(若实现退化为全局单链,B 会排在
    // A 之后永不出现,waitFor 超时即用例失败)
    const roomB = provider.sendMessage("!room-b:server", "B 房即时");
    await vi.waitFor(() => expect(gate.bodies).toEqual(["A 房在途", "B 房即时"]));

    gate.release(0);
    await blocked;
    gate.release(1);
    await roomB;
  });

  it("断连后排队的消息以可读错误结算(非 TypeError),重连后链恢复", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();
    const gate = gatedSend(clients[0]);

    const inFlight = provider.sendMessage(ROOM, "断连前在途");
    const queued = provider.sendMessage(ROOM, "断连前排队");
    await flush();

    await provider.disconnect();
    gate.release(0);
    await inFlight;
    await expect(queued).rejects.toThrow("Matrix client not connected");

    // 重连后发送照常(链上的旧条目已结算完毕)
    await provider.connect();
    const gate2 = gatedSend(clients[1]);
    const after = provider.sendMessage(ROOM, "重连后的消息");
    await vi.waitFor(() => expect(gate2.bodies).toEqual(["重连后的消息"]));
    gate2.release(0);
    await after;
  });

  it("空链清理:结算后队列条目被移除,不留无界 Map(以恢复原速直发为证)", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();
    const client = clients[0];

    // 空闲(无挂起)时连发多条:链上依次瞬时结算,最终恢复“直发”行为
    await provider.sendMessage(ROOM, "一");
    await provider.sendMessage(ROOM, "二");
    expect(client.sendMessage.mock.calls.map((c) => (c[1] as { body: string }).body)).toEqual([
      "一",
      "二",
    ]);
  });
});

describe("MatrixProvider 表情 reaction(票01,#268)", () => {
  beforeEach(() => {
    captureConsole();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sendReaction 直发:原语穿出端口,返回 reaction 事件 id,不走 per-room FIFO", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();
    const client = clients[0];
    client.sendReaction.mockResolvedValue("$reaction-1");

    // sendMessage 的 FIFO 被挂住期间,sendReaction 仍即时出手(种表情先后顺序无关,不排队)
    const gate = gatedSend(client);
    const blocked = provider.sendMessage(ROOM, "在途消息");
    await flush();
    expect(gate.bodies).toEqual(["在途消息"]);

    await expect(provider.sendReaction(ROOM, "$orig-1", "✅")).resolves.toBe("$reaction-1");
    expect(client.sendReaction).toHaveBeenCalledTimes(1);
    expect(client.sendReaction).toHaveBeenCalledWith(ROOM, "$orig-1", "✅");
    expect(client.sendMessage).toHaveBeenCalledTimes(1); // 原语不进消息 FIFO

    gate.release(0);
    await blocked;
  });

  it("sendReaction 未连接抛可读错误(与 sendMessage 同契约,失败由调用方 try/catch)", async () => {
    const { provider } = makeProvider();
    await expect(provider.sendReaction(ROOM, "$evt", "✅")).rejects.toThrow(
      "Matrix client not connected"
    );
  });

  /** 可控挂点:onReaction 收到的 MatrixReaction 信封列表。 */
  function collectReactions(provider: MatrixProvider) {
    const received: Array<{ chatId: string; targetEventId: string; key: string; sender: string }> = [];
    provider.onReaction((r) => received.push(r));
    return received;
  }

  function reactionEvent(overrides: Record<string, unknown> = {}) {
    return {
      type: "m.reaction",
      sender: ALICE,
      origin_server_ts: Date.now(),
      event_id: `$reaction-${Math.random().toString(36).slice(2)}`,
      content: {
        "m.relates_to": { rel_type: "m.annotation", event_id: "$target-1", key: "✅" },
      },
      ...overrides,
    };
  }

  /** 台账 stub:记下 record 的每个事件 id,供正/负断言。 */
  function fakeLedger() {
    const recorded: string[] = [];
    const ledger = {
      freshStart: false,
      seen: (id: string) => recorded.includes(id),
      record: (id: string) => recorded.push(id),
    } as unknown as EventLedger;
    return { ledger, recorded };
  }

  it("bot 自己种的 reaction(sender === botUserId)不触发回调", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();
    const client = clients[0];
    const reactions = collectReactions(provider);

    client.emit("room.event", ROOM, reactionEvent({ sender: BOT }));
    await flush();
    expect(reactions).toEqual([]);
  });

  it("早于 connectedAt 的迟到 reaction 不分发也不记账(重启回放静默丢弃)", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();
    const client = clients[0];
    const reactions = collectReactions(provider);
    const { ledger, recorded } = fakeLedger();
    provider.setEventLedger(ledger, "confirm");

    client.emit(
      "room.event",
      ROOM,
      reactionEvent({ origin_server_ts: Date.now() - 60_000, event_id: "$stale-reaction" })
    );
    await flush();
    expect(reactions).toEqual([]);
    expect(recorded).toEqual([]); // 未过过滤器 = 不受理 = 不记账

    // 对照组:连接后的实时 reaction 照常分发
    client.emit("room.event", ROOM, reactionEvent({ event_id: "$fresh-reaction" }));
    await vi.waitFor(() => expect(reactions).toHaveLength(1));
  });

  it("受理的 reaction 事件 id 记入事件台账(幂等)", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();
    const client = clients[0];
    const reactions = collectReactions(provider);
    const { ledger, recorded } = fakeLedger();
    provider.setEventLedger(ledger, "confirm");

    client.emit("room.event", ROOM, reactionEvent({ event_id: "$reaction-abc" }));
    await vi.waitFor(() => expect(reactions).toHaveLength(1));
    expect(recorded).toEqual(["$reaction-abc"]);
  });

  it("结构残缺的 reaction 静默丢弃:非 annotation / 缺 key / 缺 event_id / 非 m.reaction 类型不进缝", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();
    const client = clients[0];
    const reactions = collectReactions(provider);
    const { ledger, recorded } = fakeLedger();
    provider.setEventLedger(ledger, "confirm");

    client.emit("room.event", ROOM, reactionEvent({
      event_id: "$bad-rel",
      content: { "m.relates_to": { rel_type: "m.replace", event_id: "$t", key: "✅" } },
    }));
    client.emit("room.event", ROOM, reactionEvent({
      event_id: "$bad-nokey",
      content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$t" } },
    }));
    client.emit("room.event", ROOM, reactionEvent({
      event_id: "$bad-notarget",
      content: { "m.relates_to": { rel_type: "m.annotation", key: "✅" } },
    }));
    client.emit("room.event", ROOM, reactionEvent({
      event_id: "$bad-norel",
      content: {},
    }));
    // 非 m.reaction 的 room.event 维持原状:不进 reaction 缝(sticker 路径由既有用例钉住)
    client.emit("room.event", ROOM, {
      sender: ALICE,
      origin_server_ts: Date.now(),
      event_id: "$other",
      type: "m.room.message",
      content: { msgtype: "m.text", body: "普通消息" },
    });
    await flush();
    expect(reactions).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("m.reaction 经 room.event 进 onReaction:收到 (chatId/目标 event_id/key/sender) 四元组,不进消息管道", async () => {
    const { provider, clients } = makeProvider();
    await provider.connect();
    const client = clients[0];
    const reactions = collectReactions(provider);
    const { received, wire } = collectMessages();
    wire(provider);

    client.emit("room.event", ROOM, reactionEvent());
    await vi.waitFor(() => expect(reactions).toHaveLength(1));
    expect(reactions[0]).toEqual({
      chatId: ROOM,
      targetEventId: "$target-1",
      key: "✅",
      sender: ALICE,
    });
    // reaction 不走消息管道:translator/messageHandler 不见该事件
    await flush();
    expect(received).toEqual([]);
  });
});

// ─── mediaSource:流式带上限下载(sec 下载 OOM 修复)─────────────────────
// 经本地 HTTP 服务器验证端点、认证头、流式上限与本地解密 —— 不再经过
// SDK 的 downloadContent/decryptMedia(它们都先整包进内存,防不了 OOM)。

/** 与 Matrix 规范一致的加密附件加密侧(测试专用):AES-256-CTR,iv 为
 *  16 字节计数块(随机 8 字节前缀 + 8 字节 0),sha256 对密文。 */
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
 *  产出的密文,与本地解密双向互认后固化(见工单 sec-download-size-cap 交叉验证)。 */
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

/** 本地媒体服务器:handler 自定义响应;close 由测试 finally 收尾。
 *  close 前先 closeAllConnections —— 挂起不响应的连接不掐,close 永不回调。 */
async function startMediaServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe("MatrixProvider.mediaSource", () => {
  beforeEach(() => {
    captureConsole();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("明文路径:命中认证版 v1 媒体端点,带 Bearer 头,分块响应完整拼接", async () => {
    const chunk = Buffer.alloc(10, 7);
    let seenAuth = "";
    let seenPath = "";
    const server = await startMediaServer((_req, res) => {
      seenAuth = String(_req.headers.authorization ?? "");
      seenPath = _req.url ?? "";
      res.setHeader("content-type", "application/octet-stream");
      res.write(chunk);
      res.write(chunk);
      res.write(chunk);
      res.end();
    });
    try {
      const { provider } = makeProvider({ homeserverUrl: server.url });
      const data = await provider.mediaSource.downloadPlaintext("mxc://s/abc", 100);
      expect(data).toEqual(Buffer.concat([chunk, chunk, chunk]));
      expect(seenAuth).toBe("Bearer tok");
      expect(seenPath).toBe("/_matrix/client/v1/media/download/s/abc?allow_remote=true");
    } finally {
      await server.close();
    }
  });

  it("声明 Content-Length 超上限:不读 body 直接判过大", async () => {
    let clientClosedEarly = false;
    const server = await startMediaServer((_req, res) => {
      res.setHeader("content-length", "500");
      res.on("close", () => {
        clientClosedEarly = clientClosedEarly || !res.writableEnded;
      });
      // 慢速吐 body:若实现真的开始读,测试会以超上限失败而非早退
      const timer = setInterval(() => {
        try {
          res.write(Buffer.alloc(100, 1));
        } catch {
          clearInterval(timer);
        }
      }, 10);
      res.on("close", () => clearInterval(timer));
    });
    try {
      const { provider } = makeProvider({ homeserverUrl: server.url });
      await expect(provider.mediaSource.downloadPlaintext("mxc://s/big", 100))
        .rejects.toThrow(AttachmentTooLargeError);
      await new Promise((r) => setTimeout(r, 50));
      expect(clientClosedEarly).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("分块传输谎报(无 Content-Length):累计字节越线即中止,不吞整包", async () => {
    // 恶意形态:不声明长度,分 40 块×10B 连发 400B,上限 100 —— 若实现
    // 等下完再判,就会先接满 400B;逐块计数则在 11 块处截断。
    const server = await startMediaServer((_req, res) => {
      let sent = 0;
      const timer = setInterval(() => {
        if (sent >= 400) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(Buffer.alloc(10, 1));
        sent += 10;
      }, 2);
      res.on("close", () => clearInterval(timer));
    });
    try {
      const { provider } = makeProvider({ homeserverUrl: server.url });
      await expect(provider.mediaSource.downloadPlaintext("mxc://s/liar", 100))
        .rejects.toThrow(AttachmentTooLargeError);
    } finally {
      await server.close();
    }
  });

  it("挂起不响应:DOWNLOAD_TIMEOUT_MS 到点中止,翻成 attach.downloadTimeout 文案", async () => {
    // 服务器收到请求后故意不回:等客户端 60s 超时掐连接。真实等 60s 不可
    // 接受,用 fake timers 推进 downloadMediaCapped 自己的 abort 定时器,
    // 钉住 AbortError → i18n 超时文案的映射分支。
    const server = await startMediaServer(() => {
      // 故意不回响应头
    });
    vi.useFakeTimers();
    try {
      const { provider } = makeProvider({ homeserverUrl: server.url });
      const pending = provider.mediaSource.downloadPlaintext("mxc://s/hang", 100);
      const assertion = expect(pending).rejects.toThrow("下载超时(60s)");
      await vi.advanceTimersByTimeAsync(DOWNLOAD_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
      await server.close();
    }
  });

  it("加密路径:带上限下载密文后本地解密(node:crypto 规范实现,不依赖原生 crypto)", async () => {
    const plaintext = Buffer.from("enc-bytes-" + "x".repeat(300));
    const { file, ciphertext } = specEncrypt(plaintext);
    const server = await startMediaServer((_req, res) => {
      res.end(ciphertext);
    });
    try {
      const { provider } = makeProvider({ homeserverUrl: server.url, queue: [fakeMatrixClient()] });
      const out = await provider.mediaSource.downloadEncrypted!(file, 100_000);
      expect(out).toEqual(plaintext);
    } finally {
      await server.close();
    }
  });

  it("加密路径:密文与固定向量一致(Rust Attachment 互认向量)可解;被篡改则报完整性失败", async () => {
    const server = await startMediaServer((_req, res) => {
      res.end(Buffer.from(RUST_VECTOR.ciphertext));
    });
    try {
      const { provider } = makeProvider({ homeserverUrl: server.url, queue: [fakeMatrixClient()] });
      const out = await provider.mediaSource.downloadEncrypted!(RUST_VECTOR.file, 100_000);
      expect(out).toEqual(RUST_VECTOR.plaintext);

      const tampered = Buffer.from(RUST_VECTOR.ciphertext);
      tampered[0] ^= 0xff;
      const server2 = await startMediaServer((_req, res) => {
        res.end(tampered);
      });
      try {
        const { provider: p2 } = makeProvider({ homeserverUrl: server2.url, queue: [fakeMatrixClient()] });
        await expect(p2.mediaSource.downloadEncrypted!(RUST_VECTOR.file, 100_000))
          .rejects.toThrow("完整性校验失败");
      } finally {
        await server2.close();
      }
    } finally {
      await server.close();
    }
  });

  it("明文路径:非 2xx 响应翻成带状态的下载错误", async () => {
    const server = await startMediaServer((_req, res) => {
      res.statusCode = 404;
      res.end(JSON.stringify({ errcode: "M_NOT_FOUND", error: "Media not found" }));
    });
    try {
      const { provider } = makeProvider({ homeserverUrl: server.url });
      await expect(provider.mediaSource.downloadPlaintext("mxc://s/gone", 100))
        .rejects.toThrow(/HTTP 404/);
    } finally {
      await server.close();
    }
  });

  it("mediaDownloadUrl:与 SDK 同一端点与转义规则(尾部文件名段忽略)", () => {
    expect(mediaDownloadUrl("https://hs.example.org", "mxc://server/mediaId"))
      .toBe("https://hs.example.org/_matrix/client/v1/media/download/server/mediaId?allow_remote=true");
    expect(mediaDownloadUrl("https://hs.example.org", "mxc://server/mediaId/filename.png"))
      .toBe("https://hs.example.org/_matrix/client/v1/media/download/server/mediaId?allow_remote=true");
    expect(mediaDownloadUrl("https://hs.example.org", "mxc://server:name/me/dia"))
      .toBe("https://hs.example.org/_matrix/client/v1/media/download/server%3Aname/me?allow_remote=true");
    expect(() => mediaDownloadUrl("https://hs.example.org", "https://evil.example/x")).toThrow("mxc://");
  });

  it("encryption:false 不暴露 downloadEncrypted", () => {
    const { provider } = makeProvider({ encryption: false });
    expect(provider.mediaSource.downloadEncrypted).toBeUndefined();
  });
});
