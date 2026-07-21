# Athena — Phase 1 provider layer report

Extends the Phase 0 spike (ADR 0001) with the real provider layer: provider
registry + env-driven selection, SDK session wiring, a real LiteLLM OpenAI
sidecar manager (+ mock), and a runtime `/models` read. Everything lives under
`athena-core/`; nothing outside it was modified. **Keyless** throughout — no live
model calls, no LiteLLM install; those are deferred to the Windows/keyed
checklist below.

## TL;DR

- **Builds clean, typechecks clean, 64 unit tests pass** (1 live test still skipped — no key). Phase 0's 27 tests stay green; 37 new tests added.
- **Step 0 decided: `Options.env` EXISTS** — provider selection is clean per-session env injection (no `process.env` mutation, no per-request body interceptor). Details below.
- **LiteLLM pinned to `1.93.0`** (clean; well past the malicious `1.82.7`/`1.82.8` and the `1.83.10` SQLi fix). Rationale below.
- Provider switch (kimi vs anthropic vs minimax vs openai) is proven to yield the correct `base_url` / auth var / flags **keyless**, by introspecting the built SDK `Options.env`.

## Step 0 (decisive): does `Options` accept a per-session `env`?

**YES.** Verified against the installed `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (v0.3.216), inside the `Options` type (declared at line 1295):

```ts
// sdk.d.ts:1424
env?: {
    [envVar: string]: string | undefined;
};
```

Its doc comment carries the load-bearing caveat:

> When set, this value **REPLACES the subprocess environment entirely** — it is
> not merged with `process.env`. Spread `process.env` yourself if the subprocess
> still needs inherited variables like `PATH`, `HOME`, or `ANTHROPIC_API_KEY`.

**Decision (per the STEP-0 instruction): use per-session `env` injection.** This
is the clean path — it enables multi-provider selection without mutating global
`process.env`, so two sessions on different providers can coexist in one process.
The one gotcha is the "replaces, not merges" semantics: `buildSession` therefore
spreads the incoming env **first** and overlays the provider `sessionEnv` on top
(`env: { ...env, ...resolved.sessionEnv }`). Forgetting the spread would strip
`PATH`/`HOME` and the CLI would fail to launch. A `buildSession` test asserts
`PATH`/`HOME` survive alongside the provider overlay, so this can't regress.

All env-var NAMES the resolver writes were confirmed present in the SDK bundle
(`sdk.mjs`), not taken from memory: `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ENABLE_TOOL_SEARCH`,
`CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `ANTHROPIC_SMALL_FAST_MODEL`.

## What was implemented

### 1. Provider registry + selection — `resolveProvider(name, model?, opts?)`
`src/providers/resolveProvider.ts`. Returns
`{ descriptor, sessionEnv, model, missingKeyEnvVar? }`. `sessionEnv` sets:

- `ANTHROPIC_BASE_URL` = descriptor base (or the sidecar url for OpenAI).
- `ANTHROPIC_MODEL` = resolved model; plus `ANTHROPIC_SMALL_FAST_MODEL` pinned to
  the same model for non-Anthropic providers (they don't host a `claude-*-haiku`
  small model — background/small-model calls would otherwise 404).
- The correct auth var, with the VALUE read from `process.env` **at call time**:
  `ANTHROPIC_API_KEY` (anthropic & minimax, `x-api-key`) / `ANTHROPIC_AUTH_TOKEN`
  (kimi, bearer).
- `ENABLE_TOOL_SEARCH=false` when `descriptor.supportsWebTools` is false.
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` = `String(descriptor.contextWindow)`.

Secrets are never hardcoded — if the required key var is absent, `missingKeyEnvVar`
is set **but the full non-secret config is still returned** (so it's testable
keyless). Unknown provider → `UnknownProviderError`; unknown model →
`UnknownModelError` (lenient: only gates when a known list exists; volatile ids
pass once refreshed via `fetchModels`).

OpenAI is special-cased: the real secret (`OPENAI_API_KEY`) is consumed by the
sidecar **process**, not the SDK, so it is the `missingKeyEnvVar` target but is
not injected into the SDK env. The SDK→sidecar hop authenticates with a local,
non-secret master key (`LITELLM_MASTER_KEY` if set, else `sk-athena-litellm-local`).

### 2. SDK session wiring — `buildSession({provider, model, ...})`
`src/config/loadConfig.ts`. Evolution of `buildAthenaOptions` (kept intact —
Phase 0's fixture config-loading + hook wiring is preserved and still tested).
`buildSession` resolves the provider and produces SDK `Options` with `model` set
and `env` injected via the step-0 approach. Returns `{ resolved, options }`.

### 3. LiteLLM OpenAI sidecar — `SidecarManager` + `MockSidecar`
`src/providers/sidecar.ts`. The Phase 0 in-SDK routing seam
(`routeToSidecar`/`LiteLLMSidecarStub`) is retained; the new pieces are the
process lifecycle:

- `SidecarManager` — `start()`/`stop()`/`health()`, `baseUrl`
  (`http://127.0.0.1:4000`, unified route; SDK appends `/v1/messages`),
  `anthropicMessagesUrl`, and `buildSpawnCommand()`. The **real spawn is guarded**
  by `canSpawnSidecar()` (Windows-only, or `ATHENA_ENABLE_SIDECAR_SPAWN=1`) so it
  is inert in this Linux container — `start()` throws a clear deferral error
  instead of spawning. Refuses any known-compromised version.
- **Documented spawn command** (grounded in LiteLLM docs): `litellm --model
  openai/<model> --port 4000 --host 127.0.0.1`, or `litellm --config <config.yaml>
  --port ... --host ...` where the config maps `model: openai/<model>` +
  `api_key: os.environ/OPENAI_API_KEY`. Clients set
  `ANTHROPIC_BASE_URL=http://127.0.0.1:4000`; health probe is
  `GET /health/liveliness` (returns `"I'm alive!"`).
- `MockSidecar` — a tiny **real** local http server answering
  `/health/liveliness`, `/v1/models`, and a canned Anthropic-shaped
  `POST /v1/messages`. A test proves OpenAI selection routes end-to-end: aim
  `ANTHROPIC_BASE_URL` at the mock, POST `/v1/messages`, get the canned
  `{type:'message', role:'assistant', ...}` back.

### 4. Runtime `/models` read — `fetchModels(provider, {transport?})`
`src/providers/fetchModels.ts`. Injectable transport (default wraps platform
`fetch`; **no real network in tests**). Reads the auth secret at call time, sends
the right header, parses `data[].id` (Anthropic + OpenAI share this shape), and
refreshes a runtime model registry that `resolveProvider` validates against — so
volatile ids can be refreshed at runtime per the ADR. Tested against a mocked
transport and against the `MockSidecar`'s `/v1/models`.

## What is PROVEN keyless (no key, no model turn, no network)

1. Env-resolution per provider (`resolveProvider`) — correct base_url / auth var
   name / flags / compact-window for all four providers; secret VALUES read from
   an **injected** env (proving no hardcoding, no ambient read); `missingKeyEnvVar`
   set when absent while full config still returns.
2. Session wiring (`buildSession`) picks the right provider config — distinct
   base_urls from one call site; `Options.env` spreads the base env AND overlays
   the provider selection (the step-0 "replaces" gotcha guarded).
3. Sidecar routing via the mock — OpenAI selection routes `/v1/messages` through
   the sidecar `base_url`; `health()` true against a live liveliness probe;
   spawn guarded off; known-bad version refused.
4. Models-read via mock — parse/refresh/registry-honored, auth header per style,
   non-2xx error path.

## Chosen LiteLLM pinned version + why

**Pin: `litellm==1.93.0`** (latest stable, released 2026-07-19).

- **Not** `1.82.7` / `1.82.8` — both shipped a credential-stealing payload
  (`1.82.7` in `proxy_server.py` on import; `1.82.8` escalated to a
  `litellm_init.pth` that runs on interpreter start). Both were pulled from PyPI;
  MLflow emergency-pinned `<=1.82.6`.
- **Past** the later `CVE-2026-42208` proxy SQL-injection, fixed in `1.83.10`.
- `1.93.0` is the current stable line (LiteLLM dropped `-stable`/`-nightly`
  suffixes at `1.84.0`; weekly = MINOR, hotfix = PATCH), so it carries the
  malware remediation **and** the CVE fix.
- Per ADR: **pin + vendor, never auto-update.** Recommended install is
  hash-pinned: `pip install "litellm[proxy]==1.93.0" --require-hashes` against a
  vendored requirements file, and verify the artifact hash against PyPI at vendor
  time. `SidecarManager` also refuses to build a command for any
  `LITELLM_KNOWN_BAD_VERSIONS` entry as a defense-in-depth backstop.
- Conservative alternative if more soak time is wanted: step back one MINOR line
  (still `>= 1.83.10`, still clean). The pin lives in one constant
  (`LITELLM_PINNED_VERSION`) so moving it is a one-line change.

> The LiteLLM pin (1.93.0) has since been folded into ADR 0001's "Open items"
> (with the hash-verify-at-install caveat). This file records the full rationale.

## SDK-vs-assumption findings (Phase 1)

- **`Options.env` exists and is per-session** (step 0) — the central finding;
  reshapes provider selection into clean env injection. Caveat: it **replaces**
  the subprocess env (must spread `process.env`).
- **`Options.model` exists** (`sdk.d.ts:1686`) — we set both `Options.model` and
  `ANTHROPIC_MODEL` (belt-and-suspenders; the CLI reads the env var, `Options`
  passes through as a CLI arg).
- **`ANTHROPIC_SMALL_FAST_MODEL` is real** and matters for third-party endpoints
  — set it (aliased to the main model) for kimi/minimax/openai so Claude Code's
  small/fast background calls don't hit a `claude-*-haiku` id the provider
  doesn't host. Not set for anthropic (its endpoint has haiku).
- All target env-var names verified present in `sdk.mjs` (not memory).

## Deferred Windows/keyed live checklist

Run on the Windows host with real keys; each is unit-scaffolded and guarded here.

| Proof | Needs |
|---|---|
| Install the **pinned** LiteLLM (`litellm[proxy]==1.93.0`, hash-verified) and spawn `SidecarManager.start()` (set `ATHENA_ENABLE_SIDECAR_SPAWN=1`); confirm `GET /health/liveliness` | Windows host + `OPENAI_API_KEY` |
| Live Claude `query()` turn via `buildSession({provider:'anthropic'})` | `ANTHROPIC_API_KEY` |
| Live Kimi turn — `buildSession({provider:'kimi'})` hits `api.moonshot.ai/anthropic` with bearer + `ENABLE_TOOL_SEARCH=false` | `ANTHROPIC_AUTH_TOKEN` (Kimi) |
| Live MiniMax turn — `buildSession({provider:'minimax'})` hits `api.minimax.io/anthropic` | MiniMax `ANTHROPIC_API_KEY` |
| Live OpenAI turn through the real sidecar — `buildSession({provider:'openai', baseUrl: mgr.baseUrl})` → `/v1/messages` translated by LiteLLM | `OPENAI_API_KEY` + running sidecar |
| Live `fetchModels(provider)` against each real `/v1/models` to refresh volatile ids | provider keys / running sidecar |
| Real `~/.claude` (live Ares) load with `settingSources` incl. `'user'` | Windows host |

## How to run

```bash
cd athena-core
npm install
npm run typecheck   # tsc --noEmit, exit 0
npm run build       # -> dist/
npm test            # vitest: 64 passed, 1 skipped (live)
```

## Layout (Phase 1 additions in **bold**)

```
athena-core/
  src/providers/   types.ts · descriptors.ts · shapeRequest.ts · sidecar.ts · index.ts
                   **resolveProvider.ts** · **fetchModels.ts**
  src/config/      loadConfig.ts   (+ **buildSession**, buildAthenaOptions kept)
  src/hooks/       contract.ts
  src/smoke/       liveSmoke.ts
  test/            shapeRequest · config · hook · live.smoke
                   **resolveProvider · buildSession · sidecar · fetchModels**
```
