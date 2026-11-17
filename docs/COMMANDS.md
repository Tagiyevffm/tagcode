# Commands

TagCode has three command surfaces: the headless CLI (`tgc …`), the desktop app
(default) and slash commands inside the interactive UI. Slash commands are
registered in `src/commands/builtins.ts`; plugins can add
`/plugin:<plugin>:<command>`.

## Headless CLI

```text
tgc [options]                       Open the desktop app
tgc app [--no-open] [--browser]     Start the desktop app server
tgc tui                             Start the terminal UI
tgc run [prompt...]                 Run one prompt and exit
tgc init                            Create .tagcode scaffolding and AGENTS.md
tgc doctor [--json]                 Diagnose configuration and connectivity
tgc connect [type] [options]        Configure a provider
tgc disconnect [id] [--project]     Remove a provider and stored key
tgc model [name...] [--json]        Show/set the model
tgc models [--json]                 List models from the active provider
tgc config <show|path|get|set|reload> [key] [value] [--project]
tgc mcp <action> [args] [--url] [--project] [--json]
tgc skills <action> [args] [--global] [--force] [--yes]
tgc session <list|show|resume|delete|export> [args] [--yes] [--json]
tgc plugins <list|reload|enable|disable> [name] [--project]
tgc tools [filter]
```

Global options: `-C/--cwd <dir>`, `-p/--provider <id>`, `-m/--model <name>`,
`--mode <agent|plan|ask>`, `--permission <ask|auto|plan|yolo>`,
`--session <id>`, `--no-mcp`, `--no-plugins`.

`tgc run` options: `--json`, `--yes` (auto-approve), `--quiet`,
`--show-reasoning`. When no prompt is given and stdin is piped, stdin is used.

### Examples

```bash
tgc                                 # open the desktop app
tgc app --no-open                   # print the local app URL
tgc tui                             # terminal UI
tgc run "fix the failing tests" --yes
tgc run --json "review src/controller.ts"
echo "explain package.json" | tgc run --quiet
tgc --mode plan run "plan a login flow"
tgc mcp add fs -- npx -y @modelcontextprotocol/server-filesystem .
tgc skills install https://github.com/user/skill-repo
tgc session list --json
tgc session resume latest
```

## Slash commands

Type `/help` to list them, or `/help <command>` for details. Anything not
starting with `/` is sent to the agent.

| Command | Description |
| --- | --- |
| `/help [command]` | List commands or show details |
| `/status` | Provider, model, mode, session, usage, context |
| `/mode [agent\|plan\|ask]` | Show/set interaction mode |
| `/agent [task]` | Switch to agent mode, optionally run a task |
| `/plan [task]` | Switch to plan mode (read-only) |
| `/ask [question]` | Switch to ask mode (read-only) |
| `/permissions [ask\|auto\|plan\|yolo]` | Show/set permission mode |
| `/model [list\|<name>]` | Show, fetch and choose the model (opens a picker) |
| `/models` | List models from the active provider |
| `/provider [id\|remove <id>]` | List/switch/remove providers |
| `/connect [type] [options]` | Configure a provider; `/connect custom` is a guided wizard |
| `/disconnect [id]` | Remove a provider and its stored key |
| `/context` | Context budget and usage |
| `/cost` | Session token usage |
| `/compact` | Summarize older history |
| `/clear` | Clear the conversation (keeps session file) |
| `/init` | Create `.tagcode` scaffolding and AGENTS.md |
| `/memory <show\|list\|search\|add\|clear\|export>` | Project/global memory |
| `/sessions` | List saved sessions |
| `/resume <id\|latest>` | Resume a session |
| `/session <list\|show\|resume\|rename\|delete\|export>` | Session management |
| `/new` | Start a new session |
| `/save` | Save the current session |
| `/export [path]` | Export the session as Markdown |
| `/diff [--staged]` | Show the Git diff |
| `/changes` | Changed files and current branch |
| `/undo` | Restore the last checkpoint |
| `/redo` | Reapply the last undone checkpoint |
| `/checkpoints` | List checkpoints |
| `/checkpoint <path...> [--reason text]` | Capture a manual checkpoint |
| `/skills <action>` | Skills management (see SKILLS.md) |
| `/mcp <action>` | MCP management (see MCP.md) |
| `/plugins <list\|enable\|disable\|reload>` | Plugin management |
| `/tools [filter]` | List registered tools |
| `/config <show\|path\|get\|set\|reload>` | Configuration |
| `/doctor` | Diagnostics |
| `/version` | Version |
| `/quit` (`/exit`, `/q`) | Exit |

### `/session` actions

`list`, `show [id]`, `resume <id|latest>`, `rename <title>`,
`delete <id> [--yes]`, `export [path] [--json]`.

### `/mcp` actions

`status`/`list`, `tools`, `add`, `remove`, `connect`, `disconnect`, `inspect`,
`reconnect`, `reload`/`refresh`.

### `/skills` actions

`list`, `active`, `index`, `inspect`, `reload`, `use`, `off`, `install`,
`remove`, `update`, `search`, `create`, `validate`.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Enter` | Send |
| `Shift+Enter` / `Ctrl+J` | Newline |
| `↑` / `↓` | History |
| `Tab` | Complete slash command |
| `Esc` | Close modal / leave completion |
| `Ctrl+C` | Cancel the run; twice exits when idle |
| `Ctrl+D` | Exit when appropriate |
| `Ctrl+W` | Delete previous word |
| `Home` / `End` | Line start/end |
| `Ctrl+Left/Right` | Line start/end (edit mode) |

Approval modal: `y`/Enter approve, `a` approve and remember for the session,
`n`/Esc deny.

## Plugin commands

Plugins register commands as `/plugin:<plugin-name>:<command-name>`. They are
listed by `/plugins` and `/help`.
