#!/usr/bin/env bash
# Beam — installer. Run it once, from the repo:  bash install.sh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="${BEAM_BIN_DIR:-$HOME/.local/bin}"
SKILLS="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
HOME_DIR="${BEAM_HOME:-$HOME/.beam}"

echo
echo "  Beam — drive Chrome as text, from your terminal"
echo "  ──────────────────────────────────────────────"
echo

command -v node >/dev/null || { echo "  Node.js is required. Install it and run this again."; exit 1; }
MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$MAJOR" -ge 18 ] || { echo "  Node 18+ is required (found $(node -v)): fetch() is used by the CLI."; exit 1; }

chmod +x "$DIR/bin/beam" "$DIR/bin/beam-mdconv" "$DIR/server/server.js"

# 1. the two commands
mkdir -p "$BIN"
ln -sf "$DIR/bin/beam" "$BIN/beam"
ln -sf "$DIR/bin/beam-mdconv" "$BIN/beam-mdconv"
echo "  ✓ beam and beam-mdconv linked into $BIN"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "  ! $BIN is not in your PATH — add this to your shell rc:"
     echo "        export PATH=\"$BIN:\$PATH\"" ;;
esac

# 2. where adapters and the hub token live
mkdir -p "$HOME_DIR/adapters"
echo "  ✓ $HOME_DIR ready (token and site adapters live here)"

# 3. the two Claude Code skills, if Claude Code is installed
if [ -n "${CLAUDE_SKILLS_DIR:-}" ] || [ -d "$HOME/.claude" ]; then
  mkdir -p "$SKILLS"
  for s in beam web-publish; do
    if [ -e "$SKILLS/$s" ] && [ ! -L "$SKILLS/$s" ]; then
      echo "  · $SKILLS/$s already exists and is not a link — left untouched"
    else
      ln -sfn "$DIR/skills/$s" "$SKILLS/$s"
      echo "  ✓ skill '$s' linked into $SKILLS"
    fi
  done
else
  echo "  · Claude Code not found: skills not linked (they are in $DIR/skills)"
fi

# 4. the local hub (it restarts by itself on every command anyway).
# Stop anything already listening first: an older hub would keep running with
# the old code, and with it the old rules about who may send commands.
"$DIR/bin/beam" server --stop >/dev/null 2>&1 || true
"$DIR/bin/beam" server >/dev/null 2>&1 || true
echo "  ✓ local hub running on 127.0.0.1:${BEAM_PORT:-8777}"

cat <<TXT

  One thing left — the extension, 3 steps in Chrome:

    1. open  chrome://extensions
    2. turn on 'Developer mode' (top right)
    3. 'Load unpacked' and pick this folder:

       $DIR/extension

  The Beam icon opens the status panel: reconnect, release the tab, change the port.
  Tip: pin the icon from the extensions menu.

  Try it:   beam tabs

TXT
