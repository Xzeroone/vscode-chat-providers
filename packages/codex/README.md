# Codex Chat Provider for VS Code (ChatGPT OAuth)

Native **Language Model Chat Provider** that uses your **ChatGPT / Codex subscription** via OAuth — the same login as **Codex CLI** (`codex login`) or **Pi** (`openai-codex`).

No OpenAI API key. No Pi process required for Chat (Pi is only an optional auth source).

| | |
|--|--|
| Extension id | `xzeroone.codex-chat-provider` |
| Model picker | **Codex (ChatGPT)** |
| Requires | VS Code ≥ 1.103 · ChatGPT Plus/Pro (or plan that includes Codex) · `codex login` **or** Pi openai-codex OAuth |

---

## Install

### One line

```bash
curl -fsSL https://raw.githubusercontent.com/Xzeroone/vscode-codex-chat-provider/main/scripts/install.sh | bash
```

### Command Palette only

1. Download the `.vsix` from [Releases](https://github.com/Xzeroone/vscode-codex-chat-provider/releases/latest)
2. **Ctrl+Shift+P** → **Extensions: Install from VSIX…**
3. **Developer: Reload Window**

---

## Auth (no Codex/Pi CLI required)

### New PC — Command Palette only

1. Install the extension (VSIX / install script)
2. **Ctrl+Shift+P** → **`Codex: Sign in with ChatGPT`**
3. Choose:
   - **Browser sign-in** — opens ChatGPT login, callback on `localhost:1455` (recommended)
   - **Device code** — for remote/SSH; open the URL, enter the code
4. Tokens go to **VS Code Secret Storage** (and optionally `~/.codex/auth.json`)
5. Chat → **Codex (ChatGPT)** → pick a model

### Also works if you already use CLI tools

| Priority (auto) | Source |
|-----------------|--------|
| 1 | Command Palette sign-in → Secret Storage |
| 2 | `~/.codex/auth.json` (`codex login`) |
| 3 | `~/.pi/agent/auth.json` → `openai-codex` |

Tokens **refresh automatically** when near expiry.

### Commands

| Command | Purpose |
|---------|---------|
| **`Codex: Sign in with ChatGPT`** | Browser or device OAuth (no CLI) |
| `Codex: Manage Auth` | Sign in / refresh / sign out / status |
| `Codex: Refresh OAuth Token` | Force refresh |
| `Codex: Refresh Models` | Live catalog from Codex API |
| `Codex: Auth Status` | Where tokens came from + expiry |

---

## Usage

1. Open **Chat** → model picker → **Codex (ChatGPT)**
2. Pick e.g. `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.5`, …
3. Model **`>`** → **Thinking Effort** (per-model levels from the API)

---

## What is automatic

| Field | Source |
|-------|--------|
| Models | Live `GET …/codex/models?client_version=…` → `~/.codex/models_cache.json` |
| Reasoning levels | `supported_reasoning_levels` per model |
| Context window | API / cache |
| Max output | Derived from context (`0` = auto) |
| OAuth refresh | `auth.openai.com` when token expires |

---

## Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `openaiCodex.authPreference` | `auto` | `auto` / `codex-cli` / `pi` |
| `openaiCodex.defaultThinkingLevel` | `low` | Default effort (clamped) |
| `openaiCodex.hideHiddenModels` | `true` | Skip `visibility=hide` |
| `openaiCodex.defaultMaxTokens` | `0` | `0` = auto |
| `openaiCodex.debug` | `false` | **Output → Codex** |

---

## Relation to Pi / Ollama Cloud

| Extension | Role |
|-----------|------|
| **This** | Codex models for **VS Code host agent** (subscription OAuth) |
| [ollama-cloud-chat-provider](https://github.com/Xzeroone/vscode-ollama-cloud-provider) | Ollama Cloud API key models |
| [pi-chat-provider](https://github.com/Xzeroone/vscode-pi-chat-provider) | **Pi agent runtime** (all Pi providers) |

---

## License

MIT
