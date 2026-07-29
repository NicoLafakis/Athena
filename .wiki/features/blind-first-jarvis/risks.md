# Blind-first Jarvis upgrade - risk register

> [Objective overview](00-overview.md)

| Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|
| Treating one blind user's preference as universal | Medium | High | Several participants, varied AT/Braille, document study scope | Product |
| Screen-reader mode is technically clean but unusable for real coding | Medium | Critical | Core journey tests with blind developers before production claim | Product + accessibility QA |
| Announcement overload increases cognitive load | High | High | Silence by default, priorities, coalescing, verbosity, dogfood no-hit fixtures | Interaction layer |
| Athena sounds certain while runtime evidence disagrees | Medium | Critical | Runtime-over-agent invariant, provenance in `/status`, contradiction tests | Semantic core |
| Separate presentation drifts from TUI capabilities | Medium | High | Shared command handlers and parity matrix; no duplicated engine workflow | CLI/TUI |
| Permission prompt is missed, duplicated, or paired to wrong request | Low | Critical | Stable IDs, FIFO, blocking retention, integration tests, default deny | Permissions |
| Dynamic output behaves differently across terminals/AT | High | High | Append-only baseline and explicit support matrix; platform-scoped claims | Accessibility QA |
| New TUI chrome corrupts fullscreen frames | Medium | Critical | Avoid new panel; use precedence/budget chain and every-frame signatures | TUI |
| Secrets leak through summaries or direct speech | Medium | Critical | Reuse redaction, normalize targets, metadata-only observability, adversarial fixtures | Security |
| Project content manipulates accessible announcements | Medium | High | Typed events, sanitize control sequences, no untrusted priority fields | Security |
| Optional watcher/voice backend breaks boot | Medium | Critical | Best-effort verified probes and nonfatal recovery warnings | Harness |
| Persistent monitoring expands autonomy/privacy without consent | Medium | Critical | Foreground-first non-voice watches, explicit resource scope; voice daemon only through explicit `athena voice` | Product + security |
| Voice duplicates a screen reader | High | High | Direct speech off; ownership setting; separate phase and AT validation | Voice adapter |
| Existing Experiential Layer is duplicated or gains authority | Medium | High | Reuse its advisory IDs/events; permission/runtime authority remains separate | Architecture |
| Scope is too large to ship | High | High | Independently shippable phases; Phases 1-3 deliver accessible core | Program |
| Accessibility becomes a one-time audit | Medium | High | CI invariants, manual matrix on affected workflows, release checklist | Maintainers |
