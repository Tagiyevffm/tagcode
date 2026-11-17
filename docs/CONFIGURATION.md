# Configuration

TagCode merges configuration in this order (later wins):

1. Built-in defaults (`DEFAULT_CONFIG` in `src/config/schema.ts`).
2. Global file: `~/.tagcode/config.json`.
3. Project file: `<project>/.tagcode/config.json`.
4. Per-run CLI flags (`--provider`, `--model`, `--mode`, `--permission`).

The project root is the nearest ancestor containing `.git` or `.tagcode`, with
the OS home directory excluded as a project marker.

## Commands

```bash
/config show
/config path
/config get permissions.mode
/config set permissions.mode auto --project
/config reload
```

Inside the TUI use the same actions with `/config`.

## Full example

```json
{
  "version": 1,
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-5",
  "providers": [
    {
      "id": "anthropic",
      "type": "anthropic",
      "name": "Anthropic",
      "baseUrl": "https://api.anthropic.com",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "defaultModel": "claude-sonnet-4-5",
      "contextWindow": 200000,
      "maxOutputTokens": 8192,
      "timeoutMs": 120000,
      "headers": { "X-Custom": "value" },
      "models": ["claude-sonnet-4-5", "claude-opus-4-1"],
      "enabled": true
    }
  ],
  "permissions": {
    "mode": "auto",
    "allow": ["read_file", "list_directory", "git_status"],
    "deny": ["delete_file"],
    "requireApproval": ["run_command", "install_dependencies", "mcp__*"]
  },
  "context": {
    "maxTokens": 0,
    "compactAt": 0.82,
    "maxToolOutputChars": 20000,
    "maxSteps": 40,
    "keepRecentMessages": 8
  },
  "ui": {
    "showReasoning": true,
    "showTokenUsage": true,
    "showToolOutput": false,
    "animations": true
  },
  "web": {
    "searchProvider": "brave",
    "searchApiKeyEnv": "BRAVE_API_KEY",
    "maxResults": 5,
    "timeoutMs": 20000,
    "allowedDomains": []
  },
  "skills": {
    "directories": [],
    "disabled": [],
    "autoSelect": true,
    "maxActive": 3,
    "registryUrl": ""
  },
  "plugins": {
    "directories": [],
    "disabled": [],
    "enabled": []
  },
  "mcp": { "enabled": true }
}
```

## Key reference

### `defaultProvider` / `defaultModel`

Select the provider id and model used when no CLI/session override exists.
Provider ids must match `[a-zA-Z0-9][a-zA-Z0-9_-]*`.

Choosing a model in the desktop app or with `/model` writes it to this layer
(project config when the provider is project-scoped, otherwise global config)
and updates the provider's `defaultModel`. The next `tgc` launch therefore
reuses the selection instead of asking again.

### `providers[]`

| Key | Meaning |
| --- | --- |
| `id` | Unique provider id |
| `type` | `anthropic`, `openai`, `openrouter`, `deepseek`, `mistral`, `groq`, `together`, `fireworks`, `ollama`, `custom` |
| `name` | Display name |
| `baseUrl` | API base URL (including `/v1` where applicable) |
| `apiKeyEnv` | Environment variable holding the key |
| `defaultModel` | Model used when none is chosen |
| `contextWindow` | Override the inferred context window |
| `maxOutputTokens` | Requested output cap |
| `timeoutMs` | Request timeout (1000–600000) |
| `headers` | Extra HTTP headers |
| `models` | Suggested/available model ids |
| `enabled` | Set `false` to hide a provider |

API keys are never written to `config.json`. They are stored separately by the
secret store (environment → OS keychain → `auth.json`).

### `permissions`

| Key | Meaning |
| --- | --- |
| `mode` | `ask`, `auto`, `plan`, `yolo` |
| `allow` | Glob patterns that never need approval |
| `deny` | Glob patterns that are always denied (highest priority) |
| `requireApproval` | Glob patterns that always ask, even in auto/yolo |

Evaluation order: `deny` → plan mode → `allow` → session approvals →
`requireApproval` → sensitive check → mode rules.

### `context`

| Key | Meaning |
| --- | --- |
| `maxTokens` | Fixed budget; `0` derives from the model context window |
| `compactAt` | Fraction of the budget that triggers compaction (0.3–0.98) |
| `maxToolOutputChars` | Per-tool output truncation limit |
| `maxSteps` | Agent loop step limit (1–500) |
| `keepRecentMessages` | Recent messages never compacted away |

### `ui`

`showReasoning`, `showTokenUsage`, `showToolOutput`, `animations`.

### `web`

`searchProvider` (`brave` or `tavily`), `searchApiKeyEnv`, `maxResults`,
`timeoutMs`, `allowedDomains` (empty means all public domains).

### `skills`

`directories` (extra skill roots), `disabled` (names), `autoSelect`,
`maxActive`, `registryUrl` (optional JSON registry used by `/skills search`).

### `plugins`

`directories` (extra plugin roots), `disabled`, `enabled` (plugins load only
when listed here).

### `mcp`

`enabled: false` disables all MCP connections for the project.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `TAGCODE_HOME` | Override `~/.tagcode` |
| `TAGCODE_SECRET_BACKEND` | `file` forces the file secret store |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, … | Provider keys |
| `TAGCODE_<PROVIDER_ID>_API_KEY` | Generic provider key form |
| `BRAVE_API_KEY` / `TAVILY_API_KEY` | Web search (name comes from config) |
| `OLLAMA_HOST` | Ollama host used by the preset docs |

## MCP configuration

MCP servers live in `~/.tagcode/mcp.json` and `<project>/.tagcode/mcp.json`.
See [MCP.md](MCP.md).
