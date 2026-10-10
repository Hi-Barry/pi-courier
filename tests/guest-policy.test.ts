/**
 * Guest policy (issue #120): the blocklist is a snapshot-pinned constant —
 * a new dangerous command that forgets to register here turns these tests
 * red. The bang-detection regex is pinned for EQUIVALENCE with
 * command-map's parseBangCommand (same rule, two homes, one test-enforced
 * truth — a runtime import would close an auth→rpc→auth cycle).
 */
import { describe, expect, it } from "vitest";
import { GUEST_ALLOWED_COMMANDS, GUEST_BLOCKED_COMMANDS, guestCommandVerdict } from "../src/auth/guest-policy";
import { parseBangCommand } from "../src/rpc/command-map";

describe("guest policy blocklist (issue #120)", () => {
  it("snapshot: the blocklist contains exactly the dangerous surface", () => {
    expect([...GUEST_BLOCKED_COMMANDS].sort()).toEqual(
      [
        "/attach",
        "/auth",
        "/abort",
        "/bash",
        "/bashstop",
        "/detach",
        "/disable",
        "/enable",
        "/interrupt",
        "/login",
        "/logout",
        "/multiproject",
        "/newproject",
        "/pmctl",
        "/projects",
        "/remind",
        "/reload",
        "/revoke",
        "/stop",
        "/switch",
        "/toggletools",
        "/trusted",
      ].sort()
    );
  });

  it("every blocked command is a slash command; the allowed list never overlaps it", () => {
    for (const cmd of GUEST_BLOCKED_COMMANDS) expect(cmd.startsWith("/")).toBe(true);
    for (const cmd of GUEST_ALLOWED_COMMANDS) {
      expect(GUEST_BLOCKED_COMMANDS).not.toContain(cmd);
    }
  });

  it("dangerous commands are blocked with the exact trigger word", () => {
    for (const cmd of ["/bash ls", "/stop", "/pmctl list", "/pmctl", "/interrupt", "/trusted", "/remind 30m 喝水", "/LOGOUT"]) {
      const verdict = guestCommandVerdict(cmd);
      expect(verdict.blocked, cmd).toBe(true);
      expect(verdict.command, cmd).toBe(cmd.trim().split(/\s+/)[0]!.toLowerCase());
    }
  });

  it("/pmctl blocks every subcommand via the prefix rule", () => {
    for (const cmd of ["/pmctl new /w x", "/pmctl rm proj", "/pmctl rename a b"]) {
      expect(guestCommandVerdict(cmd).blocked).toBe(true);
    }
  });

  it("shell bangs are blocked in full-width and half-width, 1-2 marks", () => {
    for (const bang of ["! ls", "!! rm -rf /", "！ git status", "！！ make clean"]) {
      expect(guestCommandVerdict(bang).blocked, bang).toBe(true);
    }
  });

  it("conversation, allowed read-only commands and exclamations pass", () => {
    for (const text of ["帮我看看这个报错", "/help", "/status", "/cost", "/queue", "/find 稍后落地", "/recap", "!!! 好厉害", "!", "!git", "/unknown-extension-cmd"]) {
      const verdict = guestCommandVerdict(text);
      expect(verdict.blocked, text).toBe(false);
      expect(verdict.command, text).toBe("");
    }
  });

  it("bang detection agrees with command-map's parseBangCommand on a sample set", () => {
    // 管道文本在入口已 trim(router 的 ctx.text 构造处),等价性按 trim 后
    // 的输入对齐 —— 与两个消费方看到的世界一致。
    const samples = ["! ls", "!! rm", "！ git", "！！ make", "!!! ok", "!", "!git", "hello ! ls", "！! x"];
    for (const sample of samples) {
      const asBang = parseBangCommand(sample);
      expect(guestCommandVerdict(sample).blocked, sample).toBe(asBang !== null);
    }
  });
});
