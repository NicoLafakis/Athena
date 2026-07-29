# Blind-first Jarvis upgrade - implementation plan

> [Objective overview](00-overview.md) | [PRD](prd.md) | [Design](design.md) |
> [Test strategy](test-strategy.md) | [Rollout](rollout.md)

Work one phase at a time. Each numbered task is independently reviewable and includes a
done condition. Write failing tests before implementation for behavior changes. Any
specific modification to existing TUI look/feel requires Nico's explicit approval before
editing under the active Global Rule.

## Phase 0 - co-design and executable fixtures

- [ ] **0.1 Confirm product defaults** - update
  `docs/discovery/decision-ledger.md` - done when Q-001 through Q-003 are answered or
  explicitly retained as defaults, and the worked story in `build-spec.md` still matches.
- [ ] **0.2 Recruit representative evaluators** - non-code - done when several
  experienced blind developers across more than one screen reader are scheduled and the
  study scope avoids claiming statistical generality.
- [ ] **0.3 Record baseline journeys** - new
  `tests/fixtures/interaction/core-journeys.json` plus research notes - done when auth,
  broad objective, status, tools, permission, child/background, failure, interrupt,
  resume, and completion sequences are represented.
- [ ] **0.4 Freeze vocabulary** - new `src/interaction/vocabulary.ts` test fixture only,
  no production use yet - done when participants can distinguish Status, Attention,
  Permission, Advisory, Completed, Failed, and Blocked without position or color.

## Phase 1 - semantic truth plane

- [x] **1.1 Add versioned contracts** - create `src/interaction/types.ts` and
  `src/interaction/schemas.ts`; test `tests/interaction/types.test.ts` - done when all
  externalized envelopes, snapshots, attention items, outcomes, and announcements reject
  malformed/oversized payloads.
- [x] **1.2 Implement per-run sequencing** - create
  `src/interaction/event-adapter.ts`; test duplicates, ordering, parent/child isolation -
  done when each accepted runtime event has a stable run ID, monotonic sequence, source,
  timestamp, and source reference.
- [ ] **1.3 Make permission lifecycle adapter-neutral** - create
  `src/presentation/types.ts`; modify `src/engine/loop.ts`, `src/tui/App.tsx`, and
  composition in `src/cli.ts`; tests in `tests/engine/` and `tests/tui/` - done when the
  current Ink queue still behaves identically and request/resolution events are observable
  outside React. The engine/event-adapter half is complete: paired, stable, redacted
  `permission-requested`/`permission-resolved` events now drive exact blocking attention
  outside React, including headless default-deny. The presentation contract and existing
  Ink queue migration remain pending. **Frontend approval gate applies before editing
  `App.tsx`.**
- [x] **1.4 Implement pure reducer** - create `src/interaction/state.ts`; test every
  fixture after every event - done when snapshots are deterministic and runtime/user
  precedence over agent assertions is mechanically enforced.
- [x] **1.5 Add replay/invariant property tests** - create
  `tests/interaction/state-property.test.ts` - done when duplicate, malformed,
  out-of-order, and contradictory sequences cannot create verified facts without runtime
  evidence or cross run boundaries.
- [x] **1.6 Attach trace metadata** - modify `src/harness/traces.ts` only through the
  existing redaction/hash-chain path; test verification - done when transitions have
  reducer version and source sequences without duplicated raw content.
- [x] **1.7 Wire passive composition subscriber** - modify `src/cli.ts` and
  `src/engine/index.ts` as needed - done when the subscriber emits no presentation output,
  existing TUI/text/JSON/JSONL behavior remains compatible, semantic transitions reach
  the redacted trace, and full repository gates pass.

## Phase 2 - attention and announcement policy

- [x] **2.1 Implement priority mapping** - create
  `src/interaction/announcements.ts`; tests from the category table - done when routine
  events are silent and blocking/error/complete cases map deterministically.
- [x] **2.2 Implement coalescing and acknowledgement** - create
  `src/interaction/announcement-store.ts`; test changed target/count/severity/action -
  done when unresolved blocking items cannot be evicted or hidden by routine events.
- [x] **2.3 Add redacted formatters** - create `src/interaction/format.ts`; reuse
  `redactSessionValue` through an extracted shared safe primitive if necessary; test
  secret-shaped strings and control sequences - done when messages are bounded, plain,
  and no untrusted ANSI control survives.
- [ ] **2.4 Add local state controls** - extend `src/tui/slash.ts`, slash menu, and shared
  handlers for `/status`, `/repeat`, `/details`, `/verbosity`; tests in `tests/tui/` and
  `tests/cli/` - done when commands use zero model calls and work outside fullscreen.
  **Frontend approval gate applies before modifying visible menus/components.**
- [x] **2.5 Add semantic JSONL events** - modify `src/cli.ts`; test schema and ordering -
  done when additive envelopes are machine-readable and existing result events remain
  compatible.
- [x] **2.6 Enforce performance/bounds** - add deterministic 20k-event replay benchmark
  and character/count caps - done when the budgets in `nfr-budgets.md` pass or a measured
  exception is documented.

## Phase 3 - append-only screen-reader presentation

- [x] **3.1 Add global accessibility settings** - modify `src/brain/settings.ts` with
  deep defaults and project-override rejection; tests in `tests/brain/settings.test.ts` -
  done when legacy settings parse and partial objects cannot erase defaults.
- [ ] **3.2 Add CLI selection** - modify argument parsing/help in `src/cli.ts`; tests in
  `tests/cli/args.test.ts` - done when `--accessibility screen-reader|standard` overrides
  global settings for one invocation and invalid values fail clearly.
- [ ] **3.3 Implement line adapter** - create `src/presentation/screen-reader.ts` and
  `src/presentation/line-input.ts`; integration tests capture raw bytes - done when output
  is append-only, contains no prohibited escape sequences, and prompt/announcement lines
  never corrupt each other.
- [ ] **3.4 Cover pre-TUI authentication and session selection** - reuse the existing
  `WizardIO` seam in `src/auth/wizard.ts`; add a line-oriented session selector beside
  `SessionPicker` and select it from `src/cli.ts` - done when first-run provider/key
  setup, `--resume`, no-session, cancel, and invalid-choice flows work without Ink,
  animated selection, or per-character `*` output that floods speech; secrets remain
  hidden and are never announced.
- [ ] **3.5 Implement accessible permission presentation** - create
  `src/presentation/permission-format.ts`; reuse existing diff logic through a
  presentation-neutral helper; tests for queue/order/detail/deny - done when all choices,
  target, consequence, reason, and detail route are available without sight.
- [ ] **3.6 Add accessible cancellation/resume** - modify adapter-neutral input and engine
  handoff; tests for busy, waiting-permission, idle, and aborted states - done when every
  interrupt gets explicit acknowledgement and no dead prompt remains.
- [ ] **3.7 Add feature-parity matrix** - create
  `tests/fixtures/interaction/presentation-parity.json`; test handlers rather than visual
  frames - done when every interactive command is reachable by key or slash/CLI path in
  screen-reader mode.
- [ ] **3.8 Run manual Windows cohort** - NVDA and Narrator in Windows Terminal - done
  when all core journeys pass, versions/settings are recorded, and blocking issues are
  converted to regression fixtures.
- [ ] **3.9 Run blind-user production gate** - moderated evaluation - done when no core
  journey requires sighted intervention and the ledger/verbosity defaults reflect the
  findings.

## Phase 4 - outcome orientation and deterministic proactivity

- [x] **4.1 Add bounded agent status assertions** - create a `StatusUpdate` tool or extend
  the existing Todo contract only after an alternatives review; tests prove assertions
  cannot set verified outcomes - done when objective/next step can be richer without
  weakening truth precedence.
- [x] **4.2 Repeated-failure detector** - reuse the canonical
  [Experiential Layer component](experience.md) rather than forking it; key by run and
  normalized tool input - done when the
  unchanged second failure emits one advisory and meaningful input change resets it.
- [x] **4.3 Verification-invalidation detector** - create
  `src/interaction/detectors/verification.ts`; consume successful gate and later mutation
  events - done when Athena never continues to claim stale gate success after relevant
  edits.
- [x] **4.4 Budget detector** - consume `RunBudget` snapshots at 75% and 90% thresholds -
  done when each threshold announces once and exact costs/tokens remain available on
  demand rather than unsolicited.
- [x] **4.5 Child/background aggregation** - create deterministic aggregation over child
  status and background task events - done when routine progress coalesces and
  failure/limit/awaited completion is never lost.
- [ ] **4.6 Dogfood attention quality** - add positive and deliberate no-announcement
  fixtures from real traces - done when each detector has evidence of usefulness and no
  loop/spam regression before default enablement.

## Phase 5 - Experiential Layer

- [ ] **5.1 Implement the canonical Experiential Layer component** - follow
  [experience.md](experience.md); keep its store outside `src/interaction/` - done when
  deterministic capture/retrieval, provenance, approval, no-hit, privacy, and context
  budgets pass.
- [ ] **5.2 Define advisory event seam** - add metadata-only experience/guidance IDs,
  confidence, and signal kind to interaction events - done when retrieved prose is not
  duplicated in trace metadata and remains labeled advisory.
- [ ] **5.3 Map qualifying guidance to attention** - only active guidance and thresholded
  midstream signals - done when it can recommend, avoid, stop-if, or switch-if but cannot
  deny/approve tools or override runtime facts.
- [ ] **5.4 Cross-system evaluation** - replay irrelevant, contradictory, stale, and
  helpful experiences - done when unrelated turns remain quiet and current runtime
  evidence wins every conflict.

## Phase 6 - foreground monitoring

- [ ] **6.1 Confirm watcher resources** - update decision ledger and threat model - done
  when the approved resources, consequence of missed events, and stop model are explicit.
- [ ] **6.2 Add watch contracts/store** - create `src/harness/watchers/` with Zod,
  atomic writes, stable IDs, resource-policy scope, and recoverable disable - done when no
  watch exists without explicit user action.
- [ ] **6.3 Implement foreground `athena watch`** - modify CLI and reuse semantic policy -
  done when the process stays foreground, announces material events, and has a documented
  stop/recovery command.
- [ ] **6.4 Add real capability probes** - platform-gated integration tests must actually
  exercise the backend - done when `doctor` never reports availability from a hard-coded
  literal or executable/platform inference.
- [ ] **6.5 Prove nonfatal failure** - fault-inject unavailable backend, corrupt optional
  state, and shutdown race - done when normal Athena boot/use continues and each warning
  names artifact, backend, and recovery command.
- [ ] **6.6 Cross-platform dogfood** - Windows/macOS/Linux foreground runs - done when
  idle resource/privacy budgets pass and Nico decides separately whether a daemon is
  warranted.

## Phase 7 - optional voice component

- [ ] **7.1 Implement the canonical voice component** - follow [voice.md](voice.md) and
  consume `InteractionSnapshot`/`Announcement` instead of inventing a second digest truth
  model - done when code and docs have one voice architecture and one state authority.
- [ ] **7.2 Run the plan's capability/cost spike and resolve current API contracts** - use
  only official OpenAI docs for the supported Realtime model and wire schema; do not pin
  the older draft's `gpt-realtime-2` without re-verification - done when audio, wake word,
  model, cost, privacy, latency, and licenses are proven or fail with a concrete report.
- [ ] **7.3 Implement speech output adapter** - consume `Announcement`, not raw events -
  done when exclusive/supplemental ownership avoids duplicate routine speech and all
  controls retain keyboard/Braille parity.
- [ ] **7.4 Implement optional speech input** - translate into normal prompts/commands -
  done when recognition failure loses no state and confirmation is required for
  consequential ambiguity.
- [ ] **7.5 Manual AT/voice validation** - test with actual screen readers enabled and
  disabled - done when voice improves measured workflows and can be entirely removed
  without reducing capability.

## Documentation and release closure for every phase

- [ ] Update affected `.wiki/` mechanism pages and `.wiki/INDEX.md` in the same commit.
- [ ] Update CLI help, keybindings, support matrix, and recovery commands.
- [ ] Run targeted tests, then `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build`
  on the exact state intended for push.
- [ ] Stage only the phase's specific files; never use `git add -A` or `git add .`.
- [ ] Do not push or publish without Nico explicitly saying "push it" or "go live."
