#!/usr/bin/env bash
# Package all three extensions into dist/*.vsix
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
mkdir -p "$DIST"
rm -f "$DIST"/*.vsix 2>/dev/null || true

need_vsce() {
  if ! command -v npx >/dev/null 2>&1; then
    echo "error: npx required" >&2
    exit 1
  fi
}

need_vsce

for pkg in ollama-cloud codex grok; do
  dir="$ROOT/packages/$pkg"
  echo "→ Packaging $pkg …"
  (
    cd "$dir"
    if [[ ! -d node_modules/@vscode/vsce ]]; then
      npm install --no-fund --no-audit --no-package-lock >/dev/null
    fi
    npx vsce package --no-dependencies
    mv -f ./*.vsix "$DIST/"
  )
done

echo "✓ VSIXes in $DIST:"
ls -1 "$DIST"/*.vsix
