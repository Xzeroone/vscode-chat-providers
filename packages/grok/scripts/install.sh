#!/usr/bin/env bash
set -euo pipefail
REPO="${GROK_CHAT_PROVIDER_REPO:-Xzeroone/vscode-grok-chat-provider}"
CODE_BIN="${CODE_BIN:-code}"
API="https://api.github.com/repos/${REPO}/releases/latest"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/grok-chat-provider.XXXXXX")"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

command -v "$CODE_BIN" >/dev/null || { echo "error: code CLI missing"; exit 1; }
echo "→ Fetching VSIX from github.com/${REPO} …"
VSIX=""
if command -v gh >/dev/null 2>&1; then
  gh release download --repo "$REPO" --pattern '*.vsix' --dir "$WORKDIR" 2>/dev/null || true
  VSIX="$(ls -1 "$WORKDIR"/*.vsix 2>/dev/null | head -1 || true)"
fi
if [[ -z "${VSIX}" ]]; then
  JSON="$(curl -fsSL -H "Accept: application/vnd.github+json" "$API")"
  URL="$(printf '%s' "$JSON" | python3 -c "import sys,json;d=json.load(sys.stdin)
for a in d.get('assets') or []:
  if (a.get('name') or '').endswith('.vsix'):
    print(a.get('browser_download_url') or ''); break")"
  [[ -n "$URL" ]] || { echo "error: no vsix on release"; exit 1; }
  curl -fsSL -L -o "$WORKDIR/e.vsix" "$URL"
  VSIX="$WORKDIR/e.vsix"
fi
"$CODE_BIN" --install-extension "$VSIX" --force
echo "✓ xzeroone.grok-chat-provider installed"
echo "  Reload → Grok: Sign in (or use existing Grok CLI / Pi xai auth)"
