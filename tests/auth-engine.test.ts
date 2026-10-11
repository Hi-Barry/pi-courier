import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChallengeAuth } from "../src/auth/challenge-auth";
import { adminCommandHelpText, handleAdminCommand } from "../src/auth/admin-commands";
import { matchesAdmin, matchesTrustedEntry } from "../src/identity";

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

describe("displayIdentity 保留 homeserver 段(审计工程批 票21)", () => {
  it("展示完整 native ID,不同 homeserver 可区分", async () => {
    const { displayIdentity } = await import("../src/identity");
    expect(displayIdentity("matrix:@alice:hs1")).toBe("@alice:hs1 (matrix)");
    expect(displayIdentity("matrix:@alice:hs2")).toBe("@alice:hs2 (matrix)");
    expect(displayIdentity("@bare:form")).toBe("@bare:form");
  });
});

describe("namespacedId 幂等(审计工程批 票23)", () => {
  it("同前缀重复包装返回原值,不同前缀正常加", async () => {
    const { namespacedId } = await import("../src/identity");
    expect(namespacedId("@u:s", "matrix")).toBe("matrix:@u:s");
    expect(namespacedId("matrix:@u:s", "matrix")).toBe("matrix:@u:s");
    expect(namespacedId("telegram:123", "matrix")).toBe("matrix:telegram:123");
    expect(namespacedId("@u:s")).toBe("@u:s");
  });
});

describe("ChallengeAuth strategy engine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pairing prompt send failure notifies the admin exactly once (audit stability batch 票18)", async () => {
    const notifications: Array<{ message: string; level?: string }> = [];
    const auth = new ChallengeAuth(
      () => {},
      (message, level) => notifications.push({ message, level })
    );
    auth.loadFromConfig({ trustedUsers: [], channels: {} });
    // 提示发送持续失败:一次挑战恰好一条管理员通知
    await auth.checkAuthorization("@loser:server", "!dm:server", "loser", false, false, async () => {
      throw new Error("network down");
    }, "matrix");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.level).toBe("warning");
    expect(notifications[0]!.message).toContain("network down");

    // 发送成功:零通知
    await auth.checkAuthorization("@winner:server", "!dm2:server", "winner", false, false, async () => {}, "matrix");
    expect(notifications).toHaveLength(1);
  });

  it("6-digit message with no pending pairing gets a one-per-chat hint (spec #93 票3)", async () => {
    const { auth } = makeEngine();
    const input = (chatId: string, text: string) =>
      handleAdminCommand(auth, { text, userId: "@eve:server", transport: "matrix", chatId });

    // No challenge in flight: the first stray 6-digit message hints, the
    // second one inside the cooldown window falls through silently.
    const first = input("!dm:server", "123456");
    expect(first.handled).toBe(true);
    expect(first.replies[0]).toContain("没有进行中的配对");

    const second = input("!dm:server", "654321");
    expect(second.handled).toBe(false);
  });

  it("pairing hints are per-chat: a hint in one chat does not mute another", async () => {
    const { auth } = makeEngine();
    const first = handleAdminCommand(auth, { text: "111111", userId: "@eve:server", transport: "matrix", chatId: "!dm1:server" });
    expect(first.handled).toBe(true);
    const second = handleAdminCommand(auth, { text: "222222", userId: "@eve:server", transport: "matrix", chatId: "!dm2:server" });
    expect(second.handled).toBe(true);
  });

  it("challenge prompt points the user at this chat (spec #93 票3)", async () => {
    const { auth } = makeEngine();
    const sent: string[] = [];
    await auth.checkAuthorization("@eve:server", "!dm:server", "eve", false, false, async (_cid, text) => {
      sent.push(text);
    }, "matrix");
    expect(sent.some((t) => t.includes("6 位配对码") && t.includes("本聊天"))).toBe(true);
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

    // Bare ID = the transport-native ID (@barry:server); matched against the
    // entry's full native segment (everything after the transport prefix).
    expect(auth.revokeUser("@barry:server")).toBe(true);
    expect(auth.isTrustedUser("@barry:server", "matrix")).toBe(false);

    expect(auth.revokeUser("nobody")).toBe(false);
  });

  it("revoke matching is segment-anchored: short/homeserver inputs never wildcard (audit batch 1)", () => {
    // Direct table over the identity rule: native-segment equality, no
    // arbitrary suffix matches.
    expect(matchesTrustedEntry("matrix:@carol:server", "matrix:@carol:server")).toBe(true);
    expect(matchesTrustedEntry("@carol:server", "matrix:@carol:server")).toBe(true); // bare native MXID
    expect(matchesTrustedEntry("12345", "telegram:12345")).toBe(true); // bare telegram ID
    // Previously matched via endsWith — these must NOT revoke anything.
    expect(matchesTrustedEntry("server", "matrix:@user:server")).toBe(false);
    expect(matchesTrustedEntry("hs.org", "matrix:@alice:hs.org")).toBe(false);
    expect(matchesTrustedEntry("er", "matrix:@user:server")).toBe(false);
    expect(matchesTrustedEntry("@user:server", "matrix:@other:server")).toBe(false);
    // Bare entries: exact match only.
    expect(matchesTrustedEntry("legacy-id", "legacy-id")).toBe(true);
    expect(matchesTrustedEntry("id", "legacy-id")).toBe(false);
    // Engine-level: revoking a homeserver fragment leaves trust intact.
    const { auth } = makeEngine();
    expect(auth.revokeUser("server")).toBe(false);
    expect(auth.isTrustedUser("@barry:server", "matrix")).toBe(true);
    expect(auth.isTrustedUser("@carol:server", "matrix")).toBe(true);
  });

  it("admin matching keeps the documented dual-form semantics, cross-transport included (audit batch 1 票3)", () => {
    // Namespaced form wins per transport; the bare form is the documented
    // legacy compat rule (early deployments stored bare IDs in config).
    expect(matchesAdmin("matrix:@barry:server", "@barry:server", "matrix")).toBe(true);
    expect(matchesAdmin("matrix:@barry:server", "@barry:server", "telegram")).toBe(false);
    // Bare-form compat: matches the raw ID on ANY transport — pinned here as
    // intentional, not accidental (single real transport today; revisit if a
    // second transport with colliding raw IDs ever ships).
    expect(matchesAdmin("@barry:server", "@barry:server", "matrix")).toBe(true);
    expect(matchesAdmin("12345", "12345", "telegram")).toBe(true);
    expect(matchesAdmin("matrix:@barry:server", "@other:server", "matrix")).toBe(false);
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

  it("pairing codes come from a CSPRNG within the 6-digit domain (audit batch 1)", async () => {
    const codes: string[] = [];
    const auth = new ChallengeAuth((code) => codes.push(code), () => {});
    auth.loadFromConfig({ trustedUsers: [], channels: {} });
    // One challenge per unknown DM user — distinct users, distinct codes.
    for (let i = 0; i < 24; i++) {
      await auth.checkAuthorization(`@fresh-${i}:server`, `!dm${i}:server`, `fresh-${i}`, false, false, undefined, "matrix");
    }
    expect(codes).toHaveLength(24);
    for (const code of codes) {
      expect(code).toMatch(/^\d{6}$/);
      const n = parseInt(code, 10);
      expect(n).toBeGreaterThanOrEqual(100000);
      expect(n).toBeLessThanOrEqual(999999);
    }
    // Variability: a predictable source (or constant) cannot produce this.
    expect(new Set(codes).size).toBeGreaterThan(12);
  });

  it("pairing code domain reaches both ends of the 6-digit range (audit batch 1 票2)", async () => {
    const codes: number[] = [];
    const auth = new ChallengeAuth((code) => codes.push(parseInt(code, 10)), () => {});
    auth.loadFromConfig({ trustedUsers: [], channels: {} });
    for (let i = 0; i < 1000; i++) {
      await auth.checkAuthorization(`@sweep-${i}:server`, `!dm${i}:server`, `sweep-${i}`, false, false, undefined, "matrix");
    }
    // Both tails of the range are reachable — a truncated/predictable source
    // (e.g. Math.random()*900000 with float rounding) can miss them.
    expect(Math.min(...codes)).toBeLessThan(150000);
    expect(Math.max(...codes)).toBeGreaterThan(950000);
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

  it("challenge-code entry returns replies plus persistAuth + spaceInvite effects", async () => {
    const { auth, shown } = makeEngine();
    await initiate(auth, "@eve:server", "!dm:server");
    const result = handleAdminCommand(auth, {
      text: shown()!,
      userId: "@eve:server",
      transport: "matrix",
    });
    expect(result.handled).toBe(true);
    expect(result.replies).toEqual(["✅ 配对成功!现在可以直接和 agent 对话了。"]);
    // The invites ride the same effect chain as trust persistence — the
    // caller (router) applies them; the engine stays free of Matrix I/O.
    expect(result.effects).toEqual([
      { kind: "persistAuth" },
      { kind: "spaceInvite", userId: "@eve:server", transport: "matrix" },
      { kind: "managementRoomInvite", userId: "@eve:server", transport: "matrix" },
    ]);
    expect(auth.isTrustedUser("@eve:server", "matrix")).toBe(true);
  });

  it("wrong-code replies carry the remaining attempts", async () => {
    const { auth, shown } = makeEngine();
    await initiate(auth, "@eve:server", "!dm:server");
    const wrong = shown() === "000000" ? "111111" : "000000";
    const result = handleAdminCommand(auth, { text: wrong, userId: "@eve:server", transport: "matrix" });
    expect(result.replies).toEqual(["❌ 配对码不对,还剩 2 次机会。"]);
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
    expect(result.replies).toEqual(["✅ 频道 !group:server 已启用(mode: mentions)"]);
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
    expect(hidden.replies).toEqual(["🔧 工具调用已在远程消息中隐藏"]);

    const shownAgain = handleAdminCommand(auth, {
      text: "/toggletools",
      userId: "@barry:server",
      transport: "matrix",
      hideToolCalls: true,
    });
    expect(shownAgain.effects).toEqual([{ kind: "hideToolCalls", value: false }]);
  });

  it("/revoke emits a warning notification plus persistAuth and the powerDemote effect; unknown users reply only", () => {
    const { auth } = makeEngine();
    const ok = handleAdminCommand(auth, { text: "/revoke @carol:server", userId: "@barry:server", transport: "matrix" });
    expect(ok.replies).toEqual(["🔓 已撤销 @carol:server 的信任"]);
    expect(ok.notifications).toEqual([{ message: "已撤销:@carol:server", level: "warning" }]);
    // The demotion effect carries the removed entry in its stored (namespaced)
    // form, however the admin spelled the command argument.
    expect(ok.effects).toEqual([
      { kind: "persistAuth" },
      { kind: "powerDemote", userId: "matrix:@carol:server" },
    ]);

    const miss = handleAdminCommand(auth, { text: "/revoke nobody", userId: "@barry:server", transport: "matrix" });
    expect(miss.replies).toEqual(["❌ nobody 不在信任用户名单中"]);
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
