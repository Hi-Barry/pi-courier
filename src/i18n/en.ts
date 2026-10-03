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
    "• `/attach` — enable the TUI ↔ Matrix session mirror (replies with a command to run in a terminal for two-way sync)\n" +
    "• `/detach` — stop the session mirror\n" +
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
  "router.extensionError": "⚠️ Extension error ({path}): {error}",

  // ── mirror (TUI ↔ Matrix session mirror, session-mirror.ts / router) ──
  "mirror.user": "🖥 **TUI** › {text}",
  "mirror.fork.warning":
    "⚠️ Session fork detected (the TUI and Matrix wrote to the same session concurrently, or the TUI switched tree branches).\n" +
    "Auto-relay is paused to avoid attaching the wrong context; message forwarding continues.\n" +
    "To resolve: pick the main branch again with /tree in the TUI, or /attach afresh.",
  "mirror.relay.failed": "⚠️ Auto-relay of session context failed (the message still goes out, but may miss the latest TUI conversation): {message}",

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
  "pmctl.new.ok":
    "✅ Project \"{name}\" created!\n\n• room: {room}\n• workdir: {workdir}\n• you've been invited into the new room\n\nTalk to the project in its new room (isolated context and workdir).{notes}",
  "pmctl.new.failed": "❌ Failed to create the project: {message}",
  "pmctl.empty": "No projects yet (create one with /pmctl new <name> <path>)",
  "pmctl.statusRunning": "✅ running",
  "pmctl.statusStopped": "⏸️ not started",
  "pmctl.statusLazy": "⏸️ not started (lazy)",
  "pmctl.list": "**Project list** ({count}):\n{lines}",
  "pmctl.show.usage": "Usage: /pmctl show <project name|room ID>",
  "pmctl.notFound": "❌ Project not found: {target} (use /pmctl list)",
  "pmctl.show.ok":
    "📁 Project: {name}\n• room: {room}\n• workdir: {workdir}\n• status: {status}\n• session: {session}",
  "pmctl.rm.usage": "Usage: /pmctl rm <project name|room ID>",
  "pmctl.rm.cancelled": "✅ Delete cancelled",
  "pmctl.rm.nothingPending": "No pending delete confirmation",
  "pmctl.rm.expired": "⏳ The previous confirmation expired (60 s); please confirm again.",
  "pmctl.rm.done":
    "🗑️ Project \"{name}\" deleted\n• mapping removed and process stopped\n• workdir kept: {workdir} (delete it yourself if you want)\n• leaving the room now…",
  "pmctl.rm.unlinkFailed": "⚠️ Failed to remove from the space (a stale entry may remain; remove it manually): {message}",
  "pmctl.rm.leaveFailed": "⚠️ Failed to leave the room (you can remove the bot manually): {message}",
  "pmctl.leaveReason": "project deleted",
  "pmctl.rm.confirm":
    "⚠️ Delete project \"{name}\"?\n\nSend `/pmctl rm {name}` again to confirm.\nOnce confirmed, I stop the process and leave that room.\n(send `/pmctl rm cancel` to cancel)",
  "pmctl.mv.usage": "Usage: /pmctl mv <project name|room ID> <new path> (relative paths resolve against the project root)",
  "pmctl.mv.done":
    "🚚 Project \"{name}\" moved\n• new workdir: {workdir}\n• the session restarts (the old session stays in the old directory's .pi-session)",
  "pmctl.rename.usage": "Usage: /pmctl rename <project name|room ID> <new name>",
  "pmctl.rename.ok": "✏️ Project renamed to \"{name}\"",
  "pmctl.rename.roomFailed": " (room rename failed: {message})",

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
};

export default en;
