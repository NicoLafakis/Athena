# Stage 1: JEV integration

Approved by Nico, 2026-11-16.

- AC-1: Reconcile existing source-linked conversational continuity with current main without losing journal, librarian, investigation, voice or permission behavior. Prove with preserved regression suites.
- AC-2: Retain one pinned optional Jev client, 0.98 gates, local fallback and current-request-only boundary. Harden invalid response, lifecycle and scope cases with offline tests.
- AC-3: Keep all new payload scopes and features off. No live inference, real-history dogfood, credential inspection, paid evaluation, deployment or push.
- AC-4: Update the wiki and report independently reviewed results plus all four local gates on the exact candidate tree.

Change budget: continuity dependency closure, overlap repairs, docs and tests; maximum 150 changed files. Ask before exceeding.

Fixed decisions: Jev 1.13.0, SDK 0.6.0; no model upgrade. Existing current-request classification defaults off, including invalid settings. Use fake transport and network-impossible offline tests. Preserve both existing worktrees and their changes.

Non-goals: new payload scopes, credential creation, agreements, settings activation, live model evaluation, deployment or push. Integrating into main requires the six-job CI matrix mandated by AGENTS.md; absent CI, report blocker.
