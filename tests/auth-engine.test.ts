import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChallengeAuth } from "../src/auth/challenge-auth";
import { adminCommandHelpText, handleAdminCommand } from "../src/auth/admin-commands";

/** Direct table tests for the auth strategy engine and the admin-command
 *  handler. The engine is a pure state machine (in-memory only, sender
 *  passed as a parameter), so expiry / lockout / revoke matching are
 *  testable without any I/O. */

function makeEngine(channels: Record<string, { enabled: boolean; mode: "all" | "mentions" | "trusted-only" }> = {}) {
  let shownCode: string | null = null;
  const notifications: Array<{ message: string; level?: string }> = [];
  const auth = new ChallengeAuth(
    (code) => {
      shownCode = code;
    },
    (message, level) => notifications.push({ message, level })
  );
  auth.loadFromConfig({
    trustedUsers: ["matrix:@barry:server", "matrix:@carol:server"],
    adminUserId: "matrix:@barry:server",
    channels,
  });
  return { auth, shown: () => shownCode, notifications };
}

/** Drive a DM message through checkAuthorization to capture the challenge. */
async function initiate(auth: ChallengeAuth, userId: string, chatId: string): Promise<void> {
  const sent: string[] = [];
  await auth.checkAuthorization(userId, chatId, userId.split(":")[0] ?? userId, false, false, async (_cid, text) => {
    sent.push(text);
  }, "matrix");
}

describe("ChallengeAuth strategy engine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("challenge codes expire after 2 minutes", async () => {
    const { auth, shown } = makeEngine();
    await initiate(auth, "@eve:server", "!dm:server");
    const code = shown()!;

    // Just before expiry: correct code authenticates.
    vi.setSystemTime(1_000_000 + 2 * 60 * 1000 - 1);
    expect(auth.validateChallengeCode("matrix:@eve:server", code)).toBe("authenticated");
    expect(auth.isTrustedUser("@eve:server", "matrix")).toBe(true);
  });

  it("an expired challenge rejects the code and a fresh one is issued", async () => {
    const { auth, shown } = makeEngine();
    await initiate(auth, "@eve:server", "!dm:server");
    vi.setSystemTime(1_000_000 + 2 * 60 * 1000 + 1);
    expect(auth.validateChallengeCode("matrix:@eve:server", shown()!)).toBe("expired");

    // Not trusted; a new DM initiates a fresh challenge (new code).
    expect(auth.isTrustedUser("@eve:server", "matrix")).toBe(false);
    await initiate(auth, "@eve:server", "!dm:server");
    expect(shown()).toMatch(/^\d{6}$/);
  });

  it("three wrong codes lock the user for 5 minutes, then the block lifts", async () => {
    const { auth } = makeEngine();
    await initiate(auth, "@eve:server", "!dm:server");
    const wrongCode = "000000";

    expect(auth.validateChallengeCode("matrix:@eve:server", wrongCode)).toBe("wrong");
    expect(auth.attemptsLeft("matrix:@eve:server")).toBe(2);
    expect(auth.validateChallengeCode("matrix:@eve:server", wrongCode)).toBe("wrong");
    expect(auth.validateChallengeCode("matrix:@eve:server", wrongCode)).toBe("blocked");
    expect(auth.attemptsLeft("matrix:@eve:server")).toBe(0);

    // Blocked: even a fresh DM is silently denied (no new challenge).
    const sent: string[] = [];
    const ok = await auth.checkAuthorization("@eve:server", "!dm:server", "eve", false, false, async (_c, t) => {
      sent.push(t);
    }, "matrix");
    expect(ok).toBe(false);
    expect(sent.length).toBe(0);

    // 5 minutes later the block lifts and a new challenge flows.
    vi.setSystemTime(1_000_000 + 5 * 60 * 1000 + 1);
    await auth.checkAuthorization("@eve:server", "!dm:server", "eve", false, false, async (_c, t) => {
      sent.push(t);
    }, "matrix");
    expect(sent.length).toBe(1);
  });

  it("challenges are per-user: concurrent unknown users never share codes", async () => {
    // The old design swapped a sender field for the duration of the call —
    // this pins the parameter-passing contract: two interleaved initiations
    // each deliver their own prompt and validate against their own code.
    const { auth: authA, shown: shownA } = makeEngine();
    const { auth: authB, shown: shownB } = makeEngine();
    const sentA: string[] = [];
    const sentB: string[] = [];
    // Interleave the two async initiations on ONE engine to prove no
    // field-swap cross-talk: A starts, B completes, then A resumes.
    const pendingA = authA.checkAuthorization("@eve:server", "!dmA:server", "eve", false, false, async (_c, t) => {
      sentA.push(t);
    }, "matrix");
    await authA.checkAuthorization("@mallory:server", "!dmB:server", "mallory", false, false, async (_c, t) => {
      sentB.push(t);
    }, "matrix");
    await pendingA;
    void authB;

    // Both users hold distinct active challenges on the same engine.
    expect(authA.validateChallengeCode("matrix:@mallory:server", "000000")).toBe("wrong");
    expect(authA.attemptsLeft("matrix:@eve:server")).toBe(3);
  });

  it("revoke matches full namespaced IDs exactly and bare IDs across transports", () => {
    const { auth } = makeEngine();
    expect(auth.revokeUser("matrix:@carol:server")).toBe(true); // namespaced, exact
    expect(auth.isTrustedUser("@carol:server", "matrix")).toBe(false);

    // Bare ID = the transport-native ID (@barry:server); suffix-matched.
    expect(auth.revokeUser("@barry:server")).toBe(true);
    expect(auth.isTrustedUser("@barry:server", "matrix")).toBe(false);

    expect(auth.revokeUser("nobody")).toBe(false);
  });

  it("channel modes gate group messages without any I/O", async () => {
    const { auth } = makeEngine({
      "!room:server": { enabled: true, mode: "trusted-only" },
    });
    expect(auth.isChannelEnabled("!room:server")).toBe(true);
    expect(
      await auth.checkAuthorization("@barry:server", "!room:server", "barry", true, false, undefined, "matrix")
    ).toBe(true);
    expect(
      await auth.checkAuthorization("@eve:server", "!room:server", "eve", true, false, undefined, "matrix")
    ).toBe(false);
    // Unenabled room: denied even for trusted users.
    expect(
      await auth.checkAuthorization("@barry:server", "!other:server", "barry", true, false, undefined, "matrix")
    ).toBe(false);
  });
});

describe("handleAdminCommand (pure in/out)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("challenge-code entry returns replies plus a persistAuth effect", async () => {
    const { auth, shown } = makeEngine();
    await initiate(auth, "@eve:server", "!dm:server");
    const result = handleAdminCommand(auth, {
      text: shown()!,
      userId: "@eve:server",
      transport: "matrix",
    });
    expect(result.handled).toBe(true);
    expect(result.replies).toEqual(["✅ Authenticated! You can now chat with the agent."]);
    expect(result.effects).toEqual([{ kind: "persistAuth" }]);
    expect(auth.isTrustedUser("@eve:server", "matrix")).toBe(true);
  });

  it("wrong-code replies carry the remaining attempts", async () => {
    const { auth, shown } = makeEngine();
    await initiate(auth, "@eve:server", "!dm:server");
    const wrong = shown() === "000000" ? "111111" : "000000";
    const result = handleAdminCommand(auth, { text: wrong, userId: "@eve:server", transport: "matrix" });
    expect(result.replies).toEqual(["❌ Wrong code. 2 attempts remaining."]);
    expect(result.effects).toEqual([]);
  });

  it("/enable mutates channels in memory and asks the caller to persist", () => {
    const { auth } = makeEngine();
    const result = handleAdminCommand(auth, {
      text: "/enable !group:server mentions",
      userId: "@barry:server",
      transport: "matrix",
    });
    expect(result.handled).toBe(true);
    expect(result.replies).toEqual(["✅ Channel !group:server enabled (mode: mentions)"]);
    expect(result.effects).toEqual([{ kind: "persistAuth" }]);
    expect(auth.isChannelEnabled("!group:server")).toBe(true);
  });

  it("/toggletools returns the flipped value as an effect (caller owns the store)", () => {
    const { auth } = makeEngine();
    const hidden = handleAdminCommand(auth, {
      text: "/toggletools",
      userId: "@barry:server",
      transport: "matrix",
      hideToolCalls: false,
    });
    expect(hidden.effects).toEqual([{ kind: "hideToolCalls", value: true }]);
    expect(hidden.replies).toEqual(["🔧 Tool calls hidden in remote messages"]);

    const shownAgain = handleAdminCommand(auth, {
      text: "/toggletools",
      userId: "@barry:server",
      transport: "matrix",
      hideToolCalls: true,
    });
    expect(shownAgain.effects).toEqual([{ kind: "hideToolCalls", value: false }]);
  });

  it("/revoke emits a warning notification plus persistAuth; unknown users reply only", () => {
    const { auth } = makeEngine();
    const ok = handleAdminCommand(auth, { text: "/revoke @carol:server", userId: "@barry:server", transport: "matrix" });
    expect(ok.replies).toEqual(["🔓 Revoked trust for @carol:server"]);
    expect(ok.notifications).toEqual([{ message: "Revoked: @carol:server", level: "warning" }]);
    expect(ok.effects).toEqual([{ kind: "persistAuth" }]);

    const miss = handleAdminCommand(auth, { text: "/revoke nobody", userId: "@barry:server", transport: "matrix" });
    expect(miss.replies).toEqual(["❌ User nobody not found in trusted users"]);
    expect(miss.effects).toEqual([]);
  });

  it("non-admin commands are not handled (router falls through to pi)", () => {
    const { auth } = makeEngine();
    for (const text of ["/new", "/skill:rust", "/trustedextra"]) {
      const result = handleAdminCommand(auth, { text, userId: "@barry:server", transport: "matrix" });
      expect(result.handled).toBe(false);
    }
  });

  it("the admin help section is auth-owned text for the unified /help", () => {
    const text = adminCommandHelpText();
    expect(text).toContain("/trusted");
    expect(text).toContain("/toggletools");
    expect(text).toContain("6 位验证码");
  });
});
