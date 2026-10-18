# Contributing to LetItCook

This document describes how to work on LetItCook as a developer or collaborator.

## Quick start for contributors

```bash
# 1. Clone the repository
git clone https://github.com/anomalyco/LetItCook.git
cd LetItCook

# 2. Verify environment
node --version  # >= 20.0.0
gnome-shell --version  # 42–47

# 3. Run tests locally (no install required)
npm test

# 4. Make a change, then rerun the affected test(s)
# Example:
# node test/test-state.js && node test/test-copilot.js
```

## Repository structure

```
LetItCook/
├── extension/                 # ESM GNOME Shell extension (GNOME 45+)
│   ├── extension.js          # Main extension code
│   ├── metadata.json         # Extension metadata
│   └── stylesheet.css        # Panel styles
├── extension-legacy/         # Legacy GJS extension (GNOME 42–44)
│   ├── extension.js
│   ├── metadata.json
│   └── stylesheet.css
├── src/                      # JavaScript modules (Node.js backend)
│   ├── adapters/            # Agent-specific logic
│   │   ├── base.js         # BaseAdapter contract
│   │   ├── opencode/
│   │   │   ├── adapter.js  # OpenCode SessionState mapper
│   │   │   └── plugin.js   # OpenCode plugin hook implementation
│   │   └── copilot/
│   │       └── adapter.js  # Copilot session/event mapper and polling bridge
│   ├── core/
│   │   ├── fs-safe.js      # Filesystem hardening utilities
│   │   ├── notification.js # Notification eligibility and deduplication
│   │   ├── registry.js     # AdapterRegistry for discovery and aggregation
│   │   └── status.js       # Status constants, session normalization, aggregation
│   ├── sync.js              # Copilot session sync bridge (poll-based)
│   └── notify.js            # Notification inspection tool
├── test/                     # Test suites (11 files, no dependencies)
│   ├── test-state.js         # Status normalization, aggregate, adapter contract
│   ├── test-base-adapter.js
│   ├── test-copilot.js       # Copilot session/state mapping, reliability
│   ├── test-plugin.js       # OpenCode plugin hook integration & sessions
│   ├── test-integration.js  # End-to-end workflows (scenarios)
│   ├── test-lifecycle.js     # Start/stop/reload behavior
│   ├── test-notification.js # Notification eligibility logic
│   ├── test-notification-integration.js
│   ├── test-filesystem-hardening.js
│   ├── test-performance.js   # Debouncing, syslog bursts
│   └── test-extension-compatibility.js
├── package.json              # Tool + test scripts (no package manager)
├── AGENTS.md                 # Development philosophy and scope (read-only reference)
├── README.md                 # User-facing documentation
└── CONTRIBUTING.md           # This file
```

## Development workflow

### 1. Understand the problem before implementing

- Read [AGENTS.md §27](AGENTS.md#27) for guiding principles (personal-first, not prematurely optimized).
- If adding support for an agent, review `src/adapters/opencode/plugin.js` (Uplink event hook example) and `src/adapters/copilot/adapter.js` (session-state replay example).
- Identify the most reliable lifecycle mechanism reported by the agent documentation before falling back to terminal parsing.

### 2. Make small, focused changes

- Prefer smallest fix that solves the current problem.
- Keep changes testable and reviewable. One commit per logical change (e.g., one adapter variant, one notification condition).
- Avoid premature abstractions (e.g., a new interface when only one adapter exists).

### 3. Write tests before or alongside code

- Every change must have at least one passing test (unit or integration) unless transformationally trivial.
- New adapter functionality: include basic contract tests (`detectSessions`, `getSessionState`, `normalizeState`, `syncToStateDir`).
- New UI behavior (status transitions, notifications): add or update `test-notification*.js` assertions.

Test command:

```bash
npm test                  # Run all (≈ 40s)
node test/test-state.js       # State normalization
node test/test-copilot.js     # Copilot behavior
node test/test-plugin.js      # OpenCode plugin
```

### 4. Validate with GNOME (optional but recommended)

After editing `extension/`:

```bash
cp extension/* ~/.local/share/gnome-shell/extensions/letitcook@letitcook.local/
gnome-extensions reload letitcook@letitcook.local
# Open extension dropdown; verify indicator matches expectations.
```

**No destructive reload required** unless override settings are changed.

### 5. Self-check before committing

- All test suites pass: `npm test`.
- No unintended side effects (race conditions, missed edge cases).
- No new dependencies beyond Node.js stdlib and existing agents.
- No private data in log output or tests.

## State-machine and notification regression expectations

### Status transitions that cannot be invented

- `session.idle` must not become `Done` without a prior `assistant.completed` signal.
- Process disappearance must never promote `Cooking`/`Your Turn` to `Done`.
- Missing state or malformed JSON must resolve to `Unknown`, not `Done`.
- `session.shutdown` with error/reason must resolve to `Burn` or `Unknown`, never `Done`.

### Notification deduplication memo

- `notify_cache.json` tracks `lastStatus`, `notifiedStatus`, and `notifiedAt`.
- Notification dispatch must check cache first; audits via `node src/notify.py --watch [ms]` or `node src/notify.js`.
- Do not add "dispatch" CLI flags; they create race conditions with the GNOME extension. Bug: fetches cover read-only inspection, no CLI auto-dispatch.

### Older GNOME compatibility

- `extension/` (ESM/legacy metadata) supports GNOME 45–47.
- `extension-legacy/` (GJS with ExtensionUtils) supports GNOME 42–44.
- Do not claim cross-version support beyond these ranges.

## Agent adapter development

### Creating a new adapter (e.g., ForAgentX)

1. **Create directory**: `src/adapters/ForAgentX/`
2. **Implement `adapter.js`**:
   - Extend `BaseAdapter`.
   - `isAvailable()`: check for CLI, config, or environment variable.
   - `detectSessions(options)`: scan agent-provided data (e.g., DB, output files) and return array of `{ session_id, agent, status, reason, cwd, title, pid, created_at, updated_at, confidence }`.
   - `syncToStateDir(targetDir, options)`: optional if adapter is push-based; otherwise adopt polling via `src/sync.js`.
   - `getSessionState(sessionId, options)`: read one session from source.
3. **Register adapter**: `src/core/registry.js` import from your module and call `registry.register(new ForAgentXAdapter())`.

### State normalization

- Use `normalizeSession(raw, options)` from `src/core/status.js` for consistency.
- Session IDs must pass regex: `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`; sanitize via `assertValidSessionId` before writing to state dir.
- File path: strictly avoid `$HOME` expansion and shell interpolation; always use `process.env.LETITCOOK_STATE_DIR` (default `~/.local/state/letitcook/sessions`) with type-safe joins.

### Filesystem and permissions

- Session directory: mode 0700, owned only by the current user.
- Session files: mode 0600, single-link (nlink=1). Use `fs-safe.js` utilities for hardening.
- Delete terminated files (Done/Burn/Unknown) automatically via GNOME extension `_update()` cleanup, but do not assume arbitrary deletion without verified termination status.

### Copilot bridges

- Use `src/sync.js --watch [ms]` to poll Copilot’s session-state. Do not attempt push hooks from Copilot.
- Adapter implements `syncToStateDir(targetDir, options)` to stream events into `{copilot_<session_id>.json}` under targetDir.
- Use `DEFAULT_STALE_MS` and `maxAgeMs` in adapter to prune stale sessions per guidance documented in `src/adapters/copilot/adapter.js`.

## Security and concurrency guidelines

1. **Validate all inputs from agents or external sources**:
   - Session IDs: strict regex.
   - Paths: use `fs-safe.js` and GNOME Gio APIs.
   - PIDs: verify via `/proc` for alive checks.

2. **Never trust agent-provided command strings or execution payloads** (e.g., tool invocations). Execute only via approved safe helpers or gated approvals.

3. **Log only structural data** (status, reason, durations). Never log prompts, credentials, or full conversation JSON. For precision, use structured fields rather than `console.log`.

4. **Notification deduplication is trust boundaries**:
   - Cache creation: strict permissions checks (0600, nlink=1).
   - JNI: do not simulate emission or dispatch from Node.js; rely solely on GNOME extension.

5. **Graceful degradation**:
   - Errors in one adapter should not abort the whole GNOME UI.
   - Untrusted state (confidence: low) should not trigger notifications.

## Bug reporting

### Minimal bug report

Provide:

- **GNOME Shell version**: `gnome-shell --version`
- **Agent CLI version** (if relevant): OpenCode/Copilot CLI versions
- **LetItCook version**: `git describe --tags --always`
- **Reproduce steps** (commands, agent start flags)
- **Observed behavior**: panel indicator + log snippets from GNOME Shell (Error Log via Alt+F2 → r and `journalctl --user -f` while triggering).
- **Expected behavior**: expected indicator / notification
- **Configuration**:
  - Paths to state dir: `ls -lR ~/.local/state/letitcook/sessions/`
  - Copilot: `ls ~/.copilot/session-state/` (if applicable)
- **Environment**:
  - Distribution + Window System: e.g., Ubuntu 24.04, X11
  - Replacement scripts: `~/.local/state/letitcook/notify_cache.json` permissions
- **Logs**: direct `node src/notify.js --include-done` output and any error logs from the extension.

### Development-specific bug reports

For adapter issues:

- Attach `events.jsonl` dump (sanitized) and `workspace.yaml` for Copilot.
- Include before/after state from `readAllSessionsFromDir()` and the adapter’s raw functions.

For UI/notification issues:

- Capture `node src/notify.js --include-done` transitions snapshot before rewriting `notify_cache.json`.

For security/persistence concerns:

- Attach exact sequences of `fs*Sync` calls being bypassed (aka not using `fs-safe.js` or GNOME hardening calls) and root cause.

## Pull request checklist

Before submitting a PR:

- [ ] All tests pass: `npm test`.
- [ ] Changes are small and focused (one logical change per PR).
- [ ] New code includes unit or integration tests that cover the change.
- [ ] No new dependencies added (unless absolutely necessary and justified).
- [ ] Documentation updated (no external links unverified; internal links point to existing files/sections).
- [ ] No sensitive data (tokens, private paths, prompts) in test output or commit history.
- [ ] Security constraints: input validation and filesystem hardening are intact.

## Beyond code

- Run manual integration test: start agent, verify indicator/dropdown/menu inside GNOME, ensure Copilot polling runs (`src/sync.js --watch 5000`) and notifications are deduplicated. If anything creates friction (battery drain, CPU spikes, stale states due to race), document it as a primary improvement goal rather than a secondary polish item.
- Update `AGENTS.md` sections if project philosophy changes (no fabrication of unverified roadmap or marketing claims).

## Development philosophy (from AGENTS.md)

1. Personal-first: verify with real usage before generalizing.
2. Reliability over responsiveness: never report `Unknown` as `Done`.
3. Minimal dependencies: stay within Node.js stdlib and GNOME APIs.
4. Security first: treat session data as potentially sensitive; restrict filesystem permissions, validate inputs, avoid shell injection.

If you're unsure whether a feature belongs in the codebase, ask: "Does this help the developer know whether they need to go back to the agent right now?" If the answer is not an unambiguous yes, either simplify or omit.

## Contact / Discussion

- Issue tracker: GitHub Issues (if enabled).
- Pull requests: merge after maintainer review.
- No code of conduct or contribution workflow via external links unless explicitly present; manage all paths through GitHub.

---

Use this guide alongside [AGENTS.md](AGENTS.md) for development philosophy and status semantics. Link back to [README.md](README.md) for installation and architecture overview.