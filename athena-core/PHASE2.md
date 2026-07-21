# Athena — Phase 2 brain-port report

Ports the live Ares brain onto the Claude Agent SDK engine (ADR 0001, Phase 2):
an Ares-aware config loader that rides the live `~/.claude` in place, seam 3
(native memory-index injection), RSI Loop B (reflection nudge), and the
per-turn `rules_reinject` identity/rules commission. Everything lives under
`athena-core/`; nothing outside it was modified. **Keyless throughout** — no
model turns, no `py`-hook execution, no live Ares `~/.claude` (that tree isn't in
this Linux container). Those are deferred to the Windows/keyed checklist below.

## TL;DR

- **Builds clean, typechecks clean, 108 unit tests pass** (1 live smoke still
  skipped — no key). Phase 0/1's 70 tests stay green; 38 new tests added.
- **STEP 0 decided (below): CLAUDE.md is loaded FREE by the preset; the Ares
  `MEMORY.md` INDEX is the gap seam 3 must inject.** Verified against the
  installed SDK bundle, not memory.
- **Proven keyless against the REAL `/home/user/Ares`:** `discoverAresConfig`
  discovers all five hook events (incl. `reflection.py` + `rules_reinject.py`),
  plus 54 agents / 59 skills, with no key and no model turn.
- All three native-injection gaps are ported as programmatic SDK `HookCallback`s
  and unit-tested keyless; they are gated OFF when riding live Ares so they never
  double-fire with the native `py` hooks on Windows.

## STEP 0 (decisive): what does the `claude_code` preset + `settingSources` auto-load?

**Question:** with `systemPrompt:{type:'preset',preset:'claude_code'}` and
`settingSources` including `'user'`/`'project'`, does the SDK auto-load the project
CLAUDE.md and an Ares `MEMORY.md`, or must we inject them? This decides how much
of seam 3 we build vs. get free.

**Method:** inspected `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` +
`sdk.mjs` (v0.3.216) directly, and ran `resolveSettings` keyless against the real
Ares config. No answers from memory.

**Findings:**

1. **CLAUDE.md is auto-loaded — FREE.** The `settingSources` type doc states
   verbatim: *"Must include `'project'` to load CLAUDE.md files."* `'user'` loads
   `~/.claude` (the tier the Ares `settings.json` + user `CLAUDE.md` occupy). The
   bundle confirms CLAUDE.md file loading, exclude-pattern machinery, and an
   org-managed `claudeMd` injection path. So the **Ares identity preamble + global
   rules ride in for free** via the preset + `settingSources:['user','project']`.
   (This is also why `rules_reinject` is still worth porting: CLAUDE.md arrives
   wrapped in "may or may not be relevant" framing and is summarized by
   compaction; a per-turn `additionalContext` commission survives both — the exact
   rationale in the Ares hook's docstring.)

2. **Claude Code has a NATIVE auto-memory feature whose directory defaults to the
   Ares memory path.** From the `autoMemoryDirectory` schema in the bundle:
   *"Custom directory path for auto-memory storage… When unset, defaults to
   `~/.claude/projects/<sanitized-cwd>/memory/`."* That is **exactly** where Ares
   stores its `MEMORY.md` index + `*.md` memory files (e.g.
   `projects/C--Users-lafak--claude/memory/MEMORY.md`). So the Ares memory store
   **is** Claude Code's auto-memory directory. Gated by `autoMemoryEnabled` /
   `CLAUDE_CODE_DISABLE_AUTO_MEMORY`. The `<sanitized-cwd>` slug is reproduced by
   `sanitizeCwd` (`[^A-Za-z0-9] → -`), verified against the real hub slug.

3. **BUT the Ares `MEMORY.md` INDEX is NOT injected deterministically.** The
   literal string `MEMORY.md` does not appear anywhere in the SDK bundle — the
   native feature manages its own memory files, it does not special-case a
   hand-authored index named `MEMORY.md`. Native auto-memory can also be disabled,
   and its recall is model-driven / not verifiable keyless. So relying on it would
   be a non-deterministic bet on a feature that may be off.

**Decision (scope of seam 3):** we get CLAUDE.md **free**; we **build** the
deterministic injection of the Ares `MEMORY.md` index (the doctrine the ADR calls
"reimplement the native memory injections"), plus the "files win / verify on
recall" freshness reminder, as a SessionStart `HookCallback`. This is exactly what
`memoryInjector` does.

## The Ares-aware config loader (deliverable 1)

`src/config/aresConfig.ts` + evolved `buildSession` in `src/config/loadConfig.ts`.

- **`resolveAresHome(explicit?, env?)`** — precedence: explicit arg →
  `ATHENA_ARES_HOME` env → OS home `.claude`. This is the `.claude`-style config
  dir Athena rides (on Windows: `C:\Users\<user>\.claude`).
- **`discoverAresConfig(aresHome)`** — the keyless discovery. Mechanism proven in
  this container: `resolveSettings` reads the **real** `process.env.CLAUDE_CONFIG_DIR`
  at call time (it takes no env arg), so `discoverAresConfig` sets that global to
  `aresHome` around the call and restores it in `finally` (never leaves
  `process.env` mutated). It returns the discovered **hooks** (from the SDK
  merge engine) + **agents/skills** (from a directory scan — the SDK `Settings`
  schema does NOT enumerate agents/skills, those are filesystem-discovered at
  runtime).
- **`buildSession({rideAres, aresHome, aresHooks, allowDoubleFire})`** — evolves
  the Phase 1 session builder. `rideAres:true` adds `'user'` to `settingSources`,
  injects `CLAUDE_CONFIG_DIR=aresHome` into the session `env`, and points `cwd` at
  the Ares home — so the real `settings.json` (14 `py` hooks etc.) loads natively.
  Phase 0/1 defaults are untouched when the new args are omitted (all prior tests
  stay green).

**Proof (keyless, against the REAL `/home/user/Ares`):** `discoverAresConfig`
returns `found:true`, `settingsPath=/home/user/Ares/settings.json`, hook events
`PreToolUse, SessionStart, UserPromptSubmit, PostToolUse, Stop`, with
`reflection.py` and `rules_reinject.py` among the discovered commands; and
`agents.length ≥ 50`, `skills` contains `recursive-learning`. (`test/aresConfig.test.ts`;
these two cases `skipIf` the Ares repo is absent, so they run here and skip on a
host without that path.)

## The three ported hooks (deliverables 2–4)

Each is a programmatic SDK `HookCallback` — signature verified against `sdk.d.ts`:
`(input, toolUseID, {signal}) => Promise<HookJSONOutput>`. All fail-open (any
error → no injection / allow the stop), mirroring the Ares `py` convention.

### Seam 3 — `memoryInjector(aresHome)` (SessionStart) — `src/hooks/memoryInjector.ts`
Reads the Ares `MEMORY.md` index for the session's cwd
(`<aresHome>/projects/<sanitizeCwd(cwd)>/memory/MEMORY.md`, or an explicit
`memoryDir`) and returns it as `SessionStart` `additionalContext`, led by the
freshness reminder. Ports the Ares doctrine: the index is procedural memory
(recall on relevance), and **the files win** — a recalled/handed-forward memory is
a lead, not gospel; verify against disk before asserting state
(`freshnessNote` stamps the index's mtime-age and says exactly that, per
`feedback_verify_state_against_disk`). No index → no injection.

### RSI Loop B — `reflectionNudge()` (Stop) — `src/hooks/reflectionNudge.ts`
Faithful port of `hooks/reflection.py`. Streams the JSONL transcript and counts
assistant `tool_use` blocks (early-exit at threshold). When `>= 5` and the session
hasn't been nudged, returns `{decision:'block', reason:<recursive-learning nudge>}`
— the `Stop → decision:'block'` re-prompt confirmed in Phase 0 seam 2. Guards:
respects `StopHookInput.stop_hook_active` (never re-blocks — the loop guard) and a
per-session marker (a module-level `Set<sessionId>`, the in-process equivalent of
the py hook's flag file; injectable + resettable for tests). `< 5` or already
nudged → allow.

### `rulesReinject(aresHome)` (UserPromptSubmit) — `src/hooks/rulesReinject.ts`
Faithful port of `hooks/rules_reinject.py`. Injects the Ares **identity**
commission (leads; a self-model "you are Ares", exempt from the rule cap) + the
**five operating rules** as `UserPromptSubmit` `additionalContext`, skipping
trivial prompts (`< 12` chars). The commission is INLINE by design (the
instruction-adherence rationale from the py docstring: commissions hold ~100% at
depth, ~30-token budget). `aresHome` drives an opt-in "files win" path
(`preferLiveIdentity`) that sources the identity line from the live
`user_ares_identity.md` frontmatter, falling back to the inline constant.

## Wiring + the double-fire gate (deliverable 5)

`buildSession` exposes the three ports behind opt-in flags
(`aresHooks:{memory,reflection,rules}`) via `buildAresProgrammaticHooks`.

**The critical rule: the TS ports must NOT double-fire with the native `py`
hooks.** On Windows, riding live Ares means the real `settings.json` already runs
`reflection.py`, `rules_reinject.py`, and (natively) the auto-memory read. So:

- **`rideAres:true`** → the TS ports are **gated OFF** (native `py` hooks own it).
  `buildSession({rideAres:true, aresHooks:{...all}})` wires **no** programmatic
  hooks. An `allowDoubleFire:true` escape hatch exists for deliberate testing.
- **Not riding live Ares** (the cross-platform / no-`py` future, where the Windows
  `py` + `C:\` hooks can't run) → the TS ports **are** the vehicle and wire freely.

So on Windows the real 14 hooks run natively via `settingSources:['user',...]` +
`CLAUDE_CONFIG_DIR`; the TS ports cover the native-injection gaps and the
cross-platform future without ever colliding with the py hooks.

## What is PROVEN keyless (no key, no model turn, no `py`, no live `~/.claude`)

1. **STEP-0 findings** — CLAUDE.md auto-load + the auto-memory-dir default,
   read straight from the SDK bundle/type docs (documented above).
2. **`discoverAresConfig` against the REAL `/home/user/Ares`** — 5 hook events,
   `reflection.py`/`rules_reinject.py` present, 54 agents / 59 skills, settings
   attributed to `/home/user/Ares/settings.json`; `process.env` restored.
3. **`memoryInjector`** — reads the fixture `MEMORY.md` via slug derivation +
   explicit override; injects it with the freshness header; truncates oversized
   indexes; fails open when absent.
4. **`reflectionNudge`** — `>= 5` blocks once; `< 5` allows; second call same
   session no double-nudge; `stop_hook_active` never re-blocks; distinct sessions
   each nudge once; transcript counting streams JSONL and never throws.
5. **`rulesReinject`** — injects identity + rules; skips short prompts; the
   `preferLiveIdentity` "files win" path sources from `user_ares_identity.md` and
   falls back to inline.
6. **`buildSession` Phase 2 wiring** — Phase 0/1 defaults intact; `rideAres` adds
   `'user'` + `CLAUDE_CONFIG_DIR`; the double-fire gate suppresses ports while
   riding; ports wire off the Ares path; provider selection still works alongside.

## Deferred Windows/keyed live checklist

Run on the Windows host with the live Ares `~/.claude` and real keys.

| Proof | Needs |
|---|---|
| Point at the live `~/.claude`: `discoverAresConfig()` (default home) discovers the real 14 `py` hooks + 54 agents + 59 skills | Windows host |
| A live `query()` turn via `buildSession({rideAres:true})` shows, in one turn: the Ares **identity** (from CLAUDE.md + `rules_reinject.py`), the **memory index** injected at SessionStart, and — after ≥ 5 tool calls — the **reflection nudge** re-prompt at Stop | Windows host + any Anthropic-style key |
| The real `py` hooks fire natively (not the TS ports) under `settingSources:['user',...]` + `CLAUDE_CONFIG_DIR`; confirm the TS ports do NOT also fire (no double injection) | Windows host + key |
| Native auto-memory read vs. the `memoryInjector` port — confirm whether Claude Code's native auto-memory injects the Ares `MEMORY.md` index on its own, and if so gate `memoryInjector` off to avoid duplication (only the py-hook side of the gate is proven keyless here) | Windows host + key |
| `sanitizeCwd` slug matches Claude Code's actual `projects/<slug>` dir for the live cwd (verified against the hub slug here; confirm for a live project cwd) | Windows host |

## How to run

```bash
cd athena-core
npm install
npm run typecheck   # tsc --noEmit, exit 0
npm run build       # -> dist/
npm test            # vitest: 108 passed, 1 skipped (live)
```

## Layout (Phase 2 additions in **bold**)

```
athena-core/
  src/config/   loadConfig.ts  (+ **rideAres/aresHooks wiring**, buildSession/buildAthenaOptions kept)
                **aresConfig.ts**   (resolveAresHome, sanitizeCwd, resolveMemoryDir, discoverAresConfig)
  src/hooks/    contract.ts
                **memoryInjector.ts**  (seam 3: MEMORY.md index + freshness)
                **reflectionNudge.ts** (RSI Loop B: Stop recursive-learning nudge)
                **rulesReinject.ts**   (UserPromptSubmit identity + rules commission)
  fixtures/     .claude/ (Phase 0)
                **ares-home/projects/proj-fixture/memory/**  (MEMORY.md + 2 memory files)
                **transcripts/**  (substantive.jsonl · light.jsonl)
  test/         **aresConfig · memoryInjector · reflectionNudge · rulesReinject · buildSessionAres**
```
