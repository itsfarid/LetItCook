# Security Policy

LetItCook is a small, personal-first project maintained on a best-effort basis. This policy explains how to report a vulnerability and what is in scope.

## Supported versions

LetItCook has no versioned releases. Security fixes target the latest development version on the `main` branch. Older commits, forks and local copies are not maintained; please confirm an issue against current `main` before reporting it.

## Reporting a vulnerability

**Do not disclose vulnerability details in public GitHub issues, pull requests, discussions or commit messages.**

A verified private reporting channel has not been set up for this repository yet. Until one is configured and documented here, contact the maintainer through a private channel you have already established with them, and say that you have a security report. If you have no such channel, you may open a public issue that only asks for a private contact. Do not include any technical details, affected files or proof of concept in that issue.

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
- **Provider adapters:** the OpenCode plugin and the Copilot CLI adapter and sync bridge mishandling untrusted or malformed agent data.
- **Event handling:** crafted events that crash the plugin or the GNOME extension, block GNOME Shell's main thread, or produce a misleading state (for example a false `Done`).
- **Notifications:** text that escapes sanitization, such as hidden direction-control characters or unredacted credentials.
- **Logs:** prompts, credentials or full conversation data written to logs or the journal.

Out of scope:

- Vulnerabilities in OpenCode, GitHub Copilot CLI, GNOME Shell, Node.js or other upstream software. Please report those to their maintainers.
- Attacks that already require control of your user account, or root access.
- Exposure caused by sharing your own unsanitized logs or session files.

## Security limitations

- LetItCook depends on the event and session formats of the agents it supports (currently OpenCode and GitHub Copilot CLI). If an agent changes those formats, states may become inaccurate until the adapter is updated. LetItCook shows `Unknown` rather than guessing when it cannot interpret the data.
- Notification redaction covers common credential patterns only. It is not a guarantee that no sensitive text can appear.
- The GNOME extension is checked by automated tests against fakes; desktop behaviour is verified manually and not on every change.
