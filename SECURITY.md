# Security Policy

LetItCook is a small, personal-first project maintained on a best-effort basis. This policy explains how to report a vulnerability and what is in scope.

## Supported versions

LetItCook has no versioned releases. Security fixes target the latest development version on the `main` branch. Older commits, forks and local copies are not maintained; please confirm an issue against current `main` before reporting it.

## Reporting a vulnerability

**Do not disclose vulnerability details in public GitHub issues, pull requests, discussions or commit messages.**

A verified private reporting channel has not been set up for this repository yet. GitHub private vulnerability reporting is not enabled for it at the time of writing, and there is no security contact address. Until a private channel is configured and documented here, contact the maintainer through a private channel you have already established with them, and say that you have a security report. If you have no such channel, you may open a public issue that only asks for a private contact. Do not include any technical details, affected files or proof of concept in that issue.

### What to include

- **Impact:** what an attacker can do, and under which conditions (for example, another local user, a malicious agent event, or a crafted session file).
- **Reproduction steps:** the LetItCook commit, GNOME Shell version and extension variant (`extension/` or `extension-legacy/`), the agent and its version, and the exact steps.
- **Sanitized logs or proof of concept:** remove tokens, API keys, prompts, conversation content, usernames and private paths first.
- **Possible mitigation:** a suggested fix or workaround, if you have one.

### What to expect

Reports are reviewed as the maintainer's availability permits. There is no guaranteed response time, fix timeline or disclosure date. If a report is confirmed, the fix is made on `main`, and the maintainer aims to agree on disclosure timing with you.

## Scope

LetItCook runs locally and reads state from AI coding agents. In-scope issues include:

- **Credential and token exposure:** secrets leaking into session files, notifications, menu rows, logs or test output; and the self-test's local server password.
- **Session files and symlinks:** following symlinks, hard links or swapped files in the state directory; deleting or overwriting the wrong file; path traversal through session IDs.
- **File permissions:** state directories, session files or the notification cache being readable or writable by other users, or trusted when owned by someone else.
- **Process execution and termination:** command or shell injection; the self-test starting, approving or signalling anything other than its own server and the exact test command.
- **Provider adapters:** the OpenCode plugin, the Copilot CLI adapter and sync bridge, and the Claude Code, Codex CLI and Gemini CLI hook adapters mishandling untrusted or malformed agent data.
- **Hook bridge and event protocol:** `src/hooks/hook.js`, `src/hooks/bridge.js` and `src/protocol/` accepting events that should be rejected, writing outside the state directory, or letting one producer affect another producer's or a native adapter's sessions.
- **Event handling:** crafted events that crash the plugin or the GNOME extension, block GNOME Shell's main thread, or produce a misleading state (for example a false `Done`).
- **Notifications:** text that escapes sanitization, such as hidden direction-control characters or unredacted credentials.
- **Logs:** prompts, credentials or full conversation data written to logs or the journal.

Out of scope:

- Vulnerabilities in OpenCode, GitHub Copilot CLI, Claude Code, Codex CLI, Gemini CLI, GNOME Shell, Node.js or other upstream software. Please report those to their maintainers.
- Attacks that already require control of your user account, or root access.
- Exposure caused by sharing your own unsanitized logs or session files.

## Security limitations

- LetItCook depends on the event, hook and session formats of the agents it integrates with: native adapters for OpenCode, GitHub Copilot CLI, Claude Code, Codex CLI and Gemini CLI, plus any producer of the generic event protocol. The Claude Code, Codex CLI and Gemini CLI adapters and the protocol have only been tested with synthetic fixtures and the reference producer. If an agent changes those formats, states may become inaccurate until the adapter is updated. LetItCook shows `Unknown` rather than guessing when it cannot interpret the data.
- Notification redaction covers common credential patterns only. It is not a guarantee that no sensitive text can appear.
- The GNOME extension is checked by automated tests against fakes; desktop behaviour is verified manually and not on every change.
