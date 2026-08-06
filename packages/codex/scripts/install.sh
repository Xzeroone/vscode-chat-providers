#!/usr/bin/env bash
# Install xzeroone.codex-chat-provider from GitHub Releases.
set -euo pipefail

REPO="${CODEX_CHAT_PROVIDER_REPO:-Xzeroone/vscode-codex-chat-provider}"
CODE_BIN="${CODE_BIN:-code}"
API="https://api.github.com/repos/${REPO}/releases/latest"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-chat-provider.XXXXXX")"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

if ! command -v "$CODE_BIN" >/dev/null 2>&1; then
  echo "error: VS Code CLI '$CODE_BIN' not on PATH." >&2
  exit 1
fi

echo "→ Fetching latest VSIX from github.com/${REPO} …"
VSIX=""
if command -v gh >/dev/null 2>&1; then
  if gh release download --repo "$REPO" --pattern '*.vsix' --dir "$WORKDIR" 2>/dev/null; then
    VSIX="$(ls -1 "$WORKDIR"/*.vsix 2>/dev/null | head -1 || true)"
  fi
fi
if [[ -z "${VSIX}" ]]; then
  JSON="$(curl -fsSL -H "Accept: application/vnd.github+json" "$API")"
  URL="$(printf '%s' "$JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for a in data.get('assets') or []:
    if (a.get('name') or '').endswith('.vsix'):
        print(a.get('browser_download_url') or ''); break
")"
  [[ -n "$URL" ]] || { echo "error: no .vsix on latest release"; exit 1; }
  curl -fsSL -L -o "$WORKDIR/extension.vsix" "$URL"
  VSIX="$WORKDIR/extension.vsix"
fi

echo "→ Installing $(basename "$VSIX") …"
"$CODE_BIN" --install-extension "$VSIX" --force
echo "✓ Installed xzeroone.codex-chat-provider"
echo "  Reload VS Code → ensure \`codex login\` (or Pi openai-codex) → Codex: Refresh Models"
