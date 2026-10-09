# LetItCook
Let your agents cook. We'll tell you when they're done.

GNOME Shell top-panel indicator for terminal-based AI coding agents:
🟡 Cooking · 🟠 Your Turn · 🟢 Done · 🔴 Burn · ⚪ Unknown

## Architecture

```
Agent → Agent Adapter → Normalized LetItCook State → GNOME Shell UI
```

The GNOME UI (`extension/`) is agent-agnostic: it only reads normalized
`{session_id, agent, status, ...}` JSON files from
`~/.local/state/letitcook/sessions/`. All agent-specific logic lives in
`src/adapters/<agent>/`. Adapters implement the `BaseAdapter` contract:
`detectSessions()`, `getSessionState()`, `start/stopMonitoring()`,
`normalizeState()` (see `src/adapters/base.js`, registry in `src/core/registry.js`).

## Supported agents

| Agent | Status | How state is detected |
|---|---|---|
| OpenCode | Supported | Official plugin (`src/adapters/opencode/plugin.js`) writes state files on `event` / `tool.execute.before/after` hooks |
| GitHub Copilot CLI | Supported | Adapter replays the documented session-event log (`~/.copilot/session-state/*/events.jsonl` + `workspace.yaml`); `src/sync.js` bridges normalized sessions into the state dir |
| Claude Code | Detected but unsupported | — |
| Gemini CLI | Detected but unsupported | — |
| Codex CLI | Detected but unsupported | — |
| Goose | Detected but unsupported | — |

See `AGENTS.md` §28 for per-state reliability notes.

## Commands

```bash
npm test          # all suites (state, adapters, integration, plugin, performance, lifecycle)
npm run sync      # one-shot: sync poll-based adapters (Copilot) into the state dir
node src/sync.js --watch [ms]   # repeat sync every ms (default 5000)

# reload the GNOME extension after changing extension/
# For GNOME 45+ (ESM):
cp extension/* ~/.local/share/gnome-shell/extensions/letitcook@letitcook.local/

# For GNOME 42–44 (Legacy):
cp extension-legacy/* ~/.local/share/gnome-shell/extensions/letitcook@letitcook.local/

# then: Alt+F2 → r (X11) or log out/in (Wayland), or:
gnome-extensions disable letitcook@letitcook.local && gnome-extensions enable letitcook@letitcook.local
```

For Copilot sessions to appear in the panel, `src/sync.js --watch` (or a
systemd user timer running `npm run sync`) must be running — Copilot has no
push-hook into LetItCook, so its event log is polled.
