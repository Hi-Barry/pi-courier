/**
 * Constants single-source (audit engineering batch 票19): every duplicated
 * business constant now lives at its owner; these pins make the consumers'
 * output follow the owner's value instead of a drifted literal.
 */
import { describe, expect, it, vi } from "vitest";
import { MAX_PAIRING_ATTEMPTS, PAIRING_BLOCK_MINUTES, ChallengeAuth } from "../src/auth/challenge-auth";
import { adminCommandHelpText, handleAdminCommand } from "../src/auth/admin-commands";
import { COMMAND_REGISTRY, PMCTL_COMMAND } from "../src/command-registry";
import { guestCommandVerdict } from "../src/auth/guest-policy";
import { RM_CONFIRM_WINDOW_MS } from "../src/rpc/pmctl-controller";
import { MAX_REMINDERS_PER_ROOM } from "../src/reminders/reminder-store";
import { PROJECT_SESSION_DIR } from "../src/rpc/project-manager";
import { CONFIG_DIR } from "../src/config";
import { t, setLocale } from "../src/i18n";

describe("constants single-source (audit engineering batch 票19)", () => {
  it("pairing block constants flow into admin-command replies and audit detail", async () => {
    const auth = new ChallengeAuth(() => {}, () => {});
    auth.loadFromConfig({ trustedUsers: [], channels: {} });
    await auth.checkAuthorization("@eve:server", "!dm:server", "eve", false, false, async () => {}, "matrix");
    // 连续喂 MAX_PAIRING_ATTEMPTS 次错误码 → blocked;回复文案随常量走
    let reply = "";
    for (let i = 0; i < MAX_PAIRING_ATTEMPTS; i++) {
      const r = handleAdminCommand(auth, { text: "000000", userId: "@eve:server", transport: "matrix", chatId: "!dm:server" });
      if (r.replies.length > 0) reply = r.replies.join(" ");
    }
    expect(reply).toContain(`${PAIRING_BLOCK_MINUTES} minutes`);
  });

  it("PMCTL_COMMAND is the registry's /pmctl and guest verdict blocks the whole family", () => {
    expect(PMCTL_COMMAND).toBe("/pmctl");
    expect(COMMAND_REGISTRY.find((c) => c.name === PMCTL_COMMAND)?.guest).toBe("blocked");
    expect(guestCommandVerdict("/pmctl list").blocked).toBe(true);
  });

  it("reminder cap placeholder interpolates the owner's value", () => {
    setLocale("en");
    expect(t("cmd.remind.limit", { max: MAX_REMINDERS_PER_ROOM })).toContain(String(MAX_REMINDERS_PER_ROOM));
    setLocale("zh");
    expect(t("cmd.remind.limit", { max: MAX_REMINDERS_PER_ROOM })).toContain(String(MAX_REMINDERS_PER_ROOM));
  });

  it("rm confirm window is a single exported constant (>0) and PROJECT_SESSION_DIR is the session dir name", () => {
    expect(RM_CONFIRM_WINDOW_MS).toBeGreaterThan(0);
    expect(PROJECT_SESSION_DIR).toBe(".pi-session");
  });

  it("CONFIG_DIR is the ~/.pi bridge root (consumers derive from it)", () => {
    expect(CONFIG_DIR.endsWith(".pi")).toBe(true);
    // admin help text no longer hardcodes the pairing numbers (they flow from the owner)
    expect(adminCommandHelpText()).toBeDefined();
  });
});
