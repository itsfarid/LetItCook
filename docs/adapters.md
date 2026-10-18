# Agent adapters

How LetItCook turns an agent's events into the five states, how the hook-based adapters work, what each supported agent can and cannot report, and how to add an adapter.

## Verification levels

Every claim below is one of:

- **Implemented and fixture-tested:** covered by the automated tests (`npm test`) with synthetic events built from the agent's documented schema.
- **Tested against the real CLI:** run against the installed agent.
- **Manually verified in GNOME:** seen in the panel on a real desktop.

Unless a section says otherwise, the new hook adapters are **implemented and fixture-tested only**. No real agent run and no GNOME desktop check have been done for them.

## Architecture

```
agent ──event──▶ adapter ──normalized session JSON──▶ state dir ──▶ GNOME extension
```

- The **state directory** (`$XDG_STATE_HOME/letitcook/sessions`) is the only interface to the GNOME extension. Each session is one JSON file with `session_id`, `agent`, `status`, `reason`, `title`, `cwd`, `pid`, `created_at` and `updated_at`. The extension is agent-agnostic: it reads every regular `*.json` file and applies the same staleness and process-exit rules to all of them (`normalizeSession` in `src/core/status.js`, mirrored in both extension variants).
- **OpenCode** pushes state from an in-process plugin (`src/adapters/opencode/plugin.js`).
- **Copilot CLI** is replayed from its event log by `node src/sync.js --watch` (`src/adapters/copilot/adapter.js`).
- **Producers of the event protocol** run `node src/hooks/hook.js event` (or use `src/protocol/sdk.js`); see [protocol.md](protocol.md). Their sessions are `@<agent>.<session>.json`.
- **Hook-based agents** (Claude Code, Codex CLI, Gemini CLI) run `node src/hooks/hook.js <agent>` for each hook event. The event JSON arrives on stdin, and the hook writes `<agent>_<session>.json`.

### Hook-based adapters

An adapter for a hook-based agent is a small pure module (`src/adapters/<agent>/hooks.js`) with:

- `id`, `name`, `bins` and `binEnv`, used for detection;
- `events`, the hook events to register;
- `config(command)`, which builds the settings block that `--print-config` prints;
- `toSignals(input)`, which maps one hook input to zero or more lifecycle signals.

It does no I/O and keeps no state. Everything else is shared:

| Part | File | Responsibility |
|---|---|---|
| Lifecycle contract | `src/core/lifecycle.js` | Signals, validation and the reducer that sets the status |
| Bridge | `src/hooks/bridge.js` | Bounded stdin (16 MiB), JSON parsing, finding the agent's pid, per-session lock, safe read and atomic write |
| Hook command | `src/hooks/hook.js` | Entry point; prints nothing and always exits 0 |
| Registry adapter | `src/adapters/hook-adapter.js` | `isAvailable()` (CLI on `PATH` or `*_BIN`), `detectSessions()` |

### Lifecycle signals

| Signal | Meaning | Status |
|---|---|---|
| `turn_start` | The user submitted a prompt | Cooking; waiting requests are cleared |
| `activity` | Reliable evidence of work | Cooking. It doesn't change Your Turn while a request waits, and doesn't change Done or Burn unless marked `revive` |
| `request_open` | A permission, question or elicitation waits for the user | Your Turn |
| `request_close` | That request was resolved | Cooking once no request is left |
| `turn_complete` | Documented successful end of the turn | Done |
| `turn_end` | The turn ended without a reported outcome | Your Turn (never Done) |
| `failure` | Documented failure | Burn |
| `cancel` | The user interrupted the turn | Your Turn (never Burn) |
| `session_end` | The session ended | The session file is removed (never Done) |

The reducer enforces these rules for every adapter:

- **Subagents never settle their parent.** A signal marked `subagent` that would complete, end, fail or cancel the turn counts as plain activity of the parent.
- **Late events cannot regress a settled turn.** Only a new prompt or a new request leaves Done or Burn.
- **Duplicates are idempotent.** A request resolved earlier is not reopened by a duplicate of its opening event. Adapters whose request ids repeat for identical tool calls opt out of this with `remember: false`.
- **Bookkeeping is bounded.** At most 32 waiting and 32 remembered requests are kept.
- **Input is validated.** Session ids must be safe file-name tokens, reasons are limited to 120 characters, and control characters are removed.

Hook processes run concurrently when tools run in parallel. A lock file (`.<agent>_<session>.json.lock`) serializes each read-modify-write. Waiting for it is capped at 1 s, after which the update proceeds without the lock, and a lock left by a crashed hook is broken after 10 s. The previous state is read with `O_NOFOLLOW`, and it is ignored unless it is a regular file owned by the user. The state directory must pass the same trust checks as the other writers.

The hook command is a pure observer. It prints nothing to stdout or stderr and always exits 0. For the agents covered here, that means it can neither block nor alter the agent. Each event costs roughly 70 ms, almost all of it Node.js startup.

## Claude Code

**Verified against:** the official hooks reference (https://code.claude.com/docs/en/hooks) and guide (https://code.claude.com/docs/en/hooks-guide), for the locally installed Claude Code 2.1.295. **Status:** implemented and fixture-tested; not run against the real CLI or verified in GNOME.

| Hook event | Signal |
|---|---|
| `UserPromptSubmit` | `turn_start` (neither the prompt nor the prompt-derived `session_title` is stored) |
| `PreToolUse` | `activity`, with `revive` for the main agent. `AskUserQuestion` also opens a `question` request |
| `PostToolUse`, `PostToolUseFailure`, `PermissionDenied` | Resolve the call's permission or question, then `activity`. `PostToolUseFailure` with `is_interrupt` is a `cancel` |
| `PermissionRequest` | `request_open` (`permission:<tool>`) |
| `Elicitation` / `ElicitationResult` | Open / resolve `elicitation:<server>` |
| `Stop` | `turn_complete`. It is documented not to fire on a user interrupt; API errors fire `StopFailure` instead |
| `StopFailure` | `failure` (`error:<documented error code>`) |
| `SubagentStart`, `SubagentStop`, and tool events carrying `agent_id` | Subagent `activity` of the parent session |
| `SessionEnd` | `session_end` |

Notes:

- **Permission ids.** `PermissionRequest` carries no `tool_use_id` (documented). A permission is therefore identified by the agent (main or the subagent's `agent_id`), the tool, and a SHA-256 digest of the tool input. The `PostToolUse`, `PostToolUseFailure` or `PermissionDenied` of the same call resolves it.
- **A denied permission stays shown.** No hook fires when the user denies a permission in the dialog, which stops the turn. The session stays Your Turn until the next prompt.
- **Subagents.** Subagents share the parent's `session_id`; that is an assumption based on local transcripts, not the docs. Their tool events carry `agent_id` (documented).
- **Esc while the model is thinking.** No hook fires when Esc is pressed while no tool is running. The session stays Cooking until it goes stale (Unknown after 5 minutes).
- **Continued turns.** Another `Stop` hook can make Claude continue its turn. The main agent's next `PreToolUse` then leaves Done (`revive`).
- **Mismatched input.** A different `PreToolUse` hook may rewrite a tool's input (`updatedInput`). The resolution then no longer matches the request, which stays shown until the turn ends.
- **Hooks run synchronously** (documented), so the order of events is kept. Parallel tool calls run their hooks concurrently; the bridge's lock covers that.
- **Process tracking.** The panel tracks the `claude` process found above the hook's shell. Once it exits, a Done or Burn session is removed and a Cooking or Your Turn session becomes Unknown.

## Codex CLI

**Verified against:**
- the official hooks documentation (https://learn.chatgpt.com/docs/hooks; https://developers.openai.com/codex/hooks redirects there);
- the openai/codex source at tag `rust-v0.160.1`: the input schemas in `codex-rs/hooks/schema/generated`, `hook_config.rs`, `discovery.rs` and `core/src/session/turn.rs`;
- `codex features list` on the installed CLI, which reports `hooks` as stable and enabled.

**Status:** implemented and fixture-tested; not run against the real CLI or verified in GNOME.

| Hook event | Signal |
|---|---|
| `UserPromptSubmit` | `turn_start` (a subagent's own prompt is subagent activity) |
| `PreToolUse` | `activity`, with `revive` for the main agent |
| `PermissionRequest` | `request_open` (`permission:<tool>`); like Claude Code, it is identified by its tool call |
| `PostToolUse` | Resolves the call's permission, then `activity` |
| `Stop` | `turn_complete`. Codex runs it only when a turn finishes normally; subagents run `SubagentStop` instead |
| `Interrupt` | `cancel` |
| `SubagentStart`, `SubagentStop`, and events carrying `agent_id` | Subagent `activity` |
| `SessionEnd` | `session_end` |

Limitations:

- **No Burn.** An errored turn ends without `Stop` and no hook reports the error. The session stays Cooking and becomes Unknown after 5 minutes. The error is only recorded in Codex's rollout files, which LetItCook does not read.
- **Questions are not shown.** `request_user_input` calls no hook.
- **Automatically reviewed permissions.** `PermissionRequest` runs before the Guardian auto-reviewer decides. An approval it grants on its own shows a brief Your Turn until the tool runs. One it denies stays shown until the turn ends.
- **Trust.** Codex runs a non-managed hook only after the user trusts it in `/hooks`, and asks again whenever the hook changes.
- **Login shell.** Hooks run through `$SHELL -lc`. A login profile that prints to stdout could produce output Codex rejects from `Stop` and `Interrupt` hooks. The LetItCook hook itself prints nothing.
- **Clean shutdown only.** `SessionEnd` runs only on a clean shutdown. A killed Codex leaves the session to the process-exit rule (Unknown, then removed after an hour).

## Gemini CLI (partial: never Done or Burn)

**Verified against:**
- the hooks documentation bundled with the installed Gemini CLI 0.56.0 (`bundle/docs/hooks/`, the same text as https://geminicli.com/docs/hooks/);
- the installed bundle itself, for the hook runner, `HookEventHandler`, the tool scheduler and the settings schema.

**Status:** implemented and fixture-tested; not run against the real CLI or verified in GNOME. Hooks are enabled by default (`hooksConfig.enabled`).

| Hook event | Signal |
|---|---|
| `BeforeAgent` | `turn_start` |
| `BeforeTool` | `activity`. It runs before the tool's confirmation, so it never resolves a request |
| `Notification` (`ToolPermission`, the only type) | `request_open`: `permission:<kind>`, or `question` for the `ask_user` tool |
| `AfterTool` | Resolves the waiting confirmation, then `activity` |
| `AfterAgent` | `turn_end`: Your Turn, **not** Done |
| `SessionEnd` | `session_end` |

Limitations:

- **No Done or Burn.** `AfterAgent` fires after a successful turn and also after API errors, loop detection, the turn limit, and a cancel while the model is streaming. It has no outcome field, so every finished turn shows Your Turn (and notifies), like Copilot's `assistant.turn_end`. Guessing the outcome from the response text would be unreliable.
- **Unanswered cancels stay Your Turn.** A cancel while a confirmation is open fires no hook. The session stays Your Turn until the next prompt.
- **Resolution by tool completion.** Notifications carry no tool call id, so any `AfterTool` resolves the waiting confirmation. That relies on the scheduler executing no tool of a batch while one of its calls awaits confirmation, which was verified in the 0.56 bundle. It does not hold for a subagent (`invoke_agent`) asking for confirmation while another tool of the parent's batch finishes, nor for a sandbox expansion request on a tool that is already running.
- **Subagents** run as the `invoke_agent` tool and their hooks carry no agent id. They show as the parent's activity.
- **Execution.** Hooks run synchronously through `bash -c`. Project-level hooks need a trusted folder; the user-level `~/.gemini/settings.json` is used here.

## Goose (deferred)

Goose 1.46 has documented lifecycle hooks: Open Plugins, `~/.agents/plugins/<name>/hooks/hooks.json`. Verified against https://goose-docs.ai/docs/guides/context-engineering/hooks/ and the `aaif-goose/goose` source at tag v1.46.0. The adapter is deferred anyway, because:

- **Approvals are invisible.** No hook fires while Goose waits for tool approval. `PreToolUse` fires only after a call is approved. In the approval modes, LetItCook would show Cooking while Goose actually needs the user, which is exactly the misleading state the status model forbids.
- **Stop has no outcome.** `Stop` fires at the end of every reply, including provider errors and cancellation, so it supports neither Done nor Burn.
- **The session database is internal.** Goose's SQLite store is undocumented as an interface and on schema version 16. It records no approval or error state. Reading it would also need a SQLite dependency on Node.js < 22.5.

A Goose adapter becomes reasonable once Goose exposes a hook for approval requests, or if LetItCook could reliably limit the adapter to the fully automatic mode.

## Integration categories

| Category | When | Status in LetItCook |
|---|---|---|
| **Native adapter** | The agent has official hooks or event logs with its own semantics | OpenCode, Copilot CLI, Claude Code, Codex CLI, Gemini CLI |
| **Event protocol** ([docs/protocol.md](protocol.md)) | A plugin, wrapper or the CLI itself can emit normalized events | Implemented; tested with the reference producer only |
| **Limited detection** | Only process or terminal output | Not offered: such evidence cannot support the states |

Every adapter, whatever its category, declares the outcomes it can report (`capabilities`: `requests`, `complete`, `fail`, `cancel`). The conformance suite checks each declaration against the adapter's events.

### Candidate CLIs (evaluated, not integrated)

These were evaluated as test cases for the protocol, from their official documentation and, for Cline, its installed package. None has been integrated or tested with LetItCook.

| CLI | Mechanism found | Can support | Missing |
|---|---|---|---|
| Qwen Code | Command hooks similar to Claude Code's (`UserPromptSubmit`, tool events, `PermissionRequest`, `Stop`, `StopFailure`, `SessionEnd`) | Cooking, Your Turn, Burn; Done only if "Stop without StopFailure" means success (undocumented) | A cancel event; per-event compatibility details |
| Cline CLI (3.0.60 installed) | File hooks named after events, with its own payload (`TaskStart`, `TaskComplete`, `TaskError`, `TaskCancel`, tool events) | Cooking, Done, Burn, cancel | No event when it waits for approval, so no Your Turn |
| Cursor CLI | `hooks.json` with `stop` reporting `completed`/`aborted`/`error` | Done, Burn, cancel | No event for a waiting approval; reports say the CLI fires only some hooks |
| Amp | Plugin API with `agent.end` reporting `done`/`error`/`cancelled` | Cooking, Done, Burn, cancel | No event for a waiting approval |
| Aider | `--notifications-command` when it waits for input | A turn end without outcome (`turn.ended`) | Everything else |
| Crush | Preliminary hooks, `PreToolUse` only | Cooking | Everything else |

Qwen Code is the closest to a native adapter; Cline, Cursor and Amp suit the event protocol through a plugin or hook script, minus Your Turn; Aider and Crush are limited detection.

## Adding an adapter

0. **Consider the event protocol first.** If you control a plugin, wrapper or the CLI itself, emit [protocol events](protocol.md) instead: no LetItCook code is needed. Write a native adapter only for an agent's own official hooks.
1. **Research.** Read the agent's documented lifecycle mechanism and record, for each state, the event that proves it. Keep verified facts and assumptions apart. If no trustworthy event exists for a state, do not emit that state.
2. **Write the mapping.** Add `src/adapters/<agent>/hooks.js` with a pure `toSignals(input)`. Read only identifiers from the input, never prompts, tool inputs or outputs, or messages.
3. **Register it.** Add it to `src/hooks/adapters.js` and to `createDefaultRegistry()` (`src/core/registry.js`).
4. **Add tests.** Put adapter-specific tests in `test/test-<agent>.js`. Add a spec to `test/test-adapter-conformance.js`, with a fixture for every scenario the agent has an event for, and `null` where it has none. The suite reports `null` scenarios as not applicable; it never assumes them.
5. **Document it.** Add a section to this file and the setup steps to the README.

Run `node test/test-adapter-conformance.js` for the shared checks, and `npm test` for everything.
