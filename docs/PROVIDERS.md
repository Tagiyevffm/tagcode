# Providers

TagCode is provider independent. The agent engine only knows the `Provider`
interface from `src/core/types.ts`; adapters translate requests/streams.

## Supported types

| Type | Protocol | Key required | Suggested model |
| --- | --- | --- | --- |
| `anthropic` | Anthropic Messages API | Yes | `claude-sonnet-4-5` |
| `openai` | OpenAI Chat Completions | Yes | `gpt-4.1` |
| `openrouter` | OpenAI-compatible | Yes | `openai/gpt-4.1` |
| `deepseek` | OpenAI-compatible | Yes | `deepseek-chat` |
| `mistral` | OpenAI-compatible | Yes | `mistral-large-latest` |
| `groq` | OpenAI-compatible | Yes | `llama-3.3-70b-versatile` |
| `together` | OpenAI-compatible | Yes | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |
| `fireworks` | OpenAI-compatible | Yes | `accounts/fireworks/models/llama-v3p3-70b-instruct` |
| `ollama` | OpenAI-compatible (`/v1`) | No | `qwen2.5-coder:7b` |
| `custom` | OpenAI-compatible | Optional | any |

Presets and defaults live in `src/providers/presets.ts`.

## Connecting

Interactive:

```text
/connect
/connect anthropic
/connect ollama --model qwen2.5-coder:7b
```

Headless:

```bash
tgc connect anthropic --model claude-sonnet-4-5
tgc connect openai --api-key-stdin
tgc connect custom --base-url http://localhost:8000/v1 --model local
tgc connect ollama --id local-ollama --model qwen2.5-coder:7b --project
```

In the TUI, `/connect custom` is a guided flow: it asks for the base URL, an
optional model and an optional API key. After any connection, `/model` fetches
the provider's models and opens a numbered picker.

Options: `--id`, `--name`, `--base-url`, `--model`, `--api-key`,
`--api-key-stdin`, `--project`.

`--project` writes to `<workspace>/.tagcode/config.json` instead of the global
config. The first configured provider becomes the default.

## Managing

```bash
tgc model               # current model + provider models
tgc models              # list models from the active provider
tgc model gpt-4.1       # switch model for this session
tgc disconnect openai   # remove config + stored key
```

Slash equivalents: `/provider` (list/switch/remove), `/model` (fetch + picker),
`/models`, `/disconnect`.

## Keys and storage

Resolution order when a provider is used:

1. `apiKeyEnv` environment variable (for example `ANTHROPIC_API_KEY`).
2. `TAGCODE_<PROVIDER_ID>_API_KEY`.
3. OS credential store (Windows Credential Manager / macOS Keychain / Linux
   Secret Service) via optional `@napi-rs/keyring`.
4. `~/.tagcode/auth.json` with owner-only permissions.

The fallback file is not encrypted at rest; `tgc connect` warns when it is used.
`TAGCODE_SECRET_BACKEND=file` forces it.

Keys never appear in `config.json`, logs, audit entries or tool output. Provider
error bodies pass through `redactSecrets`.

## Capabilities

`Provider.capabilities` advertises streaming, tool calling, vision, structured
output, reasoning and model listing. `src/providers/capabilities.ts` infers
per-model context windows and hints from model ids. Inference is best effort;
override `contextWindow` in provider config when needed.

The agent always sends tool definitions in the protocol's native form. Models
without tool support still work for plain chat, but the agent cannot act on
files until a tool-capable model is selected.

## Local inference

### Ollama

```bash
ollama serve
ollama pull qwen2.5-coder:7b
tgc connect ollama --model qwen2.5-coder:7b
tgc models
```

Ollama uses `http://localhost:11434/v1` by default and requires no key.

### vLLM / LM Studio / llama.cpp

```bash
tgc connect custom --base-url http://localhost:8000/v1 --model my-model
```

Any server that implements `POST /v1/chat/completions` with SSE streaming works.
Some servers reject `stream_options`; the OpenAI adapter retries without it on a
400 response mentioning `stream_options`.

## Adding an adapter

1. Implement `Provider` with `stream()` and `listModels()`.
2. Add a preset and the type to `ProviderType`.
3. Construct it in `src/providers/registry.ts`.
4. Add tests with a mocked `fetchImpl`.
5. Document it here.
