# VS Code Chat Providers

Album repo for **native VS Code Language Model Chat providers** (host Chat UI, not a separate agent shell).

| Package | Vendor in Chat | Auth | Install id |
|---------|----------------|------|------------|
| [`packages/ollama-cloud`](./packages/ollama-cloud) | **Ollama Cloud** | API key | `xzeroone.ollama-cloud-chat-provider` |
| [`packages/codex`](./packages/codex) | **Codex (ChatGPT)** | ChatGPT OAuth (Codex CLI / Pi / palette) | `xzeroone.codex-chat-provider` |
| [`packages/grok`](./packages/grok) | **Grok (xAI OAuth)** (`vendor: grok`) | SuperGrok OAuth (Grok CLI / Pi / palette) | `xzeroone.grok-chat-provider` |

Related (separate repo): [vscode-pi-chat-provider](https://github.com/Xzeroone/vscode-pi-chat-provider) — Pi as **agent runtime** behind Chat.

---

## Install

### All three

```bash
curl -fsSL https://raw.githubusercontent.com/Xzeroone/vscode-chat-providers/main/scripts/install-all.sh | bash
```

### One provider

```bash
# ollama-cloud | codex | grok
curl -fsSL https://raw.githubusercontent.com/Xzeroone/vscode-chat-providers/main/scripts/install.sh | bash -s -- codex
```

### Command Palette only

1. Open [Releases](https://github.com/Xzeroone/vscode-chat-providers/releases/latest)
2. Download the `.vsix` you want
3. **Ctrl+Shift+P** → **Extensions: Install from VSIX…**
4. **Developer: Reload Window**

### From a clone

```bash
git clone https://github.com/Xzeroone/vscode-chat-providers.git
cd vscode-chat-providers
./scripts/install-all.sh
# or: ./scripts/package-all.sh && ./scripts/install-all.sh --local
```

---

## After install

| Provider | First step |
|----------|------------|
| Ollama Cloud | **Ollama Cloud: Set API Key** |
| Codex | **Codex: Sign in with ChatGPT** (or existing `codex login` / Pi) |
| Grok | **Grok: Sign in with SuperGrok / X Premium** (or existing Grok CLI / Pi) |

Then open **Chat** → model picker → pick the vendor.

### Thinking effort defaults (Chat + Agents)

Per-model schema defaults (what Agents use when you do not pick a level):

| Ladder | Default |
|--------|---------|
| Includes **medium** | **medium** |
| **off → high** (no low/medium) | **high** |
| Other | first useful level (prefer high) |

No adaptive auto-router — fixed smart defaults only. Override anytime in the model’s Thinking Effort control or the provider’s `defaultThinkingLevel` setting (fallback).

---

## Layout

```text
vscode-chat-providers/
  packages/
    ollama-cloud/   # Ollama Cloud API
    codex/          # OpenAI Codex / ChatGPT OAuth
    grok/           # xAI Grok OAuth
  scripts/
    install-all.sh
    install.sh
    package-all.sh
```

Each package is a normal VS Code extension (`package.json` + `out/`).  
Versions and changelogs live **per package**.

---

## Develop

```bash
cd packages/codex   # or ollama-cloud | grok
npm install
npm run package
code --install-extension ./codex-chat-provider-*.vsix --force
```

Tag a monorepo release (CI builds all VSIXes):

```bash
git tag v0.1.0
git push origin v0.1.0
```

---

## Individual repos

Standalone repos may still exist for history; **this monorepo is the home** for the three providers going forward.

| Standalone (legacy / mirrors) |
|-------------------------------|
| [vscode-ollama-cloud-provider](https://github.com/Xzeroone/vscode-ollama-cloud-provider) |
| [vscode-codex-chat-provider](https://github.com/Xzeroone/vscode-codex-chat-provider) |
| [vscode-grok-chat-provider](https://github.com/Xzeroone/vscode-grok-chat-provider) |

---

## License

MIT (see each package’s `LICENSE`).
