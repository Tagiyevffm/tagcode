# Contributing to TagCode

Thanks for helping improve TagCode. The project is a TypeScript/Node.js
terminal application; changes should keep it runnable after every step.

## Prerequisites

- Node.js 22 or newer (Node 26 is used in development)
- npm
- Git
- Windows 11 is the primary platform; Linux and macOS changes must not break it

## Setup

```bash
git clone <repository>
cd tagcode
npm install
npm run build
npm test
```

Run the CLI from source:

```bash
npm run dev
node --import tsx src/cli/index.ts doctor
```

## Quality gates

Every pull request must pass:

```bash
npm run typecheck
npm test
npm run build
```

- Do not disable or skip tests to make the build pass.
- Do not introduce placeholder tools that return hardcoded success messages.
- Do not add dependencies without a clear need; prefer existing utilities.
- Keep new features covered by tests under `tests/`.
- Update documentation (`README.md`, `docs/`, `DEVELOPMENT.md`, `CHANGELOG.md`)
  when behavior changes.

## Code conventions

- ESM imports use explicit `.js` extensions in TypeScript source.
- Strict TypeScript is enabled, including `noUncheckedIndexedAccess`.
- Providers implement the `Provider` interface from `src/core/types.ts`; do not
  add provider-specific types to the agent engine.
- Tools implement `Tool` from `src/tools/types.ts` and declare a permission
  level. All tools must flow through `ToolRegistry.execute` so permissions and
  output truncation apply.
- Filesystem access goes through `WorkspacePaths`. Never bypass it.
- Never log or persist secrets. Use `redactValue` / `redactSecrets`.
- Commands live in `src/commands/builtins.ts` (slash commands) or
  `src/cli/index.ts` (headless CLI). Both should provide usage text and
  actionable errors.

## Adding a tool

1. Add a `defineTool({...})` definition in the appropriate `src/tools/` module.
2. Give it a Zod schema, a description that tells the model when to use it, and
   the lowest permission that is accurate.
3. Implement real behavior with useful errors; use `ok`, `fail` or
   `errorResult`.
4. Export it from the module's tool array.
5. Add tests in `tests/`.

## Adding a provider

1. Implement `Provider` (`stream`, `listModels`, `capabilities`).
2. Reuse `src/providers/http.ts` and `src/providers/sse.ts` for transport.
3. Add the provider type to `src/config/schema.ts` and a preset to
   `src/providers/presets.ts`.
4. Wire construction in `src/providers/registry.ts`.
5. Add streaming/tool-call/error tests with a mocked `fetchImpl`.
6. Document configuration in `docs/PROVIDERS.md`.

## Adding an MCP transport

MCP transports belong in `src/mcp/manager.ts`; keep tool registration and
permission behavior identical to stdio/HTTP. External MCP output is untrusted
data and must be flattened safely.

## Adding a plugin feature

The plugin API is versioned (`tagcode.apiVersion: "1"`). Extending it requires
updating `src/plugins/types.ts`, the host, documentation and an example in
`examples/plugins/`. Plugins must never bypass the permission gate.

## Security reports

Do not open a public issue for vulnerabilities. See [SECURITY.md](SECURITY.md).

## Commit messages

Use short imperative subjects (`add diff command`, `fix MCP reconnect`). Include
a body when the change needs rationale or trade-offs. Keep unrelated changes in
separate commits.
