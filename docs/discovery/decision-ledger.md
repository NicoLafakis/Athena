# Blind-first Jarvis upgrade - decision ledger

**Status:** draft for founder confirmation
**Last updated:** 2026-07-29
**Canonical technical package:** [objective overview](../../.wiki/features/blind-first-jarvis/00-overview.md)

This is the project memory for product decisions and engineering defaults. `answered`
rows come from Nico's volunteered framing. `inferred` rows come from repository artifacts.
`assumed-default` rows are software-mechanism decisions that let planning proceed without
turning an unanswered choice into an invisible requirement.

## Decisions and assumptions

| ID | Question (plain language) | Status | Decision | Source | Why it matters / unblocks | Revisit trigger |
|---|---|---|---|---|---|---|
| D-001 | What does "behaves like Jarvis" mean? | answered | Athena acts as a trusted technical chief of staff: understands outcomes, maintains situational awareness, surfaces material changes, coordinates work, and preserves human control. | founder-said: "upgrade athena so that she behaves like Jarvis" plus the volunteered blind-user exercise (2026-07-29) | Defines the product job rather than a voice or visual effect. | Nico narrows Jarvis to a different job. |
| D-002 | Why design for a blind person? | answered | Blind-first use is a forcing function for a truly semantic, conversational system; it is not shorthand for voice-only operation. | founder-said: "developing this for someone who were blind" (2026-07-29) | Makes hidden visual assumptions testable. | User research changes the product framing. |
| D-003 | Who is the primary first-release persona? | assumed-default | An experienced blind software developer using a keyboard, screen reader, and possibly refreshable Braille. | agent-default: Athena is a coding harness and W3C recommends matching participant expertise to the product audience. | Sets journey depth and recruitment profile. | Research identifies a different primary user. |
| D-004 | What architecture keeps every interface consistent? | assumed-default | A semantic state and announcement contract feeds the fullscreen TUI, append-only screen-reader mode, JSONL, and future voice. | agent-default: prevents each renderer from inventing state, priority, and truth. | Unblocks module boundaries and test strategy. | A smaller standardized terminal semantic API becomes available. |
| D-005 | Should Athena detect that a screen reader is running? | assumed-default | No. Screen-reader presentation is explicitly selected by the user. | agent-default: avoids brittle/privacy-invasive inference and follows Athena's capability-proof rule. | Unblocks settings and startup behavior. | A standardized, consented terminal capability negotiation exists. |
| D-006 | What output contract should screen-reader mode use? | assumed-default | Append-only, non-animated, keyboard-complete, color-independent output without the alternate screen. | agent-default: stable text supports speech, Braille, scrollback, logs, and deterministic tests. | Unblocks presentation design. | Cross-AT testing proves a better equally stable contract. |
| D-007 | What happens when Athena's narration conflicts with runtime evidence? | assumed-default | Runtime facts win. Every claim is sourced as runtime, user, or agent; agent assertions cannot mark mutations, gates, or completion verified. | agent-default: false confident status is a critical trust failure. | Establishes the load-bearing invariant. | Never; only the exact representation may evolve. |
| D-008 | Is voice the accessibility foundation? | assumed-default | No. Voice is a planned opt-in adapter over the semantic state plane and must avoid double-speaking over a screen reader. | agent-default: blind developers commonly use keyboard, speech, and Braille; direct speech can conflict with AT. | Keeps accessible operation complete even when voice/API/audio is unavailable. | Research establishes voice as the only required primary modality, which would require explicit confirmation. |
| D-009 | How proactive is Athena outside an active run? | assumed-default | The tracked voice daemon is explicit and opt-in. Non-voice watchers begin foreground-first; no monitoring process starts from ordinary `athena` boot. | agent-default reconciling the voice plan with Athena's optional-hardening and consent constraints. | Unblocks daemon/watch lifecycle and boot invariants. | Nico approves an always-on non-voice watcher service. |
| D-010 | Can accessibility or experience guidance bypass safety? | inferred | No. Existing permissions, trust, sandbox, traces, and governed-learning controls remain authoritative. | artifact: `AGENTS.md`, current `PermissionEngine`, and Experiential Layer plan. | Preserves Athena's security boundary. | A separate approved security architecture supersedes it. |
| D-011 | Where does relevant past experience come from? | inferred | The Experiential Layer component in the canonical Jarvis package; this project does not create another retrieval or memory store. | reconciled artifact: `.wiki/features/blind-first-jarvis/experience.md`; historical PDF removed under D-018. | Prevents duplicate memory authority and implementation. | The component is explicitly rejected or redesigned. |
| D-012 | Who controls accessibility preferences? | assumed-default | They are global user settings; project settings cannot override them. | agent-default: a repository must not disable or manipulate the user's assistive presentation. | Unblocks settings precedence and threat model. | The user explicitly requests a per-project override model. |
| D-013 | Does routine state reporting use another model call? | assumed-default | No. State, progress, and routine announcements are deterministic and local. | agent-default: they must work during provider failure, keep local `/status` below the 100 ms p95 budget, and add no model cost. | Unblocks NFR and architecture. | A separately approved summarizer proves bounded value and safe fallback. |
| D-014 | What proves accessibility quality? | assumed-default | Automated invariants plus recurring manual validation with several blind users across the supported AT matrix. | agent-default informed by W3C and Microsoft accessibility testing guidance. | Unblocks release gates. | The matrix changes; the combined method remains. |
| D-015 | What failure should the draft prioritize before Nico answers the pre-mortem? | assumed-default | Guard equally against excessive interruption, false confidence, and an accessible mode that cannot complete real work. | agent-default: these are the highest-impact failures found by internal pre-mortem. | Nico answers Q-003. |
| D-016 | Is there already a voice architecture to reuse? | inferred | Yes. Preserve its opt-in daemon, wake word, Realtime conductor, engine-session router, permissions, and phased control channel inside this package, with the semantic plane as its only state authority. | reconciled artifact: `.wiki/features/blind-first-jarvis/voice.md`; historical commit `3bc1ce6`. | The canonical voice component is superseded. |
| D-017 | Which Realtime model is pinned in the implementation plan? | assumed-default | Do not freeze the older draft's `gpt-realtime-2` choice now. Resolve and explicitly configure a supported current model during the voice spike; official docs currently list `gpt-realtime-2.1` and `gpt-realtime-2.1-mini`, both with audio and function calling. | agent-default from official OpenAI model docs checked 2026-07-29. | Immediately before the voice spike or when OpenAI model availability changes. |
| D-018 | Which upgrade plan survives the remote sync? | answered | The blind-first Jarvis package is the only source of truth. Fold useful voice and experiential decisions into component pages here, remove their standalone artifacts, and update every inbound reference. | Nico: "make sure that YOUR version of this upgrade is the only one that survives" (2026-07-29). | Resolves competing roadmaps and authorizes documentation reconciliation. | Nico explicitly designates another canonical plan. |
| D-019 | Which implementation sequence is active? | default-applied | Build the semantic truth plane first, while keeping voice as a later opt-in adapter over that authority. | active user objective: "complete the blind-first-jarvis upgrade" plus the Q-001 recommended default (2026-07-29). | Lets implementation proceed without making voice or an external audio dependency foundational. | Nico explicitly directs voice to lead or the semantic seam proves insufficient. |

## Priority-ranked open questions

| ID | Question (plain language) | Status | Decision | Source | Why it matters / unblocks | Revisit trigger |
|---|---|---|---|---|---|---|
| Q-001 | Which milestone should lead: the semantic/screen-reader foundation or the voice capability spike? | default-applied | Ship the semantic truth plane before conversational status and voice permissions; the audio/probe spike remains independently schedulable. | D-019 | The voice conductor needs trustworthy state summaries; sequencing determines the critical path. | Nico explicitly selects a different order. |
| Q-002 | Which screen-reader and platform combinations must pass before the first production claim? | open | Recommended default: Windows Terminal with NVDA and Narrator first; VoiceOver/macOS and Orca/Linux before a cross-platform claim. | - | Sets recruitment, hardware, and release scope. | Before Phase 3 support claim. |
| Q-003 | It is three months after launch and this flopped - what happened? | open | - | - | The founder-facing pre-mortem identifies the risk that should reorder the rollout gates. | Before final dogfood thresholds. |

## Coverage audit

| Category | Rating | Evidence / remaining gap |
|---|---|---|
| 1. Purpose and value | Clear | D-001/D-002 and build-spec purpose. |
| 2. Actors and roles | Partial | Primary persona defaulted in D-003; Q-002 shapes the tested cohort. |
| 3. Core workflows | Clear | Walking skeleton plus ten manual journeys. |
| 4. Domain vocabulary | Clear | Build-spec glossary distinguishes fact, assertion, state, announcement, advisory, AT, and watcher. |
| 5. Data and lifecycle | Clear | Ephemeral snapshot, trace authority, privacy map, settings retention, and recoverable watcher removal are specified. |
| 6. Permissions and visibility | Clear | Filled actor/action matrix and D-010/D-012. |
| 7. Failure and edge outcomes | Clear | Every R-001 through R-012 has a paired failure; rollout runbook covers adapter, permission, watcher, and noise failure. |
| 8. Money and viability | Clear / N/A | Phases 1-5 add no paid service or model call; any voice service requires a later cost decision. |
| 9. Scale and criticality | Partial | NFR bounds exist; Q-001 determines semantic-versus-voice sequencing. |
| 10. Integrations | Clear | Existing systems and the canonical Realtime/wake-word/session-routing component are defined; model choice is resolved at the voice spike. |
| 11. Existing state and transition | Clear | Existing TUI/settings remain default; migration and rollback are additive. |
| 12. Scope fences and priority | Partial | Phase fence is explicit; Q-001 decides semantic-versus-voice sequencing. |
| 13. Completion signals | Partial | Automated/manual release gates exist; Q-003 may reorder dogfood success thresholds. |

## Session log

### 2026-07-29

- Nico volunteered D-001: "upgrade athena so that she behaves like Jarvis."
- Nico volunteered D-002 as a forcing exercise: imagine developing Athena for someone
  who is blind.
- Research and repository inspection produced D-003 through D-015 as declared defaults or
  artifact inferences. No option-picked founder answer has been recorded yet.
- The remote voice plan was discovered after the first draft. D-008/D-009 were
  reconciled and D-016/D-017 added rather than duplicating or dismissing that work.
- After sync, Nico selected this package as the only surviving upgrade plan (D-018).
  Useful voice and experiential decisions were folded into component pages and the two
  standalone artifacts were removed.
- The active completion objective applied the recommended semantic-first default (D-019).
  Phase 1 implementation began with contracts, runtime adaptation, deterministic state,
  and trace provenance; Q-002 and Q-003 remain open before their respective release gates.
