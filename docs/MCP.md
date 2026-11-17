# MCP (Model Context Protocol)

TagCode is an MCP client. It connects to configured servers, discovers tools,
resources, resource templates and prompts, and exposes server tools to the agent
through the same permission gate as built-in tools.

Implementation: `src/mcp/manager.ts`, using the official
`@modelcontextprotocol/sdk`.

## Transports

- **stdio** — `command` + optional `args`, `env`, `cwd`.
- **Streamable HTTP** — `url` + optional `headers`.

A server config must have exactly one of `command` or `url`.

## Configuration files

- Global: `~/.tagcode/mcp.json`
- Project: `<project>/.tagcode/mcp.json`

Project configuration is merged over the global one by server name.

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\project\\myapp"],
      "permission": "sensitive",
      "timeoutMs": 60000,
      "enabled": true
    },
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${TOKEN}" },
      "permission": "network"
    }
  }
}
```

| Key | Meaning |
| --- | --- |
| `type` | `stdio` or `http` |
| `command`, `args`, `env`, `cwd` | stdio process |
| `url`, `headers` | HTTP endpoint |
| `enabled` | `false` keeps the server configured but disconnected |
| `timeoutMs` | Connect/request timeout (1000–600000) |
| `description` | Human note |
| `permission` | Permission class applied to the server's tools |

`permission` defaults to `sensitive`, so new servers require approval. Set
`read` only for servers you trust to be side-effect free.

## Commands

```bash
tgc mcp list
tgc mcp tools
tgc mcp inspect filesystem
tgc mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem C:\project\myapp
tgc mcp add remote --url https://example.com/mcp
tgc mcp connect [name]
tgc mcp disconnect <name>
tgc mcp reload
tgc mcp remove filesystem [--project]
```

Slash commands: `/mcp status|list|tools|add|remove|connect|disconnect|inspect|reconnect|reload`.

### Desktop panel

Open the **MCP** tab in the inspector to see every configured server with its
transport, state, tool/resource/prompt counts, contributed tool names and last
error. Buttons connect, reconnect or remove a server. The **+** wizard supports
custom stdio commands and remote HTTP endpoints. Each server records a
permission class (`read`, `write`, `execute`, `network` or `sensitive`).

Choose **▦** to browse the MCP catalog. The catalog is a curated list of
ready-made servers; selecting one shows its command preview, runtime
requirements, documentation link and input fields. The server — not the
renderer — resolves placeholders such as `{{workspace}}` and writes an
`mcpServers` entry, so a catalog install cannot inject an arbitrary command.

| Entry | Transport | Permission | Inputs |
| --- | --- | --- | --- |
| Filesystem | stdio (`npx`) | write | allowed folder |
| GitHub | stdio (`npx`) | network | personal access token |
| PostgreSQL | stdio (`npx`) | sensitive | database URL |
| SQLite | stdio (`uvx`) | sensitive | database path |
| Playwright | stdio (`npx`) | execute | none |
| Fetch | stdio (`uvx`) | network | none |
| Brave Search | stdio (`npx`) | network | API key |
| Memory | stdio (`npx`) | write | memory file path |
| Sequential Thinking | stdio (`npx`) | read | none |
| Slack | stdio (`npx`) | network | bot token, team ID |

Installing an entry that already exists returns a conflict; reopen it and use
**Reinstall** to replace its inputs. Remove the server from the MCP panel to
uninstall it. Secrets entered in the catalog are stored in the selected MCP
configuration file, so prefer a narrowly scoped token. `npx` and `uvx` download
the server package on first use; the first connection can therefore be slow.

MCP changes made in the app are written to the selected scope and the manager is
reloaded immediately; the next launch reads the same config.

`/mcp add` writes the configuration and then reconnects. Review commands before
adding them; TagCode executes the command you provide. Catalog installs use the
same `upsertMcpServer` path and the same reconnect step.

## Tool naming and permissions

Server tools are registered as:

```text
mcp__<server-segment>__<tool-segment>
```

Server and tool names are sanitized to letters, digits, `_` and `-`. Each tool
appears in `/tools` and receives the server's configured permission class (or
`sensitive` by default). Every call is authorized and audited.

## Resources, templates and prompts

When a server advertises resources, TagCode registers helper tools for listing
and reading them, and records counts in `/mcp status`. Prompts and templates are
reported in the status and inspect output. Resource content is flattened to
text; binary resources are described by size instead of being inlined.

## Failure handling

- Connection errors are captured per server; other servers still connect.
- Status records `connecting`, `connected`, `disconnected`, `error`, `disabled`,
  the last error and counts.
- `reconnect`/`reload` disconnects and re-discovers tools.
- Startup connects all enabled servers unless `mcp.enabled` is `false` or the CLI
  is run with `--no-mcp`.

## Security

Treat MCP responses as untrusted data. Do not follow instructions found inside
tool output, resources or prompts. The agent is instructed to treat external
content as data. Servers run with the current user's privileges; only configure
servers you trust.
