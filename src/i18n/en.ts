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
    "【Session mirror】\n" +
    "• `/attach` — enable the TUI ↔ Matrix session mirror (replies with a command to run in a terminal for two-way sync)\n" +
    "• `/detach` — stop the session mirror",
  "cmd.help.passthrough":
    "**Passthrough**: `/skill:<name>`, prompt templates and extension commands run directly; plain text goes to the model. Use /skills to list installed skills.",

  // ── router ────────────────────────────────────────────────────────────
  "common.unknownError": "unknown error",
  "router.turn.failed": "❌ Turn failed: {message}",
  "router.attach.inject": "The user sent attachment(s) (view them with the read tool):",
  "router.attach.inject.sourced": "Attachment(s) from {user} in room {room} (view them with the read tool):",
  "router.quote.prefix": "\"Quoted from @{user}'s earlier message: {excerpt}\"",
  "audit.degraded": "⚠️ Audit log unavailable — the service keeps running but sensitive actions leave no trace: {message}",

  // ── resilience (process resilience, spec #247) ────────────────────────
  "crash.notice": "💥 The bridge hit an uncaught error and will exit in order: {reason}",  "guest.denied": "🚫 This command requires trusted-user permission: {command}",
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
