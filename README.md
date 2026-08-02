# pi-remote

[English](README.md) | [简体中文](README.zh-CN.md)

Run the [pi coding agent](https://pi.dev) headlessly from your messenger — Matrix, Telegram, WhatsApp, Slack, Discord.

Unlike the classic extension mode, this project drives pi over the [RPC protocol](https://pi.dev/docs/latest/rpc), so **slash commands work from messengers** (`/new`, `/compact`, `/model`, `/skill:name`, prompt templates, extension commands) — the extension mode can't do this because pi's `sendUserMessage()` deliberately skips command handling.

> **Upstream**: this project is a rework of [tintinweb/pi-messenger-bridge](https://github.com/tintinweb/pi-messenger-bridge) — the messenger transport layer (Matrix/Telegram/WhatsApp/Slack/Discord) and challenge auth come from there; the RPC-based standalone architecture, slash-command mapping and setup wizard are new.

## Features

- 📱 Multi-messenger: Matrix, Telegram, WhatsApp, Slack, Discord
- 🔐 Challenge-based auth (6-digit codes), transport-namespaced user IDs
- 🎛️ Full slash-command support: `/new`, `/compact`, `/model`, `/thinking`, `/bash`, `/reload`, ...
- 🧩 Skills & prompt templates pass through: `/skill:name`, `/template`
- 💾 Session persistence: pi sessions live on disk, resume across restarts
- 🔄 `/reload` restarts the pi process (after installing extensions/config) — lossless
- 🔌 pi is **not bundled**: installed independently on the system, upgraded on its own
- 🧭 One-command CLI: `pi-remote setup` wizard, `pi-remote enable` auto-start, `pi-remote update` self-update

## Architecture

```
Messenger ──> pi-remote (dist/standalone.js) ──> pi --mode rpc (system-installed)
Messenger <── replies <────────────────────── <── agent events (stdout JSONL)
```

- pi-remote spawns and manages the `pi --mode rpc` child process
- Sessions persist to `~/.pi/agent/sessions`, resumed automatically after restarts
- systemd only needs to manage the pi-remote service

## Requirements

| Component | Requirement | Check |
|---|---|---|
| Node.js | >= 20 (tested on 24.x) | `node --version` |
| pi | >= 0.83, **installed globally** (not bundled) | `pi --version` |
| Network | access to your homeserver and LLM provider | — |

Install pi first — pi-remote is a companion app that connects to it over RPC:

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version
```

> Using nvm? Run `source ~/.nvm/nvm.sh` (or your nvm init) in each new terminal and make sure `pi` is on PATH.

## Installation

```bash
git clone https://github.com/Hi-Barry/pi-remote.git
cd pi-remote
npm install
npm link          # make the `pi-remote` command available globally
npm run build
```

**Do not use `--ignore-scripts`**: the Matrix E2EE library (`@matrix-org/matrix-sdk-crypto-nodejs`) downloads its native binary via postinstall. If your npm blocks it (allow-scripts) and you hit `Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu'`, run:

```bash
cd node_modules/@matrix-org/matrix-sdk-crypto-nodejs
node download-lib.js
cd ../..
```

A successful build produces `dist/standalone.js`.

## Configuration

### pi's LLM provider (`~/.pi/agent/`)

**a) models.json** — model metadata. Best pulled from models.dev so fields are complete and correct (opencode-go example):

```bash
curl -s https://models.dev/api.json -o /tmp/modelsdev.json
python3 -c "
import json, os
md = json.load(open('/tmp/modelsdev.json'))   # top level is the provider dict
out = {'providers': {'opencode-go': md['opencode-go']}}
json.dump(out, open(os.path.expanduser('~/.pi/agent/models.json'), 'w'), indent=2)
"
```

**b) auth.json** — API key (chmod 600):

```json
{
  "opencode-go": { "type": "api_key", "key": "sk-your-key" }
}
```

**c) settings.json** — default provider & model:

```json
{
  "defaultProvider": "opencode-go",
  "defaultModel": "deepseek-v4-flash"
}
```

> Field names are `defaultProvider`/`defaultModel` (not `provider`/`model`).

Verify (run inside the pi-remote project dir):

```bash
node --input-type=module -e "
import { RpcClient } from '@earendil-works/pi-coding-agent';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
const c = new RpcClient({ cliPath: path.join(path.dirname(entry), 'cli.js') });
await c.start();
console.log('models:', (await c.getAvailableModels()).length);
console.log('current:', (await c.getState()).model?.id);
await c.stop();
"
```

### Messenger (Matrix example)

**Option A (recommended): setup wizard**

```bash
pi-remote setup
```

Follow the prompts: platform → homeserver URL → token (password login or paste an existing one) → trusted admin user MXID → E2EE toggle → pi workdir. The wizard verifies the token and writes `~/.pi/msg-bridge.json`.

**Option B: manual `~/.pi/msg-bridge.json`** (chmod 600):

```json
{
  "matrix": {
    "homeserverUrl": "https://your-homeserver",
    "accessToken": "syt_...",
    "encryption": true
  },
  "auth": {
    "trustedUsers": ["matrix:@you:your-homeserver"],
    "adminUserId": "matrix:@you:your-homeserver"
  },
  "workdir": "/path/to/pi/workdir",
  "autoConnect": true,
  "debug": true
}
```

- Get an access token: `POST /_matrix/client/v3/login` (password login) or from Element's settings page
- `trustedUsers`/`adminUserId` format: `<transport>:<full userId>`, e.g. `matrix:@barry:matrix.example.com`
- `workdir`: pi's working directory (spawned automatically if missing); `pi-remote run --workdir <dir>` overrides it
- `sessionDir` / `cliPath`: optional overrides (defaults: pi's session dir, and `which pi` for the CLI)
- `encryption: true` for encrypted rooms (works for plain rooms too)
- Env var alternatives: `PI_MATRIX_HOMESERVER` / `PI_MATRIX_ACCESS_TOKEN` (other platforms: `PI_TELEGRAM_TOKEN`, `PI_SLACK_BOT_TOKEN`+`PI_SLACK_APP_TOKEN`, `PI_DISCORD_TOKEN`, `PI_WHATSAPP_AUTH_PATH`)

## Usage

Everything goes through a single command:

```
pi-remote setup      first-run configuration wizard (Matrix account, trusted user, workdir)
pi-remote run        run in the foreground (workdir from config; --workdir overrides)
pi-remote enable     install a user-level systemd service (auto-start) and start it
pi-remote start      start the service
pi-remote stop       stop the service
pi-remote restart    restart the service
pi-remote status     show service status + recent logs
pi-remote logs       tail the service logs
pi-remote disable    uninstall the service (stop + remove autostart + delete unit file)
pi-remote update     update this project (git pull + npm install + build)
```

Typical first deployment:

```bash
pi-remote setup        # answer the prompts (or edit ~/.pi/msg-bridge.json manually)
pi-remote enable       # auto-start on boot, running as your user
```

For a quick foreground test: `pi-remote run` (Ctrl+C to stop). The old `node dist/standalone.js --workdir ...` form still works if you prefer it.

Startup success looks like:

```
✅ Matrix connected as @bot:your-homeserver (2 rooms, E2EE enabled)
✅ pi RPC connected (model: deepseek-v4-flash, session: 019f...)
🚀 msg-bridge standalone ready. Waiting for messages...
```

### Commands (send in the bot's DM)

**Pi commands (mapped to RPC):**

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
| `/bash <cmd>` | Run a shell command (goes into context) |
| `/abort` | Abort current operation |
| `/reload` | Restart pi process (after installing extensions/config) |
| `/help` | Full help |

**Bridge admin commands:** `/trusted`, `/revoke <userId>`, `/channels`, `/enable <chatId> <mode>`, `/disable <chatId>`, `/toggletools`

**Pass-through:** any other `/`-prefixed command goes to pi directly — extension commands, `/skill:name` and prompt templates are expanded by pi. Plain text is a normal conversation turn.

### First run: authentication

1. DM the bot account from your account
2. The bridge terminal (or `journalctl --user -u pi-msg-bridge -f`) prints a 6-digit code
3. Reply with the code → you become a trusted user (the first trusted user becomes admin)

Users pre-listed in `msg-bridge.json` → `auth.trustedUsers` skip this step.

## systemd deployment

**User-level (recommended, no sudo):**

```bash
pi-remote enable
```

That's it — it writes a systemd unit to `~/.config/systemd/user/pi-msg-bridge.service` (using the absolute node path and your configured workdir), enables auto-start and starts the service. For fully headless operation (keep running after logout), run once: `sudo loginctl enable-linger $USER`.

Commands: `pi-remote status`, `pi-remote logs`, `pi-remote stop`, `pi-remote start` (or `systemctl --user restart pi-msg-bridge`).

**System-level (needs sudo):** copy `deploy/pi-msg-bridge.service` to `/etc/systemd/system/`, adjust the three marked values (`User`, `WorkingDirectory`, `NVM_DIR`), then `sudo systemctl enable --now pi-msg-bridge`.

## Upgrading pi

pi is managed independently on the system — upgrade it, no bridge code changes:

```bash
npm install -g @earendil-works/pi-coding-agent@latest
pi --version
pi-remote restart    # or: systemctl --user restart pi-msg-bridge
```

pi-remote always connects to the system pi via `which pi`. Only a breaking change to pi's RPC protocol would require bridge code changes (the protocol is a documented stable interface and has never broken).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `git clone` 404 | wrong repo URL | use `https://github.com/Hi-Barry/pi-remote.git` |
| `Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu'` | native lib not downloaded | run the manual download in Installation |
| `model: unknown` at startup | provider not configured | check the three `~/.pi/agent/` files |
| `getAvailableModels` empty | models.json malformed | regenerate with the models.dev command |
| Lots of `Decryption error` in logs | historical event replay without keys | normal; doesn't affect new messages |
| No new messages in encrypted room | bot device unverified | verify the bot device in Element (or use a non-encrypted room) |
| `pi RPC did not become ready` | pi fails to start | run `node node_modules/@earendil-works/pi-coding-agent/dist/cli.js --mode rpc` manually to see the error |
| `no transports configured` | bridge config empty | check `~/.pi/msg-bridge.json` or `PI_*` env vars |
| Matrix connect failure | wrong homeserver/token | `curl -H "Authorization: Bearer <token>" https://homeserver/_matrix/client/v3/account/whoami` |
| No reply to messages | model call failing | run with `--debug`; curl the provider endpoint directly |

## Tips

- **Element clients** treat `/`-prefixed messages as client commands — prefix with `//` to send a literal slash (`//compact` sends `/compact`)
- **Proxy environments**: set `HTTP_PROXY`/`HTTPS_PROXY` (systemd: via `EnvironmentFile`)
- **Group chats**: enable with `/enable <roomId> all` first; DMs need no setup

## Development

```bash
npm run build        # compile
npm run typecheck    # type-check
npm run test         # unit tests (vitest)
npm run lint         # biome lint
```

## License

MIT

Upstream: [tintinweb/pi-messenger-bridge](https://github.com/tintinweb/pi-messenger-bridge) (MIT)
