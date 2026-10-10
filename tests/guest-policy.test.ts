/**
 * Guest policy (issue #120): the verdict is snapshot-pinned against the
 * command registry (架构候选3) — a new dangerous command that forgets to
 * register there turns these tests red. The bang regex is single-homed in
 * the registry; the old copy-and-pin-equivalence bandage is retired (the
 * sample-set test below still guards both parsers' agreement).
 */
import { describe, expect, it } from "vitest";
import { AUDIT_EVENTS } from "../src/audit/audit-log";
import { guestCommandVerdict } from "../src/auth/guest-policy";
import { COMMAND_REGISTRY, commandPolicy, GUEST_READ_ONLY_DOC } from "../src/command-registry";
import { parseBangCommand } from "../src/rpc/command-map";

describe("guest policy blocklist (issue #120)", () => {
  it("snapshot: the registry's blocked set is exactly the dangerous surface", () => {
    expect(
      COMMAND_REGISTRY.filter((c) => c.guest === "blocked").map((c) => c.name).sort()
    ).toEqual(
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

  it("every registered command is a slash command and names are unique", () => {
    for (const entry of COMMAND_REGISTRY) expect(entry.name.startsWith("/")).toBe(true);
    expect(new Set(COMMAND_REGISTRY.map((c) => c.name)).size).toBe(COMMAND_REGISTRY.length);
  });

  it("registry audit events live in the AUDIT_EVENTS vocabulary, pinned for the sensitive three", () => {
    const values = new Set<string>(Object.values(AUDIT_EVENTS));
    for (const entry of COMMAND_REGISTRY) {
      if (entry.auditEvent !== undefined) expect(values.has(entry.auditEvent), entry.name).toBe(true);
    }
    expect(commandPolicy("/bash")?.auditEvent).toBe(AUDIT_EVENTS.bashExec);
    expect(commandPolicy("/bashstop")?.auditEvent).toBe(AUDIT_EVENTS.bashStop);
    expect(commandPolicy("/reload")?.auditEvent).toBe(AUDIT_EVENTS.reload);
    expect(commandPolicy("/help")).toBeUndefined();
    expect(commandPolicy("/status")?.auditEvent).toBeUndefined();
  });

  it("the read-only documentation list never overlaps the blocked set", () => {
    for (const cmd of GUEST_READ_ONLY_DOC) {
      expect(commandPolicy(cmd)?.guest, cmd).toBeUndefined();
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
