# Athena — Phase 0 de-risk spike report

Scaffolds the Claude Agent SDK engine (ADR 0001), stands up the provider dialect
layer, and kills the four-seam unknowns as far as a keyless Linux authoring
container allows. Everything lives under `athena-core/`; nothing outside it was
modified.

## TL;DR

- **Builds clean, typechecks clean, 27 unit tests pass** (1 live test skipped — no key).
- **SDK package:** `@anthropic-ai/claude-agent-sdk@0.3.216` (npm `latest` on 2026-07-21; Node `>=18`). Installed fine through the proxy.
- **Seam 2 CONFIRMED against the real `sdk.d.ts`:** the SDK exposes both the `Stop → decision:'block'` re-prompt and `additionalContext` injection. Details below.
- **Bonus:** the SDK exports `resolveSettings()` — it runs the CLI's settings-merge engine *without spawning the CLI or a model*, so we proved hook discovery from a `.claude` config with **no key and no turn**.
- **Biggest ADR-vs-reality gap:** the SDK owns the HTTP call and exposes **no public per-request body interceptor**. Provider switching in practice is **env-var + settings driven** (base_url, auth token, thinking defaults, tool-search flag, auto-compact window), not body mutation. Our `shapeRequest` is proven as the reference dialect model; wiring it to the SDK's live transport is Phase 1 (see Provider seam).

## Environment reality

- Linux authoring container. Product targets Windows only; the live Ares `~/.claude` brain and `py` hooks are **not** exercised here.
- Keys checked via `printenv`: only `ANTHROPIC_BASE_URL` (`https://api.anthropic.com`) is set. **No** `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `MOONSHOT_API_KEY` / `MINIMAX_API_KEY`. All live model calls skipped; transport not hit.
- Windows `py` hooks not run. A **portable node hook** (`fixtures/.claude/hooks/inject.mjs`) stands in.

## What was PROVEN in-container (no key, no model turn)

1. **TS SDK app builds + typechecks + tests green.** `npm run typecheck` (exit 0), `npm run build` (emits `dist/` mirroring `src/`), `npm test` → 27 passed / 1 skipped.
2. **Provider dialect shaping** (`src/providers/`), pure + no network, unit-tested per provider:
   - anthropic keeps `cache_control`; sets `x-api-key`.
   - kimi forces `thinking:{type:'enabled'}`, strips web-tool declarations, uses `Authorization: Bearer`.
   - minimax clamps `temperature` into `[0,2]` and drops `top_k` / `stop_sequences` / `mcp_servers`.
   - openai is marked `dispatch:'sidecar'` and routed through the sidecar seam stub (never a direct call).
   - purity: input request object is never mutated.
3. **SDK config discovery of the fixture hook — via `resolveSettings({cwd, settingSources:['project','local']})`.** Real output:
   ```json
   "SessionStart":     [{ "matcher":"startup", "hooks":[{ "type":"command", "command":"node \"$CLAUDE_PROJECT_DIR/.claude/hooks/inject.mjs\"" }] }],
   "UserPromptSubmit": [{ "hooks":[{ "type":"command", "command":"node \"$CLAUDE_PROJECT_DIR/.claude/hooks/inject.mjs\"" }] }]
   ```
   attributed to `source:"project"` at `.../athena-core/fixtures/.claude/settings.json`. This is the same merge engine `query()` would use — so a live turn *would* fire these hooks.
4. **Hook I/O contract, independent of a live turn.** `inject.mjs` piped the documented stdin JSON emits, for both events:
   ```json
   {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"ATHENA_PHASE0_HOOK_OK::additionalContext-injected"}}
   ```
   A drift test asserts the file hook's marker equals `HOOK_MARKER` in `src/hooks/contract.ts`.
5. **Programmatic SDK hook shape** (`sessionStartInjector`) type-checks against the real `HookCallback` / `HookJSONOutput` types and returns the injecting payload.
6. **Fixture skill well-formed** — `skills/hello/SKILL.md` has valid `name` + `description` frontmatter and sits where `settingSources:['project']` + `skills:['hello']` would discover it.

## What remains as LIVE proofs (need keys and/or the Windows host)

| Proof | Needs | Why deferred |
|---|---|---|
| One real `query()` turn injects the hook `additionalContext` + `hello` skill is invocable | any Anthropic-style key | no key in container. Guarded test `test/live.smoke.test.ts` + `runLiveSmoke()` are ready; the keyed block auto-skips when absent. |
| Claude ↔ Kimi provider switch hitting a real endpoint | `ANTHROPIC_AUTH_TOKEN` (Kimi) / `ANTHROPIC_API_KEY` | live transport + provider env wiring (Phase 1). |
| Real Ares config load from live `~/.claude` (54 agents, 59 skills, 14 hooks, memory) | Windows host | that tree isn't present here; would use `settingSources` incl. `'user'`. |
| Real `py` hook fire (Windows Task Scheduler / `py` launcher) | Windows host | `py` + `C:\` paths don't run on Linux; node fixture substitutes. |
| Skill *runtime* discovery/listing (vs. file-well-formed) | a turn (or streaming introspection) | skill listing materializes during a run; `resolveSettings` covers hooks, not skills. |

## Per-seam findings

### Seam 1 — Transcript access + shape
Not built in Phase 0 (needs live `~/.claude/projects/*.jsonl`). Relevant SDK surface exists: session mgmt (`sessionId`, `resume`, `sessionStore`, `SessionStore`), `renameSession`/`tagSession`, and the `Stop` hook input carries `last_assistant_message` (avoids parsing the transcript for the common case). A `getSessions()` adapter over the JSONL format remains the Phase 3 task.

### Seam 2 — Hook event/return contract — **CONFIRMED** (the key unknown)
Verified against the installed `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`:

- **`additionalContext` injection is real** on `SessionStartHookSpecificOutput`, `UserPromptSubmitHookSpecificOutput`, `StopHookSpecificOutput`, `SubagentStopHookSpecificOutput` (all `{ hookEventName, additionalContext? }`).
- **`Stop → decision:'block'` re-prompt is real.** `SyncHookJSONOutput` = `{ continue?, suppressOutput?, stopReason?, decision?: 'approve' | 'block', systemMessage?, terminalSequence?, reason?, hookSpecificOutput? }`. For `Stop`, `decision:'block'` + `reason` prevents the agent from stopping and continues the conversation — exactly the recursive-learning nudge the ADR needs. `StopHookInput` also exposes `stop_hook_active` (loop-guard) and `last_assistant_message`.
- **`HookEvent`** is broad — includes `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `PreCompact`/`PostCompact`, `SessionEnd`, and more.
- **Two ways to host our 14 Ares hooks:** (a) **command hooks** in `settings.json` (`type:'command'`), which the SDK loads and fires as-is — the pure-injection py hooks can be **`command` shims** with no TS rewrite; (b) **programmatic** `HookCallback`s passed via `Options.hooks`.

**Real `HookCallback` signature (differs from some doc summaries):**
```ts
type HookCallback = (input: HookInput, toolUseID: string | undefined, options: { signal: AbortSignal }) => Promise<HookJSONOutput>;
Options.hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
interface HookCallbackMatcher { matcher?: string; hooks: HookCallback[]; timeout?: number }
```
(The `{ match, handler }` shape in loose docs is wrong; it's a matcher wrapping a `hooks: HookCallback[]` array.)

### Seam 3 — Native memory injections
Mechanism proven via seam 2: a `SessionStart` hook returning `additionalContext` is the vehicle for the `# auto memory` read + the "memory is N days old, verify" freshness reminder. `SessionStartHookSpecificOutput` even offers `reloadSkills`, `watchPaths`, `initialUserMessage`. Content/protocol port is Phase 2.

### Seam 4 — Headless sub-model call + scheduler
`query({ prompt, options })` returns an async-generator `Query`; a single `maxTurns:1` call is the `claude -p` replacement (see `runLiveSmoke`). Windows Task Scheduler stays as the trigger. Live exec deferred (needs key). RSI Loop A wiring is Phase 3.

## Provider layer — ADR-vs-reality (read this)

The provider layer is delivered and unit-tested as a **pure reference model** of the dialect rules:
`ProviderCapabilities` descriptor → `shapeRequest(provider, baseRequest)` → transport-ready `ShapedRequest`; OpenAI behind an `OpenAISidecarAdapter` seam (`LiteLLMSidecarStub`, not bundled).

**Reality check:** the Agent SDK spawns the Claude Code CLI, which **owns the HTTP request**; the public API exposes **no per-request body interceptor**. So in practice Claude/Kimi/MiniMax switching is done by **env + settings**, not by mutating a request body:
- `ANTHROPIC_BASE_URL` (present in this env; the doc fast-summary's `ANTHROPIC_API_BASE` is not the canonical var) + `ANTHROPIC_AUTH_TOKEN` (Kimi, `Authorization: Bearer`) / `ANTHROPIC_API_KEY` (Anthropic, MiniMax, `x-api-key`).
- Kimi: `ENABLE_TOOL_SEARCH=false` (no web tools) and `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (announce context) — these map to our `supportsWebTools:false` / `contextWindow`.
- The "force thinking", "strip cache_control", "clamp temp", "drop ignored params" rules are still needed and are exactly what `shapeRequest` encodes.

**Where `shapeRequest` actually runs in Phase 1:** (a) as the validation/spec that drives the per-provider **env/settings** the SDK reads; and/or (b) as the real body shaper for any call we make **outside** the SDK against `@anthropic-ai/sdk` directly (e.g. RSI Loop A sub-calls, or a future OpenAI sidecar path). It is deliberately SDK-decoupled so it serves both. Descriptor numbers (contextWindow, temperatureRange, model IDs) are **volatile** — ADR mandates reading `/models` at runtime.

**OpenAI/LiteLLM:** seam + stub only, per ADR. LiteLLM is **not** installed. The stub's result carries `pinnedVersionRequired: true` and a note to avoid the credential-stealing `1.82.7 / 1.82.8`. Exact clean pin is still an open ADR item.

## Other SDK notes vs. ADR assumptions

- **`settingSources` semantics** (from installed `sdk.d.ts`): values `'user' | 'project' | 'local'`. *"When omitted, all sources are loaded (matches CLI defaults). Pass `[]` to disable filesystem settings. Must include `'project'` to load CLAUDE.md files."* We set it **explicitly** (`['project','local']`) for deterministic, host-independent fixtures. To ride **live Ares** (`~/.claude`), Phase 2 adds `'user'`.
- **`resolveSettings()` (alpha)** is a genuine, undocumented-in-ADR win: keyless introspection of the exact merged config a `query()` would see. It underpins our seam-2/3 proof and is ideal for the fixture/eval ratchet.
- **`systemPrompt`** supports `{ type:'preset', preset:'claude_code', append? }` — the way to keep Claude Code's base behavior while appending Ares identity.
- **`skills`** is the single enablement point (`'all' | string[]`); no need to add `'Skill'` to `allowedTools`.

## How to run

```bash
cd athena-core
npm install
npm run typecheck   # tsc --noEmit, exit 0
npm run build       # -> dist/
npm test            # vitest: 27 passed, 1 skipped (live)
# keyed live smoke (Windows host / with a key):
#   set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) then `npm test` — the live block un-skips.
```

## Layout

```
athena-core/
  src/providers/   types.ts · descriptors.ts · shapeRequest.ts · sidecar.ts · index.ts
  src/config/      loadConfig.ts        (buildAthenaOptions, resolveAthenaSettings, seam 2/3)
  src/hooks/       contract.ts          (HOOK_MARKER, command-hook I/O shapes)
  src/smoke/       liveSmoke.ts         (guarded one-turn query(); seams 2 & 4)
  src/index.ts
  fixtures/.claude/ settings.json · skills/hello/SKILL.md · hooks/inject.mjs
  test/            shapeRequest · config · hook · live.smoke
```
