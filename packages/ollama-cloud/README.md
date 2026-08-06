# Ollama Cloud Chat Provider for VS Code

Native **Language Model Chat Provider** for [Ollama Cloud](https://ollama.com) — dynamic model discovery, max-token / thinking metadata, streamed chat into **VS Code Chat**.

**Not** local Ollama (`localhost:11434`).

| | |
|--|--|
| Extension id | `xzeroone.ollama-cloud-chat-provider` |
| Model picker | **Ollama Cloud** |
| Requires | VS Code ≥ 1.103, [Ollama Cloud API key](https://ollama.com/settings/keys) |

---

## Install (pick one)

### A — One line (easiest on any machine)

```bash
curl -fsSL https://raw.githubusercontent.com/Xzeroone/vscode-ollama-cloud-provider/main/scripts/install.sh | bash
```

Needs: `curl`, and the `code` CLI on PATH  
(Command Palette → **Shell Command: Install 'code' command in PATH** if missing).

### B — Command Palette only (no terminal)

1. Open the [latest Release](https://github.com/Xzeroone/vscode-ollama-cloud-provider/releases/latest)
2. Download the **`.vsix`** file
3. In VS Code: **Ctrl+Shift+P** (Mac: **Cmd+Shift+P**)
4. Run **`Extensions: Install from VSIX…`**
5. Select the downloaded `.vsix`
6. Run **`Developer: Reload Window`**

### C — From a clone

```bash
git clone https://github.com/Xzeroone/vscode-ollama-cloud-provider.git
cd vscode-ollama-cloud-provider
./scripts/install.sh
# or: npm install && npm run package && code --install-extension ./ollama-cloud-chat-provider-*.vsix --force
```

---

## After install

1. Command Palette → **`Ollama Cloud: Set API Key`**  
   (or set env `OLLAMA_API_KEY` before launching VS Code)
2. Open **Chat** → model picker → **Ollama Cloud** → pick a model  
3. Optional: model **`>`** → **Thinking Effort** (when the model supports it)

### Useful commands

| Command | Purpose |
|---------|---------|
| `Ollama Cloud: Set API Key` | Store key in Secret Storage |
| `Ollama Cloud: Manage API Key` | Set / clear / status |
| `Ollama Cloud: Refresh Models` | Re-fetch catalog from API |
| `Ollama Cloud: Clear API Key` | Remove stored key |

---

## What is automatic

| Field | Source |
|-------|--------|
| Model list | Live `GET /v1/models` |
| tools / vision / thinking | Live `/api/show` capabilities |
| Context length | Live `model_info` → models.dev |
| Max output tokens | models.dev `limit.output` → derived from context |
| Thinking effort levels | models.dev `reasoning_options` → family heuristic |

New cloud models appear after **Refresh Models** or the refresh interval — no extension update required for normal catalog changes.

---

## Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `ollamaCloud.baseUrl` | `https://ollama.com` | Cloud base (`/v1` API) |
| `ollamaCloud.toolsOnly` | `true` | Only tool-capable models |
| `ollamaCloud.refreshIntervalMinutes` | `60` | Re-discover interval (`0` = on demand) |
| `ollamaCloud.defaultMaxTokens` | `0` | **`0` = auto**; positive = force cap |
| `ollamaCloud.useModelsDevRegistry` | `true` | Enrich max-out + reasoning options |
| `ollamaCloud.defaultThinkingLevel` | `off` | Default Thinking Effort |
| `ollamaCloud.includeReasoningInResponse` | `false` | Append reasoning block in chat |
| `ollamaCloud.debug` | `false` | **Output → Ollama Cloud** |

---

## Relation to Pi

| Extension | Role |
|-----------|------|
| **This** | Thin model backend for the **VS Code host agent** |
| [`pi-chat-provider`](https://github.com/Xzeroone/vscode-pi-chat-provider) | **Pi** as agent runtime (`pi /provider/model`) |

You can install both.

---

## Develop / release

```bash
npm install
npm run package
code --install-extension ./ollama-cloud-chat-provider-*.vsix --force
```

Tag a release (CI builds and uploads the VSIX):

```bash
git tag v0.1.2
git push origin v0.1.2
```

## License

MIT
