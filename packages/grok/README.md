# Grok Chat Provider for VS Code (xAI OAuth)

Native **Language Model Chat Provider** using your **SuperGrok / X Premium** subscription — same OAuth client as **Grok CLI** and **Pi** (`xai`).

| | |
|--|--|
| Extension id | `xzeroone.grok-chat-provider` |
| Model picker | **Grok (xAI)** |
| OAuth client | `b1a00492-073a-47ea-816f-4c329264a828` (official) |

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/Xzeroone/vscode-grok-chat-provider/main/scripts/install.sh | bash
```

Or: [Releases](https://github.com/Xzeroone/vscode-grok-chat-provider/releases/latest) → **Extensions: Install from VSIX…**

---

## Auth (Grok CLI + Pi first)

### Already have Grok CLI or Pi?

Nothing extra — the extension reads:

1. **`~/.grok/auth.json`** (Grok CLI) — **primary**
2. **`~/.pi/agent/auth.json`** → `xai` (Pi)
3. VS Code Secret Storage (palette sign-in)
4. Optional `XAI_API_KEY` (API key, not subscription)

### Fresh PC (Command Palette)

1. **Ctrl+Shift+P** → **`Grok: Sign in with SuperGrok / X Premium`**
2. Device code (same flow as Grok CLI / Pi) — open the link, enter the code
3. Chat → **Grok (xAI)**

Tokens refresh automatically. Palette sign-in can also write `~/.grok/auth.json` for CLI compatibility.

---

## What is automatic

| Field | Source |
|-------|--------|
| Models | Grok CLI proxy catalog + `api.x.ai/v1/models` + disk cache |
| Reasoning efforts | Grok CLI `reasoning_efforts` (e.g. high/medium/low on grok-4.5) |
| Context | Model catalog |
| Max output | Derived from context (`0` = auto) |
| Chat | `https://api.x.ai/v1/chat/completions` with OAuth bearer |

---

## Commands

| Command | Purpose |
|---------|---------|
| **Grok: Sign in with SuperGrok / X Premium** | Device OAuth |
| Grok: Manage Auth | Sign in / refresh / sign out |
| Grok: Refresh Models | Re-fetch catalog |
| Grok: Auth Status | Which source + expiry |

---

## License

MIT
