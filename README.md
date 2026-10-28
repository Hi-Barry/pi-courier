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
- **One-command CLI**: setup wizard, autostart (systemd on Linux, Task Scheduler on Windows), self-update

## 2. Install

### Prerequisites

| Component | Requirement |
|---|---|
| Node.js | >= 22.19 (tested on 24.x and 26.x) |
| pi | >= 0.83, installed **globally** |

Install pi first — pi-courier connects to it:

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version
```

Using nvm? Run `source ~/.nvm/nvm.sh` in each new terminal so `pi` and `node` are on PATH.

> **⚠️ Node version**: pi 1.0+ hard-requires **Node ≥ 22.19** — on older Node the pi CLI dies at startup with a `SyntaxError` (missing `fs.globSync`). pi-courier declares the same floor (its own `engines` is `>=22.19` since 1.0.0). If you must stay on Node 20/21, keep a pre-1.0 pi (e.g. `npm install -g @earendil-works/pi-coding-agent@0.83.0`) together with pi-courier 0.7.x.

### Option A: Regular users — one command

```bash
npm install -g pi-courier
```

That's it. Verify: `pi-courier help`.

> **⚠️ npm ≥ 11 with the install-scripts gate**: if the install prints `npm warn install-scripts … not yet covered by allowScripts`, npm has silently skipped every install script — including pi-courier's postinstall that downloads and sha256-verifies the E2EE native library. Install once with the scripts allowed:
>
> ```bash
> npm install -g --allow-scripts=pi-courier,@matrix-org/matrix-sdk-crypto-nodejs pi-courier
> ```
>
> (Real-machine verified 2026-10-14 on a gated npm 11.19; the same flag list is what npm itself suggests in the warning.)

> **⚠️ Don't use `pi install`**: the package page on pi.dev shows `pi install npm:pi-courier`. That installs pi-courier as a **pi extension** (just a `/pi-courier` usage hint inside pi) — it does **not** create the `pi-courier` command, so `pi-courier -v` will fail with "command not found". The bridge is a standalone service and must be installed with `npm install -g pi-courier`. If you already ran `pi install`, clean it up with `pi remove npm:pi-courier`.

### Option B: Developers — from source

```bash
git clone https://github.com/Hi-Barry/pi-courier.git
cd pi-courier
npm install
npm run build
npm link          # make the `pi-courier` command available globally
```

**Do not use `--ignore-scripts`**: the Matrix E2EE library downloads its native binary via postinstall, and `pi-courier`'s own postinstall self-checks for it and auto-downloads the missing binary (since 0.1.38 the binary is cached locally and sha256-verified, so later updates skip the 21 MB download and tampered binaries are refused). One exception: on npm >= 11 machines configured with the install-scripts gate (see the warning above) **both** postinstalls are skipped silently — use the `--allow-scripts` flag from Option A for the install. If you still hit `Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-*'` (any platform suffix), run the dependency's downloader manually:

```bash
cd node_modules/@matrix-org/matrix-sdk-crypto-nodejs
node download-lib.js
cd ../..
```

Slow download (20-60 kB/s)? The binary comes from GitHub Releases and ignores npm's proxy — set `export https_proxy=... http_proxy=...` first. (Those variables cover the **install-time** download only; the bridge's **runtime** proxy is a separate setting — see the next section.)

## Outbound proxy (runtime)

Skip this section if the machine has direct internet access. Since 1.1.0 the bridge can route its **runtime** traffic through an HTTP proxy — one setting that covers all three outbound legs:

- **Matrix send/receive** — the bot's connection to your homeserver;
- **pi's LLM requests** — the effective proxy is injected into the pi subprocess environment automatically, so model calls inside pi need no extra configuration;
- **The setup wizard's login** — `pi-courier setup` applies the same settings before its first request, so the token login goes through the proxy too.

(The **install-time** downloads — `npm install` itself and the E2EE native library fetched by postinstall — are a different story: they are covered by the notes in [Install](#2-install) and the FAQ, and they ignore this section's settings.)

### Two ways to configure: the config file wins

**Way 1 — the config file** (recommended, one global copy): add `proxy` (a single URL) and optionally `noProxy` (exemption list) to `~/.pi/pi-courier.json`:

```json
{
  "proxy": "http://192.0.2.10:10809",
  "noProxy": ["192.168.1.0/24", ".internal"]
}
```

**Way 2 — environment variables**: when the config file has no `proxy`, the bridge falls back to the standard `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`. Every spelling is recognized (upper- and lowercase); when several are set, lowercase wins over uppercase and HTTPS is checked before HTTP.

When both are present **the config file wins** — a leftover shell variable can never override what you wrote in the config. With no proxy in the config and none in the environment the bridge behaves exactly as before (direct connection).

### The setup wizard asks too (optional)

Since 1.1.0 `pi-courier setup` has an optional outbound-proxy step (asked near the end, after the multi-project question — and the space question in multi-project mode — and just before the config is written; leave blank to skip). When a proxy is already in effect (config or env), setup announces it before the first question and offers it as the default — press Enter to keep it. This announce line always prints in English, because it appears before the wizard's first question — the language choice:

```
🌐 outbound proxy: http://192.0.2.10:10809 (source: config; edit ~/.pi/pi-courier.json and restart to change)
```

With nothing in effect the prompts are (real wizard output):

```
Outbound proxy URL (optional, http/https; Enter to skip): 
Proxy exemptions (optional; comma-separated hosts/domains/IP ranges, Enter to skip): 
```

The end-of-setup summary always includes the outcome (or `   outbound proxy: not configured (direct connection)` when skipped):

```
   outbound proxy: http://192.0.2.10:10809 (exempt 192.168.1.0/24, .internal)
```

### Rules of the road

- **Only `http://` and `https://` proxies (1.1.0)**. Anything else — `socks5://` in particular — is rejected at startup regardless of whether it came from the config or the environment, with a bilingual error naming the value and its origin. `pi-courier setup` prints it like this (real output):

  ```
  [pi-courier] fatal: ❌ Proxy "socks5://192.0.2.10:1080" (from config.proxy) is not supported in this version — only http/https proxies are supported; use an address starting with http:// or https://
  ```

  A running service logs the same error in the configured language (with a `[bridge] fatal:` prefix).

- **Proxy changes take effect on restart.** The proxy is resolved once at startup (an invalid one is rejected right there); after editing the config or the env, run `pi-courier restart` (a foreground `run` just means Ctrl+C and start again). While a proxy is in effect, the service log carries one line naming it and its source (`config` or `env`).
- **`noProxy` semantics**: the list is passed through to the underlying HTTP stacks unchanged (comma-separated `NO_PROXY` for the env consumers) — the bridge does no matching of its own, so hosts, domain suffixes and CIDR ranges behave exactly as those libraries dictate. **One behavior worth knowing**: when `proxy` comes from the config file and `noProxy` is **not** set, an inherited `NO_PROXY` environment variable is suppressed — the config is authoritative, and leaving `noProxy` out means **no exemptions** (an explicit `"noProxy": []` says the same). List your exemptions in the config to keep them. (A `noProxy` with no proxy anywhere is inert.)
- **Authenticated proxies**: credentials embedded in the URL (`http://user:pass@192.0.2.10:3128`) are handled by the underlying HTTP stacks; there is no separate UI for them.
- **Windows**: everything above works the same — the config file, and `HTTP_PROXY`-style env vars (uppercase is the Windows convention; both cases are recognized).

### systemd: shell exports don't reach the service

A proxy you `export` in your interactive shell never reaches the systemd service. Use either the config file (works everywhere) or the unit's environment file `~/.config/pi-bridge.env` (the user unit already loads it via `EnvironmentFile` — a missing file is fine; the system-level template uses `/etc/pi-bridge.env`). A line like `HTTP_PROXY=http://192.0.2.10:10809` there reaches the bridge at startup and is honored like any environment variable — the config file still wins.

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

The wizard verifies the token and writes `~/.pi/pi-courier.json`. Since 1.1.0 it also asks one optional extra question — the outbound proxy (the transcript above predates that step; press Enter to skip) — see [Outbound proxy](#outbound-proxy-runtime). To skip the wizard, create that file manually — the format is in the [FAQ](#4-faq).

### Step 2 — Start it

```bash
pi-courier enable     # install a systemd service: auto-start on boot + start now (Linux; Windows → the Windows section)
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
| `/stop` | Stop everything now, exactly like the TUI's Esc: also **clears queued messages** and lists what was dropped (alias `/abort`; on pi older than 0.84.4 the queue survives — the reply says so) |
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
- `/stop` — stop everything now, the TUI's Esc: queued messages are cleared too

**What happens to the queue, stated up front**: since 0.3.8 `/stop` and `/interrupt` mirror the TUI's Esc — the queue is cleared **before** the abort, and the reply lists exactly which queued messages were dropped, so nothing disappears unseen. On a pi older than 0.84.4 (no `clear_queue` RPC) the old behaviour applies: the queue survives and fires on the **next** turn; the reply says so explicitly (`⚠️ N queued message(s) will take effect on the next turn:`). Since 0.5.0 even **involuntary** loss is visible: if the queue is non-empty when the subprocess restarts (/reload or a crash respawn), the bot proactively posts `⚠️ Subprocess restarted — N queued message(s) never ran` with the full list — a queue you cleared yourself via `/stop` never triggers the warning. Service-level restarts (systemd/machine) are covered too, for **project rooms in multi-project mode**: the snapshot lives in `~/.pi/pi-courier-state/queue-snapshots.json`, and the next start posts `⚠️ Service restarted — N queued message(s) never ran` per project room before wiping it (a queue already reported by `/reload` is never reported twice; the single-project default process is out of scope — its room binding is a runtime DM).

### Tool-loop aggregation: one "working" card, continuously refreshed

While the agent works through long tasks, the **intermediate tool-loop turns no longer flood the room**: the first turn posts a single "working" card, and every following turn edits **that same card in place** (Matrix message edits, MSC2676; Element X / Element Web / FluffyChat all render edits in place) — one card keeps updating, progress is visible at a glance, and phones stop getting pinged by every intermediate turn. The **final answer** is still its own standalone message (with the status footer), so the notification that matters is never swallowed by an edit. On a client without edit support you'll see the full text with a `* ` prefix (the classic fallback — nothing is lost). When content approaches the single-message ceiling (4000 characters) the old card is finalized and a new one continues (only the newest card is ever edited); if an edit fails, the bridge automatically **falls back to the old one-message-per-turn behaviour**, so nothing is ever lost. With `/toggletools` (hideToolCalls) hiding tool lines, aggregation is bypassed entirely — byte-for-byte the old behaviour.

**Deployment note (Synapse rate limiting)**: aggregation raises the bot's posting rate considerably (one N-turn tool loop ≈ N edits). Synapse rate-limits accounts by default via `rc_message` (0.2 messages/second, burst 10) — when throttled, the worst case is **edits arriving late**: the card refreshes slower but still converges to the final state, losing nothing (and the automatic fallback covers outright failures). Self-hosting? Either raise the global limit in `homeserver.yaml`:

```yaml
rc_message:
  per_second: 0.5
  burst_count: 15
```

or exempt just the bot account via the Admin API (`0` = unlimited; `DELETE` on the same path removes the exemption):

```
POST /_synapse/admin/v1/users/<bot account>/override_ratelimit
Authorization: Bearer <admin access token>

{ "messages_per_second": 0, "burst_count": 0 }
```

**Prefer the old one-message-per-turn mode?** Add `aggregateToolTurns: false` by hand (not in the setup wizard), then `pi-courier restart` — byte-for-byte the old behaviour:

```json
{ "aggregateToolTurns": false }
```

### Session handoff cards: /recap

`/recap` asks the current session to summarize itself — goal, what got done, what's left, in ≤5 bullets — and posts a `📋 Handoff card` right in the room, so `/new` stops being an act of amnesia. `/recap` refuses honestly when there's nothing to summarize (fewer than two completed turns) or when a task is still running (it never races a live task with steering semantics). In multi-project mode the card is also copied to the management room as `📋 <project> handoff card (project log)` — a running "what has this project been doing" timeline.

Want cards automatically before `/new` (and `/clear`) wipes a session? Set `recap.onNew: true` by hand (not in the setup wizard), then `pi-courier restart`. It's **off by default** because every card is a real model call (a few hundred tokens); generation failure never blocks `/new` — the card is a bonus, never a dependency.

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

Bash replies (`!` / `!!` / `/bash`) truncate their output before posting: the cap is `bashOutputLimit` characters (default 30000). Configured values above 65536 are clamped to 65536 — 64 KB is the Matrix event-size ceiling, so a longer reply would be rejected by the homeserver anyway. This field is also **not** part of the setup wizard:

```json
{ "bashOutputLimit": 50000 }
```

### Custom avatars (space / bot / project rooms)

Not happy with the bundled pick? Point any target at your own image and restart (these fields are **not** part of the setup wizard):

```json
{
  "spaceAvatar": "~/pix/space-face.png",
  "botAvatar": "faces/agent.png",
  "projects": {
    "!roomId:server": { "name": "myapp", "workdir": "~/Projects/app", "avatar": "/abs/path/room.png" }
  }
}
```

- Paths support `~` expansion; relative paths resolve against `~/.pi/`; the format is picked by extension (png / jpg / jpeg / webp / gif).
- **Config is desired state**: while configured, every start verifies the target — when the file content or the current avatar no longer matches the last upload, the custom image is re-uploaded automatically (edit the file, restart, done). Targets without an override keep the "fill missing only, never overwrite" rule.
- Missing file, unsupported extension or failed upload: one startup warning, then the run falls back to the bundled pool logic — a room never ends up without a face.
- A project room with `projects[].avatar` (keyed by room ID) keeps your custom image across `/pmctl rename`; rooms without one re-pick from the bundled pool by the new name (first free slot in the space, so siblings never share an image).

### Bot language: bilingual messages (zh / en)

All bot messages — command replies, pairing prompts, extension questions, management-room guides — speak English by default (0.3.0+). Chinese is one setting away:

```json
{ "language": "zh" }
```

How the language is picked (first match wins):

1. `PI_LANGUAGE=en|zh` environment variable — the most reliable option in containers/minimal deployments
2. `"language": "zh" | "en"` in `~/.pi/pi-courier.json` (the setup wizard asks and writes it)
3. The system locale of the service: on Linux/macOS `LC_ALL` > `LC_MESSAGES` > `LANG` (`zh*` → Chinese); on Windows (which sets none of those variables) the system regional setting is read instead — a Chinese Windows yields Chinese. At startup the log prints one line explaining where the language came from
4. English as the final fallback

Notes:

- Language changes take effect on restart (same as `multiProject`)
- **Upgrading from 0.2.x and prefer Chinese?** Set `"language": "zh"` once (or re-run `pi-courier setup`) — 0.2.x deployments detected `zh_CN` locale keep Chinese with zero action; the cancel keyword stays bilingual either way (`取消` and `cancel` are both accepted in every language)
- The zh table is Simplified Chinese; `zh_TW` / `zh_HK` locales also get Simplified
- Windows reads the regional format setting (what "Region" in the control panel defines); a mixed configuration — Chinese display language but a non-Chinese region — can point to the wrong language. Pin `PI_LANGUAGE` (or config `language`) in that case
- Already-created rooms keep their original names and guides — no retroactive rebranding on language change

### When a model call fails

A failed turn (usage exhausted, auth expired, provider unreachable…) tells the room: `❌ Turn failed: <reason>`. Auto-retries are visible too — `⚠️ Call failed, retrying n/N` per attempt, and the final error once retries are exhausted. A manual `/stop` never produces error notices.

### Model fallback chain: automatic failover on repeated failures

One provider staying down shouldn't strand your task on a broken model. Add a chain in `pi-courier.json` (restart to apply):

```json
"modelFallbacks": ["zai/glm-5.3", "deepseek/deepseek-v4-flash"]
```

When the **same pi process fails 2 turns in a row** (pi's own auto-retry already exhausted by then), the bridge switches to the next chain entry by itself and tells the room: `⚠️ 2 consecutive failed turns — switched the model automatically: <from> → <to>. Send /model <from> to switch back` — plus one `model.fallback` line in the audit log. Rules of the road:

- A successful turn resets the failure count; the next streak advances to the following entry, never backwards.
- Chain exhausted → one `❌ … fallback chain exhausted` notice and normal error replies afterwards — **no looping**, and the notice does not repeat either.
- **No automatic switch-back** by design: once the provider recovers, `/model <from>` returns you (the receipt names it).
- Project rooms can carry their own chain via `projects[].fallbacks` — it takes priority over the global one (see per-project presets below).
- No config → byte-for-byte the old behaviour. Malformed entries are warned about at startup and skipped.

### Provider login from chat: `/login`

No shell needed to (re-)login a provider:

- `/login` — list login-able providers (oauth / api_key capability, ✅ badge for authenticated ones)
- `/login <provider> [oauth|api_key]` — interactive login in the room; send `cancel` (or `取消`) at any moment to abort. **OAuth**: open the link in any browser, authorize, then paste the redirect URL back into the chat. **API key**: just paste the key. ⚠️ What you paste stays in the room history — delete the message afterwards if that matters to you.
- `/logout <provider>` — delete a stored credential (running pi processes keep theirs in memory; `/reload all` once idle)
- `/auth` — the authenticated providers

Gate: admin + management room only (single-project mode: your DM with the bot). On success the **idle** pi processes restart automatically so the new credential loads; busy ones are told to `/reload` later. Credentials go straight into pi's standard credential file (`~/.pi/agent/auth.json`), shared with every pi process on the machine — pi-courier itself neither stores nor displays them.

### Replying to an earlier message

Reply (Matrix reply) to an earlier **user** message — e.g. one of your own long prompts — and send the new instruction: a one-line excerpt (≈200 chars) of the referenced text is prepended to the prompt, framed as `「Quoted from @user's earlier message: …」` so the agent can tell third-party content from live instructions. The excerpt cache is per-room, in-memory, 50 most recent messages; the bot's own replies are not cached, and quotes that miss (too old, or from before a restart) are silently ignored — the message just goes out without the prefix.

### Sending images and files to the agent

Just **paste or send files** in Element — the bot saves them first, the agent reads them after:

1. Paste an image (or send a file) → the bot replies `📎 Attachment saved: <absolute path>` and does **not** wake the agent;
2. Send a text instruction next → the path is prepended to the prompt automatically, and the agent reads it with its `read` tool (same workflow as pi TUI's `@path`), combining the attachment with your instruction. The injected header names the source (`Attachment(s) from @user in room <room>`) so the agent always knows whose files those are.

Supported: `m.image` / `m.file` / `m.audio` / `m.video` / stickers. Images are handed to the vision model by pi (its `read` pipeline downscales large images before the model call, per pi's own source); audio/video can't be ingested by models directly, but the agent can process them with bash/ffmpeg. Limits and details:

- **10 MB per attachment** (configurable via `attachments.maxMb`, also in the setup wizard); oversize/download failures answer with the reason — never silence
- Attachments land in `~/.pi/pi-courier-attachments/<room>/` (configurable via `attachments.directory`) — **outside your project workdirs**, so `git status` stays clean
- Pending attachments are tracked per room+sender: `/pmctl`, `/login` and other commands don't consume the queue; a **restart clears it** (the receipt shows the path — reference it manually if needed)
- Encrypted rooms (E2EE) are supported — attachments are decrypted automatically
- Unsupported types (e.g. location) get a polite notice; if the model itself lacks vision, pi will say so — that's the model, not the bridge

**Group chats**: rooms with **more than 2 members** are silent by default — the bot posts a one-time hint when invited, then answers nothing until enabled. **Enable without the room ID**: send `/enable <all|mentions|trusted-only>` right in the group (trusted users only, defaults to `trusted-only`), or in a DM with `/enable <roomId> <mode>` (or add it during `setup`). Two-person rooms (you + the bot) answer automatically. Room IDs look like `!xxx:server`.

### Guest access: chat without the keys

Sharing the bot with teammates doesn't have to mean sharing admin power. List guests by hand in `auth.guestUsers` (MXIDs in the same `matrix:@user:server` form as `trustedUsers`; takes effect on restart), and they get a middle tier:

- **Guests can** chat, send attachments, use read-only commands (`/help` `/status` `/cost` `/models` `/queue` …) in DMs and in groups enabled for everyone;
- **Guests cannot** touch the dangerous surface — the bridge rejects it **before** anything runs, with a polite `🚫 This command requires trusted-user permission: <command>`: shell execution (`!` `!!` `/bash` `/bashstop`), project management (`/pmctl*`), auth (`/login` `/logout` `/auth`), lifecycle (`/reload` `/stop` `/interrupt` `/enable` `/disable` `/switch` `/multiproject`), the trust list (`/trusted` `/revoke` `/toggletools`), proactive sends (`/remind`) and session mirror (`/attach` `/detach`);
- Every denial is logged to the audit trail (see below); the boundary is the bridge, not the model's manners — though note the honest limit: a guest's *conversation* can still drive the agent's own tools (pi has no per-session tool switch; that's upstream territory);
- Room modes keep their semantics: a `trusted-only` group keeps guests outside entirely (mode first, tier second), and guests never trigger the pairing challenge — pre-listed, they just chat.

### Audit trail: sensitive actions leave a trace

Every sensitive action appends one JSONL line to `~/.pi/pi-courier-state/audit.jsonl` (0600, append-only): who, when, what, in which room — pairing successes and failures, `/trusted` //revoke`, bash execution (`!`, `!!`, `/bash`), `/pmctl rm`, `/login` family, `/reload`, queue clears and offline-backlog batch executions, plus every guest denial. The file rotates at 10 MB (two rotated siblings kept); if the file becomes unwritable the service keeps running but warns the management room — an audit outage is visible, never fatal. As a second hardening layer, attachments and reply-quotes enter the prompt with their source labeled (see the sections above), so third-party content arrives as data, not as instructions.

### Single-project vs multi-project mode

**Default is single-project (simple)**: one bot account ↔ one pi. Every room talks directly to the default working directory (`workdir`); there are **no** management/project rooms and `/pmctl` is unavailable — ideal for users who just want to chat with the bot.

**Enable multi-project when you need isolation**:

- answer `y` to "Enable multi-project mode?" during setup
- or later send `/multiproject on` and restart with `pi-courier restart`

> **Offline inbox** (since 0.5.0): messages sent while the bot was down are **no longer lost** — after a restart the bot settles them per room ("N message(s) arrived while offline" + the full list); reply **"execute"** to run them in order or **"ignore"** to discard (valid 10 minutes; silence counts as ignore). This is the default; set `inbox.mode: "auto"` to run them after a notice, or `"off"` to restore the old drop-quietly behaviour. Backlog from untrusted senders still goes through the normal gate — it never becomes a privilege bypass.

`/multiproject` (trusted users): `on` / `off` (both take effect on restart); no args shows the current mode. The management-room / project-room mechanisms below only exist in multi-project mode.

### Multi-project rooms (project isolation)

One bot account can serve multiple projects — each project gets its own private room (room name: `<project> (<instance>)`), its own pi process, working directory and conversation history.

- **Management room**: with the **space feature enabled** (fresh multi-project setups default to it), the bot **creates the management room itself at startup**, inside a private Element space `π <instance>`, and invites all trusted users — no first DM needed; trusted users who join via the challenge later are invited into the management room automatically (one invite per person, failures retried by the next-start self-heal). With the space off (or if its creation fails), the classic behavior applies: the first room where the bot **successfully accepts (authorizes) a message** — a non-project, ≤2-person room — becomes the management room (renamed to `Project Management (<instance>)` — localized per the bot language — guide sent, room ID persisted to `config.managementRooms`). Either way the room is the admin console — `/pmctl` works only there — and its ID is stable afterwards.
- **Space organization (Element)**: a purely cosmetic grouping — a private space `π <instanceName>` collects every room the bot creates (the management room and all `/pmctl new` project rooms) so they don't scatter across your room list. The space itself takes no part in authorization — who may send commands and who holds which room permissions is decided by the permission model below. `/pmctl rm` also removes the room from the space. Toggle it in `setup` ("Enable space organization?", fresh configs default on, existing configs keep their current state); creation is lazy at the next start, and any failure just falls back to the unspace'd behavior with a warning and a retry on the next start. Users who pass the challenge later are invited into the space automatically (one invite per person, ever). A space still carrying the old `pi-courier · <instance>` name is renamed to the short form by the next-start self-heal (manually renamed spaces are left alone).
- **Avatars (three art sets, 24 images each, hues spread across the wheel)**: the bot automatically brands everything it manages with bundled art — and each kind of entity gets its own set, so you can tell them apart at a glance: **spaces** pick from a **landscape** set (aurora mountains, islands, cloud seas, ringed planets, galaxies…), **project rooms** from an **architecture** set (gingerbread cottage, chinese pavilion, pagoda, princess castle, shrine, space pod…), the **management room** wears the architecture set's dedicated golden-roof castle, and the **bot account itself** (the agent's face, shown in member lists and next to its messages) wears an **animal** set (fox, bunny, panda, unicorn, dragon…). Every set ships 24 distinct subjects with 24 distinct dominant hues: within a set the image is picked by hashing the instance/project name (same name → same image forever), sibling project rooms automatically skip slots another room already took (no two rooms in a space share a face) and coexisting deployments rarely collide. Existing rooms are branded on the next start too; an avatar you set manually is never replaced — except when an art set ships a full restyle, in which case that set's scope (its rooms — or the bot face, for the animal set) is re-branded once on the next start, each set migrating independently (manual avatars are kept again from then on). Not a fan of your pick? See "Custom avatars" above — point any target at your own image; or replace any PNG in `assets/avatars/` (same filename) with your own, no code changes needed.
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
    "!roomid:server": {
      "workdir": "/home/you/Projects/api",
      "model": "deepseek/deepseek-v4-flash",
      "thinkingLevel": "high",
      "fallbacks": ["zai/glm-5.3"]
    }
  }
  ```
- **Per-project presets** (since 0.7.0; `model` / `thinkingLevel` / `fallbacks`, all optional): each project remembers its own default model and thinking level — project A on a cheap fast model, project B on a strong reasoner, zero re-setup when you switch rooms. The process applies them once after every start **and** every `/reload` (one `📋 Project presets applied: …` line in the room). A preset is a **start-up default, not a lock**: manual `/model` / `/thinking` win afterwards and stay until the next restart returns you to the preset. Application failures never block the process — one warning line, then set things by hand. Levels: `off minimal low medium high xhigh max`; `model` uses the same `provider/id` form as `/model` (a bare id is resolved against the available-models list). `fallbacks` is that project's failover chain (see "Model fallback chain" above) — project chain wins over the global one. `/pmctl show` displays a project's presets.
- Each project room lazily starts its own pi process (~300MB RAM each) with `--session-dir <workdir>/.pi-session`, so sessions survive restarts per project.

### TUI ↔ Matrix session mirror (two-way sync)

Keep working in the terminal while the bot echoes everything into Matrix. In a room, send:

```
/attach
```

The bot replies with the exact command to run in a terminal, e.g. `pi --session <id>` (with `--session-dir` when the deployment uses a custom one). Attach in the terminal and the two ends stay in sync:

- **TUI → Matrix (live mirror)**: every prompt you send in the TUI and every reply the agent gives is forwarded to the room in real time — user lines carry a `🖥 **TUI user**` prefix and agent replies a `🤖 **TUI assistant**` one (all posted by the bot account, so the role prefixes are the only distinction); tool-call traffic is not forwarded, only conversation text.
- **Matrix → TUI (inherited context)**: attaching opens the very same session file, so the TUI starts with the full history of what Matrix already discussed.
- **Back to Matrix (auto-relay)**: after working in the TUI, just message the room again — before answering, the bot reloads the session file while idle, so the agent's context includes whatever happened in the TUI. In-flight work and queued messages are never interrupted by a reload.
- **TUI-side `/new`**: a new session started in the TUI keeps mirroring, but the room posts a notice — the Matrix side stays on its previous session, and the two contexts are unrelated (different session files). To bring Matrix along: `/sessions` then `/switch <number>`, or `/attach` again for the new session's command; likewise, after a Matrix-side `/new`, re-run `/attach` in the TUI.
- **Fork notice**: the TUI process never re-reads the session file, so writing in the TUI after a Matrix-side reply branches off the old node — the bot posts a one-time notice explaining how to converge (run `/resume` in the TUI to pick up the Matrix side). Relaying is **not** interrupted: it keeps following the newest branch in the session file.

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

### What happens when the bridge dies: systemd vs. watchdog

The systemd unit ships with `Restart=on-failure` + `RestartSec=5`: a **crash** (non-zero exit code or killed by a signal) is restarted after 5 seconds. The crash guard turns uncaught exceptions into a "message + non-zero graceful exit", so JS-level deaths are covered by systemd too; `pi-courier stop` is a clean exit (code 0) and is not restarted.

systemd cannot see a **hang**: the process and its PID are still there, but the event loop is stuck. The unit still shows active, journal gets no new lines, and the bridge stops answering. The independent watchdog `deploy/watchdog/watchdog-posix.sh` fills that gap:

- runs every minute from cron / a systemd timer; reads `~/.pi/pi-courier-state/heartbeat.json` (written atomically every 30 seconds, along with disk and heap levels);
- heartbeat older than **180 seconds** (= 6 × 30; the stale threshold lives as a script constant and can be overridden with `--stale-seconds`) or the PID in it no longer exists → `systemctl --user restart`. A missing PID waits one heartbeat interval (30 seconds by default, overridable with `--heartbeat-interval-seconds`) before declaring death, so a stale beat from the previous instance cannot kick a starting instance again;
- after the restart, the sibling `matrix-alert.mjs` reads the Matrix credentials and management room from `~/.pi/pi-courier.json` (`managementRooms[0]`, falling back to `space.roomId`) and calls the homeserver room-send API directly. The cooldown is 30 minutes by default (stamp file `~/.pi/pi-courier-state/watchdog-alert-stamp`); a failed send does not write the stamp, so the next minute retries. Alerts do not depend on the bridge — when the bot is dead, they still get out;
- a missing heartbeat file (the bridge has never had its first run) is treated as an installation error: no alert, no action;
- **a deliberate stop is never undone**: `pi-courier stop` writes `~/.pi/pi-courier-state/watchdog-paused` *before* calling systemctl (so the marker lands even when the process is hung and its signal handlers never run); the watchdog skips its check while the marker exists, and the next bridge start removes it. `pi-courier restart` has the process write the marker on SIGTERM, and the new instance clears it on startup. A raw `systemctl stop` or `kill -9` does not write the marker and will still be treated as a failure — use `pi-courier stop` for maintenance, or stop the watchdog first.

Install (either one; full comments in the script header):

```bash
# Option 1: cron (cron usually has no XDG_RUNTIME_DIR, which makes systemctl --user fail;
# replace 1000 with your uid, or use option 2, which is recommended)
* * * * * XDG_RUNTIME_DIR=/run/user/1000 /opt/pi-courier/deploy/watchdog/watchdog-posix.sh >> ~/.pi/pi-courier-state/watchdog.log 2>&1
```

Option 2: a systemd timer (two unit files, `systemctl --user enable --now pi-courier-watchdog.timer`). The service name defaults to `pi-pi-courier` (the name `deploy/pi-courier.user.service` installs as); override it with `PI_COURIER_SERVICE`; `PI_COURIER_ALERT=off` disables alerts (it can also hold a custom command template with a `{message}` placeholder, which the watchdog shell-quotes), and `PI_COURIER_HEARTBEAT` overrides the heartbeat path. The script hard-codes `systemctl --user` for **user units**; for a system-level unit remove `--user` and set `PI_COURIER_SERVICE`. Uninstall: stop the watchdog first (`systemctl --user disable --now pi-courier-watchdog.timer` and remove the two unit files, or delete the crontab line), then `pi-courier disable`; otherwise the watchdog will bring the service back once the stop window passes.

**Circuit breaker for a persistently full disk**: at startup, before any network wiring, the bridge checks the disk hard threshold (512MB by default) and exits with a single cause line in the local log (no management-room message). If the disk never gets cleaned, systemd keeps restarting it, one local log line per round. Add the following to the unit's `[Unit]` section to stop the loop:

```ini
[Unit]
StartLimitIntervalSec=300
StartLimitBurst=5
```

(5 starts within 300 seconds stop automatic restarts; after cleaning the disk run `systemctl --user reset-failed pi-pi-courier` and start again.) Resilience knobs live in the `resilience` section of the config file: heartbeat interval 30s, disk soft threshold 2048MB, hard threshold 512MB, heap alert 80%, pi RPC consecutive respawn limit 5; changes take effect on restart.

**When do you still need the watchdog?** Install it if you want hangs restarted and a Matrix alert when the service dies; if systemd's crash restart is enough and you accept discovering hangs manually, you can skip it. The watchdog's stale threshold deliberately does not live in the bridge's `resilience` config — the watchdog depends on zero bridge code and only reads the heartbeat and Matrix credentials. If you change `resilience.heartbeatIntervalSeconds`, adjust the script default (or install argument) to keep the 6× relationship.

## Windows

Supported since 1.0.0 and verified end-to-end on a real Windows Server 2025 machine (2026-10-14): install with native-library download + sha256 + load, setup wizard, Matrix connectivity, `!`/`!!` bash, single-instance lock, multi-project rooms with spaces, Task Scheduler autostart and a clean Ctrl+C shutdown. Everything not mentioned as a limitation below behaves as on Linux.

**Requirements**:

- Node.js >= 22.19 (the same hard floor pi 1.x enforces)
- **Git for Windows** — its bundled bash executes `!` / `!!` commands; without it they fail with a readable error
- pi, installed globally — see the discovery note below

The E2EE crypto native binding ships prebuilt for `win32-x64-msvc` / `win32-ia32-msvc` / `win32-arm64-msvc` and is downloaded + sha256-verified during install (x64 real-machine verified: the `.node` lands in `~/.cache/pi-courier/native-crypto/` and loads via N-API).

**Install and run**:

```powershell
npm install -g pi-courier
pi-courier setup
pi-courier run
```

On npm >= 11 machines with the install-scripts gate (you'll see `npm warn install-scripts`), the postinstall — including the native-library self-check — is silently skipped; install once with the scripts allowed:

```powershell
npm install -g --allow-scripts=pi-courier,@matrix-org/matrix-sdk-crypto-nodejs pi-courier
```

Verify with `pi-courier -v`. The `.cmd` / `.ps1` shims npm installs into `%APPDATA%\npm` work normally.

- **pi discovery is automatic**: an npm-global `@earendil-works/pi-coding-agent` is resolved from pi-courier's own install tree, and a pi.dev `install.ps1` install under `~/.pi/agent` is detected as well. Only exotic layouts need `PI_CLI_PATH` pointing at the `dist/cli.js` inside your pi package directory — **not** the `pi.cmd` / `pi.ps1` shim.
- **`!` / `!!` bash commands run through the Git for Windows bash** — POSIX paths (`/c/Users/...`), exit codes and error messages pass through exactly as on Linux.
- **`pi-courier update` works on Windows**: it launches npm through its `npm-cli.js` entry and skips the systemd stop/start choreography.
- **Autostart via Task Scheduler** (no admin needed, fires at every logon) — verified recipe:

  ```powershell
  $action  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c pi-courier run >> %USERPROFILE%\pi-courier-run.log 2>&1'
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  Register-ScheduledTask -TaskName 'pi-courier' -Action $action -Trigger $trigger
  Start-ScheduledTask -TaskName 'pi-courier'   # start right now; it refires on every logon
  ```

  This is a **logon-triggered** task: it starts at every logon only. It does not restart a process that crashes, is killed or hangs mid-session; after the process dies the task may still show Running. There are two ways to add self-healing:

  - **Auto-logon (automatic desktop login)**: lets the machine log in after a reboot so the logon task fires. The cost is credentials and a desktop session left on an unattended machine (a security risk), and it only covers "nobody logged in after a reboot" — it still cannot detect a hang.
  - **Watchdog (recommended)**: an independent scheduled task runs `deploy/watchdog/watchdog-windows.ps1` every minute and reads `%USERPROFILE%\.pi\pi-courier-state\heartbeat.json`. If the heartbeat is older than **180 seconds** (= 6 × 30, overridable with `-StaleSeconds`) or its PID no longer exists (a missing PID also waits one heartbeat interval, 30s by default) → ① if the PID is still alive (hang), `taskkill /F /PID` kills the old instance first (the single-instance lock is not preempted from a live process; without the kill the new instance exits immediately); ② `schtasks /end` terminates the stuck task instance (an end failure does not block the next step); ③ `schtasks /run` starts it. The sibling `matrix-alert.mjs` then reads the credentials and management room from `%USERPROFILE%\.pi\pi-courier.json` and posts a Matrix alert (30-minute cooldown by default). A missing heartbeat file is treated as an installation error: no alert, no action. The watchdog itself needs `node` on PATH.

    Install (the bridge task name defaults to `pi-courier`, matching the recipe above; replace the script path with your install directory — for an npm global install it is usually under `%APPDATA%\npm\node_modules\pi-courier\deploy\watchdog\`):

    ```powershell
    schtasks /create /tn "pi-courier-watchdog" `
      /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\pi-courier\deploy\watchdog\watchdog-windows.ps1 -TaskName pi-courier" `
      /sc minute /mo 1 /f
    ```

    Parameters: `-TaskName` the bridge task name; `-HeartbeatPath` heartbeat file (default `%USERPROFILE%\.pi\pi-courier-state\heartbeat.json`); `-StaleSeconds` stale threshold (default 180 = 6 × 30, see the script header for the conversion); `-NoAlert` disables the Matrix alert. Ctrl+C / Ctrl+Break writes the manual-stop marker so the watchdog will not bring the service back (`pi-courier stop` is Linux-only); `schtasks /end` is a hard kill and does not write it — stop the watchdog task before maintenance or uninstall. Uninstall:

    ```powershell
    schtasks /delete /tn "pi-courier-watchdog" /f
    ```

    Delete the watchdog task before stopping the bridge / deleting the bridge task — otherwise the watchdog will bring the bridge back once the stop window passes.

  A Windows service wrapper such as [NSSM](https://nssm.cc/) removes the logon dependency, but turns Node into a system service — heavier to install, upgrade and inspect; this version does not implement it and only keeps it as a trade-off option. Or simply keep a foreground session.
- **Ctrl+C / Ctrl+Break (SIGBREAK) shut the bridge down cleanly** — pi RPC stopped, Matrix disconnected, the single-instance lock released.
- **Single-instance lock** works the same: a stale lock left by a crashed process is taken over by the next start, whether launched from a console or the Task Scheduler.
- The config-file permission check (0600) is skipped on Windows: the OS cannot express POSIX modes there, so checking would warn on every start.

**Known limitations**: the service-management subcommands (`enable` / `start` / `stop` / `restart` / `status` / `logs` / `disable`) are Linux-only (systemd) and exit with an explanation; `pi-courier logs` filtering relies on journald (Linux). Config, sessions, attachments and state live under `%USERPROFILE%\.pi\` exactly as on Linux.

## 4. FAQ

**Q: `npm install` hangs / crawls at 20-60 kB/s?**
A: The 21 MB E2EE native library downloads from GitHub Releases and ignores npm's proxy. Set `export https_proxy=... http_proxy=...` (add to `~/.bashrc`) and reinstall.

**Q: `Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-…'` (any platform suffix)?**
A: The native binary didn't download — postinstall was blocked. On npm ≥ 11 machines with the install-scripts gate this is **silent**; re-install once with `npm install -g --allow-scripts=pi-courier,@matrix-org/matrix-sdk-crypto-nodejs pi-courier`. For a source checkout, run `cd node_modules/@matrix-org/matrix-sdk-crypto-nodejs && node download-lib.js`.

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
