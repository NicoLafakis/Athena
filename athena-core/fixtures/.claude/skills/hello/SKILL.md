---
name: hello
description: Minimal Athena Phase 0 fixture skill used to prove that the Claude Agent SDK discovers skills from a .claude/skills directory loaded via settingSources. Use when asked to run the hello skill or to verify skill discovery.
---

# Hello (Athena Phase 0 fixture skill)

This skill exists only to prove that the Claude Agent SDK discovers skills from a
`.claude/skills/` directory that is loaded via `settingSources: ['project']`.

When asked to run the hello skill, respond with exactly this marker and nothing
else:

`ATHENA_HELLO_SKILL_OK`
