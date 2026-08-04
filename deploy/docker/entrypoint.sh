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
  cp -n "$DEFAULTS/agent/." "$CONFIG_DIR/agent/" 2>/dev/null || true
fi

exec "$@"
