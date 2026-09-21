/**
 * 共享 Matrix 端口假对象(spec #99/#100 票1,接口即测试面):针对
 * src/transports/matrix-client.ts 的 MatrixClientPort 的可编程假客户端。
 *
 * - 记录 on() 注册的处理器(测试经 emit() 谓词触发事件);
 * - 各方法为 vi.fn,默认实现同时把调用按序记入 calls,测试可经
 *   mockResolvedValue / mockRejectedValue 覆写返回值与抛错;
 * - 绝不触碰真实 ~/.pi 路径与网络(测试不使用缺省生产工厂)。
 */
import { vi } from "vitest";
import type { MatrixClientPort } from "../src/transports/matrix-client.js";

export interface FakeCall {
  method: string;
  args: unknown[];
}

/** 假客户端类型:端口方法全部可 mock(.mock.calls / mockResolvedValue…),
 *  外加处理器登记表、调用序列与 emit 触发器。 */
export interface FakeMatrixClient {
  handlers: Map<string, Array<(...args: any[]) => void>>;
  calls: FakeCall[];
  emit(event: string, ...args: any[]): void;
  on: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  getUserId: ReturnType<typeof vi.fn>;
  getJoinedRooms: ReturnType<typeof vi.fn>;
  getJoinedRoomMembers: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  setTyping: ReturnType<typeof vi.fn>;
  downloadContent: ReturnType<typeof vi.fn>;
  createRoom: ReturnType<typeof vi.fn>;
  sendStateEvent: ReturnType<typeof vi.fn>;
  getRoomStateEvent: ReturnType<typeof vi.fn>;
  inviteUser: ReturnType<typeof vi.fn>;
  setUserPowerLevel: ReturnType<typeof vi.fn>;
  setAvatarUrl: ReturnType<typeof vi.fn>;
  getUserProfile: ReturnType<typeof vi.fn>;
  uploadContent: ReturnType<typeof vi.fn>;
  leaveRoom: ReturnType<typeof vi.fn>;
  crypto?: { decryptMedia: ReturnType<typeof vi.fn> };
}

/** 端口 crypto 成员的假解密器(decryptMedia 恒返回 DECRYPTED 字节)。 */
export function fakeCrypto() {
  return { decryptMedia: vi.fn(async (_file: unknown) => Buffer.from("DECRYPTED")) };
}

export function fakeMatrixClient(overrides: Record<string, unknown> = {}): FakeMatrixClient {
  const handlers = new Map<string, Array<(...args: any[]) => void>>();
  const calls: FakeCall[] = [];
  // 默认实现同时记录调用序列;测试用 mockResolvedValue 等覆写后,该方法的
  // 序列记录退位(此时测试直接断言 mock 自身的 calls)。
  const rec = (method: string, impl: (...args: any[]) => unknown) =>
    vi.fn((...args: any[]) => {
      calls.push({ method, args });
      return impl(...args);
    });

  const client: FakeMatrixClient = {
    handlers,
    calls,
    emit(event, ...args) {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    start: rec("start", async () => undefined),
    stop: rec("stop", () => undefined),
    getUserId: rec("getUserId", async () => "@bot:server"),
    getJoinedRooms: rec("getJoinedRooms", async () => ["!room:server"]),
    getJoinedRoomMembers: rec("getJoinedRoomMembers", async () => ["@bot:server", "@alice:server"]),
    sendMessage: rec("sendMessage", async () => "$sent"),
    setTyping: rec("setTyping", async () => undefined),
    downloadContent: rec("downloadContent", async () => ({
      data: Buffer.from("BYTES"),
      contentType: "image/png",
    })),
    createRoom: rec("createRoom", async () => "!created:server"),
    sendStateEvent: rec("sendStateEvent", async () => "$state"),
    getRoomStateEvent: rec("getRoomStateEvent", async () => ({})),
    inviteUser: rec("inviteUser", async () => undefined),
    setUserPowerLevel: rec("setUserPowerLevel", async () => undefined),
    setAvatarUrl: rec("setAvatarUrl", async () => undefined),
    getUserProfile: rec("getUserProfile", async () => ({})),
    uploadContent: rec("uploadContent", async () => "mxc://server/uploaded"),
    leaveRoom: rec("leaveRoom", async () => undefined),
  };
  return Object.assign(client, overrides) as FakeMatrixClient;
}
