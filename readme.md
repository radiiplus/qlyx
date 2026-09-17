# qlyx

qlyx is a terminal coding agent that can use Qwen or DeepSeek as its model
provider. It can inspect a project, edit files, run commands, browse documentation,
operate an existing Chrome tab, track a plan, and resume work later. The model
selects actions while the local qlyx runtime validates and executes them through
MCP.

## Requirements

- Node.js 22 or newer.
- npm with access to the public npm registry.
- Chrome or Chromium with remote debugging enabled for Qwen authentication or
  browser control.
- A Qwen account for the stable provider. DeepSeek web-session support is being
  developed separately.

qlyx uses the current operating-system user's permissions. Its execution modes
control which tools may run, but they do not create an OS sandbox.

## Start qlyx

Open a terminal in the project you want qlyx to work on and run:

```sh
npx @radiiplus/qlyx
```

`npx` downloads the scoped qlyx package when needed and starts its interactive chat.
The installed executable is still named `qlyx`. For scripts or
automation where npm should not ask before installing the package, use:

```sh
npx --yes @radiiplus/qlyx
```

The equivalent form that makes the executable name explicit is:

```sh
npx --yes --package @radiiplus/qlyx qlyx
```

You can also install qlyx globally:

```sh
npm install --global @radiiplus/qlyx
qlyx
```

Pass an initial task after the options to begin immediately:

```sh
npx @radiiplus/qlyx "Find the failing tests, fix the cause, and verify the result"
npx @radiiplus/qlyx --root /path/to/project "Explain how authentication works"
npx @radiiplus/qlyx --autonomous "Add a health endpoint and run the tests"
```

## Qwen authentication

qlyx uses your existing Chrome profile so Google or Qwen sign-in remains
available. It does not launch a separate browser profile.

1. Open `chrome://inspect/#remote-debugging` in Chrome.
2. Enable remote debugging.
3. Run `npx @radiiplus/qlyx` and submit a prompt.
4. Accept Chrome's connection prompt if it appears.
5. Complete Qwen sign-in or browser verification in the qlyx-owned tab.

When authentication succeeds, qlyx stores the Qwen session privately at
`~/.local/share/qlyx/session.json`. The file is owner-readable only and is never
placed in the workspace or npm package. qlyx stores only Qwen cookies and Qwen
page storage, not Google cookies or data from unrelated sites.

The Chrome “Allow” prompt authorizes qlyx to attach to the DevTools session; it
is separate from Qwen sign-in. qlyx keeps that attachment open for the lifetime
of the CLI process, so normal follow-up prompts reuse it. Chrome can ask again
after qlyx exits, after the browser restarts, or after a connection is revoked.

On Linux, qlyx discovers common Chrome and Chromium profiles. You can choose a
profile or debugging endpoint explicitly:

```sh
PROFILE=/path/to/chrome/profile npx @radiiplus/qlyx
ENDPOINT=http://127.0.0.1:9222 npx @radiiplus/qlyx
```

Use `/session check` inside qlyx to validate the saved session. Missing or expired
credentials trigger the interactive browser flow unless `--unattended` is set.
On startup, qlyx completes this validation before rendering the chat header and
input. The chat interface only becomes available after authentication succeeds.

## Model providers

Qwen is the stable default provider and uses the browser session described above.
Select it explicitly with:

```sh
npx @radiiplus/qlyx --provider qwen
```

DeepSeek web-session support is reserved for a follow-up. It will use the same
existing-browser authentication pattern and will not use an API key. Do not set
up a DeepSeek provider session from this release yet.

Use `--model ID` or `/model` to choose one of the models returned by the active
provider.

## Command-line options

```text
npx @radiiplus/qlyx [options] ["Initial prompt"]
```

| Option | Description |
| --- | --- |
| `--root PATH` | Workspace qlyx may inspect and modify. Defaults to the current directory. |
| `--resume ID` | Resume a saved global session and reopen its original workspace. |
| `--resume latest` | Resume the newest agent checkpoint in the selected workspace. |
| `--provider qwen\|deepseek` | Select the model provider. Qwen is the stable default. |
| `--new` | Start a new remote model conversation while preserving local context. |
| `--model ID` | Select a model from the active provider for subsequent requests. |
| `--steps N` | Limit model decisions for a task. Default 20, range 1 to 100. |
| `--timeout SECONDS` | Set the model request timeout. Default 180, maximum 3600. |
| `--mcp FILE` | Load additional MCP server definitions from JSON. |
| `--autonomous` | Execute enabled tools without individual approval prompts. |
| `--passive` | Allow inspection and research while disabling mutations and commands. |
| `--unattended` | Fail instead of opening Chrome when authentication is required. |
| `--plain` | Disable colors, animation, and rich terminal panels. |
| `--palette FILE` | Load terminal color indexes from a JSON object. |
| `--help`, `-h` | Print command-line and interactive help. |

`--autonomous` and `--passive` cannot be used together.

## Execution modes

### Guided

Guided is the default. Reads and web retrieval can proceed immediately. File
changes, commands, browser interaction, and external MCP tools require approval.

When an approval appears:

- Press Enter to approve.
- Press Escape to skip.
- Press `v`, then Enter, to inspect a proposed change.
- Press `e`, then Enter, to inspect its purpose and available evidence.

### Autonomous

Autonomous mode executes enabled tools without asking for each action. Start in
this mode with `--autonomous`, select `/approval on`, or run `/mode autonomous`.
Use it only in a workspace and environment you trust.

### Passive

Passive mode can read files, search source, retrieve web pages, and open a page
for inspection. It disables file mutation, commands, browser interaction, and
external tools. Start with `--passive` or use `/approval passive`.

## Interactive commands

Type `/` to open the categorized command menu. Use the arrow keys to select an
item, Enter to open or choose it, Tab to fill it into the prompt, and Escape to
close the menu. You can also type any complete command directly.

### Sessions

| Command | Description |
| --- | --- |
| `/new` | Start a separate local coding session in the current workspace. |
| `/sessions [text]` | Search saved sessions by title, ID, status, or workspace. |
| `/resume ID` | Resume a global session ID or unique ID prefix. |
| `/continue` | Continue the current paused or incomplete agent task. |
| `/history` | Print the saved user and assistant conversation. |
| `/reset` | Start a new remote model conversation with the current local context. |
| `/session check` | Validate the active provider's authentication. |

`/sessions` opens an inline picker in an interactive terminal. Resuming a session
switches to its original workspace, prints its previous conversation, and keeps
its plan and execution journal available.

### Models and permissions

| Command | Description |
| --- | --- |
| `/model` | Fetch available models and open the model picker. |
| `/model ID` | Select a specific available model. |
| `/approval on` | Enable autonomous approval. Equivalent to `/auto on`. |
| `/approval off` | Return to guided approval. Equivalent to `/auto off`. |
| `/approval passive` | Switch to passive mode. |
| `/mode guided` | Ask before mutations and execution. |
| `/mode autonomous` | Execute enabled tools automatically. |
| `/mode passive` | Disable mutations and execution. |
| `/batch on` | Approve all currently proposed actions in the turn. |
| `/batch off` | Return to individual guided approvals. |

A model change starts a new remote conversation with the saved local context.
Changing modes preserves the current local session and conversation.

### Planning

Planning is automatic. qlyx creates a milestone plan when a task is large enough
to benefit from one and updates it from actual tool results.

| Command | Description |
| --- | --- |
| `/plan status` | Show run status and completed milestone count. |
| `/plan steps` | Display the current milestone list. |
| `/plan progress` | Show completed tools, failures, and pending work. |

The workspace `plan.md` contains an agent-managed section with `[ ]`, `[~]`, and
`[x]` milestone states. Text outside that generated section is preserved.

### Execution inspection

| Command | Description |
| --- | --- |
| `/outputs` | List captured executions and their stable IDs. |
| `/output [ID]` | Open stdout, stderr, exit status, and capture details. Defaults to the latest execution. |
| `/diff [ID]` | Open the captured before/after diff for a file change. |
| `/explain [ID]` | Show an action's purpose, plan contribution, and returned evidence. |
| `/map` | List explored, changed, and executed targets for the session. |
| `/learned` | Show saved architectural findings and limitations reported at completion. |

Normal activity output is intentionally compact. These commands reveal the saved
details without rerunning a tool.

### Background tasks

Commands that run for more than one second yield a task ID. qlyx keeps checking
them while the agent performs independent work.

| Command | Description |
| --- | --- |
| `/tasks list` | Show running and completed background commands. |
| `/tasks output ID` | Inspect accumulated output and current status. |
| `/tasks stop ID` | Stop the command and its process group. |

A running task is not considered successful verification. The agent must observe
its exit result before claiming completion, unless it explicitly reports a
persistent service as still running. Closing qlyx stops tasks owned by that
runtime; saved sessions do not reattach old operating-system processes.

### Skills and control

| Command | Description |
| --- | --- |
| `/skills` | List approved global reusable skills. |
| `/stop` | Cancel the active turn and its running commands. |
| `/help` | Print all commands and shortcuts. |
| `/exit` | Close qlyx. |

To send a prompt that begins with a literal slash, prefix it with another slash:

```text
//explain this route syntax
```

End a line with `\` to compose multiline input.

## Keyboard controls

| Key | Action |
| --- | --- |
| `Ctrl+T` | Enter or leave the live transcript. |
| `Ctrl+O` | Enter or leave the current execution output. |
| `Escape` | Return from a viewer, close a menu, or skip a pending approval. |
| `Enter` | Submit input, choose a menu item, or approve a pending action. |
| `Ctrl+C` | Cancel the active turn; when idle, exit qlyx. |
| `Up` / `Down` | Navigate input history, menu choices, or viewer lines. |
| `Page Up` / `Page Down` | Scroll transcript and output viewers. |
| `Home` | Jump to the beginning of a viewer. |
| `End` | Jump to the end and follow new viewer events. |

Input entered while the agent is busy is queued and delivered at the next model
decision boundary. If new direction arrives while the model is selecting an action,
qlyx discards that stale action before execution.

## What the agent can do

### Workspace exploration

The bundled MCP server provides bounded directory listing, text reads, and source
search. It excludes `.git`, `node_modules`, `.agent`, `config`, and `.env` files.
File tools reject paths outside the selected workspace and symlink escapes.

### File changes

Before replacing a file, the agent must read it and provide its digest. This
prevents a stale model action from silently overwriting a newer change. Successful
writes produce syntax-highlighted diffs with green additions and red removals.

### Commands

Commands use argument arrays instead of shell interpolation. qlyx streams stdout
and stderr, records the exit code or terminating signal, applies a timeout, and
kills timed-out process groups on supported platforms. Output is bounded and an
omission notice is shown when a capture limit is reached.

### Web research

The `web` tool searches the web and the `browse` tool retrieves readable HTTP or
HTTPS text. HTML pages are converted into bounded text with resolved links.
JavaScript-rendered or interactive pages can use the browser tools instead.

### Browser control

Browser tools attach through Chrome remote debugging and create one owned tab.
The agent can open a URL, inspect visible controls, click, fill fields, and press
keys. Closing qlyx closes only its owned tab and leaves Chrome and existing tabs
running.

### Batches

The model can request several independent tool actions in one response. qlyx runs
them concurrently, shows one explanation for the batch, and records each result
under its own execution ID. Actions with dependencies remain sequential.

### External MCP servers

Pass `--mcp /path/to/servers.json` to add command-based or HTTP MCP servers:

```json
{
  "servers": [
    {
      "name": "docs",
      "command": "node",
      "args": ["/absolute/path/to/server.js"]
    },
    {
      "name": "remote",
      "url": "https://example.com/mcp"
    }
  ]
}
```

Server names must be unique lowercase single words. External servers are trusted
programs and may have side effects simply by starting.

## Workspace memory

On first use, qlyx creates three editable files in each workspace:

| File | Purpose |
| --- | --- |
| `context.md` | Project facts, constraints, architecture, and useful commands. |
| `skill.md` | Project-specific operating guidance. |
| `plan.md` | User notes plus the current agent-managed milestone section. |

New workspace files are copied from templates under
`~/.local/share/qlyx/templates/`. Edit those templates to change defaults for
future workspaces. Existing workspace files are never replaced by the templates.

The agent can propose a reusable global skill after verifying a procedure.
Guided mode asks before saving it; autonomous mode can save it directly. Global
skills live under `~/.local/share/qlyx/skills/` with owner-only permissions. The
default `os` and `browser` skills explain local tool and existing-browser usage.
Skills cannot contain known credentials, session data, or project-only secrets.

## Sessions and persistence

qlyx stores its central SQLite catalog at:

```text
~/.local/share/qlyx/session.db
```

The catalog tracks prompt conversations and coding runs across workspaces. It
stores titles, status, workspace paths, conversation snapshots, and checkpoint
snapshots. Checkpoints, chats, journals, and locks are stored under the same
central data directory with private permissions.

Session history survives terminal restarts and provider account changes. When the
authenticated account changes, qlyx starts a new remote conversation and restores
the saved local context instead of sending the old account's remote chat ID.

On first use after upgrading, qlyx migrates existing data from
`~/.local/share/qwen/` into the qlyx data directory. Existing qlyx files take
precedence if both directories already exist.

Use `DATABASE=/path/to/session.db npx @radiiplus/qlyx` to select a different
catalog and `SESSION=/path/to/session.json npx @radiiplus/qlyx` to select a
different credential file.

## Transcript and rendering

The normal conversation view shows concise semantic rows for exploration,
changes, commands, browser actions, success, and failure. Loading animation uses
its own row so prompt input does not flicker during updates.

Ctrl+T opens a live, formatted transcript containing tool arguments, structured
results, command streams, timing, reconnects, and session events. Ctrl+O opens the
current execution output. Both viewers preserve code syntax colors and diff
backgrounds while scrolling and wrapping.

Use `--plain` or set `NO_COLOR=1` when output must be unstyled. A custom palette
file can map `context`, `action`, `attention`, `success`, `failure`, `user`, and
`muted` to terminal color indexes from 0 through 255.

## Reconnect and failure behavior

Before a model request, qlyx validates authentication. If a recoverable network,
socket, timeout, or 401 interruption occurs during a turn, it validates the
session, creates a new remote chat from the saved local context, and retries the
model decision once. It never automatically replays a tool action.

Qwen browser verification challenges require manual completion in the attached
Qwen tab. Provider failures show the safe reason, code, and endpoint when
available; saved cookie values, API keys, and terminal control characters are
redacted.

An interrupted tool is marked uncertain. Inspect the workspace and execution
output before continuing because the operating-system action may have completed
partially.

## Local development

Install dependencies and start the checkout:

```sh
npm install
npm start
```

Available package scripts:

| Script | Description |
| --- | --- |
| `npm start` | Start the interactive chat. |
| `npm run chat` | Alias for the interactive chat. |
| `npm run mcp` | Start the bundled MCP server over stdio. |
| `npm test` | Run the full test suite. |

The root contains only `chat.js`, the npm executable, and `server.js`, the MCP
subprocess entrypoint. Shared implementation lives in `module/`.

## Publish

Review exactly what npm will include:

```sh
npm pack --dry-run
```

After authenticating with npm, publish the package:

```sh
npm login
npm publish --access public
```

Publishing runs the test suite through `prepublishOnly`.
