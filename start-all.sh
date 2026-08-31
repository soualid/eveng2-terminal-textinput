#!/usr/bin/env bash
# Free the ports below, then launch one even-terminal per project plus the
# textinput companion (server.mjs). Everything is spawned detached, logging
# under ~/.even-terminal/, so it survives this shell closing.
#
#   arte-player  4447  ~/work/arte-player
#   cryptopunks  4444  ~/work/cryptopunks.eth
#   teamwise     4446  ~/work/teamwise
#   ui           8790  server.mjs (this repo)
#
# The auth token must stay stable across restarts (the Even app pairs with
# it): set EVEN_TOKEN=... or put it in ~/.even-terminal/token (kept out of
# the repo — it grants control of the machine's Claude Code sessions).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$HOME/.even-terminal"
TOKEN="${EVEN_TOKEN:-$(cat "$LOG_DIR/token" 2>/dev/null || true)}"
[ -n "$TOKEN" ] || { echo "token manquant : export EVEN_TOKEN=... ou écrire $LOG_DIR/token" >&2; exit 1; }
UI_PORT=8790

# "name port project-dir" — one even-terminal instance per line
INSTANCES=(
  "arte-player 4447 $HOME/work/arte-player"
  "cryptopunks 4444 $HOME/work/cryptopunks.eth"
  "teamwise    4446 $HOME/work/teamwise"
)

# Resolve node / even-terminal even when PATH doesn't carry nvm (cron, launchd).
NODE_BIN="$(command -v node || true)"
[ -z "$NODE_BIN" ] && NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
[ -z "$NODE_BIN" ] && { echo "node introuvable" >&2; exit 1; }
EVEN_BIN="$(command -v even-terminal || true)"
[ -z "$EVEN_BIN" ] && EVEN_BIN="$(dirname "$NODE_BIN")/even-terminal"
[ -x "$EVEN_BIN" ] || { echo "even-terminal introuvable ($EVEN_BIN)" >&2; exit 1; }

mkdir -p "$LOG_DIR"

listening_pids() { lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null || true; }

# SIGTERM the listener and its children (claude subprocesses would otherwise
# be orphaned), wait up to 5s, then SIGKILL whatever survived.
free_port() {
  local port=$1 pids all pid
  pids="$(listening_pids "$port")"
  if [ -z "$pids" ]; then
    echo "  :$port déjà libre"
    return
  fi
  all="$pids"
  for pid in $pids; do
    all="$all $(pgrep -P "$pid" || true)"
  done
  echo "  :$port occupé — kill $all"
  kill $all 2>/dev/null || true
  for _ in $(seq 1 25); do
    local alive=""
    for pid in $all; do kill -0 "$pid" 2>/dev/null && alive="$alive $pid"; done
    [ -z "$alive" ] && return
    sleep 0.2
  done
  for pid in $all; do kill -9 "$pid" 2>/dev/null || true; done
}

launch_even_terminal() {
  local name=$1 port=$2 dir=$3
  local log="$LOG_DIR/textinput-start-$port.log"
  [ -d "$dir" ] || { echo "  ✗ $name : dossier manquant $dir" >&2; return 1; }
  (cd "$dir" && nohup "$NODE_BIN" "$EVEN_BIN" -d "$dir" -p "$port" -t "$TOKEN" -n "$name" \
    >>"$log" 2>&1 < /dev/null &)
  echo "  → $name sur :$port (log: $log)"
}

launch_ui() {
  local log="$LOG_DIR/textinput-companion.log"
  (cd "$SCRIPT_DIR" && PORT=$UI_PORT nohup "$NODE_BIN" "$SCRIPT_DIR/server.mjs" \
    >>"$log" 2>&1 < /dev/null &)
  echo "  → ui sur :$UI_PORT (log: $log)"
}

wait_port() {
  local name=$1 port=$2
  for _ in $(seq 1 50); do
    if [ -n "$(listening_pids "$port")" ]; then
      echo "  ✓ $name écoute sur :$port"
      return
    fi
    sleep 0.2
  done
  echo "  ✗ $name ne répond pas sur :$port — voir les logs dans $LOG_DIR" >&2
  return 1
}

echo "Libération des ports…"
for spec in "${INSTANCES[@]}"; do
  read -r _ port _ <<<"$spec"
  free_port "$port"
done
free_port "$UI_PORT"

echo "Lancement…"
for spec in "${INSTANCES[@]}"; do
  read -r name port dir <<<"$spec"
  launch_even_terminal "$name" "$port" "$dir"
done
launch_ui

echo "Vérification…"
fail=0
for spec in "${INSTANCES[@]}"; do
  read -r name port _ <<<"$spec"
  wait_port "$name" "$port" || fail=1
done
wait_port "ui" "$UI_PORT" || fail=1
exit $fail
