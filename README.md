# pi-courier

[English](README.md) | [简体中文](README.zh-CN.md)

Run the [pi coding agent](https://pi.dev) headlessly from **Matrix**. Slash commands, skills and prompt templates fully work from your chat client.

Unlike the classic extension mode, this project drives pi over the [RPC protocol](https://pi.dev/docs/latest/rpc), so **slash commands work from messengers** (`/new`, `/compact`, `/model`, `/skill:name`, prompt templates, extension commands) — the extension mode can't do this because pi's `sendUserMessage()` deliberately skips command handling.

> **Upstream**: this project is a rework of [tintinweb/pi-messenger-bridge](https://github.com/tintinweb/pi-messenger-bridge) — the Matrix transport layer and challenge auth come from there; the RPC-based standalone architecture, slash-command mapping, CLI and setup wizard are new.

## Features

- 📱 Matrix transport (E2EE-capable), challenge-based auth (6-digit codes)
- 🎛️ Full slash-command support: `/new`, `/compact`, `/model`, `/thinking`, `/bash`, `/reload`, ...
- 🧩 Skills & prompt templates pass through: `/skill:name`, `/template`
- 💾 Session persistence: pi sessions live on disk, resume across restarts
- 🔄 `/reload` restarts the pi process (after installing extensions/config) — lossless
- 🔌 pi is **not bundled**: installed independently on the system, upgraded on its own
- 🧭 One-command CLI: `pi-courier setup` wizard, `pi-courier enable` auto-start, `pi-courier update` self-update

## Architecture

```
Messenger ──> pi-courier (dist/standalone.js) ──> pi --mode rpc (system-installed)
Messenger <── replies <────────────────────── <── agent events (stdout JSONL)
```

- pi-courier spawns and manages the `pi --mode rpc` child process
- Sessions persist to `~/.pi/agent/sessions`, resumed automatically after restarts
- systemd only needs to manage the pi-courier service

## Requirements

| Component | Requirement | Check |
|---|---|---|
| Node.js | >= 20 (tested on 24.x) | `node --version` |
| pi | >= 0.83, **installed globally** (not bundled) | `pi --version` |
| Network | access to your homeserver and LLM provider | — |

Install pi first — pi-courier is a companion app that connects to it over RPC:

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version
```

> Using nvm? Run `source ~/.nvm/nvm.sh` (or your nvm init) in each new terminal and make sure `pi` is on PATH.

## Installation

```bash
git clone https://github.com/Hi-Barry/pi-courier.git
cd pi-courier
npm install
npm link          # make the `pi-courier` command available globally
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

Verify (run inside the pi-courier project dir):

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
pi-courier setup
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
- `workdir`: pi's working directory (spawned automatically if missing); `pi-courier run --workdir <dir>` overrides it
- `sessionDir` / `cliPath`: optional overrides (defaults: pi's session dir, and `which pi` for the CLI)
- `encryption: true` for encrypted rooms (works for plain rooms too)
- Env var alternatives: `PI_MATRIX_HOMESERVER` / `PI_MATRIX_ACCESS_TOKEN`

## Usage

Everything goes through a single command:

```
pi-courier setup      first-run configuration wizard (Matrix account, trusted user, workdir)
pi-courier run        run in the foreground (workdir from config; --workdir overrides)
pi-courier enable     install a user-level systemd service (auto-start) and start it
pi-courier start      start the service
pi-courier stop       stop the service
pi-courier restart    restart the service
pi-courier status     show service status + recent logs
pi-courier logs       tail the service logs
pi-courier disable    uninstall the service (stop + remove autostart + delete unit file)
pi-courier update     update this project (git pull + npm install + build)
```

Typical first deployment:

```bash
pi-courier setup        # answer the prompts (or edit ~/.pi/msg-bridge.json manually)
pi-courier enable       # auto-start on boot, running as your user
```

For a quick foreground test: `pi-courier run` (Ctrl+C to stop). The old `node dist/standalone.js --workdir ...` form still works if you prefer it.

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
pi-courier enable
```

That's it — it writes a systemd unit to `~/.config/systemd/user/pi-msg-bridge.service` (using the absolute node path and your configured workdir), enables auto-start and starts the service. For fully headless operation (keep running after logout), run once: `sudo loginctl enable-linger $USER`.

Commands: `pi-courier status`, `pi-courier logs`, `pi-courier stop`, `pi-courier start` (or `systemctl --user restart pi-msg-bridge`).

**System-level (needs sudo):** copy `deploy/pi-msg-bridge.service` to `/etc/systemd/system/`, adjust the three marked values (`User`, `WorkingDirectory`, `NVM_DIR`), then `sudo systemctl enable --now pi-msg-bridge`.

## Upgrading pi

pi is managed independently on the system — upgrade it, no bridge code changes:

```bash
npm install -g @earendil-works/pi-coding-agent@latest
pi --version
pi-courier restart    # or: systemctl --user restart pi-msg-bridge
```

pi-courier always connects to the system pi via `which pi`. Only a breaking change to pi's RPC protocol would require bridge code changes (the protocol is a documented stable interface and has never broken).

## FAQ

### Installation & deployment

**Q: `git clone` fails with 404?**
A: Wrong repo URL. Use `https://github.com/Hi-Barry/pi-courier.git` (install from npm instead: `npm install -g pi-courier`).

**Q: `npm install` hangs / crawls at ~20-60 kB/s?**
A: Two downloads are involved:
- npm registry packages → set npm proxy: `npm config set proxy http://...` and `npm config set https-proxy http://...`
- the 21 MB E2EE native lib (downloaded from GitHub Releases by matrix-sdk-crypto-nodejs) → does **not** use npm's proxy; export `https_proxy`/`http_proxy` env vars before installing (e.g. `export https_proxy=http://10.88.88.8:10809`). Add them to `~/.bashrc` to make it permanent.

**Q: `Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu'`?**
A: The native binary wasn't downloaded (postinstall blocked or interrupted). Run manually (with proxy env vars set if needed):
```bash
cd node_modules/@matrix-org/matrix-sdk-crypto-nodejs
node download-lib.js
cd ../..
```

**Q: `npm install -g pi-courier` fails with EEXIST?**
A: A previous `npm link` left a conflicting `pi-courier` bin. Remove it first:
```bash
npm unlink -g pi-courier
rm -f ~/.nvm/versions/node/v24.18.1/bin/pi-courier
npm install -g pi-courier
```

**Q: `pi-courier` command not found after `npm link`?**
A: The link was created before `npm run build`, so `dist/cli.js` didn't exist yet. Re-run `npm link` after building (or just install via npm instead).

**Q: The systemd service keeps restarting in a loop?**
A: The pi child process crashed — almost always a Node version mismatch. The bridge spawns pi via PATH, and systemd's default PATH may find a system node (e.g. v20) that pi's undici is incompatible with (`webidl.util.markAsUncloneable is not a function`). Fix: load nvm (`source ~/.nvm/nvm.sh`) and re-run `pi-courier enable` (v0.1.2+ writes `Environment=PATH=<nvm bin first>` into the unit automatically). Stick to one Node version (nvm v24) everywhere.

### Configuration

**Q: Startup logs `model: unknown`?**
A: pi's provider isn't configured. Check the three files in `~/.pi/agent/`: `models.json` (model metadata), `auth.json` (API key, chmod 600), `settings.json` (`defaultProvider` / `defaultModel` — note the exact field names).

**Q: `getAvailableModels` returns nothing?**
A: `models.json` is malformed. Regenerate it with the models.dev extraction command in the Configuration section.

**Q: `no transports configured` at startup?**
A: The bridge config is empty. Check `~/.pi/msg-bridge.json` (run `pi-courier setup`) or the `PI_*` env vars.

**Q: Weird `DeprecationWarning: util._extend` appears during setup?**
A: Known noise from a transport dependency, filtered since v0.1.0 — update pi-courier if you still see it.

### Messaging & encryption

**Q: Lots of `Decryption error` lines in the log?**
A: Historical events that can't be decrypted (new device without old keys). Normal — new messages decrypt fine.

**Q: Encrypted room: no reply / can't decrypt new messages?**
A: The bot's new device never received the room keys from your client. Options:
- In Element (web: Settings → Security & Privacy → Encryption), make sure "Only share keys with verified devices" is unchecked, then send a message in the room
- The bot account has no cross-signing, so user verification shows "unavailable" — device-level trust is the relevant one, but the simplest reliable fix is: **use a non-encrypted room** (create a room without encryption enabled and invite the bot). The bridge handles plain rooms fine even with `encryption: true`.

**Q: `M_BAD_JSON: Provided device_id in device_keys does not match...` at startup?**
A: The crypto store holds an old device identity but your access token belongs to a newer device (token was re-logged). Delete the store and restart:
```bash
rm -rf ~/.pi/msg-bridge-matrix-crypto
pi-courier restart
```
Remember this whenever you re-run setup / change the token.

**Q: Matrix connection fails (wrong homeserver/token)?**
A: Verify the token: `curl -H "Authorization: Bearer <token>" https://homeserver/_matrix/client/v3/account/whoami`.

**Q: First message to the bot asks for a 6-digit code?**
A: That's the challenge auth — reply with the code to become a trusted user (the first trusted user becomes admin). Users pre-listed in `auth.trustedUsers` skip this.

**Q: No reply to messages at all?**
A: Check in order: (1) `pi-courier status` / logs — is Matrix connected? any Decryption errors (encrypted room)? (2) is pi RPC connected? (3) the model call itself — run `curl` against the provider endpoint with your key to isolate it.

### Running & maintenance

**Q: `pi RPC did not become ready`?**
A: The pi child failed to start. Run it manually to see the real error:
```bash
node node_modules/@earendil-works/pi-coding-agent/dist/cli.js --mode rpc
```
Common causes: Node version mismatch (see service restart loop above), invalid provider config, no network access to the provider.

**Q: After a restart the conversation context is gone?**
A: Since v0.1.1 the bridge passes `--continue` to pi, resuming the most recent session per workdir (same as `pi -c`). Update pi-courier and restart; `/new` starts a fresh session and the next restart resumes that one.

**Q: Element (web client) intercepts `/`-prefixed messages?**
A: Prefix with `//` to send a literal slash (`//compact` sends `/compact`).

**Q: Proxy environment tips?**
A: npm registry → `npm config set proxy/https-proxy`; GitHub downloads & bridge runtime → `export https_proxy`/`http_proxy` (systemd: add to `EnvironmentFile`).

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

The full development history — research, design decisions, every pitfall hit in
real deployments — is documented in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

MIT

Upstream: [tintinweb/pi-messenger-bridge](https://github.com/tintinweb/pi-messenger-bridge) (MIT)
