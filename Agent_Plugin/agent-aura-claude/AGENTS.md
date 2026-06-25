# AGENTS.md

## Project Overview

**agent-aura-claude** is a Claude Code plugin that synchronizes Claude Code lifecycle hook events to an AgentAura ESP32 Ring Light. When Claude Code transitions between states (e.g., running a tool, waiting for permission, idle), the plugin sends the corresponding state to the ring light hardware, which reflects the state via its LED ring.

- **License**: MIT
- **Runtime**: Node.js >= 18
- **Module system**: CommonJS (`"type": "commonjs"`)
- **Key dependency**: `serialport@^12.0.0` (native module, lazy-loaded only when the serial transport is used)

## Project Structure

```
agent-aura-claude/
├── .claude-plugin/
│   └── plugin.json              # Claude Code plugin manifest (name, userConfig schema)
├── bin/
│   ├── agent-aura-claude.js     # CLI entry point (shebang, requires src/index.js)
│   └── aura-dispatch.sh         # Shell dispatcher for the /agent-aura-claude:aura slash command
├── commands/
│   └── aura.md                  # /agent-aura-claude:aura slash command definition
├── hooks/
│   └── hooks.json               # Claude Code hook registrations (18 lifecycle events)
├── src/
│   ├── types.js                 # Constants: AGENT_STATES, TRANSPORTS + validators
│   ├── config.js                # Config load/save, env var overrides, runtime state, disabled marker
│   ├── discovery.js             # UDP broadcast device discovery on port 8888
│   ├── deviceClient.js          # RingLightClient: send state/commands via HTTP/UDP/serial
│   ├── hooks.js                 # Claude hook event → agent state mapping + runClaudeHook entry
│   └── index.js                 # CLI command dispatcher + parseArgs/parseBoolean helpers
├── test/
│   └── regression.test.js       # Node.js built-in test runner (node:test)
├── agent-aura-claude.config.example.json  # Example config file
├── package.json
└── README.md
```

## Build and Test Commands

```bash
npm run build        # Runs lint + test:unit (the full CI check)
npm run lint         # Syntax-checks all JS files via `node --check`
npm run test:unit    # Runs test/regression.test.js via `node --test`
npm test             # Alias for test:unit
```

- **Lint**: `node --check` is run on `bin/agent-aura-claude.js`, every file in `src/`, and `test/regression.test.js`. There is no ESLint or Prettier configuration — the lint step is purely a syntax check.
- **Tests**: Uses Node.js built-in test runner (`node:test` + `node:assert/strict`). Tests are in `test/regression.test.js`. Tests use isolated temp directories and env var snapshots to avoid side effects.

## Architecture and Module Division

### `src/types.js` — Constants and Validators

Defines the two core constant arrays and their validators:

- `AGENT_STATES`: `['running', 'busy', 'waiting', 'error', 'idle', 'init', 'offline', 'upgrade']`
- `TRANSPORTS`: `['http', 'udp', 'serial']`
- `isAgentState(value)`, `isTransportName(value)`: boolean validators

### `src/config.js` — Configuration Management

Manages all configuration persistence and loading:

- **`DEFAULT_CONFIG`**: `enabled: true`, `transport: 'http'`, `host: ''`, `port: 80`, `serialPort: ''`, `baud: 115200`, `debounceMs: 500`, `cooldownMs: 3000`, `timeoutMs: 650`, `autoDiscover: true`
- **Path functions**:
  - `claudeDir()`: `CLAUDE_HOME` env or `~/.claude`
  - `configPath()`: `AGENTAURA_CLAUDE_CONFIG` env or `~/.claude/agent-aura-claude.json`
  - `runtimeStatePath()`: `AGENTAURA_CLAUDE_STATE` env or `CLAUDE_PLUGIN_DATA/state.json` or `~/.claude/agent-aura-claude-state.json`
  - `disabledPath()`: `~/.claude/agent-aura-claude.disabled`
- **Config load precedence** (applied in order, later wins):
  1. File config (`~/.claude/agent-aura-claude.json`)
  2. Plugin option overrides (`CLAUDE_PLUGIN_OPTION_*` env vars)
  3. Environment overrides (`AGENTAURA_CLAUDE_*` and `AGENTAURA_*` env vars)
- **`normalizeConfig(input)`**: Enforces defaults and clamps ranges:
  - `port`: 1–65535
  - `baud`: 1200–4000000
  - `debounceMs`: 0–60000
  - `cooldownMs`: 0–60000
  - `timeoutMs`: 100–10000
- **`saveConfig(patch)`**: Merges patch into file config, normalizes, writes to disk. Environment overrides are NOT persisted — only the patch and existing file config are saved.
- **Runtime state**: `loadRuntimeState()`, `saveRuntimeState(patch)`, `clearRuntimeState()` — tracks last-sent state, last failure timestamp, discovery state
- **Manual command hook suppression**: `suppressHooks()` writes `hookSuppressedUntil` to runtime state so `/agent-aura-claude:aura ...` commands are not immediately overwritten by surrounding `UserPromptSubmit` / `Stop` hooks. A following non-AgentAura `UserPromptSubmit` clears the suppression.
- **Disabled marker**: `isDisabled()` checks for existence of `~/.claude/agent-aura-claude.disabled`; `setDisabled(bool)` creates/removes the marker file

### `src/discovery.js` — UDP Device Discovery

- `DISCOVERY_PORT = 8888`
- `discoverDevices(timeoutMs = 2500)`: Creates a UDP4 socket with `reuseAddr`, binds to port 0, sends `discover\n` to `255.255.255.255:8888`, collects JSON responses, deduplicates by `mac`/`ip`/`address`, resolves the array after the timeout
- `discoverFirst(timeoutMs = 1500)`: Returns the first discovered device or `null`

### `src/deviceClient.js` — RingLightClient

The `RingLightClient` class is the primary interface to the hardware:

- **`constructor(config)`**: Stores the loaded config
- **`get isConfigured()`**: `serial` transport requires `serialPort`; `http`/`udp` require `host`
- **`sendAgentState(state)`**: Main hook entry point. Checks `enabled`/disabled, auto-discovers if needed, debounces same state (within `debounceMs`), applies cooldown after failures (within `cooldownMs`). Sends via HTTP POST `/api/agent?state=<state>` or the `agent <state>` command for UDP/serial
- **`sendCommand(command)`**: Sends raw firmware command. HTTP: POST `/api/cmd`; UDP/serial: text command exchange
- **`health()`**: Queries device state. HTTP: GET `/api/state`; UDP/serial: `state` command
- **`maybeAutoDiscover()`**: If not configured, `autoDiscover` is true, and transport is not serial, discovers the first device via UDP and saves the HTTP config (transport: `http`, host: found IP, port: found HTTP port or 80)
- **Transport methods**: `httpPost(path, body)`, `httpGetJson(path)`, `udpExchange(command, timeoutMs)`, `serialExchange(command, waitForJson)` — serial lazy-loads `serialport` via `require()`
- **`portFor(transport)`**: Returns `config.port` or the default (8888 for UDP, 80 for HTTP)
- **`parseDeviceState(body)`**: Extracts JSON from a response body, returns parsed object or `{ reachable: true, raw: body }` fallback

### `src/hooks.js` — Claude Hook Event Mapping

- **`CLAUDE_HOOK_EVENTS`**: 18 events registered in `hooks/hooks.json`:
  `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `PreCompact`, `PostCompact`, `Stop`, `StopFailure`, `SessionEnd`
- **`CLAUDE_EVENT_TO_AGENT_STATE`**: Direct event-to-state mapping:
  | Event | Agent State |
  |---|---|
  | `SessionStart` | `init` |
  | `UserPromptSubmit` | `running` |
  | `PreToolUse` | `busy` |
  | `PermissionRequest` | `waiting` |
  | `PermissionDenied` | `error` |
  | `PostToolUse` | `running` |
  | `PostToolUseFailure` | `error` |
  | `PostToolBatch` | `running` |
  | `SubagentStart` | `busy` |
  | `SubagentStop` | `running` |
  | `TaskCreated` | `busy` |
  | `TaskCompleted` | `running` |
  | `PreCompact` | `busy` |
  | `PostCompact` | `running` |
  | `Stop` | `idle` |
  | `StopFailure` | `error` |
  | `SessionEnd` | `offline` |
- **`runClaudeHook(eventArg)`**: Main entry point called by `bin/agent-aura-claude.js hook <event>`. Reads JSON from stdin (with 1000ms timeout), normalizes the event name, maps to agent state (with payload signal refinement), sends to device. **All wrapped in try/catch** — hook errors are silently swallowed so device issues never interrupt Claude Code.
- **`mapClaudeEventToAgentState(eventName, payload)`**: If `eventName` is itself a valid agent state, uses it directly. Otherwise checks payload for error/waiting signals, maps Notification events, falls back to direct mapping, then substring matching for unknown events.
- **`normalizeClaudeEventName(eventArg, payload)`**: Uses `eventArg` if non-empty, otherwise looks in payload for `hook_event_name`/`hookEventName`/`event`/`type`/`name`/`hook` keys.
- **Payload signal detection**:
  - `payloadSignalsError(payload)`: Inspects payload for `success: false`, `ok: false`, error/denied keys with truthy values, or string values like `denied`/`rejected`/`failed`/`failure`/`error`
  - `payloadSignalsWaiting(payload)`: Inspects payload for permission/approval/elicitation keys with truthy values, or string values like `pending`/`waiting`/`approval_required`/`permission_prompt`/`elicitation_dialog`
  - `mapNotificationToAgentState(payload)`: Maps Notification payloads: `permission_prompt`/`elicitation_dialog` → `waiting`, `idle_prompt` → `idle`, `auth_success`/`elicitation_complete`/`elicitation_response` → `running`
- **Manual command suppression**: `shouldSkipClaudeHook()` skips hooks when the payload begins with `/agent-aura-claude:aura`, and skips following hooks while `hookSuppressedUntil` is active. This keeps manual state commands from being immediately overwritten by the same slash command's outer `UserPromptSubmit` / `Stop` lifecycle events. A non-AgentAura `UserPromptSubmit` clears the suppression so normal work resumes immediately.

### `src/index.js` — CLI Command Dispatcher

- **`main(argv = process.argv.slice(2))`**: Dispatches CLI commands:
  - `hook <event>` — Runs Claude hook (called by hooks.json registrations)
  - `configure [--transport] [--host] [--port] [--discover]` — Interactive/configure device
  - `config get|path|init|set` — Manage config file
  - `show-config` — Print current resolved config as JSON
  - `discover [--save] [--timeout]` — Discover devices via UDP broadcast
  - `test|state <state>` — Send a test agent state to the device
  - `command|cmd <raw>` — Send a raw firmware command
  - `status|doctor [--probe]` — Show config and optionally probe device health
  - `disable|off` — Create disabled marker (hooks go silent)
  - `enable|on` — Remove disabled marker (hooks resume)
  - `reset-cache` — Clear runtime state
  - `hooks` — List all registered hook events
  - `help|--help|-h` — Print usage
- **`parseArgs(args)`**: Parses `--flag value` and `--flag=value` into camelCase keys; collects positionals
- **`parseBoolean(value)`**: Returns `true` unless value is `0`/`false`/`no`/`off`
- **`parseNumberFlag(value, label)`**: Parses a number, throws if not finite
- **Exports**: `main`, `runCli`, `parseArgs`, `parseBoolean`

### `bin/aura-dispatch.sh` — Slash Command Dispatcher

Shell script that dispatches `/agent-aura-claude:aura` subcommands to the Node CLI. Claude Code plugin commands are always namespaced by plugin name, so bare `/aura` is not registered:
- `/agent-aura-claude:aura on` → `enable`
- `/agent-aura-claude:aura off` → `disable`
- `/agent-aura-claude:aura status` (or no arguments) → `status --probe`
- `/agent-aura-claude:aura cmd <raw>` → `command <raw>`
- `/agent-aura-claude:aura <state>` → `test <state>`

Manual slash commands call `suppressHooks()` before sending or probing so their surrounding Claude lifecycle hooks do not immediately overwrite the requested state. The next normal user prompt clears the suppression.

## Configuration System

### Config File

Located at `~/.claude/agent-aura-claude.json` (overridable via `AGENTAURA_CLAUDE_CONFIG` or `CLAUDE_HOME`). An example is provided in `agent-aura-claude.config.example.json`.

### Environment Variable Overrides

Environment overrides are applied at load time and are NOT persisted to the config file by `saveConfig()`.

**`AGENTAURA_CLAUDE_*` / `AGENTAURA_*` (long and short forms):**
- `AGENTAURA_CLAUDE_TRANSPORT`
- `AGENTAURA_CLAUDE_HOST`
- `AGENTAURA_CLAUDE_PORT`
- `AGENTAURA_CLAUDE_SERIAL_PORT`
- `AGENTAURA_CLAUDE_BAUD`
- `AGENTAURA_CLAUDE_ENABLED`
- `AGENTAURA_CLAUDE_DEBOUNCE_MS`
- `AGENTAURA_CLAUDE_COOLDOWN_MS`
- `AGENTAURA_CLAUDE_TIMEOUT_MS`
- `AGENTAURA_CLAUDE_AUTO_DISCOVER`

**`CLAUDE_PLUGIN_OPTION_*` (plugin option overrides, both UPPER_CASE and snake_case variants):**
- `CLAUDE_PLUGIN_OPTION_ENABLED`
- `CLAUDE_PLUGIN_OPTION_TRANSPORT`
- `CLAUDE_PLUGIN_OPTION_HOST`
- `CLAUDE_PLUGIN_OPTION_PORT`
- `CLAUDE_PLUGIN_OPTION_SERIAL_PORT`
- `CLAUDE_PLUGIN_OPTION_BAUD`
- `CLAUDE_PLUGIN_OPTION_DEBOUNCE_MS`
- `CLAUDE_PLUGIN_OPTION_COOLDOWN_MS`
- `CLAUDE_PLUGIN_OPTION_TIMEOUT_MS`
- `CLAUDE_PLUGIN_OPTION_AUTO_DISCOVER`

### Config Precedence (later overrides earlier)

1. File config (`~/.claude/agent-aura-claude.json`)
2. Plugin option overrides (`CLAUDE_PLUGIN_OPTION_*`)
3. Environment overrides (`AGENTAURA_CLAUDE_*` / `AGENTAURA_*`)

### Plugin Manifest userConfig Schema

Defined in `.claude-plugin/plugin.json` under `userConfig`. All fields have defaults, types, and range constraints. The schema mirrors the runtime `DEFAULT_CONFIG` in `src/config.js`.

## Hook System

### Hook Registration

`hooks/hooks.json` registers 18 Claude Code lifecycle events. Each hook invokes:

```
node ${CLAUDE_PLUGIN_ROOT}/bin/agent-aura-claude.js hook <EventName>
```

All hooks have a 3-second timeout. The `Notification` hook uses matchers: `permission_prompt|elicitation_dialog` and `idle_prompt`.

### Hook Event → Agent State Mapping

The mapping is defined in `src/hooks.js` via `CLAUDE_EVENT_TO_AGENT_STATE`. Some events are refined by inspecting the hook payload (e.g., `PostToolUse` with `{ success: false }` → `error`; `Notification` with `permission_prompt` → `waiting`).

### Hook Error Handling

**Critical**: All hook execution is wrapped in try/catch in `runClaudeHook()`. Exceptions are silently swallowed. This ensures that device offline, network errors, or config issues never break Claude Code's workflow. The hook always exits cleanly (exit code 0) regardless of device communication success.

### Debounce and Cooldown

- **Debounce** (`debounceMs`, default 500): If the same agent state is sent within this interval, the send is skipped (returns `true` without sending).
- **Cooldown** (`cooldownMs`, default 3000): After a device or discovery failure, sends are skipped for this duration. The last failure timestamp and state are persisted in runtime state.

## Transport System

Three transports are supported, selected via `config.transport`:

### HTTP (default)

- Sends state: `POST /api/agent?state=<state>`
- Sends commands: `POST /api/cmd` (body is the raw command string)
- Queries state: `GET /api/state`
- Default port: 80
- Configured via: `transport: 'http'`, `host: '<ip>'`, `port: 80`

### UDP

- Sends state: `agent <state>` command via UDP exchange
- Sends commands: raw command via UDP exchange
- Queries state: `state` command via UDP exchange
- Default port: 8888
- Configured via: `transport: 'udp'`, `host: '<ip>'`, `port: 8888`

### Serial (USB CDC)

- Sends state: `agent <state>` command via serial exchange
- Sends commands: raw command via serial exchange
- Queries state: `state` command via serial exchange
- Default baud: 115200
- Configured via: `transport: 'serial'`, `serialPort: '/dev/ttyACM0'`, `baud: 115200`
- **Note**: `serialport` is lazy-loaded via `require('serialport')` only when the serial transport is actually used, so the native module is not needed for HTTP/UDP-only installations.

## Device Discovery

- **Protocol**: UDP broadcast on port 8888
- **Process**: Sends `discover\n` to `255.255.255.255:8888`, listens for JSON responses
- **Auto-discovery**: If `autoDiscover: true` and no host is configured, the `RingLightClient` triggers `maybeAutoDiscover()` on the first `sendAgentState()` or `sendCommand()` call. If a device is found, the config is automatically saved with `transport: 'http'`, `host: <found IP>`, `port: <found HTTP port or 80>`.
- **Discovery failures**: Trigger cooldown (no sends during cooldown period)

## CLI Commands

The CLI is invoked via `node bin/agent-aura-claude.js <command>` or directly via the installed `agent-aura-claude` binary.

| Command | Description |
|---|---|
| `hook <event>` | Run Claude hook for the given event (reads JSON from stdin) |
| `configure [--transport T] [--host H] [--port P] [--discover]` | Configure device transport/host/port, optionally auto-discover |
| `config get` | Print current resolved config as JSON |
| `config path` | Print config file path |
| `config init` | Initialize config file with defaults (if not exists) |
| `config set <key> <value>` | Set a config key and persist to file |
| `show-config` | Alias for `config get` |
| `discover [--save] [--timeout ms]` | Discover devices via UDP broadcast; `--save` persists found device |
| `test <state>` / `state <state>` | Send a test agent state to the device |
| `command <raw>` / `cmd <raw>` | Send a raw firmware command to the device |
| `status [--probe]` / `doctor [--probe]` | Show config; `--probe` also queries device health |
| `disable` / `off` | Disable ring sync (creates disabled marker) |
| `enable` / `on` | Enable ring sync (removes disabled marker) |
| `reset-cache` | Clear runtime state (last-sent state, failure timestamps) |
| `hooks` | List all registered Claude hook events |
| `help` / `--help` / `-h` | Print usage help |

## Slash Commands

### `/agent-aura-claude:aura`

Defined in `commands/aura.md`. Dispatches via `bin/aura-dispatch.sh` to the Node CLI:

- `/agent-aura-claude:aura on` — Enable ring sync
- `/agent-aura-claude:aura off` — Disable ring sync
- `/agent-aura-claude:aura status` (or no arguments) — Show config and probe device
- `/agent-aura-claude:aura cmd <raw>` — Send raw firmware command (e.g., `/agent-aura-claude:aura cmd rgb 255,0,0`)
- `/agent-aura-claude:aura <state>` — Send a test agent state (e.g., `/agent-aura-claude:aura busy`)

The command suppresses surrounding hooks for a short window, so manual `busy` / `waiting` / `idle` states remain visible instead of being immediately replaced by `running` or `idle` from Claude's own command lifecycle. The next non-AgentAura prompt clears the suppression.

Allowed tools: `Bash(sh:*)` — the command runs shell commands.

## Code Style Guidelines

- **Module system**: CommonJS (`require`/`module.exports`). `"type": "commonjs"` in `package.json`.
- **Strict mode**: All source files begin with `'use strict';`.
- **No transpilation**: Plain Node.js JavaScript (no TypeScript, no Babel). Syntax is checked via `node --check`.
- **No external linter**: No ESLint/Prettier config. The `lint` npm script is `node --check` on each file.
- **Naming conventions**:
  - Files: `camelCase.js` (e.g., `deviceClient.js`)
  - Functions/variables: `camelCase` (e.g., `loadConfig`, `debounceMs`)
  - Constants: `UPPER_SNAKE_CASE` (e.g., `DEFAULT_CONFIG`, `DISCOVERY_PORT`)
  - Classes: `PascalCase` (e.g., `RingLightClient`)
- **Error handling**: Hook execution silently swallows all errors (never breaks Claude Code). CLI commands surface errors via `console.error` and set `process.exitCode = 1`.
- **Lazy loading**: `serialport` is lazy-loaded only when the serial transport is used.
- **No async/await in hot paths**: The hook path uses Promise chains for performance (hook timeout is 3s).

## Testing Instructions

- **Test runner**: Node.js built-in `node:test` (no Jest/Mocha)
- **Test file**: `test/regression.test.js`
- **Run tests**: `npm run test:unit` or `npm test`
- **Test isolation**: Tests use:
  - `withIsolatedEnv()`: Saves/restores all relevant env vars (`CLAUDE_HOME`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PLUGIN_OPTION_*`, `AGENTAURA_CLAUDE_*`)
  - `withTempClaudeHome()`: Creates a temp directory and sets `CLAUDE_HOME` to it, cleaned up after
- **Test coverage**:
  1. `saveConfig` does not persist temporary environment overrides
  2. UDP transport defaults to firmware UDP port (8888) when port is omitted
  3. Plugin option defaults do not override saved CLI config
  4. Plugin data directory is used for runtime state when `CLAUDE_PLUGIN_DATA` is provided
  5. Claude hook events map to firmware agent states
  6. Claude payload signals can refine hook state (Notification permission_prompt → waiting, PostToolUse success:false → error)
  7. Manual AgentAura slash commands suppress surrounding hooks, normal prompts clear suppression, and suppression expires
  8. Bundled Claude plugin hooks use the `node` exec form with `${CLAUDE_PLUGIN_ROOT}/bin/agent-aura-claude.js`

## Security Considerations

- **Hook error isolation**: All hook execution is wrapped in try/catch. Errors are silently swallowed. This is intentional — device/network failures must never interrupt Claude Code's workflow. The hook always exits cleanly.
- **Disabled marker**: The `~/.claude/agent-aura-claude.disabled` file is a simple presence-check marker. When present, all sends are skipped (hooks go silent). Created by `disable`/`off`, removed by `enable`/`on`.
- **Config file permissions**: The config file at `~/.claude/agent-aura-claude.json` may contain device IP addresses. No special file permissions are set by the plugin — the file inherits the default umask permissions. Treat device IPs as mildly sensitive (local network addresses).
- **No credentials stored**: The plugin does not store or transmit any authentication credentials, API keys, or tokens. Device communication is unauthenticated HTTP/UDP/serial.
- **Stdin JSON parsing**: `readStdinJson()` reads JSON from stdin with a 1000ms timeout. Malformed JSON is handled gracefully (returns `null`), and the hook continues with event-name-only mapping.
- **Network exposure**: UDP discovery broadcasts to `255.255.255.255:8888`. HTTP requests go to the configured device host. Serial communication is local USB only. No inbound network listeners are opened by the plugin itself (discovery uses a temporary ephemeral port socket).
- **Env var override safety**: Environment overrides are runtime-only and are NOT persisted to the config file by `saveConfig()`. This prevents accidental persistence of temporary overrides (e.g., from CI or testing).

## Plugin Installation

```bash
# From Claude Code marketplace
/plugin marketplace add /home/xuyd2/Git/open/AgentAura/Agent_Plugin
/plugin install agent-aura-claude@agentaura
```

The plugin is distributed with all necessary files (see `files` in `package.json`): `.claude-plugin/`, `bin/`, `commands/`, `hooks/`, `src/`, `agent-aura-claude.config.example.json`, `README.md`, `package.json`.

## Runtime State

Runtime state is persisted at `~/.claude/agent-aura-claude-state.json` (or `CLAUDE_PLUGIN_DATA/state.json` if `CLAUDE_PLUGIN_DATA` is set, or `AGENTAURA_CLAUDE_STATE` env var).

Runtime state tracks:
- `lastState`: The last agent state successfully sent (used for debouncing)
- `lastSentAt`: Timestamp of the last successful send (used for debouncing)
- `lastErrorAt`: Timestamp of the last failure (used for cooldown)
- `lastErrorState`: The state that failed (used for cooldown)
- `hookSuppressedUntil`: Timestamp until which automatic hooks are skipped after a manual `/agent-aura-claude:aura ...` command
- `hookSuppressionReason`: Last reason recorded for hook suppression

Runtime state can be cleared via `reset-cache` CLI command or `clearRuntimeState()`.
