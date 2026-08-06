#!/usr/bin/env bash
# Install one provider: ollama-cloud | codex | grok
# Usage:
#   ./scripts/install.sh codex
#   curl -fsSL …/scripts/install.sh | bash -s -- grok
set -euo pipefail

PKG="${1:-}"
if [[ -z "$PKG" ]]; then
  echo "usage: $0 <ollama-cloud|codex|grok>" >&2
  exit 1
fi

case "$PKG" in
  ollama-cloud|ollama) PKG=ollama-cloud; PATTERN='ollama-cloud-chat-provider-*.vsix' ;;
  codex) PATTERN='codex-chat-provider-*.vsix' ;;
  grok|xai) PKG=grok; PATTERN='grok-chat-provider-*.vsix' ;;
  *)
    echo "unknown package: $PKG (want ollama-cloud|codex|grok)" >&2
    exit 1
    ;;
esac

REPO="${VSCODE_CHAT_PROVIDERS_REPO:-Xzeroone/vscode-chat-providers}"
CODE_BIN="${CODE_BIN:-code}"
ROOT="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd || true)"

if ! command -v "$CODE_BIN" >/dev/null 2>&1; then
  echo "error: '$CODE_BIN' not on PATH" >&2
  exit 1
fi

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/vsc-chat-provider.XXXXXX")"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

VSIX=""

# Local monorepo package
if [[ -n "$ROOT" && -f "$ROOT/packages/$PKG/package.json" ]]; then
  echo "→ Packaging local packages/$PKG …"
  (
    cd "$ROOT/packages/$PKG"
    npm install --no-fund --no-audit --no-package-lock >/dev/null 2>&1 || true
    npx --yes @vscode/vsce package --no-dependencies
  )
  VSIX="$(ls -1 "$ROOT/packages/$PKG"/$PATTERN 2>/dev/null | head -1 || true)"
fi

# Local dist/
if [[ -z "$VSIX" && -n "$ROOT" ]]; then
  VSIX="$(ls -1 "$ROOT/dist"/$PATTERN 2>/dev/null | head -1 || true)"
fi

# GitHub release
if [[ -z "$VSIX" ]]; then
  echo "→ Downloading $PKG from github.com/${REPO} releases …"
  if command -v gh >/dev/null 2>&1; then
    gh release download --repo "$REPO" --pattern "$PATTERN" --dir "$WORKDIR" 2>/dev/null || true
    VSIX="$(ls -1 "$WORKDIR"/*.vsix 2>/dev/null | head -1 || true)"
  fi
  if [[ -z "$VSIX" ]]; then
    API="https://api.github.com/repos/${REPO}/releases/latest"
    JSON="$(curl -fsSL -H "Accept: application/vnd.github+json" "$API")"
    URL="$(printf '%s' "$JSON" | python3 -c "
import sys, json, fnmatch
pat = '''$PATTERN'''
data = json.load(sys.stdin)
for a in data.get('assets') or []:
    name = a.get('name') or ''
    if fnmatch.fnmatch(name, pat):
        print(a.get('browser_download_url') or '')
        break
")"
    if [[ -z "$URL" ]]; then
      echo "error: no asset matching $PATTERN on latest release of $REPO" >&2
      echo "  Tip: run from a clone, or create a release with all three VSIXes." >&2
      exit 1
    fi
    curl -fsSL -L -o "$WORKDIR/ext.vsix" "$URL"
    VSIX="$WORKDIR/ext.vsix"
  fi
fi

echo "→ Installing $(basename "$VSIX") …"
"$CODE_BIN" --install-extension "$VSIX" --force
echo "✓ Installed $PKG — reload VS Code"
