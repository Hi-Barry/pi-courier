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

mkdir -p "$CONFIG_DIR/agent"
# Per-file idempotent bootstrap (audit stability batch 票18): copy a default
# only when its target is absent — two concurrent first starts converge on
# the same complete state (no half-copied mixes), and no non-POSIX `cp -n`.
for src in "$DEFAULTS"/agent/*; do
  name=$(basename "$src")
  if [ ! -e "$CONFIG_DIR/agent/$name" ]; then
    echo "[pi-courier] first run: seeding $CONFIG_DIR/agent/$name from template"
    cp -r "$src" "$CONFIG_DIR/agent/$name" || echo "[pi-courier] WARN: template copy failed: $name"
  fi
done

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
