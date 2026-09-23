# Athena codebase map

This is the short structural map of the runtime. Behavioral rules live in
[`AGENTS.md`](AGENTS.md); design detail and rationale live in [`.wiki/INDEX.md`](.wiki/INDEX.md).

## Runtime composition

`bin/athena.js` loads the built CLI in `dist/cli.js`; the TypeScript composition root is
[`src/cli.ts`](src/cli.ts). It owns startup, trust and credential resolution, settings,
plugins, presentation selection, shutdown ordering, and experience capture, then hands the
session itself to `HarnessSessionController`
([`src/harness/controller.ts`](src/harness/controller.ts)).

The controller is the single session composition: tool and MCP registration, the
permission gate, resource policy, protected-paths fence, hooks, sessions, tracing,
semantic interaction state, the agent orchestrator, the context manager, and the engine.
Every path builds it — `athena exec`, the append-only screen-reader loop, the Ink TUI, and
`athena voice` — so a session is assembled in one place and its guarantees are configured
in one place. Presentation-specific wiring stays with the caller: the Ink
`PermissionBridge`, the screen-reader approver, slash-command handling, the `--continue`
and `--resume` selection callback, and the teardown order each surface needs.

```text
CLI / settings
      |
      v
engine event bus ---> interaction adapter ---> interaction service ---> announcements
      |                       |                       |                    |
      |                       +---- trace / JSONL ----+                    |
      |                                                                    |
      +---- tools, permissions, hooks, sessions                            |
      |                                                                    |
      +---- standard presentation: Ink App <-------------------------------+
      |       `src/tui/` (fullscreen, mutable visual frame)
      |
      +---- screen-reader presentation <-----------------------------------+
              `src/presentation/` (append-only, serialized line I/O)
```

The standard Ink TUI remains the default. The global accessibility setting or the
session-only `--accessibility screen-reader` flag selects the append-only composition;
that path does not mount Ink, and the explicit flag can also consume redirected lines.
Both paths use the same engine, session history, semantic truth plane, permission gate,
and local slash-command handler.

## Major source areas

- `src/engine/` — provider-neutral model loop, authoritative runtime events, context and
  run limits. Permission requests receive stable IDs here before either presentation is
  asked for a decision. The `ModelClient` seam is Anthropic-shaped internally;
  `client.ts` (Anthropic + Anthropic-compatible endpoints) and `openai-client.ts`
  (OpenAI Responses API) are the only protocol boundaries.
- `src/interaction/` — versioned semantic envelopes, deterministic reduction,
  announcements, attention detectors, and local `status`, `repeat`, `details`, and
  verbosity controls. It derives truth from runtime evidence rather than assistant prose.
- `src/presentation/` — presentation-neutral interactive contracts plus the append-only
  screen-reader implementation. Line input is serialized; announcements queue while a
  prompt is active; assistant text stays separate from semantic status output.
- `src/tui/` — React/Ink fullscreen presentation and its existing FIFO permission bridge.
  Slash commands are parsed here but handled by shared CLI dependencies. Read the
  fullscreen row-budget page before changing layout.
- `src/harness/` — the shared session controller plus permissions, resource policy, the
  protected-paths fence, hooks, sessions, traces, MCP, agents, trust, plugins, staleness
  checks, and opt-in watcher primitives.
- `src/tools/` — built-in tool definitions and the registry used by the main engine and
  delegated agents.
- `src/brain/` — paths, settings, credentials and vaults, models, plugins, and local brain
  loading. Accessibility preferences are global/user-controlled and are not overridden
  by project settings. Cross-project conversational continuity is not yet implemented;
  its source-linked, local-first design and phased plan are in
  [`.wiki/features/conversational-continuity/00-overview.md`](.wiki/features/conversational-continuity/00-overview.md).
- `src/experience/` — deterministic capture, compilation, storage, and retrieval of
  bounded experiential guidance.
- `src/voice/` — provider-neutral optional voice contracts and routing over semantic
  state, plus the opt-in `athena voice` session: a persistent local wake listener, a
  bounded OpenAI Realtime audio/intent adapter advertising only `submit_turn` and
  `local_control`, and `VoiceAttentionBridge`, the permission approver it hands to the
  shared controller. No default boot-time audio or network activity.
- `src/learning/` — governed learning candidates, evaluation, promotion, and warehouse.
- `src/auth/` — interactive credential setup.

## Presentation and permission flow

The accessibility branch is selected once during startup in `src/cli.ts`:

1. The engine emits a semantic-safe `permission-requested` event and calls `askUser`
   with the same stable request ID.
2. Standard mode enqueues the request through `PermissionBridge` in `src/tui/App.tsx`.
   Screen-reader mode creates a presentation-neutral accessible request and reads a
   plain `y`, `a`, or `n` response. `athena voice` is the third consumer:
   `VoiceAttentionBridge` speaks the canonical record through local TTS, tells the
   Realtime session a decision is outstanding without granting it authority to answer,
   and settles only on a validated `local_control` call — refusing same-turn, stale,
   unknown, and ambiguous replies, and reaching `allow-once` but never `allow-always`.
3. Shared helpers in `src/presentation/permission-diff.ts` derive change counts and a
   bounded on-demand diff; the visual and append-only presentations consume the same
   diff algorithm from `src/presentation/diff-lines.ts`.
4. The engine emits the paired `permission-resolved` event and applies the answer through
   the existing permission gate. Headless execution remains fail-closed.

`/status`, `/repeat`, `/details`, and `/verbosity` are deterministic local controls: they
query or alter the in-memory `InteractionService` and do not spend a model call. The Ink
menu and append-only line loop route through the same parser and handler.

## Tests and build

Tests mirror source boundaries under `tests/`. Accessibility composition has presentation
unit tests, CLI argument and real-process coverage, engine permission pairing tests, and
shared diff tests. Fullscreen safety cannot be proven by row count; use the every-frame
content-signature tests described in
[`.wiki/architecture/tui-fullscreen-row-budget.md`](.wiki/architecture/tui-fullscreen-row-budget.md).

The required local gates are `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build`.
`dist/` is generated and gitignored.
