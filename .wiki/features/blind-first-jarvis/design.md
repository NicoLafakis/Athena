# Blind-first Jarvis upgrade - technical design

> [Objective overview](00-overview.md) | [PRD](prd.md) |
> [Product requirements](../../../docs/discovery/build-spec.md) |
> [Implementation tasks](tasks.md)

## Approach

Introduce one deterministic interaction layer between Athena's operational events and
its presentations. It owns live state, evidence precedence, attention classification,
deduplication, and concise announcements. It does not own model reasoning, permissions,
traces, memory, or visual layout.

The initial accessible surface is a separate append-only interactive adapter. The
existing Ink TUI continues to consume raw events while gradually adopting semantic state.
This keeps the accessible path independent of fullscreen row budgeting and avoids a
large-bang renderer rewrite.

## Architecture

```text
User input
   |
   v
Engine / tools / agents / permissions / background tasks
   |                 (authoritative runtime events)
   v
InteractionEventAdapter ---- optional agent StatusUpdate assertions
   |                                      |
   +------------------+-------------------+
                      v
             InteractionStateReducer
                      |
              InteractionSnapshot
                      |
             AnnouncementPolicy
        (priority, coalesce, redact, retain)
          /           |           |          \
         v            v           v           v
  existing Ink   screen-reader   JSONL    future voice/
      TUI         line adapter             notifications

RunTraceWriter stores source events + semantic metadata references
Experience retrieval remains advisory and separate
```

## Module boundaries

### `src/interaction/types.ts`

Versioned contracts:

```ts
type InteractionSource = 'runtime' | 'user' | 'agent'
type RuntimePhase =
  | 'idle'
  | 'thinking'
  | 'acting'
  | 'waiting-permission'
  | 'waiting-user'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'limited'

interface Provenance {
  source: InteractionSource
  runId: string
  sequence: number
  sourceEventType: string
  sourceEventId?: string
}

interface InteractionEventEnvelope {
  schemaVersion: 1
  id: string
  runId: string
  sequence: number
  timestamp: string
  source: InteractionSource
  kind: InteractionEventKind
  payload: unknown
  sourceRef?: string
}

interface InteractionSnapshot {
  schemaVersion: 1
  runId: string
  objective: Sourced<string | null>
  phase: Sourced<RuntimePhase>
  activity: Sourced<Activity | null>
  attention: AttentionItem[]
  lastVerifiedOutcome: Sourced<Outcome | null>
  nextExpected: Sourced<string | null>
  updatedAt: string
}

type AnnouncementPriority = 'silent' | 'polite' | 'assertive' | 'blocking'

interface Announcement {
  schemaVersion: 1
  id: string
  runId: string
  priority: AnnouncementPriority
  category: string
  text: string
  detail?: string
  dedupeKey: string
  requiresAcknowledgement: boolean
  provenance: Provenance[]
  createdAt: string
}
```

All user-controlled strings have explicit length caps. Zod schemas validate persisted or
externalized forms. Pure internal reducer input may use TypeScript exhaustiveness, but
JSONL and watch definitions must parse through Zod.

### `src/interaction/event-adapter.ts`

Subscribes to `EngineEventBus` and receives adapter-neutral permission lifecycle events.
It assigns a monotonic per-run sequence and maps renderer-oriented events into semantic
facts. Mapping is conservative:

| Source event | Semantic fact |
|---|---|
| `turn-start` | phase `thinking` |
| `tool-request` | phase `acting`; current tool summary |
| `tool-result` success | verified tool outcome; phase returns to `thinking` |
| `tool-result` error | attention item; phase returns to `thinking` unless blocked |
| permission requested | phase `waiting-permission`; blocking attention item |
| permission resolved | remove item; resume prior runtime phase |
| `run-limit` | phase `limited`; assertive announcement |
| fatal `error` | phase `failed`; blocking/assertive announcement |
| `turn-done` | phase from `RunResult`, never agent prose |
| background completion | polite or assertive depending on result |
| child status | aggregate child count; announce failures/limits, coalesce routine status |

Assistant text does not become verified state. A model may provide a bounded status
assertion through a future `StatusUpdate` tool, but it remains `source: agent` until a
runtime event confirms it.

### `src/interaction/state.ts`

A pure reducer with no I/O, clock, model, or renderer dependencies. The caller supplies
timestamp and sequence. Precedence rules:

1. Later runtime fact for the same field.
2. Later explicit user statement.
3. Agent assertion only where no contradicting runtime/user fact exists.

Agent assertions may enrich `objective` and `nextExpected`; they cannot set permission
resolution, tool success, verified completion, or resource mutation.

The store retains the current snapshot and a bounded ring of recent material events and
announcements. Complete detail lives in the trace.

### `src/interaction/announcements.ts`

Policy is deterministic and settings-driven:

- `silent`: animation ticks, streaming deltas, routine reads, repeated unchanged status.
- `polite`: verified phase change, nonfatal first failure, background success, child
  completion when specifically awaited.
- `assertive`: repeated failure, run limit, child failure, invalidated verification,
  recoverable renderer/watch failure.
- `blocking`: permission, explicit user decision, fatal error with recovery path.

Coalescing keys include run, category, target, and condition. A changed target, severity,
count, or required action creates a new announcement. Blocking announcements persist
until acknowledged/resolved and cannot be evicted by ring-buffer limits.

### `src/presentation/types.ts`

Adapter-neutral interaction contract:

```ts
interface InteractivePresentation {
  start(initial: InteractionSnapshot): Promise<void>
  announce(item: Announcement): void
  prompt(request: PromptRequest): Promise<string>
  requestPermission(request: AccessiblePermissionRequest): Promise<PermissionAnswer>
  showDetails(request: DetailRequest): void
  close(result: RunResult): Promise<void>
}
```

The existing `PermissionBridge` becomes an Ink implementation of this contract or is
wrapped by one. Headless execution continues to deny when no interactive presentation is
present.

### `src/presentation/screen-reader.ts`

Uses line-oriented input and output, not a React tree. Requirements:

- never send alternate-screen, cursor-hide, erase-line, or animation sequences;
- prefix event classes with stable words (`Status:`, `Attention:`, `Permission:`,
  `Completed:`, `Failed:`), not glyphs alone;
- do not print every streamed token twice; assistant final text remains normal output;
- offer explicit commands for bounded detail and full trace paths;
- echo no secret values in summaries;
- leave native terminal and screen-reader cursor/scrollback behavior intact;
- announce cancellation acknowledgement and input state.

Input should reuse parsing and command handlers, not fork slash-command semantics. If
Node `readline` cannot safely support concurrent announcements and editable input in the
tested terminals, use a serialized prompt loop: queue nonblocking announcements and
flush them before the next prompt rather than rewriting the active line.

### `src/interaction/status-tool.ts` or direct slash handlers

`/status`, `/repeat`, and `/details` read local state and never invoke the model. Slash
and CLI output must share formatter functions so tests cover exact semantics. A model
tool may later expose the same snapshot, but the user controls cannot depend on it.

## Settings

Add a nested global-first schema:

```ts
accessibility: {
  presentation: 'standard' | 'screen-reader'
  verbosity: 'concise' | 'balanced' | 'detailed'
  progressAnnouncements: 'off' | 'milestones' | 'timed'
  progressIntervalMs: number
  directSpeech: 'off' | 'exclusive' | 'supplemental'
}
```

Initial defaults preserve current behavior:

```json
{
  "accessibility": {
    "presentation": "standard",
    "verbosity": "balanced",
    "progressAnnouncements": "milestones",
    "progressIntervalMs": 60000,
    "directSpeech": "off"
  }
}
```

Project settings cannot override this object. CLI flags override global settings for the
current invocation. Nested settings require explicit deep merge so a partial global
object does not erase defaults.

## Permission flow

Move permission presentation out of the React-only boundary:

```text
Engine permission decision = ask
  -> AccessiblePermissionRequest created and semantic blocking event emitted
  -> selected presentation requests answer
  -> stable request ID resolves FIFO promise
  -> semantic resolution event emitted
  -> engine proceeds or denies
```

The accessible summary contains tool, normalized target, consequence, reason, and keys.
For Write/Edit it includes bounded diff statistics and `/details permission <id>` for the
full bounded diff. It never substitutes a summary for the existing permission engine.

## Proactive attention

Start with deterministic in-run detectors over events:

- same normalized tool input fails twice;
- a gate passed and a later write invalidates it;
- run token/cost/time budget crosses 75% and 90%;
- awaited background task or child agent completes, fails, aborts, or reaches a limit;
- a required optional backend is unavailable;
- the planned Experiential Layer returns qualifying `avoid`, `stop-if`, or `switch-if`
  guidance.

Each detector emits an advisory event once per condition sequence. Detectors never deny
actions. Experience remains explicitly advisory and is referenced by ID, not copied in
full.

## Persistent watchers

Only after in-session semantics pass validation:

1. Add `athena watch <resource>` as a foreground process.
2. Persist only explicit watch definitions under the global Athena directory.
3. Reuse resource policy, redaction, semantic events, and announcement settings.
4. Probe each backend by round-tripping a sentinel or observing a known resource; never
   claim `available: true` from platform/executable presence.
5. On failure, warn and keep interactive Athena usable.
6. Design an always-on service only after foreground dogfood establishes demand and
   acceptable privacy/resource behavior.

## Voice seam

The tracked voice plan in commit `3bc1ce6` already defines an opt-in `athena voice`
daemon, wake word, OpenAI Realtime conductor, session router, and control channel. Reuse
that architecture. Its conductor consumes `InteractionSnapshot` and `Announcement`, never
raw tool/model events or a second independently inferred status digest. Voice input
produces normal user prompts or command invocations. The adapter supports cancellation,
speech ownership, and complete keyboard fallback.

The older voice draft names `gpt-realtime-2`. Do not freeze that model string in this
package. The voice capability spike must consult current official OpenAI documentation
and explicitly choose a supported model. As of 2026-07-29, official model pages list
`gpt-realtime-2.1` and `gpt-realtime-2.1-mini` with audio and function calling. Model
availability and cost are runtime dependencies with an event-based recheck before the
spike, not durable product semantics.

## Integration with existing planned systems

- **Experiential Layer:** contributes advisory context and midstream signals after its
  threshold filters; does not own announcements.
- **Self-reflection journal:** may receive interaction event references but remains an
  evidence journal, not live state.
- **Memory hygiene:** may create attention items for flagged memory but remains the
  authority on memory status.
- **Governed learning:** may consume evaluation outcomes; cannot auto-promote interaction
  policy without existing approval/canary rules.

## Alternatives summary

| Option | Benefit | Cost / risk | Verdict |
|---|---|---|---|
| Retrofit fullscreen Ink only | Smallest apparent UI change | Redraw noise, visual semantics remain load-bearing | Reject |
| Voice-first | Cinematic and visible | Conflicts with screen readers, excludes Braille, platform dependency | Defer |
| Model-narrated state | Natural wording | Cost, latency, provider dependence, false confidence | Reject for truth plane |
| Separate accessible CLI with duplicated engine flow | Quick prototype | Parity and security drift | Reject |
| Shared semantic plane + presentation adapters | Consistent truth, testable, extensible | More up-front contracts | Choose |

## Wiki mechanisms affected

Implementation changes to TUI presentation or input must update:

- `.wiki/architecture/tui-fullscreen-row-budget.md` if fullscreen siblings/budgets change;
- `.wiki/reference/tui-keybindings.md` for new or changed bindings;
- `.wiki/reference/tui-platform-limits.md` if a new reachable input seam is proven;
- the Experiential Layer documentation when its events are integrated;
- `.wiki/INDEX.md` summaries when package status changes.
