# AGENTS.md

# 🍳 LetItCook

**Project Type:** Personal Linux Desktop Utility  
**Status:** Pre-development / Research & Prototyping  
**Primary Platform:** Linux + GNOME  
**Primary UI:** GNOME Shell Top Panel  
**Initial Agents:** OpenCode, Goose  
**Deployment:** Local installation initially  
**Development Strategy:** Personal-first, generalize later

> Let your agents cook. We'll tell you when they're done.

---

## 1. Project Overview

LetItCook is a personal GNOME Shell extension for monitoring the state of AI coding agents while the developer works on other tasks.

AI coding agents such as OpenCode and Goose can perform development tasks autonomously through the terminal.

A typical workflow looks like:

Start AI agent  
↓  
Agent works autonomously  
↓  
User switches to another activity  
↓  
Agent continues working  
↓  
User periodically checks terminal  
↓  
Agent may still be working  
↓  
User checks again  
↓  
Agent may already be finished

The problem is not necessarily the agent itself.

The problem is **knowing when to look back at the agent**.

While an agent is working, the developer may want to:

- work on another project;
- browse documentation;
- read email;
- use Discord;
- research something;
- perform other development tasks;
- simply step away from the terminal.

Currently, the developer often has to manually switch back to the terminal to determine the agent's state.

This creates unnecessary context switching.

---

## 2. Core Idea

### LetItCook

> Let the agent cook.

The user should be able to start an AI coding agent, leave the terminal, and rely on a small visual indicator on the desktop to tell them when their attention is required.

Instead of repeatedly asking:

> Is the agent done yet?

the intended workflow is:

Start agent  
↓  
🍳 LetItCook  
↓  
Go do something else  
↓  
Indicator changes  
↓  
Your agent needs you  
↓  
Return to terminal

LetItCook is therefore an **attention indicator**, not another AI interface.

The core question the project should answer is:

> **Do I need to look at my agent right now?**

---

## 3. Project Philosophy

### Personal First

The first goal is to improve the developer's own workflow.

Do not prematurely optimize for:

- every Linux distribution;
- every desktop environment;
- every AI coding agent;
- marketplace distribution;
- commercial usage;
- generalized enterprise use.

The development loop is:

Personal problem  
↓  
Small implementation  
↓  
Use it  
↓  
Observe real friction  
↓  
Improve  
↓  
Generalize if useful

Actual usage should drive feature decisions.

Do not invent features simply because they appear technically interesting.

---

## 4. Platform

Primary platform:

Linux  
└── GNOME  
    └── GNOME Shell  
        └── LetItCook Extension

LetItCook is primarily a **GNOME Shell Extension**.

It does not require modifying the Linux kernel or operating system itself.

The initial deployment model is local installation.

The GNOME Extensions website is **not required** for development or personal use.

Local development may use:

`~/.local/share/gnome-shell/extensions/`

The project should prioritize the developer's current GNOME environment and Linux LTS versions, while remaining lightweight enough for older hardware.

---

## 5. Initial Agents

The initial target agents are:

1. OpenCode
2. Goose

Additional agents may be supported later.

Do not add agents merely to increase the supported-agent list.

A new agent should be added because it solves an actual workflow need.

---

## 6. Status Model

LetItCook uses the following user-facing terminology:

| Indicator | Status | Meaning |
|---|---|---|
| 🟡 | **Cooking** | Agent is actively working |
| 🟠 | **Your Turn** | Agent requires user interaction, permission, input, or a decision |
| 🟢 | **Done** | Agent finished successfully |
| 🔴 | **Burn** | Agent encountered an error or failed |
| ⚪ | **Unknown** | Agent state cannot be reliably determined |

The cooking metaphor is intentional.

Common lifecycle:

🟡 Cooking  
↓  
🟢 Done

or:

🟡 Cooking  
↓  
🟠 Your Turn

or:

🟡 Cooking  
↓  
🔴 Burn

`Unknown` must not automatically be treated as `Done`.

### Cooking

The agent is actively processing work.

### Your Turn

The agent needs the user's interaction, permission, answer, or decision.

### Done

The agent completed its work successfully.

### Burn

The agent encountered an error, failure, or unrecoverable execution problem.

### Unknown

LetItCook cannot reliably determine the current state.

---

## 7. Reliability

Correctness is more important than visual responsiveness.

Never assume:

- process alive = Cooking;
- process exited = Done;
- no event received = Done;
- state unavailable = Done.

If the state cannot be determined reliably, report:

⚪ Unknown

rather than inventing a state.

A false `Done` state is particularly dangerous because it may cause the developer to ignore an agent that actually requires attention.

---

## 8. State Detection

Prefer reliable lifecycle mechanisms in this order:

1. Official lifecycle/event mechanisms
2. Agent hooks
3. Local APIs
4. Local state files
5. Process information
6. Terminal/output parsing as a last resort

Avoid fragile terminal-output parsing when a more reliable mechanism exists.

Do not assume that a process being alive means the agent is `Cooking`.

Do not assume that a process exiting means the agent is `Done`.

---

## 9. Architecture

Keep agent-specific logic separated from the GNOME UI.

Conceptually:

LetItCook  
↓  
Normalized Agent State  
↓  
OpenCode Adapter / Goose Adapter  
↓  
OpenCode / Goose

The GNOME UI should consume normalized agent state rather than containing agent-specific implementation details.

A conceptual adapter may expose:

- `detect()`
- `get_status()`
- `get_session()`
- `get_last_activity()`

The exact interface is not predetermined.

Do not over-engineer the adapter architecture before multiple agents actually require it.

---

## 10. Local-First

LetItCook should operate entirely on the local machine.

Do not introduce:

- cloud infrastructure;
- user accounts;
- telemetry;
- cloud synchronization;
- unnecessary network communication.

Agent information may be sensitive.

If local HTTP communication is necessary, bind it to localhost rather than exposing it publicly.

No agent conversation content should leave the machine.

---

## 11. Performance

LetItCook should remain lightweight enough for older hardware.

Avoid:

- Electron;
- heavy desktop frameworks;
- unnecessary background processes;
- aggressive polling;
- excessive filesystem access;
- unnecessary network activity;
- continuous terminal-output processing.

Prefer event-driven mechanisms where practical.

Resource usage is a first-class consideration.

The extension should be something the developer can leave running without noticeably affecting the machine.

---

## 12. UI Principles

The primary UX goal is:

> **The developer should know whether they need to return to the agent without opening the terminal.**

The UI should therefore be:

- glanceable;
- minimal;
- low distraction;
- easy to interpret;
- consistent.

The primary UI is the GNOME top panel.

The indicator should communicate state before exposing additional details.

Do not turn LetItCook into a full dashboard unless real usage demonstrates a need for one.

---

## 13. Multiple Sessions

LetItCook may eventually monitor multiple agent sessions simultaneously.

Example:

OpenCode → Project A  
Goose → Project B  
OpenCode → Project C

Useful session identifiers may include:

- agent;
- project;
- working directory;
- session;
- elapsed time.

Only expose information that helps answer:

> **Do I need to go back to this agent?**

Do not expose excessive information merely because it is technically available.

---

## 14. Notifications

Notifications should primarily be useful for:

- 🟠 Your Turn
- 🔴 Burn

Normal 🟡 Cooking activity should not create notification noise.

Possible behavior:

Cooking  
→ No notification

Done  
→ Optional notification

Your Turn  
→ Notification

Burn  
→ Notification

Exact notification behavior should be determined through real-world usage.

---

## 15. Existing Projects

Existing projects should be treated as references and sources of ideas.

Relevant examples include:

- OpenCode Status Pill
- AgentLights
- codelight
- other AI-agent status/monitoring projects

Before implementing a major feature:

1. Check whether an existing project already solves it.
2. Understand its approach.
3. Determine whether the existing solution is sufficient.
4. Identify the actual gap.
5. Implement only if there is a meaningful reason.

Do not assume LetItCook needs to reproduce all functionality found in existing projects.

The existence of similar projects does not invalidate LetItCook.

The project should focus on the actual personal workflow and gaps discovered through use.

---

## 16. Development Strategy

Before implementing significant functionality:

1. Understand the existing implementation.
2. Research the relevant agent lifecycle mechanisms.
3. Prefer the smallest viable solution.
4. Test it in the actual personal workflow.
5. Record real friction.
6. Improve based on observed problems.

The project should follow:

Research  
↓  
Prototype  
↓  
Use  
↓  
Observe  
↓  
Improve

rather than:

Design everything  
↓  
Build everything  
↓  
Discover whether it is useful

---

## 17. Development Phases

### Phase 0 — Existing Tool Evaluation

Use existing tools such as OpenCode Status Pill.

Observe:

- status accuracy;
- UI usefulness;
- multiple sessions;
- notifications;
- stale states;
- resource consumption;
- suspend/resume behavior;
- terminal closure;
- misleading states.

Record anything that creates friction in the actual workflow.

### Phase 1 — Minimal GNOME Prototype

Create a basic GNOME Shell Extension.

Initial goal:

GNOME Top Panel  
↓  
🍳

No agent integration is required initially.

Goal:

> Validate local extension development, installation, enabling, and development/reload workflow.

### Phase 2 — OpenCode

Add OpenCode integration.

Implement:

- 🟡 Cooking
- 🟠 Your Turn
- 🟢 Done
- 🔴 Burn
- ⚪ Unknown

### Phase 3 — Personal Testing

Use LetItCook during normal development.

Test:

- short tasks;
- long tasks;
- multiple sessions;
- permission requests;
- questions;
- successful completion;
- failures;
- terminal closure;
- stale sessions;
- suspend/resume.

Record actual problems rather than hypothetical ones.

### Phase 4 — Goose

Investigate Goose lifecycle/event mechanisms and implement a Goose adapter.

### Phase 5 — Refinement

Improve only based on actual usage.

Possible areas:

- status accuracy;
- session identification;
- notifications;
- click-to-focus;
- resource usage;
- compatibility;
- installation experience.

---

## 18. Scope Control

Before implementing a feature, ask:

> **Does this directly help the developer know whether an agent needs attention?**

If not, it probably does not belong in the initial project.

Do not prioritize without demonstrated need:

- chat UI;
- prompt editing;
- remote agent control;
- analytics dashboards;
- AI-generated summaries;
- cloud synchronization;
- usage/billing analytics;
- unrelated productivity features.

The project should remain intentionally small.

---

## 19. Testing

Tests should prioritize state correctness.

At minimum, test:

- Cooking detection;
- Your Turn detection;
- Done detection;
- Burn detection;
- Unknown handling;
- session identification;
- stale state handling;
- agent disappearance;
- malformed or missing state;
- multiple simultaneous sessions.

Tests should verify observable behavior rather than implementation details wherever practical.

---

## 20. Error Handling

Never silently convert an error into `Done`.

Examples:

Agent unavailable  
≠ Done

State parsing failed  
≠ Done

No recent event  
≠ Done

Unknown session  
≠ Done

Prefer:

⚪ Unknown

unless an actual `Burn` condition is known.

An error in one agent adapter should not unnecessarily break the entire GNOME extension.

---

## 21. Security

Follow normal software security practices.

Important considerations:

- validate local input;
- avoid shell injection;
- avoid unsafe command construction;
- minimize filesystem permissions;
- do not expose local services publicly;
- protect authentication tokens if local APIs use them;
- avoid executing arbitrary agent-provided content;
- avoid trusting project names or paths as shell commands.

Treat agent state and working directories as potentially sensitive.

---

## 22. Dependencies

Keep dependencies minimal.

Before adding a dependency, ask:

1. Is it actually necessary?
2. Can the functionality be implemented using existing platform APIs?
3. Does it increase resource usage?
4. Does it complicate local installation?
5. Does it make the project harder to maintain on older systems?

Prefer standard GNOME/JavaScript APIs and lightweight local tooling where practical.

---

## 23. Git Workflow

Keep commits focused and understandable.

Prefer commit messages such as:

- `feat: add OpenCode status adapter`
- `fix: handle stale agent sessions`
- `feat: add Your Turn indicator`
- `test: cover Burn state detection`

Avoid mixing unrelated changes into one commit.

Do not rewrite history or perform destructive Git operations unless explicitly requested.

Do not commit:

- API keys;
- authentication tokens;
- local configuration;
- personal paths when unnecessary;
- machine-specific state;
- generated secrets.

---

## 24. Documentation

Keep documentation synchronized with actual behavior.

When a significant architectural or UX decision changes:

1. Update the relevant documentation.
2. Update `AGENTS.md` if development rules or project decisions change.
3. Avoid leaving contradictory instructions.

Clearly distinguish between:

- current behavior;
- planned behavior;
- research ideas.

Do not document hypothetical features as implemented functionality.

---

## 25. Definition of Done

A feature is complete when:

- it solves the intended problem;
- its behavior is tested;
- it does not introduce unnecessary complexity;
- it remains lightweight;
- it follows the local-first principle;
- it works in the developer's actual environment;
- documentation is updated when necessary.

For status-related features, correctness is more important than visual polish.

---

## 26. Current Project Direction

Current decisions:

**Project:** LetItCook

**Platform:** Linux + GNOME

**Implementation:** GNOME Shell Extension

**Initial agents:** OpenCode + Goose

**Deployment:** Local

**Priority:** Personal workflow

**Status model:**

- 🟡 Cooking
- 🟠 Your Turn
- 🟢 Done
- 🔴 Burn
- ⚪ Unknown

**Architecture:**

Agent adapters  
→ normalized state  
→ GNOME UI

**Development philosophy:**

Personal first  
→ real usage  
→ refine  
→ generalize if useful

---

## 27. Immediate Instructions for Coding Agents

When working on LetItCook:

1. Understand the current implementation before changing it.
2. Preserve the personal-first and local-first philosophy.
3. Prefer the smallest solution that solves the current problem.
4. Do not introduce unnecessary dependencies.
5. Do not over-engineer for hypothetical future requirements.
6. Prefer reliable lifecycle/event mechanisms over terminal scraping.
7. Never report an unknown state as `Done`.
8. Preserve the user-facing terminology:
   - `Cooking`
   - `Your Turn`
   - `Done`
   - `Burn`
   - `Unknown`
9. Test status transitions and failure cases.
10. Keep the GNOME UI agent-agnostic.
11. Keep agent-specific logic inside adapters.
12. Keep the project lightweight.
13. Do not introduce cloud services, telemetry, or accounts.
14. Do not publish or distribute anything unless explicitly requested.
15. Do not assume a feature is needed because another project has it.
16. Base feature decisions on actual workflow friction whenever possible.
17. Do not make destructive system, Git, or configuration changes without explicit instruction.
18. When uncertain about an architectural decision, inspect the existing code and relevant documentation before changing direction.

---

## 28. Guiding Principle

> **Let the agent cook. Don't babysit it.**

The purpose of LetItCook is not to make AI agents more powerful.

It is to make **waiting for them less annoying**.

When the agent is cooking, the developer should be free to do something else.

When it is done, needs the developer, or burns, LetItCook should make that obvious.