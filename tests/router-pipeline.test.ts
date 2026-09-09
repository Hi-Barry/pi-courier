/**
 * Pipeline stage table (spec #72 票3/C1): the stage list itself is the test
 * surface — order, preAuth flags, ledger consumption and rpc laziness are
 * pinned here so future stages can't silently break the invariants.
 */
import { describe, expect, it, vi } from "vitest";
import { ChallengeAuth } from "../src/auth/challenge-auth";
import { ConfigStore } from "../src/config";
import { createMessageRouter } from "../src/rpc/message-router";
import { PmctlController } from "../src/rpc/pmctl-controller";
import type { PiRpc } from "../src/rpc/pi-rpc";
import type { ProjectManager } from "../src/rpc/project-manager";
import type { RoomOps } from "../src/transports/interface";
import type { ExternalMessage } from "../src/types";

function makeMsg(overrides: Partial<ExternalMessage> & { text?: string } = {}): ExternalMessage {
  const { text = "hi", ...rest } = overrides;
  return {
    chatId: "!dm:server",
    transport: "matrix",
    userId: "@barry:server",
    username: "barry",
    payload: { kind: "text", text },
    isGroupChat: false,
    wasMentioned: false,
    messageId: "m1",
    timestamp: new Date(),
    ...rest,
  };
}

function makeFixtures() {
  const replies: string[] = [];
  const sendReply = async (_chatId: string, _transport: string, text: string) => {
    replies.push(text);
  };
  const prompt = vi.fn().mockResolvedValue(undefined);
  const rpc = { prompt, label: undefined, onEvent: vi.fn() } as unknown as PiRpc;
  const projectManager = {
    getRpcForRoom: vi.fn().mockReturnValue(rpc),
    isProjectRoom: vi.fn().mockReturnValue(false),
    labelForRoom: vi.fn().mockReturnValue(undefined),
    isMultiProject: false,
    allRpcs: vi.fn().mockReturnValue([rpc]),
  } as unknown as ProjectManager;
  const store = new ConfigStore({});
  const auth = new ChallengeAuth(() => {}, () => {});
  auth.loadFromConfig({ trustedUsers: ["matrix:@barry:server"], adminUserId: "matrix:@barry:server", channels: {} });
  const roomOps = { getBotUserId: vi.fn().mockReturnValue("@bot:server") } as unknown as RoomOps;
  const pmctl = new PmctlController({ projectManager, roomOps, store });
  const router = createMessageRouter({ projectManager, auth, sendReply, sendTyping: vi.fn(), roomOps, store, pmctl });
  return { router, prompt, replies, getRpcForRoom: projectManager.getRpcForRoom as ReturnType<typeof vi.fn> };
}

describe("pipeline stage table (spec #72 票3/C1)", () => {
  it("declares the stages in execution order with their invariants", () => {
    const { router } = makeFixtures();
    expect(router.pipeline().map((s) => s.name)).toEqual([
      "authorization",
      "attachments",
      "adminCommands",
      "groupEnable",
      "authorizationGate",
      "multiproject",
      "managementAdoption",
      "roomBinding",
      "pmctl",
      "login",
      "slashCommands",
      "loginCapture",
      "extensionCapture",
      "prompt",
    ]);
  });

  it("preAuth stages are exactly the self-gated command families", () => {
    const { router } = makeFixtures();
    expect(router.pipeline().filter((s) => s.preAuth).map((s) => s.name)).toEqual([
      "adminCommands",
      "groupEnable",
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
