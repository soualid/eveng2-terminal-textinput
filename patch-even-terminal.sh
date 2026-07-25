#!/bin/sh
# Apply patches/ to the GLOBAL @evenrealities/even-terminal install via
# patch-package. Removes the 60 s auto-deny on permission prompts (Claude and
# Codex sessions) so they wait until someone answers; abort/stop still
# resolves them as denied. Re-run after every `npm i -g
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
echo "Patched even-terminal in $GLOBAL_NM — restart running even-terminal instances to pick it up."
