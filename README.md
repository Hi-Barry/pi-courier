# pi-remote

Run the [pi coding agent](https://pi.dev) headlessly from your messenger — Matrix, Telegram, WhatsApp, Slack, Discord.

**Slash commands fully work from messengers** (`/new`, `/compact`, `/model`, `/skill:name`, prompt templates, extension commands) — something the classic extension mode cannot do, because pi's `sendUserMessage()` explicitly skips command handling. This project talks to pi over the [RPC protocol](https://pi.dev/docs/latest/rpc) instead, and maps messenger messages to RPC commands.

```
Messenger ──> pi-remote (standalone process) ──> pi --mode rpc (bundled, JSONL stdio)
Messenger <── replies <────────────────────── <── agent events (stdout)
```

## Why a standalone project

- **Bundles pi as a dependency** — `@earendil-works/pi-coding-agent` is a regular dependency, so the RPC client and the spawned pi process are always the same version. Upgrading pi is a one-line dependency bump, **no code changes**:

  ```bash
  npm update @earendil-works/pi-coding-agent @earendil-works/pi-ai
  npm run build
  sudo systemctl restart pi-msg-bridge
  ```

- **No TUI required** — pi runs headless (`--mode rpc`); the terminal is optional.
- **Session persistence** — pi sessions live on disk and resume across restarts, so `/reload` (restarting the pi process after installing extensions) is lossless.

## Quick start

```bash
npm install
npm run build

# configure ~/.pi/agent/{models.json,auth.json,settings.json} (see docs/DEPLOYMENT.md)
# configure ~/.pi/msg-bridge.json (messenger tokens)

node dist/standalone.js --workdir /path/to/project
```

Run under systemd:

```bash
sudo cp deploy/pi-msg-bridge.service /etc/systemd/system/
sudo systemctl enable --now pi-msg-bridge
```

## Slash commands

| Command | Action |
|---|---|
| `/new` `/clear` | New session |
| `/compact [notes]` | Compact context |
| `/model` `/model <provider/id>` | Show / switch model |
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

Anything else starting with `/` is passed through to pi via `prompt`: extension commands, `/skill:name` and `/template` are expanded by pi itself. Plain text is a normal conversation turn.

Bridge admin commands (DM): `/trusted`, `/revoke`, `/channels`, `/enable`, `/disable`, `/toggletools`.

## Docs

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — full deployment & usage guide (中文)
- Upstream messenger bridge project: [tintinweb/pi-messenger-bridge](https://github.com/tintinweb/pi-messenger-bridge)

## License

MIT
