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
  "cmd.generic.error": "❌ Command failed: {message}",
  "cmd.bash.error": "❌ bash failed: {message}",
  "cmd.bash.notWritten": "(output not written to context)",
  "cmd.bash.excludedNote": "(output not written to context)",
  "cmd.bash.aborted": "⏹ Aborted: {command}{suffix}",
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
  "cmd.compact.ok": "✅ Compacted",
  "cmd.compact.tokens": "  tokens: {before} → after compaction (see summary)",
  "cmd.compact.summary": "\nSummary: {summary}",
  "cmd.stop.ok": "🛑 All tasks stopped. Awaiting your next instruction.",
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
  "cmd.help.piCommands":
    "**Pi commands** (executed over RPC):\n" +
    "• `/new` — new session\n" +
    "• `/compact [note]` — compact the context\n" +
    "• `/model` / `/model <provider/id>` — view / switch model\n" +
    "• `/models` — list available models\n" +
    "• `/thinking [level]` — view / set the thinking level\n" +
    "• `/cyclemodel` / `/cyclethinking` — rotate to the next model / thinking level\n" +
    "• `/autocompact on|off` — auto-compaction toggle (instance-wide: written to pi's global settings; toggling in one project room affects all)\n" +
    "• `/autoretry on|off` — auto-retry toggle (instance-wide, same as above)\n" +
    "• `/sessions` — list recent sessions (by modification time)\n" +
    "• `/switch <number>` — switch to a session from /sessions (run /stop first while streaming)\n" +
    "• `/last` — repeat the agent's latest reply\n" +
    "• `/session` — session stats and cost\n" +
    "• `/status` — current model and state\n" +
    "• `/name <name>` — name the session\n" +
    "• `/export [path]` — export the session as HTML\n" +
    "• `/bash <command>` — run a shell command (written to context)\n" +
    "• `! <command>` — quick shell execution (≈ TUI `!`; output written to context; a space is required after `!`)\n" +
    "• `!! <command>` — same, but output is NOT written to context (≈ TUI `!!`)\n" +
    "• `/bashstop` — list and abort running bash commands (shared by `!`/`!!`/`/bash`)\n" +
    "• `/queue [text]` — no args: view the queue; with text: queue without interrupting (≈ Alt+Enter)\n" +
    "• `/interrupt <new instruction>` — interrupt the current task and send the new one (single message)\n" +
    "• `/stop` — stop all tasks immediately (≈ TUI Esc; alias `/abort`)\n" +
    "• `/reload` — restart the pi process (after installing extensions / changing config); `/reload all` — restart every process of this instance (idle ones only, busy skipped)\n" +
    "• `/login [provider [oauth|api_key]]` — no args: list login-able providers; with args: headless login (admin + management room only)\n" +
    "• `/logout <provider>` — delete a provider credential (admin + management room only)\n" +
    "• `/auth` — view saved provider credentials (admin + management room only)\n" +
    "• `/pmctl new <name> <path>` — create a project (management room)\n" +
    "• `/pmctl list` — project list\n" +
    "• `/pmctl show|rm|mv|rename` — project details / delete / move / rename (management room;\n" +
    "  rm needs a second confirmation; after confirming, the process stops and the bot leaves the room)",
  "cmd.help.passthrough":
    "**Passthrough**: `/skill:<name>`, prompt templates and extension commands run directly; plain text goes to the model.",

  // ── router ────────────────────────────────────────────────────────────
  "common.unknownError": "unknown error",
  "router.turn.failed": "❌ Turn failed: {message}",
  "router.attach.inject": "The user sent attachment(s) (view them with the read tool):",
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
    "**Bridge admin commands**: `/help` (this help), `/trusted`, `/revoke`, `/channels`, `/enable`, `/disable`, `/toggletools`\n" +
    "**Pairing**: DM the bot for the first time → a 6-digit code appears in the bot's terminal and the management room → enter it in the chat where you received the prompt to become a trusted user (the first trusted user = admin). Group chats are enabled by a trusted user sending `/enable <mode>` in the group.",
  "auth.pairing.noPendingHint":
    "ℹ️ No pairing in progress. To pair, DM the bot first; you will receive a 6-digit code — reply with it here.",
  "auth.challenge.prompt":
    "🔐 Please enter the 6-digit code provided by the bot admin — here in this chat.\n⏱️ Expires in 2 minutes.",
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

  // ── startup ───────────────────────────────────────────────────────────
  "startup.language.system":
    "language: {locale} (detected from the system locale; set \"language\" in ~/.pi/pi-courier.json or PI_LANGUAGE to override)",
  "startup.language.default":
    "language: {locale} (default; set \"language\" in ~/.pi/pi-courier.json or PI_LANGUAGE to override)",
};

export default en;
