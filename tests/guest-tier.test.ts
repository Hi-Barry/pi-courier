/**
 * Guest tier through the engine and the gate (issue #120): REAL
 * ChallengeAuth + REAL pipeline — four-tier matrix (admin/trusted/guest/
 * untrusted × representative commands), the pairing regression (guests
 * never get a challenge), and the trusted-only room mode overriding tiers.
 */
import { describe, expect, it, vi } from "vitest";
import { ChallengeAuth } from "../src/auth/challenge-auth";
import type { PiRpc } from "../src/rpc/pi-rpc";
import { makeMsg, makeRouterFixture } from "./helpers";

const ADMIN = "@admin:server";
const TRUSTED = "@trusted:server";
const GUEST = "@guest:server";
const STRANGER = "@stranger:server";

function makeAuth(channels: Record<string, { enabled: boolean; mode: "all" | "mentions" | "trusted-only" }> = {}): ChallengeAuth {
  const auth = new ChallengeAuth(() => {}, () => {});
  auth.loadFromConfig({
    trustedUsers: [`matrix:${ADMIN}`, `matrix:${TRUSTED}`],
    guestUsers: [`matrix:${GUEST}`],
    adminUserId: `matrix:${ADMIN}`,
    channels,
  });
  return auth;
}

function makeRouter(
  auth: ChallengeAuth,
  prompt: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined)
) {
  const rpc = {
    prompt,
    getState: vi.fn().mockResolvedValue({ isStreaming: false, model: { id: "m" }, pendingMessageCount: 0 }),
    label: undefined,
    onEvent: vi.fn(),
    bash: vi.fn().mockResolvedValue({ ok: true, text: "done" }),
    requireClient: vi.fn().mockReturnValue({
      abort: vi.fn().mockResolvedValue(undefined),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue({ success: true, data: { steering: [], followUp: [] } }),
    }),
  } as unknown as PiRpc;
  const replies: Array<{ chatId: string; text: string }> = [];
  const { router, auditLines } = makeRouterFixture({
    auth,
    audit: true,
    rpc,
    sendReply: async (chatId: string, _transport: string, text: string) => {
      replies.push({ chatId, text });
    },
  });
  return { router, prompt, replies, auditLines };
}

describe("four-tier authorization matrix (issue #120)", () => {
  it.each([
    ["admin", ADMIN, "! ls", "bash"],
    ["trusted", TRUSTED, "! ls", "bash"],
    ["guest", GUEST, "! ls", "denied"],
    ["untrusted", STRANGER, "! ls", "silence"],
  ])("%s runs `!ls` → %s", async (_tier, userId, text, expectation) => {
    const { router, prompt, replies, auditLines: lines } = makeRouter(makeAuth());
    await router.handleIncoming(makeMsg({ userId, username: userId.slice(1), text }));
    if (expectation === "bash") {
      // bash 路径:不进 prompt,也绝无拒绝回执
      expect(prompt).not.toHaveBeenCalled();
      expect(replies.some((r) => r.text.includes("此命令需要信任用户权限"))).toBe(false);
      expect(lines.some((l) => l.event === "guest.denied")).toBe(false);
    } else if (expectation === "denied") {
      expect(prompt).not.toHaveBeenCalled();
      expect(replies.some((r) => r.text.includes("此命令需要信任用户权限"))).toBe(true);
      expect(lines.some((l) => l.event === "guest.denied" && l.detail!.includes("! ls"))).toBe(true);
    } else {
      // untrusted:DM 里收到的是配对征询,不进 pi,也不许碰命令
      expect(prompt).not.toHaveBeenCalled();
      expect(replies[0]?.text).toContain("6");
    }
  });

  it.each([
    ["/pmctl list"],
    ["/stop"],
    ["/trusted"],
    ["/remind 30m 喝水"],
    ["/reload"],
    ["/attach some-id"],
  ])("guest touching %s is denied and audited", async (text) => {
    const { router, prompt, auditLines: lines } = makeRouter(makeAuth());
    await router.handleIncoming(makeMsg({ userId: GUEST, username: "guest", text }));
    expect(prompt).not.toHaveBeenCalled();
    expect(lines.filter((l) => l.event === "guest.denied")).toHaveLength(1);
  });

  it("guest conversation and read-only commands flow normally", async () => {
    const { router, prompt, auditLines: lines } = makeRouter(makeAuth());
    await router.handleIncoming(makeMsg({ userId: GUEST, username: "guest", text: "这个报错怎么解?" }));
    await router.handleIncoming(makeMsg({ userId: GUEST, username: "guest", text: "/status" }));
    await router.handleIncoming(makeMsg({ userId: GUEST, username: "guest", text: "/cost" }));
    // 三条全部放行:普通对话进 prompt,只读命令由命令层处理 —— 无论走哪
    // 条路,访客档不得拦、不得记越权。
    expect(prompt).toHaveBeenCalled();
    expect(lines.filter((l) => l.event === "guest.denied")).toHaveLength(0);
  });

  it("guests never trigger the pairing challenge in DMs (regression)", async () => {
    const challengePrompts: string[] = [];
    const auth = new ChallengeAuth(() => {}, () => {});
    auth.loadFromConfig({ trustedUsers: [`matrix:${ADMIN}`], guestUsers: [`matrix:${GUEST}`] });
    const ok = await auth.checkAuthorization(
      GUEST,
      "!dm:server",
      "guest",
      false,
      false,
      async (_chatId, message) => {
        challengePrompts.push(message);
      },
      "matrix"
    );
    expect(ok).toBe(true);
    expect(challengePrompts).toHaveLength(0); // 无配对码
    expect(auth.isAdminUser(GUEST, "matrix")).toBe(false); // 也不得顺手领走 admin
    expect(auth.exportConfig().guestUsers).toEqual([`matrix:${GUEST}`]); // 往返持久化
  });

  it("trusted-only rooms keep guests outside (mode first, tier second)", async () => {
    const { router, prompt, replies, auditLines: lines } = makeRouter(
      makeAuth({ "!group:server": { enabled: true, mode: "trusted-only" } })
    );
    await router.handleIncoming(
      makeMsg({ userId: GUEST, username: "guest", chatId: "!group:server", isGroupChat: true, wasMentioned: true, text: "我能进吗" })
    );
    expect(prompt).not.toHaveBeenCalled();
    expect(replies).toHaveLength(0); // 门外静默,与旧 untrusted 同待遇
    expect(lines).toHaveLength(0);
  });

  it("guests chat in an all-mode group like any member", async () => {
    const { router, prompt, auditLines: lines } = makeRouter(makeAuth({ "!group:server": { enabled: true, mode: "all" } }));
    await router.handleIncoming(
      makeMsg({ userId: GUEST, username: "guest", chatId: "!group:server", isGroupChat: true, wasMentioned: true, text: "大家好" })
    );
    expect(prompt).toHaveBeenCalledWith("大家好");
    expect(lines).toHaveLength(0);
  });

  it("guest verdict receipts go back to the guest's own room", async () => {
    const { router, replies, auditLines: lines } = makeRouter(makeAuth());
    await router.handleIncoming(makeMsg({ userId: GUEST, username: "guest", chatId: "!guest-dm:server", text: "/stop" }));
    expect(replies[0]?.chatId).toBe("!guest-dm:server");
    expect(lines[0]?.chatId).toBe("!guest-dm:server");
  });
});
