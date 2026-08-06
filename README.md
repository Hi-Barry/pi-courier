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

### Option A: Regular users — one command

```bash
npm install -g pi-courier
```

That's it. Verify: `pi-courier help`.

### Option B: Developers — from source

```bash
git clone https://github.com/Hi-Barry/pi-courier.git
cd pi-courier
npm install
npm run build
npm link          # make the `pi-courier` command available globally
```

**Do not use `--ignore-scripts`**: the Matrix E2EE library downloads its native binary via postinstall. If your npm blocks it and you hit `Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu'`, run:

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

It walks you through, prompting for each value (defaults in brackets; press Enter to accept):

```
=== pi-courier 首次配置向导 ===
将生成 ~/.pi/pi-courier.json(权限 600)

Matrix homeserver URL (如 https://matrix.example.com):   ← 输入,如 https://matrix.example.com
获取 token 方式 [1=用户名密码登录, 2=粘贴已有 token] (1):  ← 1 或 2(Enter 默认 1)
  [方式 1] bot 用户名 (如 test2):                        ← bot 账号名,如 test3
           bot 密码:                                     ← 密码(不回显)
  [方式 2] 粘贴 access token (syt_...):                  ← 已有 token
✅ 登录成功,账号: @test3:matrix.example.com
信任用户(管理员)MXID [默认 @test3:matrix.example.com]:   ← 直接回车 = 只有 bot 自己可信;建议填你的账号,如 @barry:matrix.example.com
启用 E2EE 加密? [y/N]:                                  ← y/n(非加密房间也选 y 无妨)
pi 工作目录 [默认 /home/you/Projects]:                   ← Enter 或输入其他目录

✅ 配置已写入 ~/.pi/pi-courier.json
   账号: @test3:...
   信任用户: @barry:...
   E2EE: 开启
   工作目录: /home/you/Projects
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
[2026-08-06T02:38:55.685Z] [INFO] 📥 [matrix] @barry: 你好,收到请回复!
[2026-08-06T02:38:57.884Z] [INFO] [agent] 回复 @barry: 你好!收到,我在线。...
```

You are now a trusted user (the first trusted user also becomes admin). Any user not in `auth.trustedUsers` goes through this flow once; pre-listed users skip it entirely.

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
| `/abort` | Abort current operation |
| `/reload` | Restart pi (after installing extensions/config) |
| `/help` | Full help |

**Bridge admin commands**: `/trusted`, `/revoke <userId>`, `/channels`, `/enable <chatId> <mode>`, `/disable <chatId>`, `/toggletools`

**Anything else** starting with `/` passes through to pi directly — extension commands, `/skill:name`, prompt templates. Plain text is a normal conversation turn.

**Group chats**: enable the room first with `/enable <roomId> all` (in a DM to the bot).

### Managing the service

```bash
pi-courier status          # status + recent logs
pi-courier logs            # tail logs (INFO and above)
pi-courier logs --level debug   # tail ALL logs (incl. thinking, stream deltas)
pi-courier logs --level error   # errors only
pi-courier run --level debug    # foreground with full detail
pi-courier restart        # restart
pi-courier stop           # stop
pi-courier start          # start
pi-courier disable        # uninstall the service
pi-courier update         # update pi-courier itself
```

Log levels: `debug < info < warn < error`. The service writes everything;
`logs` shows INFO+ by default, `--level debug` shows the full session replay
(user messages, thinking, tool calls, replies). The complete conversation is
always stored in pi's session files (`~/.pi/agent/sessions/`).

Upgrading **pi** is independent — pi-courier always uses the system pi via `which pi`:

```bash
npm install -g @earendil-works/pi-coding-agent@latest
pi-courier restart
```

## 4. FAQ

**Q: `npm install` hangs / crawls at 20-60 kB/s?**
A: The 21 MB E2EE native library downloads from GitHub Releases and ignores npm's proxy. Set `export https_proxy=... http_proxy=...` (add to `~/.bashrc`) and reinstall.

**Q: `Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu'`?**
A: The native binary didn't download (postinstall blocked). Run manually: `cd node_modules/@matrix-org/matrix-sdk-crypto-nodejs && node download-lib.js`.

**Q: `npm install -g pi-courier` fails with EEXIST?**
A: A previous `npm link` left a conflicting bin. `npm unlink -g pi-courier && rm -f $(npm prefix -g)/bin/pi-courier && npm install -g pi-courier`.

**Q: The systemd service restarts in a loop?**
A: Almost always a Node version mismatch — the pi child crashes on system node v20 (`webidl.util.markAsUncloneable is not a function`). Load nvm and re-run `pi-courier enable` (v0.1.2+ writes the correct PATH into the unit). Stick to one Node version everywhere.

**Q: Startup shows `model: unknown`?**
A: pi's provider isn't configured. Check `~/.pi/agent/`: `models.json` + `auth.json` + `settings.json` (`defaultProvider` / `defaultModel` — exact field names).

**Q: Lots of `Decryption error` lines in the log?**
A: Historical events that can't be decrypted (new device without old keys). Normal — new messages work fine.

**Q: Encrypted room: no reply / can't decrypt new messages?**
A: The bot's new device never received the room keys. The bot account has no cross-signing, so the most reliable fix is to **use a non-encrypted room** (create a room without encryption and invite the bot) — the bridge handles plain rooms fine even with `encryption: true`.

**Q: `M_BAD_JSON: Provided device_id in device_keys does not match...`?**
A: The crypto store holds an old device identity but the token belongs to a newer device (re-logged). Delete and restart: `rm -rf ~/.pi/pi-courier-matrix-crypto && pi-courier restart`. Do this whenever you re-run setup / change the token.

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
  "autoConnect": true,
  "debug": true
}
```

Env var alternatives: `PI_MATRIX_HOMESERVER` / `PI_MATRIX_ACCESS_TOKEN`.

## 5. License & Acknowledgements

MIT License — see [LICENSE](LICENSE).

**Upstream**: this project is a rework of [tintinweb/pi-messenger-bridge](https://github.com/tintinweb/pi-messenger-bridge) (MIT). The Matrix transport layer and challenge auth come from upstream; the RPC-based standalone architecture, slash-command mapping, CLI, setup wizard and docs are new.

pi-courier is an independent companion app for [pi](https://pi.dev) — it is not affiliated with Earendil Inc.
