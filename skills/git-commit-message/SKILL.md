---
name: git-commit-message
description: Generate convention-compliant Git commit messages. Trigger whenever the intent is to produce commit text (commit message/description), including "generate the commit description/message" after a batch of changes — even without the word "commit". Text only; never commits or pushes.
---

<!-- [2026-09-05]-[default output to English unless project rules/user explicitly request Chinese; generic examples]-[generated messages follow this default] -->
# Git Commit Message Generation

Core rule: **deliver text only; never run `git add` / `git commit` / `git push`**.

Language: **English by default**. Use the project's configured language when the project's rules (AGENTS.md etc.) explicitly specify one, or when the user explicitly requests it.

## Flow

### 1. Confirm the task ID (always first)

- Not provided → ask once ("task ID for this commit?"); never invent it
- User explicitly declines → omit the ID (only exception); don't re-ask within the same session

### 2. Analyze changes

Run as needed, not mechanically: `git status` (files changed), `git diff` / `git diff --cached` (content), `git log --oneline -5` (repo style). Reuse this conversation's context when available to run fewer commands.

### 3. Generate the message

**Subject** (concise, one line): `<type>(<task-id>): <what was done>`; without ID `<type>: <what was done>`. State the result, not the process; no trailing period.

type: `feat` / `fix` / `refactor` / `docs` / `test` / `perf` / `style` / `chore`.

**Body**: numbered points, usually 2~4 (1 if trivial); one key change per point, no diff restatement.

Example:

```
refactor(1024): Extract config parsing into loader module

1. Move inline parsing logic into config/loader.ts
2. Add validation for missing required fields
3. Extend tests to cover the new module
```

### 4. Stop after delivery

Present the message and stop; don't ask "want me to commit?". Commit/push only on explicit request.
