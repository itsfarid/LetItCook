# LetItCook

Attention indicator for AI coding agents running in the terminal.
GNOME Shell top-panel indicator: 🟡Cooking · 🟠Your Turn · 🟢Done · 🔴Burn · ⚪Unknown

LetItCook listens to agent events (OpenCode plugin hooks, Copilot CLI event logs) and writes normalized session state files to a shared state directory. The GNOME Shell extension reads these files to update the panel indicator and handle notifications.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-&gt;=20.0.0-brightgreen.svg)](https://nodejs.org/)
[![GNOME](https://img.shields.io/badge/GNOME-42--47+-blue.svg)](https://www.gnome.org/)

## What problem does LetItCook solve?

While an AI coding agent works autonomously, you may switch to another activity (browse documentation, read email, use Discord, research, or another coding task). You don't want to repeatedly interrupt your workflow to ask "Is the agent done yet?"

LetItCook answers that question for you without opening the terminal.

## Supported agents

| Agent | Status | State source |
|---|---|---|
| OpenCode | ✅ Supported | Official plugin events (event, tool.execute.before/after hooks) writing to state dir |
| GitHub Copilot CLI | ✅ Supported | Session-event log replay (`~/.copilot/session-state/*/events.jsonl` + `workspace.yaml`) via polling |
| Claude Code, Gemini CLI, Codex CLI, Goose | ⚠️ Detected but unsupported | No adapter yet |

See [AGENTS.md §28](AGENTS.md#28) for per-state reliability notes and scope limitations.

## Installation

### Prerequisites

- **OS / Desktop**: Linux with GNOME Shell (42–47)
- **Agent CLI**: One of the supported agents must be installed
- **Node.js**: Version 20.0.0 or later (only for development)

### For GNOME Shell 45+ (ESM extension)

```bash
# 1. Obtain the repository
git clone https://github.com/anomalyco/LetItCook.git
cd LetItCook

# 2. Copy files to your extensions directory
mkdir -p ~/.local/share/gnome-shell/extensions/
cp -r extension/* ~/.local/share/gnome-shell/extensions/letitcook@letitcook.local/

# 3. Enable the extension
# Option A: GNOME Extensions app (if installed)
# Option B: From the terminal
gnome-extensions enable letitcook@letitcook.local

# 4. Reload GNOME Shell (if not using GNOME Extensions app)
# X11 session:
# Alt + F2 → type: r → Enter
# Wayland session:
# Log out and log back in, or use nested shell for testing
```

### For GNOME Shell 42–44 (Legacy extension)

```bash
# Same as above, but:
cp -r extension-legacy/* ~/.local/share/gnome-shell/extensions/letitcook@letitcook.local/
gnome-extensions enable letitcook@letitcook.local
```

### Copilot CLI setup (if using GitHub Copilot CLI)

Copilot sessions appear in the panel only when `node src/sync.js --watch` (or a systemd timer) runs. Start it once:

```bash
node src/sync.js --watch 5000
```

For persistent operation, run it as a systemd user service or Cron job.

## Configuration and data locations

| Path | Data | Generated / User-editable | Safe to delete |
|---|---|---|---|
| `~/.local/state/letitcook/sessions/` | Session state files (`{session_id}.json`, `copilot_{session_id}.json`) | Generated on first start | Sessions are recreated from adapter sources |
| `~/.local/state/letitcook/notify_cache.json` | Notification state (deduplication, notify-on-Done toggle) | Generated on first start | Deleting it resets notification state (opt-out) |
| `~/.copilot/` | Copilot CLI state | Copilot-generated | Do not delete Copilot state unless you want to restart Copilot completely |

**Default paths can be overridden via environment variables:**

- `LETITCOOK_STATE_DIR`: Override state directory (default: `~/.local/state/letitcook/sessions`)
- `LETITCOOK_COPILOT_DIR`: Override Copilot home (default: `~/.copilot`)

## Status model

The indicator shows which agent most needs your attention:

| Status | Indicator | Meaning |
|---|---|---|
| Cooking | 🟡 | Agent is actively working (executing tools, streaming messages) |
| Your Turn | 🟠 | Agent requires your input, approval, or permission |
| Done | 🟢 | Agent finished successfully (seen via explicit session metadata) |
| Burn | 🔴 | Agent encountered a fatal error or unrecoverable failure |
| Unknown | ⚪ | Evidence is insufficient, inconsistent, or ambiguous |

### Important limitations

- `Unknown` is **not automatically** treated as `Done`. If we cannot reliably determine the state, we postpone the decision.
- `Done` requires explicit session/task-complete events. Idle sessions without prior completion candidates are reported as `Unknown`.
- Any agent disappearance (dead PID, missing state) reveals `Unknown`, never an assumed `Done`.
- Multiple simultaneous sessions: the most urgent/active session determines the panel indicator.

## Notifications

GNOME desktop notifications are handled exclusively by the extension. States that trigger notifications:

| State | Notified automatically | Can opt out |
|---|---|---|
| Your Turn | ✅ Yes | No |
| Burn | ✅ Yes | No |
| Done | ✅ Yes | No (toggle: "Notify on Done" in panel menu) |
| Cooking / Unknown | ❌ No | Not applicable |

Notification deduplication uses `notify_cache.json` to prevent duplicate alerts across:
- State file writes
- Poll intervals
- Extension reloads

Verification:

```bash
node src/notify.js                # - Reads current sessions (read-only)
node src/notify.js --include-done  # - Include Done transitions in inspection
node src/notify.js --test          # - Send one manual test notification via notify-send
```

## Architecture

### Event flow

```
┌─────────────────┐
│  OpenCode CLI   │
│  Copilot CLI    │
└────────┬────────┘
         │ (events, logs)
         ▼
┌─────────────────┐
│ Agent Adapter   │
│ (opencode/,     │
│  copilot/)      │
└────────┬────────┘
         │ (normalized session JSON)
         ▼
┌─────────────────┐
│ State Directory │
│ ~/.local/state/ │
│ letitcook/      │
│ sessions/       │
└────────┬────────┘
         │ (file system monitor + polling)
         ▼
┌─────────────────┐
│ GNOME Shell     │
│ Extension       │
│ (extension/,    │
│  -extension.js) │
└────────┬────────┘
         │ (top panel indicator + popup menu)
         ▼
┌─────────────────┐
│  User Interface │
└─────────────────┘
```

### Implementation notes

- OpenCode writes state files directly via its plugin hooks (`event`, `tool.execute.before/after`). No CLI bridge needed.
- Copilot CLI is poll-based. `node src/sync.js` repeatedly replays its session-event log into the state directory. The Copilot adapter cannot push; the polling script bridges to the shared state dir.
- GNOME monitors state directory changes (directory monitor) and falls back to periodic polling (2-second interval).
- Notifications are evaluated per-session with state transitions (from last-seen status).
- Filesystem hardening: directories are created with mode 0700, session files with mode 0600. Node.js fs-safe and GNOME Gio both enforce strict ownership checks to prevent hijacking.

## Development setup

### Prerequisite checks

```bash
# Verify Node.js
node --version  # Should be >= 20.0.0

# Verify GNOME Shell (if testing directly)
gnome-shell --version
```

### Install dependencies

No external dependencies required (uses only Node.js standard library and GJS built-ins). Still:

```bash
npm install  # (no packages installed; kept for potential future additions)
```

### Run tests

```bash
npm test
```

Runs 11 test files covering:

- State normalization and aggregation
- Adapter contract and session discovery
- Copilot session/event mapping
- OpenCode event/tool-hook mapping
- Integration scenarios (OpenCode plugin, Copilot polling)
- Filesystem operations and hardening
- Notification eligibility and deduplication
- Performance (debouncing, syslog bursts)
- Lifecycle behavior (start/stop/reload)
- GNOME extension compatibility

Each command is an independent test. Ready-to-run assertions are included in every file; manual verification required only for GUI state changes.

### Development workflow

1. **Editable files**: only `extension/*`, `extension-legacy/*`, `src/*`, `test/*`. No build step.

2. **Test after change**:

   ```bash
   npm test                  # Full suite
   node test/test-state.js        # State normalization
   node test/test-copilot.js      # Copilot adapter
   node test/test-plugin.js    # OpenCode plugin integration
   ```

3. **Reload GNOME extension** (after editing `extension/`):

   ```bash
   cp extension/* ~/.local/share/gnome-shell/extensions/letitcook@letitcook.local/
   gnome-extensions reload letitcook@letitcook.local
   ```

4. **GUI validation**: open extension dropdown, observe indicator, check popup menu and notifications.

### Tool reference

| Command | Purpose |
|---|---|
| `npm test` | Run all test suites |
| `node src/sync.js` | One-shot sync Copilot sessions into state dir |
| `node src/sync.js --watch [ms]` | Poll Copilot every `[ms]` (default ping 5000) |
| `node src/notify.js` | Inspect notification transitions (read-only) |
| `node src/notify.js --include-done` | Include Done transitions in inspection |
| `node src/notify.js --test [status]` | Send manual test notification |
| `node src/notify.js --dispatch` | Refused (deprecated; causes race conditions) |

## Troubleshooting

### "Extension not appearing or not enabled"

- **Cause**: Copied files to wrong directory or GNOME Extensions app disabled it.
- **Check**:
  ```bash
  ls -la ~/.local/share/gnome-shell/extensions/letitcook@letitcook.local/
  ```
- **Fix**:
  ```bash
  killall gnome-shell  # to reload extension metadata cleanly
  gnome-extensions enable letitcook@letitcook.local
  ```

### Indicator stuck at 🟡 or ⚪

- **Cause**: Agent adapter has no recent events or state files are stale. OpenCode: missing plugin hooks; Copilot: no sessions in `~/.copilot/session-state/`.
- **Check**:
  ```bash
  node src/notify.js  # printed events/count
  ls ~/.local/state/letitcook/sessions/
  ls ~/.copilot/session-state/
  ```
- **Fix**: Start the agent again; verify Copilot `src/sync.js` is running if using Copilot.

### "Done" not appearing after task completes

- **Cause**: Agent did not emit explicit session/task-complete with `success: true`. Idle-only state is never inferred to `Done`.
- **Check**:
  ```bash
  node src/notify.js --include-done
  cat ~/.local/state/letitcook/sessions/*.json
  ```
- **Fix**: Check your agent settings. For OpenCode, verify `assistant.summary` presence; for Copilot, expect `session.task_complete { success: true }`.

### Notification missing for Your Turn / Burn

- **Cause**: Notification dispatcher is disabled, cache says already-notified, or notification cache permissions broken.
- **Check**:
  ```bash
  ls -l ~/.local/state/letitcook/notify_cache.json
  node src/notify.js
  ```
- **Fix**: Remove `notify_cache.json` if stale (optional). Ensure notify-send is installed and configured.

### Agent adapter not loading or OpenCode plugin nonexistent

- **Cause**: Agent not installed or plugin disabled via `~/.opencode/config.json`.
- **Check**:
  ```bash
  which opencode copilot
  cat ~/.opencode/config.json | grep -i plugin
  cat ~/.opencode/config.json | grep -p 'letitcook\|opus\|log'
  ```
- **Fix**: Install agent CLI. Verify OpenCode bookkeeping: `opencode opus config list | grep -i logger` and ensure the plugin writes to `$LETITCOOK_STATE_DIR`.

### Modern/legacy compatibility failing

- **Cause**: Running ESM extension on GNOME 42–44 or vice versa.
- **Check**:
  ```bash
  gnome-shell --version
  ls ~/.local/share/gnome-shell/extensions/letitcook@letitcook.local/metadata.json
  cat ~/.local/share/gnome-shell/extensions/letitcook@letitcook.local/metadata.json | grep -E '"shell-version"'
  ```
- **Fix**: Install the matching variant (`extension/` for GNOME 45+, `extension-legacy/` for 42–44).

### Stale session state or duplicate notifications

- **Cause**: Old session files not cleaned; notify_cache too permissive.
- **Fix** (careful):
  ```bash
  # Backup first (optional)
  killall gnome-shell  # unload extension to pause writes

  # Cleanup (safe to delete No longer needed sessions)
  rm ~/.local/state/letitcook/sessions/*~

  # Reset notifications after reload
  rm ~/.local/state/letitcook/notify_cache.json
  ```

## Security and privacy

- All code is local-first. No network requests, telemetry, or cloud sync.
- Session state files are stored with restricted permissions (0600 for files, 0700 for directories).
- Input validation: session IDs are sanitized (regex `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`), file paths are validated, shell commands are avoided.
- Logging never prints prompts, credentials, or sensitive agent messages. Structured agents and plugins must sanitize outputs before passing state to LetItCook.
- GNOME extension notifications are delivered via the native GNOME notification system; no CLI dispatch to avoid race conditions.
- No external dependencies. If new dependencies are added, only standard Node.js and safe open-source packages should be used.

## Project status

- **Published?**: No. Local installation only.
- **Supported GNOME versions**: 42–47 (legacy and ESM variants available).
- **Agent adapters implemented**: OpenCode, GitHub Copilot CLI.
- **Development focus**: Personal workflow validation. No roadmap promises.

## License

MIT

---

For development guidelines, contributing workflow, and agent adapter design principles, see [CONTRIBUTING.md](CONTRIBUTING.md). For lifecycle, status semantics, and security notes, see [AGENTS.md](AGENTS.md).