/**
 * English message table (issue #83). Key-aligned to the zh baseline table by
 * the compiler: Record<MessageKey, string> rejects both missing and extra
 * keys at typecheck time — the two tables can never drift.
 */
import type { MessageKey } from "./zh.js";

const en: Record<MessageKey, string> = {
  // ── common ────────────────────────────────────────────────────────────
  "common.cancel": "cancel",
  "common.on": "on",
  "common.off": "off",
  "common.enabled": "enabled",
  "common.disabled": "disabled",
  "common.yes": "yes",
  "common.no": "no",
  "common.truncated": "…(truncated)",
  "common.noOutput": "(no output)",
  "common.exitCode": "exit code: {code}",
  "common.unknown": "unknown",
  "common.listSep": ", ",

  // ── cmd ───────────────────────────────────────────────────────────────
  "cmd.new.ok": "✅ New session started",
  "cmd.new.cancelled": "⚠️ New session cancelled by an extension",
  "cmd.recap.generating": "⏳ Generating the handoff card…",
  "cmd.recap.busy": "⏳ A task is still running — finish it (or /stop) before asking for a handoff card.",
  "cmd.recap.empty": "🤷 Nothing to summarize yet in this session (try after a couple of exchanges).",
  "recap.prompt": "Summarize this session in at most 5 bullets: the goal, what was completed, and what remains. Keep it under 200 words, bullets only, no pleasantries.",
  "recap.card.plain": "📋 Handoff card · {title}",
  "recap.card.titled": "📋 {project} handoff card · {title}",
  "recap.card.context": "📜 Context used: {context}",
  "recap.cc.prefix": "📋 {project} handoff card (project log)",
  // ── bridge admin command replies (admin-commands.ts; previously hardcoded
  //    English — the en strings keep the pre-i18n wording byte-identical) ──
  "cmd.enable.usage": "Usage: /enable <chatId> <all|mentions|trusted-only>",
  "cmd.enable.ok": "✅ Channel {chatId} enabled (mode: {mode})",
  "cmd.enable.notify": "Channel {chatId} enabled ({mode})",
  "cmd.disable.usage": "Usage: /disable <chatId>",
  "cmd.disable.ok": "❌ Channel {chatId} disabled",
  "cmd.disable.notify": "Channel {chatId} disabled",
  "cmd.channels.empty": "No channels configured",
  "cmd.trusted.list": "Trusted users ({count}):\n{users}",
  "cmd.trusted.none": "None",
  "cmd.toggletools.ok": "🔧 Tool calls {state} in remote messages",
  "cmd.toggletools.hidden": "hidden",
  "cmd.toggletools.shown": "shown",
  "cmd.revoke.usage": "Usage: /revoke <userId> or /revoke <transport:userId>",
  "cmd.revoke.ok": "🔓 Revoked trust for {userId}",
  "cmd.revoke.notify": "Revoked: {userId}",
  "cmd.revoke.notFound": "❌ User {userId} not found in trusted users",
  "cmd.generic.error": "❌ Command failed: {message}",
  "cmd.bash.error": "❌ bash failed: {message}",
  "cmd.bash.notWritten": "(output not written to context)",
  "cmd.bash.excludedNote": "(output not written to context)",
  "cmd.bash.aborted": "⏹ Aborted: {command}{suffix}",
  "cmd.bash.timeout": "⏹ bash timed out after {minutes} min: {command}\nFor longer-running commands, raise bashTimeoutMinutes in the config and restart.",
  "cmd.queue.warning": "⚠️ {count} queued message(s) will take effect on the next turn:\n{lines}",
  "cmd.rpc.defaultName": "default",
  "cmd.reloadAll.restarted": "✅ Restarted {count} idle process(es): {names}",
  "cmd.reloadAll.none": "💤 No idle processes needed a restart",
  "cmd.reloadAll.skippedBusy": "⚠️ Skipped {count} busy process(es): {names} (run /reload all once they finish)",
  "cmd.reloadAll.unreachable": "⏭️ Not started / unreachable (they will pick up new config on their next start): {names}",
  "cmd.queue.localEmptyUpstreamHas":
    "📋 The local mirror is empty, but upstream still reports {count} pending message(s) (actual execution wins).",
  "cmd.queue.empty": "📋 Queue is empty: no queued steering / followUp messages.",
  "cmd.queue.header": "📋 Current message queue:",
  "cmd.queue.steering": "steering ({count} message(s), injected into the current run):",
  "cmd.queue.followUp": "followUp ({count} message(s), executed on later turns):",
  "cmd.queue.mismatch":
    "ℹ️ Upstream reports {upstream} pending message(s) (local mirror: {mirror}); actual execution wins.",
  "cmd.sessions.emptyDir": "session directory is empty",
  "cmd.sessions.noDir": "session directory not found",
  "cmd.sessions.empty": "📭 {reason}: {dir}",
  "cmd.sessions.list": "📚 Sessions (most recently modified first):\n{lines}\n\nUse /switch <number> to switch.",
  "cmd.compact.generating": "⏳ Compacting context — large sessions can take minutes…",
  "cmd.compact.ok": "✅ Compacted",
  "cmd.compact.tokens": "  tokens: {before} → after compaction (see summary)",
  "cmd.compact.summary": "\nSummary: {summary}",
  "cmd.compact.okSimple": "✅ Compacted",
  "cmd.compact.alreadyCompacted": "ℹ️ Session was just compacted — nothing to do",
  "cmd.compact.interrupted": "⏹ Compaction did not finish (superseded, process restart, or wait timeout) — try /compact again",
  "cmd.stop.ok": "🛑 All tasks stopped. Awaiting your next instruction.",
  "cmd.remind.unavailable": "❌ Reminders are unavailable (the state directory is not usable).",
  "cmd.remind.usage": "Usage: /remind <time> <text> — time formats: 30m / 2h / 1d, HH:MM (rolls to tomorrow if past), ISO (e.g. 2026-10-09T09:00). Example: /remind 30m brew tea",
  "cmd.remind.invalidTime": "❌ Can't read the time \"{input}\". Supported: 30m / 2h / 1d, HH:MM, ISO (e.g. 2026-10-09T09:00).",
  "cmd.remind.ok": "⏰ Reminder set: {when} — {text}",
  "cmd.remind.list.empty": "💤 No active reminders in this room. Set one with /remind <time> <text>.",
  "cmd.remind.list.header": "⏰ Reminders in this room:\n{lines}",
  "cmd.remind.list.item": "{n}. {when} — {text} ({user})",
  "cmd.remind.rm.usage": "Usage: /remind rm <n> (see /remind list)",
  "cmd.remind.rm.ok": "✅ Reminder cancelled: {text}",
  "cmd.remind.rm.notFound": "❌ No such number — check /remind list first.",
  "cmd.remind.limit": "⚠️ This room hit the {max} active-reminder cap; clean up with /remind rm first.",
  "remind.due": "⏰ Reminder for @{user}: {text}",
  "remind.late": "(late by {minutes} min)",
  "remind.dropped": "⚠️ {count} more overdue reminder(s) were silently dropped.",
  "cmd.stop.cleared": "🛑 Stopped, and cleared {count} queued message(s):\n{lines}",
  "cmd.interrupt.cleared": "🧹 Cleared {count} queued message(s) (they won't run):\n{lines}",
  "cmd.queue.clearUnsupported": "⚠️ The upstream pi is too old (<0.84.4) to clear queues; they are kept:",
  "queue.lost.notice": "⚠️ Subprocess restarted — {count} queued message(s) never ran:\n{lines}",
  "queue.lost.service.notice": "⚠️ Service restarted — {count} queued message(s) never ran:\n{lines}",
  "inbox.confirm.prompt": "📬 {count} message(s) arrived while the bridge was offline:\n{lines}\nReply \"execute\" to run them in order, or \"ignore\" to discard (valid for {minutes} minutes; silence counts as ignore).",
  "inbox.auto.notice": "📬 {count} message(s) arrived while offline — running them in order:\n{lines}",
  "inbox.entry.line": "- @{user}: {preview}",
  "inbox.ignored": "🗑️ Discarded {count} offline backlog message(s).",
  "cmd.queue.enqueued": "📥 Queued: won't interrupt the current task; it runs automatically once idle.",
  "cmd.interrupt.usage": "Usage: /interrupt <new instruction> — interrupt the current task and send the new one at once.",
  "cmd.interrupt.idle": "▶️ Nothing is running; the new instruction was sent directly.",
  "cmd.interrupt.done": "🛑 Interrupted; the new instruction has been sent.",
  "cmd.last.none": "💤 Nothing to repeat (no assistant output in this session yet).",
  "cmd.cyclemodel.none": "❌ No models to cycle (was the model list not restricted at startup?). Use /model <provider/id> to set one directly.",
  "cmd.cyclemodel.ok": "✅ Model switched: {model} (thinking: {thinking})",
  "cmd.cyclethinking.none": "❌ No thinking level to cycle.",
  "cmd.cyclethinking.ok": "✅ Thinking level rotated to: {level}",
  "cmd.autocompact.usage":
    "Auto-compaction: {state}\nUsage: /autocompact on|off (instance-wide: written to pi's global settings — toggling it in one project room affects all of them)",
  "cmd.autocompact.ok": "✅ Auto-compaction {state} (instance-wide).",
  "cmd.autoretry.usage":
    "Usage: /autoretry on|off\n(upstream exposes no status query; instance-wide: written to pi's global settings — toggling it in one project room affects all of them)",
  "cmd.autoretry.ok": "✅ Auto-retry {state} (instance-wide).",
  "cmd.switch.streaming": "⚠️ A task is streaming; run /stop before switching sessions.",
  "cmd.switch.usage": "Usage: /switch <number> — switch to a session listed by /sessions.",
  "cmd.switch.outOfRange": "❌ Number out of range: {index} (use /sessions to see the current list).",
  "cmd.switch.cancelled": "⚠️ Session switch cancelled by an extension",
  "cmd.switch.ok": "✅ Session switched: {file}",
  "cmd.attach.ok":
    "🔗 Session mirror enabled (this room ↔ TUI, two-way sync).\n" +
    "Run this command in a terminal to attach to the same session:\n" +
    "`{command}`\n\n" +
    "• Messages sent/received in the TUI are forwarded to this room in real time;\n" +
    "• When you come back and message this room, the context is carried over automatically (auto-relay while idle);\n" +
    "• Session directory: {dir}\n" +
    "• Use /detach to stop mirroring.",
  "cmd.attach.noSession": "💤 No session file yet (send a message to start a session), then run /attach again.",
  "cmd.attach.unavailable": "❌ Session mirroring is unavailable in this deployment.",
  "cmd.detach.ok": "✅ Session mirror stopped. TUI messages are no longer forwarded to this room.",
  "cmd.detach.notActive": "💤 No active session mirror.",
  "cmd.reload.allUnavailable": "❌ /reload all unavailable (multi-process enumeration is not enabled in this deployment).",
  "cmd.reload.allInProgress": "🔄 Restarting every pi process one by one (idle ones only, busy ones skipped)…",
  "cmd.reload.inProgress": "🔄 Restarting the pi process (extensions/skills/config will reload)…",
  "cmd.reload.ok": "✅ pi restarted, model: {model}",
  "cmd.reload.failed": "❌ Restart failed: {message}",
  "cmd.model.none": "No models available (no provider configured?)",
  "cmd.model.currentMarker": " ← current",
  "cmd.model.list": "Available models:\n{list}\n\nUsage: /model <provider/model-id>",
  "cmd.model.notFound": "❌ Model \"{id}\" not found. Use /models to see the available list.",
  "cmd.model.ok": "✅ Model switched: {model}",
  "cmd.thinking.usage":
    "Current thinking level: {level}\nAvailable levels: off, minimal, low, medium, high, xhigh, max\nUsage: /thinking <level>",
  "cmd.thinking.ok": "✅ Thinking level set to: {level}",
  "cmd.session.sessionId": "📊 Session: {id}",
  "cmd.session.messages": "messages: {count}",
  "cmd.session.tokens": "tokens: {count}",
  "cmd.session.cost": "cost: {cost}",
  "cmd.status.ok": "⚙️ Model: {model}\nStreaming: {streaming}",
  "cmd.name.usage": "Usage: /name <session name>",
  "cmd.name.ok": "✅ Session named: {name}",
  "cmd.export.ok": "✅ Exported: {path}",
  "cmd.bash.usage": "Usage: /bash <shell command> — run in pi's working directory and write to context",
  "cmd.bashstop.none": "💤 No bash commands running.",
  "cmd.bashstop.running": "(running for {elapsed})",
  "cmd.bashstop.ok": "⏹ Abort requested for {count} running command(s):\n{lines}\nCaptured output of each will follow as separate replies.",
  "cmd.skills.header": "📚 Installed skills:\n{lines}",
  "cmd.skills.group": "{label}:\n{lines}",
  "cmd.skills.group.user": "User-level",
  "cmd.skills.group.project": "Project-level",
  "cmd.skills.group.other": "Other",
  "cmd.skills.empty":
    "💤 No skills installed yet. Drop skills into these directories:\n" +
    "• User-level: ~/.agents/skills/ or ~/.pi/agent/skills/\n" +
    "• Project-level: <workdir>/.agents/skills/ or <workdir>/.pi/skills/",
  // ── /mcp command family (spec #246: MCP server management, command-map.ts)
  // Reply-safety rule: --env/--header values never reach a reply (redacted in
  // the command layer); these templates only take server names and
  // pre-formatted diagnostics.
  "cmd.mcp.unavailable":
    "❌ MCP management unavailable ({detail}).\nThe local pi may be missing or too old: the mcp subcommand requires pi ≥ 1.0.",
  "cmd.mcp.unwired": "❌ MCP management is not enabled in this deployment.",
  "cmd.mcp.forbidden": "❌ /mcp is admin-only (in multi-project mode, management room only).",
  "cmd.mcp.usage":
    "Usage:\n" +
    "• /mcp — show MCP server status\n" +
    "• /mcp add <name> (--url <address> | -- <command> [args...])\n" +
    "• /mcp remove <name>\n" +
    "• /mcp login <name> [--timeout seconds]\n" +
    "• /mcp logout <name>\n" +
    "• /mcp help — details",
  "cmd.mcp.help":
    "**MCP server management** (executed via the pi mcp subcommand):\n" +
    "\n" +
    "• `/mcp` or `/mcp list` — server status card (connection/tools/scope; needs-auth servers include a login hint)\n" +
    "• `/mcp add <name> --url <address>` — add a remote server\n" +
    "• `/mcp add <name> -- <command> [args...]` — add a local server (everything after `--` is passed through verbatim)\n" +
    "  Optional: `--env K=V`, `--header K=V` (repeatable), `--cwd <dir>`, `--description <text>`, `--exposure <mode>`\n" +
    "  ⚠️ `--env`/`--header` values are never echoed to the chat and never reach the audit log\n" +
    "• `/mcp remove <name>` — remove a server\n" +
    "• `/mcp login <name> [--timeout seconds]` — authorize a login (default 300s, cap 600s; the link is posted to this room)\n" +
    "• `/mcp logout <name>` — log out a server\n" +
    "\n" +
    "Semantics: **logins take effect immediately** (running sessions pick them up on the next turn — no /reload needed);\n" +
    "**adds/removals need /reload** (use /reload all for multiple projects).",
  "cmd.mcp.list.checking": "⏳ Checking MCP server status…",
  "cmd.mcp.list.failed": "❌ Failed to fetch MCP server status: {message}",
  "cmd.mcp.add.usage":
    "Usage: /mcp add <name> (--url <address> | -- <command> [args...])\n" +
    "Examples: /mcp add docs --url https://mcp.example.com/mcp\n" +
    "          /mcp add fs -- npx -y @modelcontextprotocol/server-filesystem /tmp\n" +
    "Optional: --env K=V, --header K=V (both repeatable), --cwd <dir>, --description <text>, --exposure <mode>",
  "cmd.mcp.add.localUnsupported": "❌ The --local scope is not supported yet: remove the option and retry.",
  "cmd.mcp.add.ok":
    "✅ MCP server \"{name}\" added.\nSend /reload to apply (use /reload all for multiple projects); check status with /mcp list.",
  "cmd.mcp.add.failed": "❌ Failed to add the MCP server: {message}",
  "cmd.mcp.remove.usage": "Usage: /mcp remove <name> (see /mcp list for names)",
  "cmd.mcp.remove.ok": "✅ MCP server \"{name}\" removed.\nSend /reload to apply (use /reload all for multiple projects).",
  "cmd.mcp.remove.failed": "❌ Failed to remove the MCP server: {message}",
  "cmd.mcp.login.usage": "Usage: /mcp login <name> [--timeout seconds] (default 300s, cap 600s)",
  "cmd.mcp.login.started": "🔑 Starting the login for MCP server \"{server}\"… the authorization link will follow in this room.",
  "cmd.mcp.login.busy": "⚠️ A login is already in progress: \"{server}\". Wait for it to finish or time out before starting another.",
  "cmd.mcp.login.authUrl":
    "🌐 Open the link below in a browser to authorize MCP server \"{server}\":\n" +
    "{url}\n\n" +
    "⚠️ The redirect may point at 127.0.0.1: if pi runs on a remote machine (SSH scenario), set up port forwarding first (e.g. `ssh -L <port>:127.0.0.1:<port> <host>`) before opening the link.\n" +
    "A receipt arrives automatically once authorization completes; logins take effect immediately — no /reload needed.",
  "cmd.mcp.login.done": "✅ MCP server \"{server}\" signed in. Takes effect immediately: running sessions pick it up on the next turn — no /reload needed.",
  "cmd.mcp.login.already": "ℹ️ MCP server \"{server}\" is already signed in — nothing to do.",
  "cmd.mcp.login.failed": "❌ MCP server \"{server}\" sign-in failed{codeSuffix}: {message}",
  "cmd.mcp.login.failedCode": " (exit code {code})",
  "cmd.mcp.login.expired": "⌛ MCP server \"{server}\" sign-in timed out ({timeoutSec}s). Retry with /mcp login {server} once the network is reachable.",
  "cmd.mcp.logout.usage": "Usage: /mcp logout <name> (see /mcp list for names)",
  "cmd.mcp.logout.ok": "✅ MCP server \"{server}\" signed out. Send /mcp login {server} when re-authorization is needed.",
  "cmd.mcp.logout.failed": "❌ Failed to sign out the MCP server: {message}",
  // Tokenizer errors (reach the chat via the add/remove/logout usage receipts).
  "cmd.mcp.tokenize.unclosedSingle": "A single quote is not closed",
  "cmd.mcp.tokenize.unclosedDouble": "A double quote is not closed",
  "cmd.mcp.tokenize.danglingBackslash": "A backslash has no following character",
  // Status card (/mcp list → formatMcpStatusCard): all via t(), zh is the key-set baseline.
  "cmd.mcp.card.empty":
    "No MCP servers configured yet.\n" +
    "Add a remote server: /mcp add <name> --url <address>\n" +
    "Add a local server: /mcp add <name> -- <command> [args...]\n" +
    "Send /reload afterwards to apply (use /reload all for multiple projects).",
  "cmd.mcp.card.header": "MCP servers ({count}):",
  "cmd.mcp.card.server": "• {name} — {state} | {exposure} | {scope}",
  "cmd.mcp.card.transport": "  transport: {transport}",
  "cmd.mcp.card.needsAuth": "  sign-in required: send /mcp login {server} to get an authorization link",
  "cmd.mcp.card.tools": "  tools ({count}): {tools}{more}",
  "cmd.mcp.card.toolsMore": " …and {count} more",
  "cmd.mcp.card.resources": "  resources: {count}, URI templates: {templates}",
  "cmd.mcp.card.serverError": "  ⚠ {error}",
  "cmd.mcp.card.errorsHeader": "Config errors:",
  "cmd.mcp.card.errorLine": "• {message}",
  "cmd.mcp.card.note": "Note: {note}",
  // Localized state words for pi list --json; unknown states pass through in code, not here.
  "cmd.mcp.state.connected": "connected",
  "cmd.mcp.state.needsAuth": "needs auth",
  "cmd.mcp.state.disabled": "disabled",
  "cmd.mcp.state.connecting": "connecting",
  "cmd.mcp.state.unknown": "unknown",
  // Execution-seam diagnostic prefixes (mcp-cli / mcp-login-flow feed {message}/{detail}).
  "cmd.mcp.detail.spawnFailed": "Failed to start the pi CLI: {message}",
  "cmd.mcp.detail.unknownSubcommand": "pi does not know this mcp subcommand: {detail}",
  "cmd.mcp.detail.cliLocate": "Cannot locate the pi CLI: {message}",
  "cmd.mcp.login.seamError": "The login execution seam threw: {message}",
  "cmd.mcp.login.noSuccessMark": "pi exited without printing a sign-in success marker",
  "cmd.mcp.login.exitCode": "pi mcp login exited with code {code}",
  // Fallback diagnostics for short commands with no stderr tail: kept in the
  // dual tables so an English deployment never mixes languages (review cleanup).
  "cmd.mcp.detail.timeout": "{label} timed out after {seconds}s and was terminated",
  "cmd.mcp.detail.listUnparsable": "pi mcp list returned no parsable JSON",
  "cmd.mcp.detail.listUnparsableDetail": "pi mcp list returned no parsable JSON: {detail}",
  "cmd.mcp.detail.exitCode": "pi mcp {sub} exited with code {code}",
  "cmd.mcp.detail.exitCodeUnknown": "pi mcp {sub} exited with an unknown code",
  // Downgrade hint for a mutating command that exited 0 with no confirmation shape
  // (an older pi treated the command as a prompt).
  "cmd.mcp.add.unverified":
    "⚠️ pi's output lacks the expected add confirmation: an older pi (<1.0) may have treated this command as a plain prompt and done nothing. Verify with /mcp list; upgrade pi to ≥ 1.0 if it is outdated.",
  "cmd.mcp.remove.unverified":
    "⚠️ pi's output lacks the expected removal confirmation: an older pi (<1.0) may have treated this command as a plain prompt and done nothing. Verify with /mcp list; upgrade pi to ≥ 1.0 if it is outdated.",
  "cmd.mcp.logout.unverified":
    "⚠️ pi's output lacks the expected sign-out confirmation: an older pi (<1.0) may have treated this command as a plain prompt and done nothing. Send /mcp login {server} again — an \"already signed in\" reply means the credentials are still there; upgrade pi to ≥ 1.0 if it is outdated.",
  "cmd.help.group.pi":
    "**Pi-native commands** (same as the pi TUI, executed over RPC):\n" +
    "\n" +
    "【Session & context】\n" +
    "• `/new` — new session (alias `/clear`)\n" +
    "• `/compact [note]` — compact the context\n" +
    "• `/name <name>` — name the session\n" +
    "• `/session` — session stats and cost\n" +
    "• `/export [path]` — export the session as HTML\n" +
    "\n" +
    "【Models & thinking】\n" +
    "• `/model` / `/model <provider/id>` — view / switch model\n" +
    "• `/thinking [level]` — view / set the thinking level\n" +
    "\n" +
    "【Lifecycle】\n" +
    "• `/reload` — restart the pi process (after installing extensions / changing config); `/reload all` — restart every process of this instance (idle ones only, busy skipped)",
  "cmd.help.group.bridge":
    "**Bridge-only commands** (not in the pi TUI; implemented by this project):\n" +
    "\n" +
    "【Session navigation & recap】\n" +
    "• `/sessions` — list recent sessions (by modification time)\n" +
    "• `/switch <number>` — switch to a session from /sessions (run /stop first while streaming)\n" +
    "• `/last` — repeat the agent's latest reply\n" +
    "• `/recap` — generate a handoff card for this session (a summary for the session that takes over)\n" +
    "\n" +
    "【Skills】\n" +
    "• `/skills` — list installed skills (grouped by user/project level; each line is the invocation form)\n" +
    "\n" +
    "【Models & thinking (enhanced)】\n" +
    "• `/models` — list available models\n" +
    "• `/cyclemodel` / `/cyclethinking` — rotate to the next model / thinking level\n" +
    "• `/autocompact on|off` — auto-compaction toggle (instance-wide: written to pi's global settings; toggling in one project room affects all)\n" +
    "• `/autoretry on|off` — auto-retry toggle (instance-wide, same as above)\n" +
    "\n" +
    "【Run control】\n" +
    "• `/status` — current model and state\n" +
    "• `/stop` — stop all tasks immediately (≈ TUI Esc; alias `/abort`)\n" +
    "• `/interrupt <new instruction>` — interrupt the current task and send the new one (single message)\n" +
    "• `/queue [text]` — no args: view the queue; with text: queue without interrupting (≈ Alt+Enter)\n" +
    "• `/update [check|force|cancel]` — self-update without interrupting tasks (check for a new version / force past the busy wait / cancel the wait; management room only)\n" +
    "\n" +
    "【Shell execution】\n" +
    "• `/bash <command>` — run a shell command (written to context)\n" +
    "• `! <command>` — quick shell execution (≈ TUI `!`; output written to context; a space is required after `!`)\n" +
    "• `!! <command>` — same, but output is NOT written to context (≈ TUI `!!`)\n" +
    "• `/bashstop` — list and abort running bash commands (shared by `!`/`!!`/`/bash`)\n" +
    "\n" +
    "【Timed reminders】\n" +
    "• `/remind <time> <text>` — a timed reminder (persisted before it runs, survives restarts; e.g. /remind 30m brew tea)\n" +
    "• `/remind list` / `/remind rm <n>` — view / cancel this room's reminders\n" +
    "\n" +
    "【MCP servers】\n" +
    "• `/mcp` — show MCP server status (connection/tools/scope)\n" +
    "• `/mcp add <name> (--url <address> | -- <command> [args...])` — add a server (--env/--header values are never echoed)\n" +
    "• `/mcp remove <name>` — remove a server (send /reload after adds/removals; /reload all for multiple projects)\n" +
    "• `/mcp login <name> [--timeout seconds]` — authorize a login (link posted to this room; takes effect immediately, no /reload)\n" +
    "• `/mcp logout <name>` — sign out a server\n" +
    "• `/mcp help` — MCP command details\n" +
    "\n" +
    "【Session mirror】\n" +
    "• `/attach` — enable the TUI ↔ Matrix session mirror (replies with a command to run in a terminal for two-way sync)\n" +
    "• `/detach` — stop the session mirror",
  "cmd.help.passthrough":
    "**Passthrough**: `/skill:<name>`, prompt templates and extension commands run directly; plain text goes to the model. Use /skills to list installed skills.",

  // ── cmd.update (/update hot-update command family) ────────────────────
  "cmd.update.unavailable": "ℹ️ /update is not available in this deployment.",
  "cmd.update.notManagementRoom": "❌ /update can only be used in the management room.",
  "cmd.update.rootDenied":
    "❌ The bridge is running as root; /update refuses to proceed (npm script privilege risk). Use the stop-the-world update instead: pi-courier update.",
  "cmd.update.rejectedArgs":
    "❌ /update takes no version, URL or path arguments (single source: npm's latest tag). Valid: /update, /update check, /update force, /update cancel.",
  "cmd.update.check.upToDate": "✅ Already up to date (v{version}).",
  "cmd.update.check.hasNew": "🆕 New version available: v{from} → v{to}. Send /update to start (running tasks are not interrupted).",
  "cmd.update.check.failed": "❌ Version check failed: {message}",
  "cmd.update.started": "🚀 Update started: v{from} → v{to} (tasks keep running during the upgrade; an idle restart follows).",
  "cmd.update.busyWaiting": "⏳ {count} task(s) running; the update starts automatically once idle (cancelled after {minutes} min; queued messages keep flowing).",
  "cmd.update.unreachableNote": "({count} instance(s) not queryable right now — pi restart window; waiting for them too.)",
  "cmd.update.waitProgress": "⏳ Still waiting for the update: {count} task(s) running ({minutes} min elapsed).",
  "cmd.update.waitingUnreachableOnly":
    "⏳ Cannot confirm all instances idle right now ({count} instance(s) failed to query or are in a restart window); the update starts automatically once they are (cancelled after {minutes} min; queued messages keep flowing).",
  "cmd.update.restartWait": "🔄 New code is on disk; the service restarts automatically once all tasks are idle (cancelled after {minutes} min — pi-courier restart works manually anytime).",
  "cmd.update.restartProgress": "🔄 Waiting to restart: {count} task(s) running ({minutes} min elapsed).",
  "cmd.update.waitTimeout": "⏰ Gave up waiting for idle after {minutes} min — update cancelled. Retry with /update force once tasks finish.",
  "cmd.update.cancelled": "🛑 Update wait cancelled.",
  "cmd.update.noPending": "ℹ️ No update in progress.",
  "cmd.update.inProgress": "⏳ An update is already in progress (use /update cancel to cancel the wait).",
  "cmd.update.npmFailed": "❌ Upgrade failed: {message}\nThe old version keeps running; the bridge is unaffected.",
  "cmd.update.installed": "📦 New code is on disk: v{from} → v{to} (this process still runs the old version).",
  "cmd.update.restarting": "🔄 All tasks idle — restarting the service to load the new version…",
  "cmd.update.restartFailed": "⚠️ Automatic restart failed ({message}): the new code is on disk — run pi-courier restart manually.",
  "cmd.update.manualRestart":
    "ℹ️ New code is on disk (v{from} → v{to}). This bridge is not managed by an active systemd unit (or no systemd) — run pi-courier restart manually to apply.",
  "cmd.update.manualRestartHint":
    "⚠️ New code is on disk (v{from} → v{to}) but tasks never went idle / the wait was cancelled. Run pi-courier restart when idle (the completion notice still arrives after the restart).",
  "cmd.update.done": "✅ Update complete: v{from} → v{to}.",
  "cmd.update.doneVersionMismatch": "⚠️ On-disk version (v{actual}) differs from the expected v{to} — the update may not have applied.",

  // ── router ────────────────────────────────────────────────────────────
  "common.unknownError": "unknown error",
  "router.turn.failed": "❌ Turn failed: {message}",
  "router.attach.inject": "The user sent attachment(s) (view them with the read tool):",
  "router.attach.inject.sourced": "Attachment(s) from {user} in room {room} (view them with the read tool):",
  "router.quote.prefix": "\"Quoted from @{user}'s earlier message: {excerpt}\"",
  "audit.degraded": "⚠️ Audit log unavailable — the service keeps running but sensitive actions leave no trace: {message}",

  // ── resilience (process resilience, spec #247) ────────────────────────
  "crash.notice": "💥 The bridge hit an uncaught error and will exit in order: {reason}",
  "resilience.diskSoft": "⚠️ Disk space is running low: {free}MB left (soft threshold {threshold}MB). Please clean up soon; the process exits automatically below the hard threshold of {hard}MB.",
  "resilience.diskRecovered": "✅ Disk space has recovered: {free}MB left (soft threshold {threshold}MB). Alert cleared.",
  "resilience.diskHardExit": "🚨 Disk space is below the hard threshold: {free}MB < {threshold}MB. The process will exit in order.",
  "resilience.heapAlert": "⚠️ Heap usage exceeded the limit: {percent}% (threshold {threshold}%). A memory leak is possible — please investigate.",
  "resilience.writeFailure": "⚠️ Disk write failure ({code}); {count} failure(s) aggregated (sources: {sources}). No repeat alert within 5 minutes.",
  "resilience.rpcRespawnGaveUp": "🚨 The pi process ({label}) crashed {count} times in a row — automatic respawn gave up. Investigate manually, then use /reload to recover.",
  "resilience.rpcLabelDefault": "default process",  "guest.denied": "🚫 This command requires trusted-user permission: {command}",
  "router.attach.saved": "📎 Attachment saved: {path} ({bytes})\nIt will be attached automatically with your next message.",
  "router.payload.unsupported":
    "🤷 Unsupported message type ({msgtype}) — ignored. You can send text, images and files directly.",
  "router.enable.usage": "Usage: /enable <all|mentions|trusted-only> (in this room)",
  "router.enable.allAdminOnly": "❌ The all mode is admin-only (use trusted-only or mentions instead)",
  "router.enable.ok": "✅ Room enabled (mode: {mode})",
  "router.multiproject.forbidden": "❌ Not allowed (only trusted users can toggle multi-project mode)",
  "router.multiproject.currentOn": "multi-project mode (on)",
  "router.multiproject.currentOff": "single-project mode (off)",
  "router.multiproject.noChange": "Already {current}; nothing to switch.",
  "router.multiproject.switched": "✅ Multi-project mode {state}.\nTakes effect on restart: run `pi-courier restart` ({detail})",
  "router.multiproject.detailOn": "after restart, the management room / project rooms /pmctl become available",
  "router.multiproject.detailOff": "after restart, every room connects straight to the default pi",
  "router.multiproject.usage":
    "Current: {current}\n\nUsage:\n/multiproject on  — enable multi-project (restart to apply)\n/multiproject off — back to single-project (restart to apply)",
  "router.login.forbidden": "❌ Not allowed (only the admin can manage provider logins)",
  "router.login.roomRestricted":
    "❌ Login management is only available in the management room (in single-project mode, any DM with the bot works)",
  "router.login.logoutUsage": "Usage: /logout <provider>",
  "router.bang.inProgress": "⏳ Running: {command}{suffix} — the result will follow as a reply; /bashstop can abort it.",
  "router.prompt.failed": "❌ Could not send to pi: {message}",
  "router.rpc.startFailed": "❌ Could not start the pi process: {message}",
  "router.retry.inProgress": "⚠️ Call failed, retrying {attempt}/{max}: {error}",
  "router.retry.exhausted": "❌ Auto-retry exhausted: {error}",
  "router.fallback.switched":
    "⚠️ {count} consecutive failed turns — switched the model automatically: {from} → {to}. Send /model {from} to switch back once the provider recovers.",
  "router.fallback.exhausted":
    "❌ {count} consecutive failed turns — the fallback chain ({chain}) is exhausted, no more automatic switching. Pick a model manually via /model.",
  "router.fallback.switchFailed":
    "⚠️ {count} consecutive failed turns — the automatic switch to {to} failed: {message}. Use /model to switch manually.",
  "router.preset.applied": "📋 Project presets applied: {items}",
  "router.preset.failed": "⚠️ Failed to apply project presets: {message} (the process is ready — set /model and /thinking manually)",
  "startup.preset.badModelRef": "⚠️ Config {path}: \"{value}\" is not a valid provider/id reference — the entry will be skipped",
  "startup.preset.badThinkingLevel": "⚠️ Config {path}: \"{value}\" is not a valid thinking level (one of: {allowed})",
  "startup.preset.badFallbacksList": "⚠️ Config {path}: expected an array of strings — the field is ignored",
  "router.extensionError": "⚠️ Extension error ({path}): {error}",

  // ── mirror (TUI ↔ Matrix session mirror, session-mirror.ts / router) ──
  "mirror.user": "🖥 **TUI user** › {text}",
  "mirror.assistant": "🤖 **TUI assistant** › {text}",
  "mirror.fork.warning":
    "⚠️ Session fork detected (the TUI process never re-reads the session file, so writing in the TUI after a Matrix-side reply branches off the old node; or the TUI switched tree branches).\n" +
    "Relay keeps following the newest branch; if the context feels off, /resume the session in the TUI to converge both ends.",
  "mirror.relay.failed": "⚠️ Auto-relay of session context failed (the message still goes out, but may miss the latest TUI conversation): {message}",
  "mirror.newSession.notice":
    "🆕 The TUI wrote to a DIFFERENT session ({file}) — Matrix is on another one, and their contexts are unrelated (messages keep mirroring).\n" +
    "To bring Matrix to that session: send /sessions and /switch <number>, or /attach again for the fresh attach command.",
  "cmd.new.mirrorHint":
    "ℹ️ The session mirror is still active for this room (TUI messages keep forwarding), but the attach command in your terminal now points at the old session — run /attach again for the new one.",

  // ── xq ────────────────────────────────────────────────────────────────
  "xq.untitled": "(untitled)",
  "xq.confirm.how": "Reply y / n (send \"cancel\" to back out)",
  "xq.select.how": "Reply with a number to choose (send \"cancel\" to back out)",
  "xq.input.how": "Reply directly with the content as the answer (send \"cancel\" to back out)",
  "xq.confirm.invalid": "⚠️ Please reply y or n (send \"cancel\" to back out)",
  "xq.select.invalid": "⚠️ Please reply with a number between 1 and {max} (send \"cancel\" to back out)",
  "xq.notify": "Extension notification: {message}",
  "xq.expired": "⌛ Question \"{title}\" timed out without an answer; treated as cancelled",
  "xq.answer.lost": "❌ Could not deliver the answer to pi (the process may have exited)",
  "xq.answer.cancelled": "Cancelled",
  "xq.answer.ok": "✅ Answer delivered",

  // ── auth ──────────────────────────────────────────────────────────────
  "auth.help.admin":
    "**Admin commands**:\n" +
    "\n" +
    "【Provider credentials】(admin + management room only)\n" +
    "• `/login [provider [oauth|api_key]]` — no args: list login-able providers; with args: headless login (pi-native)\n" +
    "• `/logout <provider>` — delete a provider credential (pi-native)\n" +
    "• `/auth` — view saved provider credentials\n" +
    "\n" +
    "【Permissions & rooms】(trusted users)\n" +
    "• `/enable <room> <all|mentions|trusted-only>` — enable the bot in a room (in a group chat, sending `/enable <mode>` alone enables that group; the `all` mode requires the admin)\n" +
    "• `/disable <room>` — disable a room\n" +
    "• `/channels` — list enabled rooms and their modes\n" +
    "• `/trusted` — list trusted users\n" +
    "• `/revoke <user>` — revoke a user's trusted status\n" +
    "• `/toggletools` — toggle tool-call visibility (when hidden, tool calls stop appearing in the chat)\n" +
    "\n" +
    "【Multi-project & projects】(management room)\n" +
    "• `/multiproject on|off` — multi-project mode toggle (restart to apply)\n" +
    "• `/pmctl new <name> <path>` — create a project\n" +
    "• `/pmctl list` — project list\n" +
    "• `/pmctl show|rm|mv|rename` — project details / delete / move / rename (rm needs a second confirmation; after confirming, the process stops and the bot leaves the room)\n" +
    "\n" +
    "**Pairing**: DM the bot for the first time → a 6-digit code appears in the bot's terminal and the management room → enter it in the chat where you received the prompt to become a trusted user (the first trusted user = admin). Group chats are enabled by a trusted user sending `/enable <mode>` in the group.",
  "auth.pairing.noPendingHint":
    "ℹ️ No pairing in progress. To pair, DM the bot first; you will receive a 6-digit code — reply with it here.",
  "setup.token.verifyKeptFailed": "⚠️ Could not verify the kept token ({message}) — kept as-is; re-run `pi-courier setup` if login fails at startup.",
"auth.challenge.promptFailed":
    "⚠️ Pairing prompt could not be sent ({message}) — please relay the code {code} to the user manually.",
  "auth.challenge.prompt":
    "🔐 Please enter the 6-digit code provided by the bot admin — here in this chat.\n⏱️ Expires in 2 minutes.",
  "auth.pairing.success": "✅ Authenticated! You can now chat with the agent.",
  "auth.pairing.expired": "⏱️ Challenge expired. Send any message to get a new code.",
  "auth.pairing.tooManyAttempts": "🚫 Too many failed attempts. Blocked for {minutes} minutes.",
  "auth.pairing.wrongCode": "❌ Wrong code. {attempts} attempts remaining.",
  "login.noProviders": "No login-able providers.",
  "login.authenticated": "✅ authenticated ({types})",
  "login.providersList": "🔐 Login-able providers ({count}):\n{lines}\n\nRun /login <provider> <oauth|api_key> to start a login.",
  "login.noCredentials": "💤 No saved credentials yet (log in with /login <provider> <oauth|api_key>).",
  "login.credentialsList": "🔐 Saved credentials ({count}):\n{lines}",
  "login.secret.line2": "Reply directly with the secret.",
  "login.secret.line3": "⚠️ The secret stays in the room history; consider deleting the message afterwards (send \"cancel\" to back out)",
  "login.manualCode.how":
    "Paste back the full URL the browser finally redirects to after authorizing (send \"cancel\" to back out)",
  "login.pendingInRoom": "⚠️ A login flow is already running in this room (send \"cancel\" to abort it first).",
  "login.unknownProvider": "❌ Unknown provider: {id} (use /login to see the login-able list)",
  "login.usage": "Usage: /login <provider> <oauth|api_key>",
  "login.chooseMethod": "⚠️ {id} supports multiple login methods ({methods}); pick one:\n/login {id} oauth\n/login {id} api_key",
  "login.unsupportedMethod": "❌ {id} does not support {method} login (supported: {methods})",
  "login.started": "🔑 Started the {id} {method} login flow; follow the prompts (send \"cancel\" at any time to abort).",
  "login.cancelled": "🛑 Cancelled the {id} login flow",
  "login.noStoredCred": "❌ {id} has no saved credential (use /auth to check)",
  "login.logoutOk":
    "✅ Deleted the {id} credential. Running pi processes keep the old one in memory until restarted — run /reload all once idle to apply the logout.",
  "login.logoutFailed": "❌ Logout failed: {message}",
  "login.readFailed": "❌ Failed to read credentials: {message}",
  "login.success": "✅ {id} login succeeded; credential written to {path}",
  "login.failed": "❌ {id} login failed: {message}",
  "login.authUrl": "🌐 Open the following link in your browser to authorize:\n{url}",
  "login.deviceCode": "🔑 Device code: {code}",
  "login.deviceCodeOpen": "Open {uri} in your browser and enter the device code above.",
  "login.expiresMinutes": "(valid for about {minutes} minutes)",

  // ── mgmt / space ──────────────────────────────────────────────────────
  "common.unknownAccount": "(unknown)",
  "mgmt.name": "Project Management ({name})",
  "mgmt.groupJoinHint":
    "🤖 I've joined this group but don't respond to messages by default.\n\n" +
    "To enable me: send /enable trusted-only in the group\n" +
    "(or all = respond to everyone / mentions = only respond when @mentioned; trusted users only)",
  "mgmt.help":
    "🏗️ **Project management room** ({instanceName})\n\n" +
    "• bot account: `{botAccount}`\n" +
    "• default workdir: `{workdir}`\n\n" +
    "This is the management console of this instance. Sending a message here = talking to pi in the default project ({workdir}).\n\n" +
    "📁 **Project management** (this room only)\n" +
    "• `/pmctl new <name> [path]` — create a project (creates a private room and invites you)\n" +
    "• `/pmctl list` — project list\n" +
    "• `/pmctl show|rm|mv|rename` — project details / delete / move / rename\n\n" +
    "⚡ **Common commands**\n" +
    "• `/stop` — stop the current task\n" +
    "• `/reload` — restart the pi process\n" +
    "• `/help` — full help",
  "mgmt.adminPowerNote": "🛡️ Trusted users automatically get room admin permissions (including new project rooms).",
  "space.linkFailedMgmt": "Failed to link the management room into the space (auto-retried next start; the room stays usable): {message}",
  "space.linkFailed": "Failed to link into the space (the project is unaffected): {message}",
  "space.avatarFailed": "Failed to set the avatar (auto-retried next start): {message}",
  "space.badAvatarFile": "Invalid avatar file name: {file}",

  // ── label ─────────────────────────────────────────────────────────────
  "label.empty": "Project name must not be empty",
  "label.noBrackets": "Project name must not contain square brackets [ ] (they would break the log format)",
  "label.noWhitespace": "Project name must not contain whitespace",
  "label.tooLong": "Project name is limited to {max} characters (got {length})",
  "label.caseClash":
    "Project name \"{name}\" differs from existing project \"{clash}\" only by letter case (log filtering matches by name and would be ambiguous)",

  // ── path (Windows path guards, win32-path.ts, issue #190) ─────────────
  "path.win32.reserved":
    "❌ This path is unusable on Windows: \"{component}\" is a reserved device name (CON/PRN/AUX/NUL/COM1-9/LPT1-9); pick another name",
  "path.win32.illegalChars":
    "❌ This path is unusable on Windows: \"{component}\" contains an illegal character (one of < > : \" | ? *)",
  "path.win32.tooLong":
    "❌ This path is too long: {length} characters, over the Windows limit (259); use a shorter path",
  "path.win32.dupWorkdir":
    "❌ This path points at the same directory as another project's workdir on Windows (NTFS is case-insensitive):\n• existing project: {name} — {workdir}\nSharing one directory would share the session state; pick another path",

  // ── pmctl ─────────────────────────────────────────────────────────────
  "pmctl.singleProjectMode":
    "❌ This is single-project mode; project management is off.\nTo go multi-project: send `/multiproject on` and restart (pi-courier restart).",
  "pmctl.managementRoomOnly": "❌ /pmctl is only available in the management room (a DM with the bot)",
  "pmctl.matrixOnly": "❌ /pmctl unavailable (Matrix deployments only)",
  "pmctl.unknownOp": "❌ Unknown operation: {op}\nAvailable: new / list / show / rm / mv / rename",
  "pmctl.new.usage":
    "Usage: /pmctl new <project name> [path]\nPath is optional: defaults to a same-named directory under the project root (e.g. newapp → ~/Projects/newapp); relative and absolute paths work too.",
  "pmctl.noInviteTarget": "❌ No invite target (no trusted users configured)",
  "pmctl.new.elevationFailed": "⚠️ Room created, but granting admin to trusted users failed (set it manually): {message}",
  "pmctl.new.startFailed": "\n⚠️ The project process failed to start: {message} — the room is kept; the first message will retry automatically.",
  "pmctl.new.ok":
    "✅ Project \"{name}\" created!\n\n• room: {room}\n• workdir: {workdir}\n• you've been invited into the new room\n\nTalk to the project in its new room (isolated context and workdir).{notes}",
  "pmctl.new.failed": "❌ Failed to create the project: {message}",
  "pmctl.new.welcomeFailed": "\n⚠️ Failed to send the welcome message: {message}",
  "welcome.project.header": "👋 **{name} is online!**",
  "welcome.project.identity.model":
    "I'm the coding assistant for this project, powered by {stack}, current model: `{model}`.",
  "welcome.project.identity.plain": "I'm the coding assistant for this project, powered by {stack}.",
  "welcome.project.stack.both": "pi coding agent (v{piVersion}) · pi-courier (v{courierVersion})",
  "welcome.project.stack.piOnly": "pi coding agent (v{piVersion}) · pi-courier",
  "welcome.project.stack.courierOnly": "pi coding agent · pi-courier (v{courierVersion})",
  "welcome.project.stack.neither": "pi coding agent · pi-courier",
  "welcome.project.capabilities":
    "🛠️ What I can do\n" +
    "• Just message me: write code, fix bugs, answer questions — anything in this project's directory\n" +
    "• Send images or files: error screenshots welcome, I can read them\n" +
    "• `! ls` runs a bash command and keeps the result in context; `!! ls` runs it without\n" +
    "• `/remind 30m make tea` sets a reminder that survives restarts\n" +
    "• `/stop` interrupts anytime; `/recap` writes a handoff card",
  "welcome.project.try":
    "💡 Try it\n" +
    "• \"Give me an overview of this project's structure\"\n" +
    "• Send an error screenshot and ask \"what's going wrong here?\"",
  "welcome.project.helpHint": "Send **/help** to see all commands.",
  "pmctl.empty": "No projects yet (create one with /pmctl new <name> <path>)",
  "pmctl.statusRunning": "✅ running",
  "pmctl.statusStopped": "⏸️ not started",
  "pmctl.statusLazy": "⏸️ not started (lazy)",
  "pmctl.list": "**Project list** ({count}):\n{lines}",
  "pmctl.show.usage": "Usage: /pmctl show <project name|room ID>",
  "pmctl.notFound": "❌ Project not found: {target} (use /pmctl list)",
  "pmctl.show.ok":
    "📁 Project: {name}\n• room: {room}\n• workdir: {workdir}\n• status: {status}\n• session: {session}\n• presets: {presets}",
  "pmctl.show.noPresets": "none (follows the global defaults)",
  "pmctl.rm.usage": "Usage: /pmctl rm <project name|room ID>",
  "pmctl.rm.cancelled": "✅ Delete cancelled",
  "pmctl.rm.nothingPending": "No pending delete confirmation",
  "pmctl.rm.expired": "⏳ The previous confirmation expired ({seconds} s); please confirm again.",
  "pmctl.rm.done":
    "🗑️ Project \"{name}\" deleted\n• mapping removed and process stopped\n• workdir kept: {workdir} (delete it yourself if you want)\n• leaving the room now…",
  "pmctl.rm.unlinkFailed": "⚠️ Failed to remove from the space (a stale entry may remain; remove it manually): {message}",
  "pmctl.rm.leaveFailed": "⚠️ Failed to leave the room (you can remove the bot manually): {message}",
  "pmctl.leaveReason": "project deleted",
  "pmctl.rm.confirm":
    "⚠️ Delete project \"{name}\"?\n\nSend `/pmctl rm {name}` again to confirm.\nOnce confirmed, I stop the process and leave that room.\n(send `/pmctl rm cancel` to cancel)",
  "pmctl.mv.usage": "Usage: /pmctl mv <project name|room ID> <new path> (relative paths resolve against the project root)",
  "pmctl.pathEscape": "❌ Path escapes the project root: {path}\nUse a name inside the project root; for a location elsewhere, pass an absolute path or one starting with ~/",
  "pmctl.mv.done":
    "🚚 Project \"{name}\" moved\n• new workdir: {workdir}\n• the session restarts (the old session stays in the old directory's {sessionDir})",
  "pmctl.rename.usage": "Usage: /pmctl rename <project name|room ID> <new name>",
  "pmctl.rename.ok": "✏️ Project renamed to \"{name}\"",
  "pmctl.rename.roomFailed": " (room rename failed: {message})",
  "pmctl.rename.avatarFailed": " (avatar update failed: {message})",

  // ── attach / room / workdir / logs ────────────────────────────────────
  "attach.tooLarge":
    "Attachment too large ({declared} > limit {max}); not saved. Compress it and resend, or ask the admin to raise the attachments.maxMb setting.",
  "attach.downloadFailed": "Attachment download failed: {detail}",
  "attach.noMediaUrl": "The event carries no downloadable media URL",
  "attach.e2eeRequired": "Encrypted attachments require E2EE (encryption not enabled for this deployment, or the native crypto library unavailable)",
  "attach.downloadTimeout": "Download timed out ({seconds}s)",
  "attach.e2eeNativeMissing": "The E2EE crypto native library is unavailable; cannot decrypt the encrypted attachment",
  "room.notConnected": "Matrix not connected",
  "workdir.prompt": "No working directory configured. Enter the pi workdir [default {fallback}]: ",
  "logs.unknownLevel": "Unknown log level: {level} (choose: debug / info / warn / error)",
  "logs.noProjects": "(no projects right now)",
  "logs.projectsNotFound": "Project(s) not found: {unknown}\nAvailable projects: {list}",

  // ── cli ───────────────────────────────────────────────────────────────
  "cli.arg.deprecatedSetup": "⚠️  Deprecated flag; use `pi-courier setup` instead",
  "cli.arg.deprecatedCliPath": "⚠️  Deprecated flag; set cliPath in ~/.pi/pi-courier.json or PI_CLI_PATH instead",
  "cli.arg.deprecatedSessionDir": "⚠️  Deprecated flag; set sessionDir in ~/.pi/pi-courier.json instead",
  "cli.arg.deprecatedDebug": "⚠️  Deprecated flag; set debug: true in ~/.pi/pi-courier.json instead",
  "cli.arg.unknown": "⚠️  Ignoring unknown argument: {arg} (deprecated flags removed; use config or subcommands)",

  // ── setup ─────────────────────────────────────────────────────────────
  "setup.title": "=== pi-courier setup wizard ===",
  "setup.languagePrompt": "Language? [{def}] (en/zh): ",
  "setup.header": "Writes ~/.pi/pi-courier.json (mode 600; an existing config prefills the defaults — press Enter to keep them)\n",
  "setup.homeserver.default": "Matrix homeserver URL [default {def}]: ",
  "setup.homeserver.plain": "Matrix homeserver URL (e.g. https://matrix.example.com): ",
  "setup.homeserver.empty": "homeserver URL must not be empty",
  "setup.token.mode": "How to get the token [1=password login, 2=paste an existing token] (1): ",
  "setup.token.paste": "Paste the access token (syt_...): ",
  "setup.token.empty": "token must not be empty",
  "setup.token.valid": "✅ Token valid, account: {user}",
  "setup.token.username": "bot username (e.g. test2): ",
  "setup.token.password": "bot password: ",
  "setup.token.credsEmpty": "username/password must not be empty",
  "setup.token.loggingIn": "Logging in…",
  "setup.token.loginOk": "✅ Login succeeded, account: {user}{device}",
  "setup.token.loginDevice": " (device {id})",
  "setup.token.loginFailed": "Login failed (HTTP {status}): {body}",
  "setup.token.missingAccessToken": "login response has no access_token",
  "setup.token.whoamiFailed": "token verification failed (HTTP {status})",
  "setup.token.keep": "Keep the existing token? [Y/n]: ",
  "setup.token.kept": "✅ Keeping the existing token, account: {user}",
  "setup.token.hsChanged": "ℹ️  homeserver changed — the token must be re-acquired",
  "setup.admin.prompt": "Trusted user (admin) MXID [default {def}]: ",
  "setup.admin.badMxid": "the MXID must start with @, e.g. @barry:matrix.example.com",
  "setup.rooms.prompt":
    "Trusted room IDs (optional, Enter to skip; comma-separated, e.g. !abc:server or !abc:server:trusted-only): ",
  "setup.rooms.invalid": "   ⚠️ Skipping invalid room ID: {room} (must start with !)",
  "setup.e2ee.defaultYes": "Enable E2EE encryption? [Y/n] [default yes]: ",
  "setup.e2ee.plain": "Enable E2EE encryption? [y/N]: ",
  "setup.workdir.prompt": "pi workdir [default {def}]: ",
  "setup.attach.dirPrompt": "Attachment save directory [default {def}]: ",
  "setup.attach.mbPrompt": "Per-attachment size limit in MB [default {def}]: ",
  "setup.attach.mbInvalid": "the attachment size limit must be a positive integer (MB)",
  "setup.instance.prompt":
    "Instance/machine name (default {def}; tells multi-machine deployments apart, shown in the management room name): ",
  "setup.multiProject.prompt":
    "Enable multi-project mode? [y/N] (multi-project = management room + isolated project rooms with /pmctl; default N = single-project, one bot to one pi): ",
  "setup.space.promptYes":
    "Enable the organizational space? [Y/n] (groups the management/project rooms in an Element space; created on restart): ",
  "setup.space.promptNo":
    "Enable the organizational space? [y/N] (groups the management/project rooms in an Element space; created on restart): ",
  "setup.space.stateOn": "on (the space will be created on restart, grouping the management/project rooms)",
  "setup.proxy.default": "Outbound proxy URL [default {def}] (http/https; Enter keeps it): ",
  "setup.proxy.plain": "Outbound proxy URL (optional, http/https; Enter to skip): ",
  "setup.proxy.noProxy.default": "Proxy exemptions [default {def}] (comma-separated; Enter keeps them): ",
  "setup.proxy.noProxy.plain":
    "Proxy exemptions (optional; comma-separated hosts/domains/IP ranges, Enter to skip): ",
  "setup.proxy.envInvalid":
    "⚠️ Ignored an unusable proxy from the environment: {message}\n   (type a working http/https proxy here, or press Enter to skip)",
  "setup.proxy.exemptList": "exempt {list}",
  "setup.done.title": "\n✅ Config written to ~/.pi/pi-courier.json",
  "setup.done.account": "   account: {user}",
  "setup.done.trusted": "   trusted user: {user}",
  "setup.done.e2ee": "   E2EE: {state}",
  "setup.done.workdir": "   workdir: {workdir}",
  "setup.done.attachments": "   attachment dir: {dir} (limit {max} MB)",
  "setup.done.instance": "   instance name: {name} (differentiates multi-machine deployments; shown in the management room name)",
  "setup.done.multiProject": "   multi-project: {state}",
  "setup.done.multiProjectOff": "off (single-project)",
  "setup.done.space": "   space: {state}",
  "setup.done.deviceId": "   device ID: {id} (fixed; reused when you re-run setup — delete this field to get a new device)",
  "setup.done.rooms": "   trusted rooms: {rooms}",
  "setup.done.noRooms": "none (groups are ignored by default; add them later with /enable)",
  "setup.done.proxy": "   outbound proxy: {proxy}",
  "setup.done.proxyOff": "not configured (direct connection)",
  "setup.next": "\nNext: pi-courier enable (auto-start on boot) or pi-courier run (foreground)",
  "setup.failed": "\n❌ Setup failed: {message}",

  // ── cli / systemd bus hint ────────────────────────────────────────────
  "cli.usage": `pi-courier — run the pi coding agent from your messenger

Usage:
  pi-courier setup     first-run configuration wizard (Matrix account, trusted user, workdir)
  pi-courier run       run in the foreground (--workdir overrides the configured workdir)
  pi-courier enable    install a user-level systemd service (auto-start) and start it
  pi-courier start      start the service
  pi-courier stop       stop the service
  pi-courier restart    restart the service
  pi-courier status     show service status + recent logs (optional project filter)
  pi-courier logs      tail the service logs (Ctrl+C to exit); with multi-project, filter by project:
                       pi-courier logs <project> [project...] [--level debug|info|warn|error]
  pi-courier disable   uninstall the service (stop + remove from autostart + delete the unit file)
  pi-courier update    update this project (git pull + install deps + rebuild)
  pi-courier -v        show the installed version (--version / version also work)

Note: pi itself is installed and upgraded independently on the system
(npm i -g @earendil-works/pi-coding-agent); this project only ever updates itself.`,
  "cli.unknownCommand": "\n❌ Unknown command: {cmd}",
  "cli.enable.nodeTooOld":
    "⚠️  Node is v{version}; pi's undici needs Node >= 21. Install v24 via nvm and re-run this command.",
  "cli.enable.unitWritten": "📝 Wrote {path}",
  "cli.enable.failed": "❌ The service could not be enabled (the unit file was written, but the systemd operations failed: {steps}).",
  "cli.enable.ok": "✅ Service enabled and started (auto-start on boot).",
  "cli.enable.logsHint": "   logs: journalctl --user -u {unit} -f",
  "cli.systemctl.failed": "❌ systemctl {args} failed (exit code {status})",
  "cli.service.notInstalled": "❌ Service not installed. Run `pi-courier enable` first.",
  "cli.service.unsupportedPlatform":
    "❌ Service management ({cmd}) is Linux-only (systemd) for now. On Windows, run `pi-courier run` in the foreground; for autostart use Task Scheduler or wrap the bridge with NSSM — see the Windows section in the README.",
  "cli.service.statusFailed":
    "⚠️ The status query failed (exit code {status}) — the journald output below is HISTORY and does not mean the service is running.",
  "cli.service.singleProjectNoFilter":
    "❌ Single-project mode: logs are not tagged per project (project tags exist only in multi-project mode).",
  "cli.service.stopMarkerFailed":
    "⚠️ Could not write the manual-stop marker ({path}); if the watchdog is running, it may restart the service after it stops.",
  "cli.disable.notInstalled": "❌ Service not installed (the unit file does not exist).",
  "cli.disable.keptUnit":
    "ℹ️ The unit file was kept; after fixing the environment, re-run `pi-courier disable` or just `pi-courier enable`.",
  "cli.disable.ok": "✅ Service stopped and uninstalled. To restore later: `pi-courier enable` (your config is untouched).",
  "cli.update.stopping": "🛑 Stopping the service…",
  "cli.update.npmUpgrade": "🔄 Upgrading pi-courier via npm …",
  "cli.update.nativeSkipped": "   (the E2EE native library already exists; skipping the 21MB download)",
  "cli.update.npmFailed": "❌ npm upgrade failed (exit code {status})",
  "cli.update.gitUpgrade": "🔄 Updating pi-courier (git) …",
  "cli.update.cmdFailed": "❌ {cmd} failed (exit code {status})",
  "cli.update.serviceSkipped":
    "ℹ️ Not Linux: skipping the systemd service checks (no systemctl on this platform) and updating directly.",
  "cli.update.restarting": "🔄 Restarting the service…",
  "cli.update.restarted": "✅ Service restarted.",
  "cli.update.wasInactive": "\nℹ️  The service was not running before the update; it was not started.",
  "cli.update.startHint": "   To start it: pi-courier start",
  "cli.update.done": "\n✅ Update complete.",
  "hint.bus.ownerMismatch":
    "💡 XDG_RUNTIME_DIR={dir} (owned by uid {owner}) points at another user's session bus, while the current user is uid {euid}.",
  "hint.bus.connectFailed": "💡 Could not connect to the current user's systemd session bus (XDG_RUNTIME_DIR={dir}).",
  "hint.bus.unset": "unset",
  "hint.bus.unsetWithParens": "(unset)",
  "hint.bus.tail1":
    "   Common cause: switching users with `su <user>` (without -) inherited the original user's environment, or this shell lacks a full login session.",
  "hint.bus.tail2": "   Fix: export XDG_RUNTIME_DIR=/run/user/$(id -u) and retry, or switch again with `su - <user>`;",
  "hint.bus.tail3": "   if /run/user/$(id -u) does not exist, log in as that user once, or run loginctl enable-linger <user> as root.",

  // ── startup ───────────────────────────────────────────────────────────
  "startup.language.system":
    "language: {locale} (detected from the system locale; set \"language\" in ~/.pi/pi-courier.json or PI_LANGUAGE to override)",
  "startup.language.default":
    "language: {locale} (default; set \"language\" in ~/.pi/pi-courier.json or PI_LANGUAGE to override)",
  "startup.pairingNotice": "🔐 Pairing code for @{username}: {code} (valid for 2 minutes; send it to that user to pair)",

  // ── proxy (outbound proxy, spec #201 ticket #202) ──────────────────────
  "proxy.active":
    "🌐 outbound proxy: {proxy} (source: {source}; edit ~/.pi/pi-courier.json and restart to change)",
  "proxy.unsupportedScheme":
    "❌ Proxy \"{value}\" (from {origin}) is not supported in this version — only http/https proxies are supported; use an address starting with http:// or https://",
};

export default en;
