# LetItCook event protocol (v1)

A small, versioned protocol that lets any coding CLI, plugin or wrapper report its sessions to LetItCook. It needs no change to LetItCook's core, its lifecycle rules or the GNOME extension.

> **Status:** the protocol is implemented. It has been tested with synthetic events and with the bundled reference producer, which drives the real `hook.js event` command. Both GNOME extension variants have read its sessions under GJS. No third-party CLI has been verified with it, and the panel has not been checked by hand.

## When to use it

| Category | Use it when | Examples |
|---|---|---|
| **Native adapter** | The agent has official hooks or event logs with its own semantics. A native adapter maps them directly. | OpenCode, Copilot CLI, Claude Code, Codex CLI, Gemini CLI |
| **Generic protocol** (this document) | You control an integration (a plugin, extension, wrapper or the CLI itself) that can tell when a turn starts, waits for the user and ends. | A plugin for a CLI with a plugin API, a CLI's own code |
| **Limited detection** | Only process or terminal output is available. LetItCook offers nothing here: such evidence cannot support the states. | — |

Prefer a native adapter when the agent's own hooks carry the information; the protocol does not replace those.

## Non-goals

- **No transcripts.** The protocol never carries prompts, commands, tool input or output, model responses, or credentials.
- **No remote or multi-user reporting.** There is no network listener and no socket.
- **No control.** Nothing in an event is ever executed or used as a path.

## Transport

Two transports are available:

- **One command per event (any language).** Run this command with exactly one JSON event (at most 16 KiB) on stdin:

  ```
  node /path/to/LetItCook/src/hooks/hook.js event
  ```

  It prints nothing and always exits 0, so it cannot break the caller. An invalid event is dropped. Use `node src/protocol/validate.js` (below) to see why.
- **In-process (Node.js).** `src/protocol/sdk.js` builds events (ids, timestamps) and applies them in-process through the same code path.
  - Each call returns `{ ok: true }` when LetItCook applied the event.
  - Otherwise it returns `{ ok: false, error }`, with a schema error code, `ignored` (the rules above or an undeclared capability), `busy` (another writer held the lock) or `write_failed`.
  - `requestOpened()` returns the request id only when the request was applied, and `null` otherwise. Do not treat a `null` request as shown.

Both write through the shared hook bridge (`src/hooks/bridge.js`). It validates the event, takes the per-session lock, runs the shared lifecycle reducer and atomically writes the session file `@<agent>.<session_id>.json` in the private state directory. **The producer never chooses a path**, and the reserved `@` prefix cannot collide with native adapter files.

## Event

```json
{
  "schema": 1,
  "agent": "mycli",
  "session_id": "3f2c9a",
  "event_id": "3f2c9a-0007",
  "type": "request.opened",
  "time": 1792360000123,
  "turn_id": "t2",
  "request_id": "perm-41",
  "kind": "permission",
  "subject": "shell"
}
```

### Required fields

| Field | Format | Meaning |
|---|---|---|
| `schema` | integer `1` | Protocol version. Any other value is rejected. |
| `agent` | `^[a-z][a-z0-9-]{1,31}$` | Producer id, shown in the panel. The ids of native adapters and `unknown` are reserved. |
| `session_id` | `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` | Stable for the life of the session, and across restarts when the agent resumes it. |
| `event_id` | `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` | Unique within the session. A repeated id is ignored, so retries are safe. |
| `type` | see [Event types](#event-types) | Unknown types are ignored, for forward compatibility. |
| `time` | integer milliseconds since the Unix epoch | When the event happened, on the producer's clock. It must be within 24 hours before and 5 minutes after the receiving machine's clock. |

### Optional fields

| Field | Format | Used by |
|---|---|---|
| `turn_id` | Same format as `event_id` | Correlates a turn's events: see [Ordering](#ordering-and-duplicates). |
| `request_id` | Same format as `event_id` | **Required** for `request.opened` and `request.resolved`. Unique per request. |
| `kind` | `permission`, `question` or `input` | `request.opened` (default `permission`). |
| `outcome` | `approved`, `denied`, `answered` or `cancelled` | `request.resolved` (informational). |
| `subject` | identifier, up to 64 of `[A-Za-z0-9_.:-]` | What a request or activity is about, e.g. a tool name. It is shown as `permission:<subject>`. Never put a command here. |
| `error_code` | identifier | `turn.failed`, shown as `error:<code>`. |
| `subagent_id` | identifier | The event comes from a subagent of this session. |
| `parent_session_id` | Same format as `session_id` | The session is a child of another session. |
| `cwd` | absolute path, up to 4096 characters | Working directory shown in the panel. |
| `capabilities` | array of `requests`, `complete`, `fail`, `cancel` | Outcomes this producer can report: see [Capabilities](#capabilities). |
| `pid` | integer > 1 | The agent's process. When it exits, the session is no longer trusted. If absent, the process that ran the command is used. With the in-process SDK, the default is its own process. |

Any other field is ignored and never stored. **An event with a missing or invalid field is rejected as a whole**; it is never applied in part.

## Event types

| Type | State effect |
|---|---|
| `session.started` | No state of its own. Stores `capabilities` and `cwd` on an existing session. |
| `turn.started` | **Cooking**. A new user turn; it clears requests left from the previous turn. |
| `activity` | **Cooking**, if no request is waiting. It never leaves Done or Burn. |
| `request.opened` | **Your Turn** until the request is resolved or the turn ends. |
| `request.resolved` | Back to Cooking once no request is waiting. |
| `turn.completed` | **Done**: the turn succeeded. Send it only on reliable evidence of success. |
| `turn.failed` | **Burn**: the turn failed. Only for an explicit failure, never for stderr or an unclassified exit code. |
| `turn.cancelled` | **Your Turn** (`cancelled`): the user interrupted. A cancel is never Burn. |
| `turn.ended` | **Your Turn** (`turn ended`): the turn ended and the producer cannot tell how. It never claims Done. |
| `session.ended` | The session is removed. It never implies Done. |
| `subagent.started`, `subagent.stopped` | Activity of the session. A subagent never completes, fails or cancels its parent, and neither does any event that carries `subagent_id`. |

Silence and process exit are never evidence of anything:
- **Silence:** a session with no events for 5 minutes while Cooking is shown as Unknown.
- **Process exit:** once the agent's process exits, the session shows as Unknown, or is removed if it was Done or Burn.
- **No process:** a session with no process to watch is removed one hour after its last event.

## Ordering and duplicates

Events from one session may arrive late, twice or out of order, for example from concurrent hook processes. The reducer stays deterministic:

1. **Duplicates.** An `event_id` seen among the session's last 64 events is ignored.
2. **Turn correlation.** When events carry `turn_id`, a turn-ending event (`turn.completed`, `turn.failed`, `turn.cancelled`, `turn.ended`) or a `request.opened` for a turn other than the current one is ignored. A late completion of an earlier turn cannot mark the current one Done.
3. **Late turn events.** A `turn.started` or turn-ending event whose `time` is earlier than the last applied one of those is ignored.
4. **Events from before the turn ended.** Once the current turn has ended, a `request.opened` or `activity` whose `time` is earlier than that end is ignored. A late request cannot turn Done or Burn back into Your Turn, and late activity cannot turn an ended or cancelled turn (Your Turn) back into Cooking. Events sent after the end, and every event of a new turn, still apply.
5. **Resumed sessions.** A `session.ended` whose `time` is earlier than the last applied `turn.started` or turn-ending event comes from an earlier run of the session. It is ignored, so it cannot remove a session the producer resumed. An end without a preceding turn still removes the session.
6. **Requests.** A `request.resolved` that arrives before its `request.opened` is remembered, so the late opening is ignored. Activity never hides a waiting request. Request ids are ordinary keys: names such as `constructor` or `toString` behave like any other id.
7. **Settled turns.** Done and Burn change only on a new `turn.started` or `request.opened`.

`time` orders events; it never decides freshness. Staleness and retention use the receiving machine's clock at the moment each event is applied.

## Capabilities

A producer declares which outcomes it can report in `capabilities` on `session.started` or `turn.started`. The latest declaration is stored with the session. Once a producer has declared them, outcome events outside the declaration are ignored:

| Capability | Allows |
|---|---|
| `requests` | `request.opened` and `request.resolved` |
| `complete` | `turn.completed` |
| `fail` | `turn.failed` |
| `cancel` | `turn.cancelled` |

`turn.started`, `activity`, `turn.ended`, `session.*` and `subagent.*` are always allowed. A producer that cannot tell success from failure and cancellation declares none of `complete`, `fail` and `cancel`, and sends `turn.ended`. It then honestly shows Your Turn at the end of each turn instead of claiming Done. A producer that declares nothing is not restricted, but `validate.js` reports which states it actually produced.

## Limits

| Limit | Value |
|---|---|
| Event size | 16 KiB |
| Event time | At most 24 hours before or 5 minutes after the receiving machine's clock |
| Remembered event ids per session | 64 |
| Waiting requests per session | 32 |
| Remembered resolved requests per session | 32 |
| Validator input | 4 MiB |

## Trust model

- **What is protected:**
  - **Other users.** The state directory must be owned by the user and private (the existing trust checks); another user's process cannot write to it.
  - **Unsafe files.** Symlinks, hard links and files readable by others are refused or replaced.
  - **Paths.** Path traversal is impossible: identifiers are validated and file names are derived from them.
  - **Native sessions.** A producer cannot write a native adapter's session files: the agent ids are reserved and protocol files use the `@` prefix.
  - **Content.** Nothing is executed, and only identifiers and `cwd` are stored.
- **`pid` is not verified.** It only tells the panel which process to watch. A wrong `pid` can make a session look gone (Unknown) or keep it shown longer; it cannot produce Done or Burn.
- **What is not protected:** processes running as the same user. They can run the event command with any `agent` and `session_id`, or write the state directory directly, just as they can edit any of the user's files. LetItCook cannot tell same-user producers apart and does not try. Do not run untrusted code as your user.

## Onboarding a CLI

1. **Emit events.**
   - From a plugin, hook or wrapper: run `node <clone>/src/hooks/hook.js event` per event.
   - From Node.js: use `src/protocol/sdk.js`.
   - `examples/protocol-producer.mjs` is a runnable reference producer; it needs no model or API key.
2. **Validate.** Record the events as JSON Lines and run `node src/protocol/validate.js events.jsonl`. It reports rejected events and why, ignored events, the resulting state after each event, and the states the producer can reach. It writes nothing.
3. **Test.** Add a spec to `test/test-adapter-conformance.js`, or reuse the generic protocol spec there, and run `npm test`.
4. **Verify in the panel.** Run a real session and check the panel and notifications.
5. **Disable.** Stop emitting events. Existing sessions disappear when the producer sends `session.ended`, when the agent process exits, or one hour after their last event; you can also delete the producer's `@<agent>.*.json` files. Nothing else needs to be uninstalled.

## Versioning

`schema` is incremented only for incompatible changes. Within version 1, new optional fields and new event types may be added. Producers must not depend on them, and receivers ignore what they do not know. Removing or changing the meaning of a field requires a new schema version; the previous version is then kept for at least one release.
