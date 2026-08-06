#!/bin/sh
# pi-courier container entrypoint.
#
# First-run bootstrap: when the config volume (/root/.pi) is empty or has no
# agent config yet (fresh bind mount), copy the default templates from
# /opt/pi-courier/defaults so the container works out of the box — the user
# then only edits ./data/agent/auth.json (API key) and runs the setup wizard.

set -e

DEFAULTS=/opt/pi-courier/defaults
CONFIG_DIR=/root/.pi

if [ ! -d "$CONFIG_DIR/agent" ] || [ -z "$(ls -A "$CONFIG_DIR/agent" 2>/dev/null)" ]; then
  echo "[pi-courier] first run: initializing $CONFIG_DIR/agent from template"
  mkdir -p "$CONFIG_DIR/agent"
  # -r is required: GNU cp refuses to copy a directory (even 'dir/.') without it
  cp -rn "$DEFAULTS/agent/." "$CONFIG_DIR/agent/" || echo "[pi-courier] WARN: template copy failed"
fi

# env-driven defaults for pi settings (pi itself has no env support for
# defaultProvider/defaultModel, so render them into settings.json).
# env wins over whatever is in the file (idempotent on every start).
if [ -n "$PI_DEFAULT_PROVIDER" ] || [ -n "$PI_DEFAULT_MODEL" ]; then
  node -e '
    const fs = require("fs");
    const p = "/root/.pi/agent/settings.json";
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    if (process.env.PI_DEFAULT_PROVIDER) s.defaultProvider = process.env.PI_DEFAULT_PROVIDER;
    if (process.env.PI_DEFAULT_MODEL) s.defaultModel = process.env.PI_DEFAULT_MODEL;
    fs.writeFileSync(p, JSON.stringify(s, null, 2));
    console.log("[pi-courier] settings.json updated from env");
  '
fi

exec "$@"
