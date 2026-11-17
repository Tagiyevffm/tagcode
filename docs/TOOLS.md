# Tools

Every tool declares a name, description, Zod input schema, permission level and
an execution handler. All calls go through `ToolRegistry.execute`, which:

1. validates arguments,
2. builds a summary for display,
3. requires permission via `PermissionManager`,
4. executes with cancellation support,
5. truncates output to `context.maxToolOutputChars`,
6. returns failures as results so the model can recover.

Tool modules live in `src/tools/` and are registered by
`registerBuiltinTools()`.

## Permission levels

| Level | Typical use |
| --- | --- |
| `read` | Reads workspace state, no side effects |
| `network` | Outbound HTTP |
| `write` | Creates or modifies files |
| `execute` | Runs commands/processes |
| `sensitive` | Destructive or high-impact operations |

`read` is the only level allowed in plan mode. `sensitive` always asks unless a
tool is explicitly allowlisted.

## File tools (`src/tools/fs.ts`)

| Tool | Permission | Description |
| --- | --- | --- |
| `read_file` | read | Read a text file, optionally a line range |
| `write_file` | write | Write/replace a file; captures a checkpoint first |
| `edit_file` | write | Exact-string replacement; uniqueness required unless `replace_all` |
| `delete_file` | sensitive | Delete a file or directory (`recursive`) |
| `create_directory` | write | Create a directory tree |
| `list_directory` | read | List entries with metadata |
| `search_files` | read | Glob search for files |
| `search_content` | read | Search file contents (regex/literal) |
| `find_references` | read | Find symbol references |
| `move_file` | write | Move/rename within the workspace |
| `copy_file` | write | Copy files/directories within the workspace |

Editing preserves UTF-8 BOM and CRLF/LF style. Binary files are rejected.
Writes and edits return a unified diff and capture checkpoints automatically.
Path escapes and symlink escapes are rejected before touching disk.

## Terminal tools (`src/tools/terminal.ts`)

| Tool | Permission | Description |
| --- | --- | --- |
| `run_command` | execute | Run a shell command in the workspace |
| `run_script` | execute | Run a project script |
| `execute_python` | execute | Execute Python with the workspace as cwd |
| `execute_node` | execute | Execute Node.js with the workspace as cwd |
| `install_dependencies` | execute | Install dependencies with the detected package manager |

Commands are classified by `src/security/commands.ts`; dangerous patterns force
approval and are surfaced in the approval prompt. Commands receive no
interactive stdin and have a timeout and output cap. There is no OS sandbox:
approval means running with your user privileges.

## Git tools (`src/tools/git.ts`)

`git_status`, `git_diff`, `git_log`, `git_branch`, `git_add`, `git_commit`,
`git_checkout`, `git_show`.

Pushing, force-pushing and publishing require approval; force-push and history
rewrites are classified as dangerous. TagCode never pushes automatically.

## Analysis tools (`src/tools/analysis.ts`)

| Tool | Purpose |
| --- | --- |
| `inspect_project` | Summarize languages, frameworks, package manager, commands |
| `detect_language` | Detect project languages |
| `detect_framework` | Detect frameworks |
| `inspect_dependencies` | Read dependency manifests and lockfiles |
| `analyze_errors` | Parse error output/file locations |
| `find_todos` | Find TODO/FIXME/HACK/XXX comments |
| `run_tests` | Run the project test command |
| `run_linter` | Run the project linter |
| `check_types` | Run the type checker |

These use detected project commands where possible and report the exact command
they ran.

## Web tools (`src/tools/web.ts`)

| Tool | Purpose |
| --- | --- |
| `web_search` | Search via configured Brave/Tavily integration |
| `fetch_url` | Fetch a URL and convert HTML to readable text |
| `read_documentation` | Fetch and extract documentation content |

Web tools are optional. Without `web.searchProvider` and a key, `web_search`
reports that search is not configured. `fetch_url` enforces timeout/size limits
and optional `web.allowedDomains`.

## Other tools (`src/tools/misc.ts`)

| Tool | Purpose |
| --- | --- |
| `ask_user` | Ask the user a question through the UI |
| `create_plan` | Create/replace the session plan |
| `update_plan` | Update plan step statuses |
| `summarize_context` | Summarize conversation context |
| `inspect_environment` | Report OS, runtime, cwd and tool availability |

## Extension tools

- MCP tools: `mcp__<server>__<tool>`.
- Plugin tools: registered with a `plugin__<plugin>__<tool>` prefix; the plugin
  manifest must declare the tool's permission class.

## Listing tools

```bash
tgc tools
tgc tools git
```

Inside the TUI: `/tools [filter]`.
