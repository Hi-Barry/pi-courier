/**
 * MatrixRoomOps 直测(spec #99/#100 票1):经 deps 注入端口假客户端,核对各
 * 操作的参数编排与查询成员契约(404 / M_NOT_FOUND → null,非 404 照抛,
 * 未连接抛『Matrix 未连接』)。MatrixError 用 SDK 类真实构造,不放松判定。
 */
import { MatrixError } from "matrix-bot-sdk";
import { describe, expect, it, vi } from "vitest";
import type { MatrixClientPort } from "../src/transports/matrix-client.js";
import { MatrixRoomOps } from "../src/transports/matrix-rooms.js";
import { logger } from "../src/logger.js";
import { fakeMatrixClient, type FakeMatrixClient } from "./matrix-fakes.js";
import { captureConsole } from "./helpers.js";

function makeOps(opts: { botUserId?: string | null; connected?: boolean } = {}) {
  const client = fakeMatrixClient();
  const onLeftRoom = vi.fn();
  const ops = new MatrixRoomOps({
    getClient: () => (opts.connected === false ? undefined : (client as unknown as MatrixClientPort)),
    // 未连接时 provider 的 botUserId 也为 undefined——与真实接线一致;
    // botUserId 显式传 null 表示「缺 bot 身份」(经 ?? 会回退,需单独区分)
    getBotUserId: () =>
      opts.connected === false || opts.botUserId === null ? undefined : (opts.botUserId ?? "@bot:server"),
    onLeftRoom,
  });
  return { ops, client, onLeftRoom };
}

const notFound = () => new MatrixError({ errcode: "M_NOT_FOUND", error: "Event not found." }, 404);
const forbidden = () => new MatrixError({ errcode: "M_FORBIDDEN", error: "You don't have permission." }, 403);

describe("MatrixRoomOps 参数编排", () => {
  it("createRoom:private_chat preset;encrypted 时带 m.room.encryption initial_state", async () => {
    const { ops, client } = makeOps();
    const roomId = await ops.createRoom({ name: "myapp", inviteUserIds: ["@u:server"], encrypted: true });

    expect(roomId).toBe("!created:server");
    expect(client.createRoom).toHaveBeenCalledWith({
      name: "myapp",
      invite: ["@u:server"],
      preset: "private_chat",
      initial_state: [
        { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
      ],
    });
  });

  it("createRoom:未加密时不带 initial_state", async () => {
    const { ops, client } = makeOps();
    await ops.createRoom({ name: "plain", inviteUserIds: [] });

    const arg = client.createRoom.mock.calls[0][0];
    expect(arg.preset).toBe("private_chat");
    expect(arg.initial_state).toBeUndefined();
  });

  it("createProjectRoom:一般建房原语 + 单一邀请人", async () => {
    const { ops, client } = makeOps();
    await ops.createProjectRoom("myapp", "@u:server");

    expect(client.createRoom).toHaveBeenCalledWith({
      name: "myapp",
      invite: ["@u:server"],
      preset: "private_chat",
    });
  });

  it("createSpace:m.space 创建内容 + private visibility", async () => {
    const { ops, client } = makeOps();
    await ops.createSpace({ name: "space", inviteUserIds: ["@u:server"] });

    expect(client.createRoom).toHaveBeenCalledWith({
      name: "space",
      invite: ["@u:server"],
      preset: "private_chat",
      visibility: "private",
      creation_content: { type: "m.space" },
    });
  });

  it("addRoomToSpace:via 取自 bot 服务器名,先 m.space.child 再 m.room.parent", async () => {
    const { ops, client } = makeOps({ botUserId: "@bot:example.org" });
    await ops.addRoomToSpace("!space:s", "!child:s");

    expect(client.sendStateEvent).toHaveBeenNthCalledWith(
      1,
      "!space:s",
      "m.space.child",
      "!child:s",
      { via: ["example.org"] }
    );
    expect(client.sendStateEvent).toHaveBeenNthCalledWith(
      2,
      "!child:s",
      "m.room.parent",
      "!space:s",
      { via: ["example.org"], canonical: true }
    );
  });

  it("addRoomToSpace:m.room.parent 失败被吞(best-effort),m.space.child 照发", async () => {
    const { ops, client } = makeOps();
    client.sendStateEvent.mockImplementation(async (_roomId: string, type: string) => {
      if (type === "m.room.parent") throw new Error("M_FORBIDDEN");
    });

    await expect(ops.addRoomToSpace("!space:s", "!child:s")).resolves.toBeUndefined();
    expect(client.sendStateEvent).toHaveBeenCalledTimes(2);
  });

  it("addRoomToSpace:botUserId 缺失时 via 为空数组", async () => {
    const { ops, client } = makeOps({ botUserId: null });
    await ops.addRoomToSpace("!space:s", "!child:s");

    expect(client.sendStateEvent).toHaveBeenNthCalledWith(1, "!space:s", "m.space.child", "!child:s", {
      via: [],
    });
  });

  it("removeRoomFromSpace:清空 m.space.child 与 m.room.parent 的 content", async () => {
    const { ops, client } = makeOps();
    await ops.removeRoomFromSpace("!space:s", "!child:s");

    expect(client.sendStateEvent).toHaveBeenNthCalledWith(1, "!space:s", "m.space.child", "!child:s", {});
    expect(client.sendStateEvent).toHaveBeenNthCalledWith(2, "!child:s", "m.room.parent", "!space:s", {});
  });

  it("removeRoomFromSpace:child 侧 m.room.parent 失败被吞(best-effort)", async () => {
    const { ops, client } = makeOps();
    client.sendStateEvent.mockImplementation(async (_roomId: string, type: string) => {
      if (type === "m.room.parent") throw new Error("M_FORBIDDEN");
    });

    await expect(ops.removeRoomFromSpace("!space:s", "!child:s")).resolves.toBeUndefined();
    expect(client.sendStateEvent).toHaveBeenCalledTimes(2);
  });

  it("inviteUser / setRoomName / setRoomAvatar / setProfileAvatar / setUserPowerLevel / uploadMedia 参数编排", async () => {
    const { ops, client } = makeOps();

    await ops.inviteUser("!r:s", "@u:s");
    expect(client.inviteUser).toHaveBeenCalledWith("@u:s", "!r:s");

    await ops.setRoomName("!r:s", "新名字");
    expect(client.sendStateEvent).toHaveBeenCalledWith("!r:s", "m.room.name", "", { name: "新名字" });

    await ops.setRoomAvatar("!r:s", "mxc://s/av", { w: 10 });
    expect(client.sendStateEvent).toHaveBeenCalledWith("!r:s", "m.room.avatar", "", {
      url: "mxc://s/av",
      info: { w: 10 },
    });

    await ops.setRoomAvatar("!r:s", "mxc://s/av2");
    expect(client.sendStateEvent).toHaveBeenCalledWith("!r:s", "m.room.avatar", "", { url: "mxc://s/av2" });

    await ops.setProfileAvatar("mxc://s/me");
    expect(client.setAvatarUrl).toHaveBeenCalledWith("mxc://s/me");

    await ops.setUserPowerLevel("!r:s", "@u:s", 50);
    expect(client.setUserPowerLevel).toHaveBeenCalledWith("@u:s", "!r:s", 50);

    const png = Buffer.from("PNG");
    await ops.uploadMedia(png, "image/png");
    expect(client.uploadContent).toHaveBeenCalledWith(png, "image/png");
  });

  it("leaveRoom:转发 reason 并触发 onLeftRoom 清缓存", async () => {
    const { ops, client, onLeftRoom } = makeOps();
    await ops.leaveRoom("!r:s", "pmctl rm");

    expect(client.leaveRoom).toHaveBeenCalledWith("!r:s", "pmctl rm");
    expect(onLeftRoom).toHaveBeenCalledWith("!r:s");
  });
});

describe("MatrixRoomOps 查询成员契约", () => {
  it("getRoomName:404/M_NOT_FOUND → null;有值返回 name", async () => {
    const { ops, client } = makeOps();

    client.getRoomStateEvent.mockRejectedValue(notFound());
    expect(await ops.getRoomName("!r:s")).toBeNull();

    client.getRoomStateEvent.mockResolvedValue({ name: "项目房" });
    expect(await ops.getRoomName("!r:s")).toBe("项目房");

    client.getRoomStateEvent.mockResolvedValue({});
    expect(await ops.getRoomName("!r:s")).toBeNull();
  });

  it("getRoomAvatar:404/M_NOT_FOUND → null;有值返回 url", async () => {
    const { ops, client } = makeOps();

    client.getRoomStateEvent.mockRejectedValue(notFound());
    expect(await ops.getRoomAvatar("!r:s")).toBeNull();

    client.getRoomStateEvent.mockResolvedValue({ url: "mxc://s/avatar" });
    expect(await ops.getRoomAvatar("!r:s")).toBe("mxc://s/avatar");
  });

  it("getPowerLevels:404/M_NOT_FOUND → null;有值原样返回", async () => {
    const { ops, client } = makeOps();

    client.getRoomStateEvent.mockRejectedValue(notFound());
    expect(await ops.getPowerLevels("!r:s")).toBeNull();

    const levels = { users: { "@owner:s": 100 } };
    client.getRoomStateEvent.mockResolvedValue(levels);
    expect(await ops.getPowerLevels("!r:s")).toBe(levels);
  });

  it("getProfileAvatarUrl:profile 404 → null;无 avatar_url → null;有值返回", async () => {
    const { ops, client } = makeOps();

    client.getUserProfile.mockRejectedValue(notFound());
    expect(await ops.getProfileAvatarUrl()).toBeNull();

    client.getUserProfile.mockResolvedValue({ displayname: "bot" });
    expect(await ops.getProfileAvatarUrl()).toBeNull();

    client.getUserProfile.mockResolvedValue({ avatar_url: "mxc://s/me" });
    expect(await ops.getProfileAvatarUrl()).toBe("mxc://s/me");
  });

  it("M_NOT_FOUND 即使 statusCode 非 404 也视为查询答案(契约的另一半)", async () => {
    const { ops, client } = makeOps();
    client.getRoomStateEvent.mockRejectedValue(
      new MatrixError({ errcode: "M_NOT_FOUND", error: "stale token" }, 500)
    );
    expect(await ops.getRoomName("!r:s")).toBeNull();
    expect(await ops.getPowerLevels("!r:s")).toBeNull();
  });

  it("非 404 错误照抛(getRoomName / getRoomAvatar / getPowerLevels / getProfileAvatarUrl)", async () => {
    const { ops, client } = makeOps();
    client.getRoomStateEvent.mockRejectedValue(forbidden());
    client.getUserProfile.mockRejectedValue(forbidden());

    await expect(ops.getRoomName("!r:s")).rejects.toThrow(MatrixError);
    await expect(ops.getRoomAvatar("!r:s")).rejects.toThrow(MatrixError);
    await expect(ops.getPowerLevels("!r:s")).rejects.toThrow(MatrixError);
    await expect(ops.getProfileAvatarUrl()).rejects.toThrow(MatrixError);
  });

  it("getProfileAvatarUrl 经 getUserId 取自己的 user ID", async () => {
    const { ops, client } = makeOps();
    client.getUserProfile.mockResolvedValue({ avatar_url: "mxc://s/me" });
    await ops.getProfileAvatarUrl();

    expect(client.getUserId).toHaveBeenCalled();
    expect(client.getUserProfile).toHaveBeenCalledWith("@bot:server");
  });
});

describe("MatrixRoomOps 未连接", () => {
  it("操作抛『Matrix 未连接』", async () => {
    const { ops, client } = makeOps({ connected: false });

    await expect(ops.createRoom({ name: "x", inviteUserIds: [] })).rejects.toThrow("Matrix 未连接");
    await expect(ops.createSpace({ name: "x", inviteUserIds: [] })).rejects.toThrow("Matrix 未连接");
    await expect(ops.addRoomToSpace("!s:s", "!c:s")).rejects.toThrow("Matrix 未连接");
    await expect(ops.inviteUser("!r:s", "@u:s")).rejects.toThrow("Matrix 未连接");
    await expect(ops.setRoomName("!r:s", "n")).rejects.toThrow("Matrix 未连接");
    await expect(ops.setUserPowerLevel("!r:s", "@u:s", 50)).rejects.toThrow("Matrix 未连接");
    await expect(ops.uploadMedia(Buffer.from("x"), "text/plain")).rejects.toThrow("Matrix 未连接");
    await expect(ops.leaveRoom("!r:s")).rejects.toThrow("Matrix 未连接");
    expect(client.createRoom).not.toHaveBeenCalled();
  });

  it("查询成员报告 null / false 而不抛", () => {
    const { ops } = makeOps({ connected: false });
    expect(ops.getBotUserId()).toBeNull();
    expect(ops.encryptionAvailable).toBe(false);
  });
});

describe("MatrixRoomOps 预期 miss 静默(适配器边界,spec #99 #105)", () => {
  // SDK 在请求失败时先同步打 ERROR 再 reject(lib/http.js:MatrixHttpClient);
  // 假客户端在这里复刻同一条链——经共享 logger 门面打出 SDK 形状的错误行,
  // 再抛 MatrixError——让「静音」成为可观察行为断言而不是实现细节。
  const sdkErrorLine = (body: string) =>
    logger.error("[matrix-sdk:MatrixHttpClient]", `(REQ-1) ${body}`);

  it("404 miss → null 且 SDK 的 ERROR 行不落线;窗口只盖这次调用", async () => {
    const lines = captureConsole();
    const { ops, client } = makeOps();
    client.getRoomStateEvent.mockImplementation(async () => {
      sdkErrorLine('{"errcode":"M_NOT_FOUND","error":"Event not found."}');
      throw notFound();
    });

    await expect(ops.getRoomName("!r:s")).resolves.toBeNull();
    expect(lines.join("\n")).not.toContain("M_NOT_FOUND");

    // 窗口已关:同模式的后续错误照常可见(真错误不被殃及)。
    sdkErrorLine('{"errcode":"M_NOT_FOUND","error":"later real noise"}');
    expect(lines.join("\n")).toContain("later real noise");
  });

  it("getRoomAvatar / getPowerLevels / getProfileAvatarUrl 的 404 miss 同样安静", async () => {
    const lines = captureConsole();
    const { ops, client } = makeOps();
    client.getRoomStateEvent.mockImplementation(async () => {
      sdkErrorLine('{"errcode":"M_NOT_FOUND","error":"Event not found."}');
      throw notFound();
    });
    client.getUserProfile.mockImplementation(async () => {
      sdkErrorLine('{"errcode":"M_NOT_FOUND","error":"Profile not found."}');
      throw notFound();
    });

    await expect(ops.getRoomAvatar("!r:s")).resolves.toBeNull();
    await expect(ops.getPowerLevels("!r:s")).resolves.toBeNull();
    await expect(ops.getProfileAvatarUrl()).resolves.toBeNull();
    expect(lines.join("\n")).not.toContain("M_NOT_FOUND");
  });

  it("非 404 照抛且其 ERROR 行不被静音(真错误必须可见)", async () => {
    const lines = captureConsole();
    const { ops, client } = makeOps();
    client.getRoomStateEvent.mockImplementation(async () => {
      sdkErrorLine('{"errcode":"M_FORBIDDEN","error":"You don' + "'t have permission." + '"}');
      throw forbidden();
    });

    await expect(ops.getRoomName("!r:s")).rejects.toThrow(MatrixError);
    expect(lines.join("\n")).toContain("M_FORBIDDEN");
  });
});
