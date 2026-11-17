# Installation

## Requirements

- Node.js **22 or newer**
- npm (or another package manager that can install dependencies)
- Git (for repositories and git-based skill installation)
- Windows 11, Linux or macOS
- No GPU required

## From source

```bash
git clone <repository>
cd tagcode
npm install
npm run build
npm link
```

`npm link` installs the `tgc` and `tagcode` commands globally. Verify:

```bash
tgc --version
tgc doctor
```

## Run without a global install

```bash
# Desktop app from TypeScript source
npm run app:dev

# Terminal UI from TypeScript source
npm run dev

# One-shot headless run
node --import tsx src/cli/index.ts run "explain this codebase"

# Built CLI
node dist/cli/index.js --help
```

## Desktop app

`tgc` (and `tgc app`) starts a local server and opens it in a chromeless
Microsoft Edge or Google Chrome window. The server listens on `127.0.0.1` with a
random port and requires a token generated for that launch.

```bash
tgc                       # open the desktop app
tgc app --no-open         # print the URL without opening a window
tgc app --browser <path>  # use a specific Edge/Chrome executable
tgc tui                   # use the terminal UI instead
```

The desktop app does not bundle Electron. It uses the browser already installed
on the machine, so there is no extra runtime dependency.

## Packaging

```bash
npm pack --dry-run    # inspect the published file list
npm publish           # requires npm credentials
```

The published package includes `dist/`, `desktop/`, `docs/`, `README.md`,
`LICENSE` and `CHANGELOG.md`.

## First-run configuration

TagCode stores global state under `~/.tagcode`:

```text
~/.tagcode/
  config.json
  mcp.json
  auth.json          # only when the OS keychain is unavailable
  skills/
  plugins/
  sessions/
  memory/
  logs/audit.jsonl
```

Set `TAGCODE_HOME` to relocate all global state:

```powershell
$env:TAGCODE_HOME = "C:\tagcode-home"
tgc doctor
```

Project state lives in `<project>/.tagcode/`.

## Connect a provider

Interactive desktop app:

```text
tgc
```

Connect from the app with the **Connect model** button, or type `/connect
anthropic` in the composer, then pick a model from the searchable picker.

Headless:

```bash
# Read the key from stdin (hidden prompt on a TTY)
tgc connect openai --model gpt-4.1 --api-key-stdin
tgc models
tgc doctor
```

Local models with Ollama:

```bash
ollama serve
ollama pull qwen2.5-coder:7b
tgc connect ollama --model qwen2.5-coder:7b
```

No key is required for `ollama` or a custom local endpoint.

## Windows notes

- Use PowerShell or Windows Terminal. The terminal UI requires a TTY; the desktop app does not.
- Paths may use either separator; workspace checks normalize them.
- `@napi-rs/keyring` is an optional dependency. If it cannot be installed,
  TagCode uses `auth.json` and warns you. Windows Credential Manager is used
  when available.
- `tgc run` works in non-interactive shells and CI; it never opens the TUI.

## Troubleshooting

```bash
tgc doctor            # config, provider, secrets, git, MCP, plugins
tgc config path       # show config file locations
tgc config show       # redacted resolved configuration
tgc mcp list          # MCP connection states
tgc tools             # registered tools
```

If a provider fails, check its base URL and model name, then run `tgc models`.
Provider errors are redacted but include HTTP status and a short body.
