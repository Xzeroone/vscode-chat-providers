#!/usr/bin/env bash
# Install xzeroone.ollama-cloud-chat-provider from GitHub Releases (public).
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Xzeroone/vscode-ollama-cloud-provider/main/scripts/install.sh | bash
#   ./scripts/install.sh
set -euo pipefail

REPO="${OLLAMA_CLOUD_PROVIDER_REPO:-Xzeroone/vscode-ollama-cloud-provider}"
CODE_BIN="${CODE_BIN:-code}"
API="https://api.github.com/repos/${REPO}/releases/latest"
TMPDIR="${TMPDIR:-/tmp}"
WORKDIR="$(mktemp -d "${TMPDIR%/}/ollama-cloud-provider.XXXXXX")"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

if ! command -v "$CODE_BIN" >/dev/null 2>&1; then
  echo "error: VS Code CLI '$CODE_BIN' not found on PATH." >&2
  echo "  Open VS Code → Command Palette → “Shell Command: Install 'code' command in PATH”" >&2
  exit 1
fi

echo "→ Fetching latest VSIX from github.com/${REPO} …"

VSIX=""
# Prefer GitHub CLI when available (works for private repos too)
if command -v gh >/dev/null 2>&1; then
  if gh release download --repo "$REPO" --pattern '*.vsix' --dir "$WORKDIR" 2>/dev/null; then
    VSIX="$(ls -1 "$WORKDIR"/*.vsix 2>/dev/null | head -1 || true)"
  fi
fi

# Public release via API + curl (no gh required)
if [[ -z "${VSIX}" ]]; then
  if ! command -v curl >/dev/null 2>&1; then
    echo "error: curl is required to download the release." >&2
    exit 1
  fi
  JSON="$(curl -fsSL -H "Accept: application/vnd.github+json" "$API")"
  URL="$(printf '%s' "$JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for a in data.get('assets') or []:
    name = a.get('name') or ''
    if name.endswith('.vsix'):
        print(a.get('browser_download_url') or '')
        break
" 2>/dev/null || true)"
  if [[ -z "$URL" ]]; then
    echo "error: no .vsix asset on the latest release of ${REPO}." >&2
    echo "  Open: https://github.com/${REPO}/releases" >&2
    exit 1
  fi
  DEST="$WORKDIR/extension.vsix"
  curl -fsSL -L -o "$DEST" "$URL"
  VSIX="$DEST"
fi

echo "→ Installing $(basename "$VSIX") …"
"$CODE_BIN" --install-extension "$VSIX" --force

echo ""
echo "✓ Installed xzeroone.ollama-cloud-chat-provider"
echo "  1. Reload VS Code (Command Palette → “Developer: Reload Window”)"
echo "  2. Command Palette → “Ollama Cloud: Set API Key”"
echo "  3. Chat model picker → Ollama Cloud"
