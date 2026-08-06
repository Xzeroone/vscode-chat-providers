#!/usr/bin/env bash
# Install all three Chat providers.
# Usage:
#   ./scripts/install-all.sh
#   ./scripts/install-all.sh --local
#   curl -fsSL https://raw.githubusercontent.com/Xzeroone/vscode-chat-providers/main/scripts/install-all.sh | bash
set -euo pipefail

CODE_BIN="${CODE_BIN:-code}"
REPO="${VSCODE_CHAT_PROVIDERS_REPO:-Xzeroone/vscode-chat-providers}"

if ! command -v "$CODE_BIN" >/dev/null 2>&1; then
  echo "error: '$CODE_BIN' not on PATH (Command Palette → Install 'code' in PATH)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"

# Prefer packaging from monorepo when present
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/install.sh" && -d "$SCRIPT_DIR/../packages/codex" ]]; then
  ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  echo "→ Installing from monorepo at $ROOT"
  for pkg in ollama-cloud codex grok; do
    bash "$SCRIPT_DIR/install.sh" "$pkg"
  done
  echo ""
  echo "✓ All three installed. Reload VS Code."
  exit 0
fi

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/vsc-chat-providers.XXXXXX")"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

echo "→ Fetching latest release assets from github.com/${REPO} …"
if command -v gh >/dev/null 2>&1; then
  gh release download --repo "$REPO" --pattern '*.vsix' --dir "$WORKDIR" 2>/dev/null || true
fi

if ! ls "$WORKDIR"/*.vsix >/dev/null 2>&1; then
  API="https://api.github.com/repos/${REPO}/releases/latest"
  JSON="$(curl -fsSL -H "Accept: application/vnd.github+json" "$API")"
  printf '%s' "$JSON" | python3 -c "
import json, sys, urllib.request, os
workdir = '''$WORKDIR'''
data = json.load(sys.stdin)
count = 0
for a in data.get('assets') or []:
    name = a.get('name') or ''
    url = a.get('browser_download_url') or ''
    if name.endswith('.vsix') and url:
        dest = os.path.join(workdir, name)
        print('  download', name, flush=True)
        urllib.request.urlretrieve(url, dest)
        count += 1
if count == 0:
    sys.exit('no .vsix assets on latest release')
"
fi

shopt -s nullglob
VSIXS=("$WORKDIR"/*.vsix)
if [[ ${#VSIXS[@]} -eq 0 ]]; then
  echo "error: no .vsix files on latest release of $REPO" >&2
  exit 1
fi

for vsix in "${VSIXS[@]}"; do
  echo "→ Installing $(basename "$vsix") …"
  "$CODE_BIN" --install-extension "$vsix" --force
done

echo ""
echo "✓ Installed ${#VSIXS[@]} extension(s). Reload VS Code."
echo "  Ollama Cloud: Set API Key"
echo "  Codex: Sign in with ChatGPT (or codex login)"
echo "  Grok: Sign in with SuperGrok (or Grok CLI / Pi xai)"
