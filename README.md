# pi-courier

[English](README.md) | [简体中文](README.zh-CN.md)

Run the [pi coding agent](https://pi.dev) from **Matrix**. Send a message in a chat, pi answers — and every slash command, skill and prompt template works, exactly like in the terminal.

Unlike pi's classic extension mode, pi-courier drives pi over the [RPC protocol](https://pi.dev/docs/latest/rpc), which is why commands work from chat: the extension mode can't do this because pi's `sendUserMessage()` deliberately skips command handling.

## 1. What is it

pi-courier is a small standalone service that bridges Matrix to a locally installed pi:

```
Matrix bot ←→ pi-courier ←→ pi --mode rpc (system-installed)
```

- **You talk to a Matrix bot account**; messages are forwarded to pi over the RPC protocol
- **Full command support**: `/new`, `/compact`, `/model`, `/thinking`, `/skill:name`, prompt templates, extension commands
- **Chat-native control**: steer, queue or interrupt while pi runs; answer extension questions right in the room; log a provider in without leaving Matrix
- **pi is not bundled** — installed independently on the system, upgraded on its own
- **Sessions persist** to `~/.pi/agent/sessions` and resume automatically after restarts
- **One-command CLI**: setup wizard, systemd auto-start, self-update

## 2. Install

### Prerequisites

| Component | Requirement |
|---|---|
| Node.js | >= 20 (tested on 24.x) |
| pi | >= 0.83, installed **globally** |

Install pi first — pi-courier connects to it:

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version
```

Using nvm? Run `source ~/.nvm/nvm.sh` in each new terminal so `pi` and `node` are on PATH.

> **⚠️ Node version for pi 1.0+**: since pi 1.0, upstream hard-requires **Node ≥ 22.19** — on older Node the pi CLI dies at startup with a `SyntaxError` (missing `fs.globSync`). pi-courier itself still runs on Node ≥ 20; if you must stay on Node 20/21, keep a pre-1.0 pi (e.g. `npm install -g @earendil-works/pi-coding-agent@0.83.0`). pi-courier checks this at startup and tells you what to do instead of letting pi crash cryptically.

### Option A: Regular users — one command

```bash
npm install -g pi-courier
```

That's it. Verify: `pi-courier help`.

> **⚠️ Don't use `pi install`**: the package page on pi.dev shows `pi install npm:pi-courier`. That installs pi-courier as a **pi extension** (just a `/pi-courier` usage hint inside pi) — it does **not** create the `pi-courier` command, so `pi-courier -v` will fail with "command not found". The bridge is a standalone service and must be installed with `npm install -g pi-courier`. If you already ran `pi install`, clean it up with `pi remove npm:pi-courier`.

### Option B: Developers — from source

```bash
git clone https://github.com/Hi-Barry/pi-courier.git
cd pi-courier
npm install
npm run build
npm link          # make the `pi-courier` command available globally
```

**Do not use `--ignore-scripts`**: the Matrix E2EE library downloads its native binary via postinstall. On npm >= 11 the `allow-scripts` default may block that dependency's postinstall; `pi-courier`'s own postinstall self-checks for it and auto-downloads the missing native binary (one extra download on first install; since 0.1.38 the binary is cached locally and sha256-verified, so later updates skip the 21 MB download and tampered binaries are refused). If you still hit `Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu'` (e.g. the auto-download was skipped), run manually:

```bash
cd node_modules/@matrix-org/matrix-sdk-crypto-nodejs
node download-lib.js
cd ../..
```

Slow download (20-60 kB/s)? The binary comes from GitHub Releases and ignores npm's proxy — set `export https_proxy=... http_proxy=...` first.

## 3. Get started

### Step 0 — Make sure pi can chat (one-time)

pi needs an LLM provider configured in `~/.pi/agent/` (`models.json`, `auth.json`, `settings.json`). Easiest check: run `pi`, send any message, confirm it answers. If it can't, configure it first — pi's own docs cover this; the field names are `defaultProvider`/`defaultModel` in `settings.json`.

### Step 1 — Run the setup wizard

```bash
pi-courier setup
```

It walks you through, prompting for each value (defaults in brackets; press Enter to accept) — real wizard output, English locale (the wizard follows `PI_LANGUAGE` / config / system locale):

```
=== pi-courier setup wizard ===
Language? [en] (en/zh):                                          ← bot message language; Enter keeps the locale-detected default (persisted to the config)
Writes ~/.pi/pi-courier.json (mode 600; an existing config prefills the defaults — press Enter to keep them)

Matrix homeserver URL (e.g. https://matrix.example.com):                        ← your homeserver URL
How to get the token [1=password login, 2=paste an existing token] (1):        ← Enter = password login
bot username (e.g. test2):                                                     ← the bot account's username
bot password:                                                                  ← typed blind
✅ Login succeeded, account: @***:*** (device PICOURIERZNLMIKUW)
Trusted user (admin) MXID [default @***:***]:                                  ← Enter trusts the bot only; better enter your own account, e.g. @barry:***
Trusted room IDs (optional, Enter to skip; comma-separated, e.g. !abc:server or !abc:server:trusted-only):   ← for group chats; skip for DM-only
Enable E2EE encryption? [y/N]:                                                 ← y/n (y is fine even on unencrypted rooms)
pi workdir [default /home/you/Projects]:                                       ← Enter keeps the default
Attachment save directory [default /home/you/.pi/pi-courier-attachments]:      ← where chat images/files land
Per-attachment size limit in MB [default 10]:                                  ← oversize attachments are rejected with a notice
Instance/machine name (default debian; tells multi-machine deployments apart, shown in the management room name):   ← Enter keeps the hostname
Enable multi-project mode? [y/N] (multi-project = management room + isolated project rooms with /pmctl; default N = single-project, one bot to one pi):   ← Enter for single-project (Spaces are only asked in multi-project mode)

✅ Config written to ~/.pi/pi-courier.json
   account: @***:***
   trusted user: @***:***
   E2EE: enabled
   workdir: /home/you/Projects
   attachment dir: /home/you/.pi/pi-courier-attachments (limit 10 MB)
   instance name: debian (differentiates multi-machine deployments; shown in the management room name)
   multi-project: off (single-project)
   device ID: PICOURIERZNLMIKUW (fixed; reused when you re-run setup — delete this field to get a new device)
   trusted rooms: none (groups are ignored by default; add them later with /enable)

Next: pi-courier enable (auto-start on boot) or pi-courier run (foreground)
```

The wizard verifies the token and writes `~/.pi/pi-courier.json`. To skip the wizard, create that file manually — the format is in the [FAQ](#4-faq).

### Step 2 — Start it

```bash
pi-courier enable     # install a systemd service: auto-start on boot + start now
```

Or run in the foreground for a quick test: `pi-courier run` (Ctrl+C to stop).

Startup success looks like:

```
✅ Matrix connected as @test3:... (2 rooms, E2EE enabled)
✅ pi RPC connected (model: deepseek-v4-flash, session: 019f...)
🚀 pi-courier ready. Waiting for messages...
```

### Step 3 — Use it from Matrix

**First contact (one-time pairing):**

1. **DM the bot** from your account and send any message
2. You are not a trusted user yet (e.g. you pressed Enter on the trusted-user prompt in setup, leaving only the bot itself trusted), so the bridge prints a challenge code in its log (`pi-courier logs` or `journalctl --user -u pi-courier -f`):

```
[2026-08-06T02:38:34.833Z] [INFO] 🔐 Challenge code for @barry: 529311
```

3. **Reply with that code** in the chat (just the digits) — the log confirms the pairing:

```
[2026-08-06T02:38:44.487Z] [INFO] [auth:info] ✅ barry authenticated
```

You can chat normally right away:

```
[2026-08-06T02:38:55.685Z] [INFO] 📥 [matrix] @barry: Hello, just checking — please ack!
[2026-08-06T02:38:57.884Z] [INFO] [agent] 回复 @barry: Hello! Online and ready....
```

You are now a trusted user (the first trusted user also becomes admin). In multi-project mode trusted users are also invited into the management room automatically and hold admin power in every room the bot manages — see [Multi-project rooms](#multi-project-rooms-project-isolation). Any user not in `auth.trustedUsers` goes through this flow once; pre-listed users skip it entirely.

**Then** chat normally, or send commands:

| Command | Action |
|---|---|
| `/new` `/clear` | New session |
| `/compact [notes]` | Compact context |
| `/model` / `/model <provider/id>` | Show / switch model |
| `/models` | List models |
| `/thinking [level]` | Show / set thinking level |
| `/session` `/cost` | Session stats & cost |
| `/status` | Current model & state |
| `/name <name>` | Name the session |
| `/export [path]` | Export session HTML |
| `/bash <cmd>` | Run a shell command |
| `! <cmd>` / `!! <cmd>` | Shell shortcut, like the TUI's `!`/`!!`: `!` writes the output into the context (the model sees it), `!!` keeps it out of the context (for your eyes only). Exclamation mark(s) + space + command — half- or full-width (`！`, `！！`) both work; without the space (`!git`) it stays a normal message |
| `/bashstop` | List running bash commands (`!`/`!!`/`/bash`) and abort them all; each command then replies with the output captured so far |
| `/stop` | Stop all tasks immediately (like Esc in the TUI; alias `/abort`; queued messages are not cleared — see below) |
| `/queue [text]` | Show the queue / queue a message for after the running task (Alt+Enter semantics) |
| `/interrupt <text>` | Interrupt the running task and send a new instruction — one message does both |
| `/last` | Repeat the agent's last reply |
| `/cyclemodel` / `/cyclethinking` | Cycle to the next model / thinking level |
| `/sessions` / `/switch <n>` | List recent sessions / switch to one (rejected while streaming) |
| `/autocompact on\|off` / `/autoretry on\|off` | Toggle pi's auto-compaction / auto-retry (writes pi's global settings — affects every pi process on this machine, survives restarts) |
| `/login` / `/logout <provider>` / `/auth` | Provider login management (admin + management room only) |
| `/reload` | Restart pi (after installing extensions/config); `/reload all` restarts every idle pi process of the instance |
| `/help` | Full help |

**Bridge admin commands**: `/trusted`, `/revoke <userId>`, `/channels`, `/enable [chatId] <mode>`, `/disable <chatId>`, `/toggletools`

**Anything else** starting with `/` passes through to pi directly — extension commands, `/skill:name`, prompt templates. Plain text is a normal conversation turn.

### While pi is busy: steer, queue, interrupt

Since 0.1.39 sending mirrors pi's TUI. A plain text message is always sent with steering semantics (the TUI's Enter): pi idle → it runs immediately; pi mid-task → it is injected into the running task.

- `/queue <text>` — TUI Alt+Enter: while pi runs, the message is queued and executes when the task finishes; an idle pi simply runs it at once
- `/queue` — show the current steering/followUp queues (count + content, cross-checked against pi's own pending-message count)
- `/interrupt <text>` — idle: runs directly; mid-task: stops the current task and sends the new instruction
- `/stop` — stop everything now; semantics unchanged

**Queue limitation, stated up front**: pi's RPC has no "clear queue" — aborting does not discard messages that were queued before the stop. After `/stop` or `/interrupt`, messages queued beforehand take effect on the **next** turn; both commands reply with an explicit `⚠️ N queued message(s) will take effect on the next turn:` listing them, so nothing fires unseen.

### Extension questions land in the room

When an extension asks you something (confirm / select / input / editor dialogs over RPC), the bot posts the question as a chat message — your next plain reply IS the answer:

- confirm → reply `y` / `n` (`yes` / `no` work too); select → reply the number; input / editor → just type the content
- send `cancel` (or `取消`) to back out — both spellings work in every language
- several questions pending: the oldest is answered first; messages starting with `/` still go through the command channel
- extension notifications are filtered by level: warning / error reach the room, info stays in the log

Pending questions auto-cancel after `extensionUiTimeoutMinutes` (default 10) — the room gets a notice and the extension receives a cancel. This field is **not** part of the setup wizard: add it to `~/.pi/pi-courier.json` by hand, then `pi-courier restart`:

```json
{ "extensionUiTimeoutMinutes": 10 }
```

### Bot language: bilingual messages (zh / en)

All bot messages — command replies, pairing prompts, extension questions, management-room guides — speak English by default (0.3.0+). Chinese is one setting away:

```json
{ "language": "zh" }
```

How the language is picked (first match wins):

1. `PI_LANGUAGE=en|zh` environment variable — the most reliable option in containers/minimal deployments
2. `"language": "zh" | "en"` in `~/.pi/pi-courier.json` (the setup wizard asks and writes it)
3. The system locale of the service (`LC_ALL` > `LC_MESSAGES` > `LANG`; `zh*` → Chinese) — at startup the log prints one line explaining where the language came from
4. English as the final fallback

Notes:

- Language changes take effect on restart (same as `multiProject`)
- **Upgrading from 0.2.x and prefer Chinese?** Set `"language": "zh"` once (or re-run `pi-courier setup`) — 0.2.x deployments detected `zh_CN` locale keep Chinese with zero action; the cancel keyword stays bilingual either way (`取消` and `cancel` are both accepted in every language)
- The zh table is Simplified Chinese; `zh_TW` / `zh_HK` locales also get Simplified
- Already-created rooms keep their original names and guides — no retroactive rebranding on language change

### When a model call fails

A failed turn (usage exhausted, auth expired, provider unreachable…) tells the room: `❌ Turn failed: <reason>`. Auto-retries are visible too — `⚠️ Call failed, retrying n/N` per attempt, and the final error once retries are exhausted. A manual `/stop` never produces error notices.

### Provider login from chat: `/login`

No shell needed to (re-)login a provider:

- `/login` — list login-able providers (oauth / api_key capability, ✅ badge for authenticated ones)
- `/login <provider> [oauth|api_key]` — interactive login in the room; send `cancel` (or `取消`) at any moment to abort. **OAuth**: open the link in any browser, authorize, then paste the redirect URL back into the chat. **API key**: just paste the key. ⚠️ What you paste stays in the room history — delete the message afterwards if that matters to you.
- `/logout <provider>` — delete a stored credential (running pi processes keep theirs in memory; `/reload all` once idle)
- `/auth` — the authenticated providers

Gate: admin + management room only (single-project mode: your DM with the bot). On success the **idle** pi processes restart automatically so the new credential loads; busy ones are told to `/reload` later. Credentials go straight into pi's standard credential file (`~/.pi/agent/auth.json`), shared with every pi process on the machine — pi-courier itself neither stores nor displays them.

### Replying to an earlier message

Reply (Matrix reply) to an earlier **user** message — e.g. one of your own long prompts — and send the new instruction: a one-line excerpt (≈200 chars) of the referenced text is prepended to the prompt, so references like "这个" ("this one") or "the one above" resolve for the agent. The excerpt cache is per-room, in-memory, 50 most recent messages; the bot's own replies are not cached, and quotes that miss (too old, or from before a restart) are silently ignored — the message just goes out without the prefix.

### Sending images and files to the agent

Just **paste or send files** in Element — the bot saves them first, the agent reads them after:

1. Paste an image (or send a file) → the bot replies `📎 Attachment saved: <absolute path>` and does **not** wake the agent;
2. Send a text instruction next → the path is prepended to the prompt automatically, and the agent reads it with its `read` tool (same workflow as pi TUI's `@path`), combining the attachment with your instruction.

Supported: `m.image` / `m.file` / `m.audio` / `m.video` / stickers. Images are handed to the vision model by pi (its `read` pipeline downscales large images before the model call, per pi's own source); audio/video can't be ingested by models directly, but the agent can process them with bash/ffmpeg. Limits and details:

- **10 MB per attachment** (configurable via `attachments.maxMb`, also in the setup wizard); oversize/download failures answer with the reason — never silence
- Attachments land in `~/.pi/pi-courier-attachments/<room>/` (configurable via `attachments.directory`) — **outside your project workdirs**, so `git status` stays clean
- Pending attachments are tracked per room+sender: `/pmctl`, `/login` and other commands don't consume the queue; a **restart clears it** (the receipt shows the path — reference it manually if needed)
- Encrypted rooms (E2EE) are supported — attachments are decrypted automatically
- Unsupported types (e.g. location) get a polite notice; if the model itself lacks vision, pi will say so — that's the model, not the bridge

**Group chats**: rooms with **more than 2 members** are silent by default — the bot posts a one-time hint when invited, then answers nothing until enabled. **Enable without the room ID**: send `/enable <all|mentions|trusted-only>` right in the group (trusted users only, defaults to `trusted-only`), or in a DM with `/enable <roomId> <mode>` (or add it during `setup`). Two-person rooms (you + the bot) answer automatically. Room IDs look like `!xxx:server`.

### Single-project vs multi-project mode

**Default is single-project (simple)**: one bot account ↔ one pi. Every room talks directly to the default working directory (`workdir`); there are **no** management/project rooms and `/pmctl` is unavailable — ideal for users who just want to chat with the bot.

**Enable multi-project when you need isolation**:

- answer `y` to "Enable multi-project mode?" during setup
- or later send `/multiproject on` and restart with `pi-courier restart`

> **Offline backlog note**: messages sent while the bot was down are dropped on restart (never executed retroactively) — resend anything important.

`/multiproject` (trusted users): `on` / `off` (both take effect on restart); no args shows the current mode. The management-room / project-room mechanisms below only exist in multi-project mode.

### Multi-project rooms (project isolation)

One bot account can serve multiple projects — each project gets its own private room (named after the project), its own pi process, working directory and conversation history.

- **Management room**: with the **space feature enabled** (fresh multi-project setups default to it), the bot **creates the management room itself at startup**, inside a private Element space `π <instance>`, and invites all trusted users — no first DM needed; trusted users who join via the challenge later are invited into the management room automatically (one invite per person, failures retried by the next-start self-heal). With the space off (or if its creation fails), the classic behavior applies: the first room where the bot **successfully accepts (authorizes) a message** — a non-project, ≤2-person room — becomes the management room (renamed to `Project Management (<instance>)` — localized per the bot language — guide sent, room ID persisted to `config.managementRooms`). Either way the room is the admin console — `/pmctl` works only there — and its ID is stable afterwards.
- **Space organization (Element)**: a purely cosmetic grouping — a private space `π <instanceName>` collects every room the bot creates (the management room and all `/pmctl new` project rooms) so they don't scatter across your room list. The space itself takes no part in authorization — who may send commands and who holds which room permissions is decided by the permission model below. `/pmctl rm` also removes the room from the space. Toggle it in `setup` ("Enable space organization?", fresh configs default on, existing configs keep their current state); creation is lazy at the next start, and any failure just falls back to the unspace'd behavior with a warning and a retry on the next start. Users who pass the challenge later are invited into the space automatically (one invite per person, ever). A space still carrying the old `pi-courier · <instance>` name is renamed to the short form by the next-start self-heal (manually renamed spaces are left alone).
- **Avatars (three art sets)**: the bot automatically brands everything it manages with bundled 512×512 art — and each kind of entity gets its own set, so you can tell them apart at a glance: **spaces** pick from a cool-pastel **landscape** set (aurora, islands, forests…), **project rooms** from a warm **cottage** set (red-roof cabin, mushroom house, lighthouse…), the **management room** wears the cottage set's dedicated golden-roof castle, and the **bot account itself** (the agent's face, shown in member lists and next to its messages) wears an **animal** set. Within a set the image is picked by hashing the instance/project name (same name → same image forever, different ones usually differ). Existing rooms are branded on the next start too; an avatar you set manually is never replaced — except when an art set ships a full restyle, in which case that set's scope (its rooms — or the bot face, for the animal set) is re-branded once on the next start, each set migrating independently (manual avatars are kept again from then on). Not a fan of the art? Replace any PNG in `assets/avatars/` (same filename) with your own.
- **Permission model (trusted = admin)**: trusted users automatically hold **admin power** (PL 100) in every room the bot manages — the space, the management room and all project rooms — regardless of whether trust came from setup or the challenge, and regardless of membership (late joiners arrive with the level already in place). `/revoke <userId>` strips that admin power in every managed room at the same time (back to plain member); a failed demotion is retried by the next-start self-heal. Zero configuration — the first start after upgrading heals existing rooms too. Admins promoted by the pre-0.1.37 special case (project-room creator) are not in the demotion ledger: `/revoke` still demotes them on the spot, and only if that on-the-spot demotion fails do you need to lower them manually once in your client.
- **Create a project** (in the management room):
  ```
  /pmctl new <name> [path]
  ```
  **The path is optional** — omitted it becomes `<project root>/<name>` (`newapp` → `~/Projects/newapp`); a relative path is resolved against the project root; an absolute path is used as-is. The bot creates a private room named after the project, invites the sender, writes the mapping to `pi-courier.json` (`projects`), and confirms. Talk to the project in its own room — context and bash working directory are fully isolated.
- **Project management commands** (`/pmctl`, **management room only**; project rooms are for conversation):
  ```
  /pmctl list                 List projects
  /pmctl show <name|roomId>   Project details
  /pmctl rm <name|roomId>     Remove a project (stops process, un-maps; room kept)
  /pmctl mv <name> <newPath>  Move the working directory (session restarts)
  /pmctl rename <name> <new>  Rename (also renames the room)
  ```
  Legacy aliases still work: `/newproject`, `/projects`.
- Manual setup is also possible: edit `pi-courier.json` and add a `projects` map (config is loaded once at startup — restart the service after manual edits):
  ```json
  "projects": {
    "!roomid:server": { "workdir": "/home/you/Projects/myapp" }
  }
  ```
- Each project room lazily starts its own pi process (~300MB RAM each) with `--session-dir <workdir>/.pi-session`, so sessions survive restarts per project.

### TUI ↔ Matrix session mirror (two-way sync)

Keep working in the terminal while the bot echoes everything into Matrix. In a room, send:

```
/attach
```

The bot replies with the exact command to run in a terminal, e.g. `pi --session <id>` (with `--session-dir` when the deployment uses a custom one). Attach in the terminal and the two ends stay in sync:

- **TUI → Matrix (live mirror)**: every prompt you send in the TUI and every reply the agent gives is forwarded to the room in real time — user lines carry a `🖥 **TUI**` prefix; tool-call traffic is not forwarded, only conversation text.
- **Matrix → TUI (inherited context)**: attaching opens the very same session file, so the TUI starts with the full history of what Matrix already discussed.
- **Back to Matrix (auto-relay)**: after working in the TUI, just message the room again — before answering, the bot reloads the session file while idle, so the agent's context includes whatever happened in the TUI. In-flight work and queued messages are never interrupted by a reload.
- **TUI-side `/new`**: a new session started in the TUI keeps mirroring, but the room posts a notice — the Matrix side stays on its previous session, and the two contexts are unrelated (different session files). To bring Matrix along: `/sessions` then `/switch <number>`, or `/attach` again for the new session's command; likewise, after a Matrix-side `/new`, re-run `/attach` in the TUI.
- **Fork guard**: if both ends write to the session at the same time (or the TUI switches tree branches), the bot posts a warning and pauses auto-relay — mirroring keeps running; resolve the branch in the TUI (`/tree`) or `/attach` afresh.

`/detach` stops mirroring for that room. The mirror is per-room and follows the room's own process: project rooms mirror their project's session directory; a room using the shared default process mirrors its session directory, filtered by working directory, so unrelated projects' terminal sessions never leak in.

### Managing the service

```bash
pi-courier status          # status + recent logs (optionally: pi-courier status <project>)
pi-courier logs            # tail logs (INFO and above)
pi-courier logs ai-api     # multi-project: only this project's tagged lines
pi-courier logs ai-api www --level debug   # several projects, full detail
pi-courier logs --level debug   # tail ALL logs (incl. thinking, stream deltas)
pi-courier logs --level error   # errors only
pi-courier run --level debug    # foreground with full detail
pi-courier restart        # restart
pi-courier stop           # stop
pi-courier start          # start
pi-courier disable        # uninstall the service
pi-courier update         # update pi-courier itself
pi-courier -v             # show the installed version
```

Log levels: `debug < info < warn < error`. The service writes everything;
`logs` shows INFO+ by default, `--level debug` shows the full session replay
(user messages, thinking, tool calls, replies). In multi-project mode every
project-related line carries a `[project]` tag, and `logs <project>` filters
by it (case-insensitive; project = the `/pmctl` name, or the working
directory's name when the project is unnamed). Filtering runs through
`journalctl --grep` — it requires journald with PCRE2 support (standard on
Debian/Ubuntu). The complete conversation is always stored in pi's session
files (`~/.pi/agent/sessions/`).

Upgrading **pi** is independent — pi-courier always uses the system pi via `which pi`:

```bash
npm install -g @earendil-works/pi-coding-agent@latest
pi-courier restart
```

A pi.dev managed install (`~/.pi/agent`) is supported too: pi-courier resolves the `bin/pi` wrapper script to the current version's real JS entry automatically, so pi upgrades need no config changes (0.3.1+).

## 4. FAQ

**Q: `npm install` hangs / crawls at 20-60 kB/s?**
A: The 21 MB E2EE native library downloads from GitHub Releases and ignores npm's proxy. Set `export https_proxy=... http_proxy=...` (add to `~/.bashrc`) and reinstall.

**Q: `Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu'`?**
A: The native binary didn't download (postinstall blocked). Run manually: `cd node_modules/@matrix-org/matrix-sdk-crypto-nodejs && node download-lib.js`.

**Q: `npm install -g pi-courier` fails with EEXIST?**
A: A previous `npm link` left a conflicting bin. `npm unlink -g pi-courier && rm -f $(npm prefix -g)/bin/pi-courier && npm install -g pi-courier`.

**Q: Installed but `pi-courier: command not found`?**
A: You likely used `pi install npm:pi-courier` from the pi.dev package page. That installs pi-courier as a pi extension (a `/pi-courier` usage hint inside pi), not the CLI. Install the CLI with `npm install -g pi-courier`, then optionally remove the extension with `pi remove npm:pi-courier`.

**Q: The systemd service restarts in a loop?**
A: Almost always a Node version mismatch — the pi child crashes on system node v20 (`webidl.util.markAsUncloneable is not a function`). Load nvm and re-run `pi-courier enable` (v0.1.2+ writes the correct PATH into the unit). Stick to one Node version everywhere.

**Q: Startup shows `model: unknown`?**
A: pi's provider isn't configured. Check `~/.pi/agent/`: `models.json` + `auth.json` + `settings.json` (`defaultProvider` / `defaultModel` — exact field names).

**Q: Lots of `Decryption error` lines in the log?**
A: Historical events that can't be decrypted (new device without old keys). Normal — new messages work fine.

**Q: Encrypted room: no reply / can't decrypt new messages?**
A: The bot's new device never received the room keys. The bot account has no cross-signing, so the most reliable fix is to **use a non-encrypted room** (create a room without encryption and invite the bot) — the bridge handles plain rooms fine even with `encryption: true`.

**Q: `M_BAD_JSON: Provided device_id in device_keys does not match...`?**
A: The crypto store's device identity doesn't match the token's device (re-logged, or a pasted token from another device). **Since 0.1.20 password login uses a fixed device ID, so re-running setup no longer triggers this.** If it still happens: delete the crypto store and restart — `rm -rf ~/.pi/pi-courier-matrix-crypto && pi-courier restart` (do this whenever you re-run setup / change the token).

**Q: `One time key signed_curve25519:... already exists` (M_UNKNOWN)?**
A: The token is bound to an old device on the server and the local OTK bookkeeping is out of sync — **deleting the local crypto store does NOT help** (the server assigns the device ID from the token, so a rebuilt store uses the same device). **You must get a new token**: re-run `pi-courier setup` and answer `n` to "keep the existing token?" (or log in with the password); a new token = a new device = clean server state. Pair with a crypto-store delete if device residue persists.

**Q: First message asks for a 6-digit code?**
A: That's the challenge auth — reply with the code to become a trusted user.

**Q: No reply to messages at all?**
A: Check in order: (1) `pi-courier status` — Matrix connected? Decryption errors (encrypted room)? (2) pi RPC connected? (3) the model call itself — curl the provider endpoint with your key.

**Q: `pi RPC did not become ready`?**
A: pi failed to start. Run `node node_modules/@earendil-works/pi-coding-agent/dist/cli.js --mode rpc` manually to see the real error. Common causes: Node version mismatch, invalid provider config, no network to the provider.

**Q: After a restart the conversation context is gone?**
A: Since v0.1.1 the bridge passes `--continue` to pi, resuming the most recent session per workdir. Update pi-courier and restart; `/new` starts a fresh session and the next restart resumes that one.

**Q: Element (web client) intercepts `/`-prefixed messages?**
A: Prefix with `//` to send a literal slash (`//compact` sends `/compact`).

**Q: What exactly is in `~/.pi/pi-courier.json`?**
A: The wizard-generated config. Example:

```json
{
  "matrix": { "homeserverUrl": "https://matrix.example.com", "accessToken": "syt_...", "encryption": true },
  "auth": { "trustedUsers": ["matrix:@you:matrix.example.com"], "adminUserId": "matrix:@you:matrix.example.com" },
  "workdir": "/home/you/Projects",
  "multiProject": true,
  "space": { "enabled": true },
  "autoConnect": true,
  "debug": true
}
```

Env var alternatives (priority: env vars > config file > wizard):

| Variable | Maps to |
|---|---|
| `PI_MATRIX_HOMESERVER` + `PI_MATRIX_ACCESS_TOKEN` | matrix.homeserverUrl / accessToken (both must be set) |
| `PI_MATRIX_ENCRYPTION` | matrix.encryption (`true`/`false`) |
| `PI_MATRIX_TRUSTED_USERS` | auth.trustedUsers (comma-separated MXIDs, e.g. `@barry:matrix.example.com`) |
| `PI_WORKDIR` | workdir |
| `PI_LOG_LEVEL` | logLevel (debug/info/warn/error) |

The LLM key can also come from an env var: write `"key": "${PI_LLM_API_KEY}"` in auth.json and pi reads it from the environment at startup (the Docker template does this by default).

## 5. License & Acknowledgements

MIT License — see [LICENSE](LICENSE).

**Upstream**: this project is a rework of [tintinweb/pi-messenger-bridge](https://github.com/tintinweb/pi-messenger-bridge) (MIT). The Matrix transport layer and challenge auth come from upstream; the RPC-based standalone architecture, slash-command mapping, CLI, setup wizard and docs are new.

pi-courier is an independent companion app for [pi](https://pi.dev) — it is not affiliated with Earendil Inc.
