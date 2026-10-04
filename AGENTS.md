# AGENTS.md

## Project

**Name:** LetItCook

**Purpose:** Personal GNOME Shell extension for monitoring the state of AI coding agents while the developer works on other tasks.

> Let your agents cook. We'll tell you when they're done.

LetItCook is initially a personal project. The primary goal is to improve the developer's own workflow before considering broader OSS distribution.

---

# 1. Core Problem

AI coding agents such as OpenCode and Goose can work autonomously in terminal sessions.

While an agent is working, the developer often switches to another application and loses visibility into the agent's state.

The primary problem is:

> **How can the developer know whether an agent needs attention without switching back to the terminal?**

LetItCook should provide a small, glanceable status indicator in the GNOME top panel.

The project is an **attention indicator**, not another AI interface.

---

# 2. Project Philosophy

## Personal First

Build for the developer's own workflow first.

Do not optimize prematurely for:

- general users;
- every Linux distribution;
- every desktop environment;
- every AI coding agent;
- marketplace distribution;
- commercial usage.

The development loop is:

```text
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