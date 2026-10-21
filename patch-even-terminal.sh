#!/bin/sh
# Apply patches/ to the GLOBAL @evenrealities/even-terminal install via
# patch-package. Removes the 60 s auto-deny on permission prompts and the
# 120 s auto-skip on user questions (Claude and Codex sessions) so both wait
# until someone answers; abort/stop still resolves them as denied/skipped.
# Also lets POST /api/prompt carry optional `model` and `effort` fields (applied to the
# Claude session's next run) so the UI can offer model + reasoning pickers, and stamps
# every SSE event / history entry with a timestamp (`ts`) so the UI can show
# when each message happened, even across replays. Raises the per-session SSE
# replay buffer (500 → 5000 events: one per streamed chunk, so 500 was barely a
# turn) and the on-disk history cap (10 → 200 messages).
# Re-run after every `npm i -g
# @evenrealities/even-terminal` — a version bump needs the patch regenerated
# (patches/ is pinned to the version in its filename).
#
# patch-package expects a project root (package.json + node_modules + patches),
# and walks UP from cwd until it finds a package.json — pointing it straight at
# the nvm lib dir picks up ~/.nvm/package.json instead. So build a throwaway
# root whose node_modules is a symlink to the global one.
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
GLOBAL_NM="$(npm root -g)"
APPROOT="$(mktemp -d)"
trap 'rm -rf "$APPROOT"' EXIT

echo '{"name":"even-terminal-patch-root","version":"0.0.0"}' > "$APPROOT/package.json"
ln -s "$GLOBAL_NM" "$APPROOT/node_modules"
cp -R "$HERE/patches" "$APPROOT/patches"

cd "$APPROOT"
npx patch-package --error-on-fail

# even-terminal pins the Agent SDK to ^0.2.x, whose bundled Claude Code is too
# old for recent models ("version 2.1.280 or newer is required"): bump it.
(cd "$GLOBAL_NM/@evenrealities/even-terminal" && npm i --no-save --omit=dev @anthropic-ai/claude-agent-sdk@0.3.281)
echo "Patched even-terminal in $GLOBAL_NM — restart running even-terminal instances to pick it up."
