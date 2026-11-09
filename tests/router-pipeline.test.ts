/**
 * Pipeline stage table (spec #72 票3/C1): the stage list itself is the test
 * surface — order, preAuth flags, ledger consumption and rpc laziness are
 * pinned here so future stages can't silently break the invariants.
 */
import { describe, expect, it, vi } from "vitest";
import type { PiRpc } from "../src/rpc/pi-rpc";
import { makeMsg, makeRouterFixture } from "./helpers";

function makeFixtures() {
  const replies: string[] = [];
  const prompt = vi.fn().mockResolvedValue(undefined);
  const rpc = { prompt, label: undefined, onEvent: vi.fn() } as unknown as PiRpc;
  const { router, projectManager } = makeRouterFixture({
    rpc,
    sendReply: async (_chatId: string, _transport: string, text: string) => {
      replies.push(text);
    },
  });
  return { router, prompt, replies, getRpcForRoom: projectManager.getRpcForRoom as ReturnType<typeof vi.fn> };
}

describe("pipeline stage table (spec #72 票3/C1)", () => {
  it("declares the stages in execution order with their invariants", () => {
    const { router } = makeFixtures();
    expect(router.pipeline().map((s) => s.name)).toEqual([
      // 票02(spec #299):botFilter 置顶(对端 bot 不触发、不进命令解析,
      // 在挑战流之前),unknownRoomGate 紧随 authorization(陌生群不接活,
      // 在附件分流之前)。
      "botFilter",
      "authorization",
      "unknownRoomGate",
      "attachments",
      "adminCommands",
      "groupEnable",
      // 票06(spec #299):项目房内 /toggletools 房间级覆盖(全局开关仍在 adminCommands)。
      "roomToolsToggle",
      "authorizationGate",
      "backlogAnswer",
      "backlogInbox",
      // 票05(spec #299):guest 房仅 @触发 + 增量信箱(积压征询之后、其余管线之前)。
      "guestTrigger",
      "multiproject",
      "managementAdoption",
      "roomBinding",
      "pmctl",
      "login",
      "slashCommands",
      "bashBang",
      "loginCapture",
      "extensionCapture",
      "prompt",
    ]);
  });

  it("preAuth stages are exactly the self-gated stages (command families + bot filter)", () => {
    const { router } = makeFixtures();
    expect(router.pipeline().filter((s) => s.preAuth).map((s) => s.name)).toEqual([
      "botFilter",
      "adminCommands",
      "groupEnable",
      // 票06(spec #299):项目房内的房间级工具流开关,自带门禁(admin+项目房)。
      "roomToolsToggle",
    ]);
  });

  it("the pending-attachment ledger has exactly ONE consumption point: prompt", () => {
    const { router } = makeFixtures();
    expect(router.pipeline().filter((s) => s.consumesLedger).map((s) => s.name)).toEqual(["prompt"]);
  });

  it("stages needing the room's pi process are exactly the rpc-bound tail", () => {
    const { router } = makeFixtures();
    expect(router.pipeline().filter((s) => s.needsRpc).map((s) => s.name)).toEqual([
      "roomBinding",
      "slashCommands",
      "bashBang",
      "extensionCapture",
      "prompt",
    ]);
  });
});

describe("rpc laziness invariant (spec #72 票3/C1)", () => {
  it("an in-room management command does NOT start a pi process for the room", async () => {
    const { router, getRpcForRoom } = makeFixtures();
    await router.handleIncoming(makeMsg({ text: "/multiproject" }));
    expect(getRpcForRoom).not.toHaveBeenCalled();
  });

  it("a conversational message does resolve the room's process (prompt needs it)", async () => {
    const { router, getRpcForRoom, prompt } = makeFixtures();
    await router.handleIncoming(makeMsg({ text: "聊一句" }));
    expect(getRpcForRoom).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("attachments park before any command parsing — even '/'-named files", async () => {
    const { router, prompt, replies } = makeFixtures();
    await router.handleIncoming(makeMsg({
      messageId: "m1",
      payload: {
        kind: "media",
        saved: [{ path: "/attachments/x//login-lookalike.png", filename: "login-lookalike.png", bytes: 12 }],
      },
    }));
    expect(replies.join("\n")).toContain("已保存");
    await router.handleIncoming(makeMsg({ messageId: "m2", text: "看这张" }));
    expect((prompt.mock.calls[0]![0] as string)).toContain("login-lookalike.png");
  });
});
