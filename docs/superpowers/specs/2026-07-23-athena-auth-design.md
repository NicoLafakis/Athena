# Athena Auth & Multi-Provider Design

**Date:** 2026-07-23
**Status:** Approved (Nico, 2026-07-22 session)
**Scope:** Credential storage, first-run setup wizard, `athena auth` command, Kimi (Moonshot) provider support, provider switching, README rewrite.

## Motivation

Setup today requires PowerShell environment-variable knowledge (`$env:` vs the `set` alias trap, `SetEnvironmentVariable` needing a new shell). Nico hit both failure modes on first run. Goal: `athena` should be runnable by pasting a key into a prompt, never touching the shell environment.

## Constraint: no subscription OAuth

Claude Code's browser login is Anthropic's private OAuth client. Third-party harnesses cannot authenticate against a Claude subscription; doing so would violate Anthropic's ToS and no public endpoint exists. Athena therefore uses console API keys (console.anthropic.com credits). This is settled — do not re-propose OAuth.

## 1. Credential store

New file `~/.athena/credentials.json`, written with best-effort owner-only permissions (`0o600` on POSIX; a no-op on Windows/NTFS, where the file relies on the user-profile directory ACL):

```json
{
  "providers": {
    "anthropic": { "apiKey": "sk-ant-..." },
    "kimi": { "apiKey": "sk-..." }
  },
  "activeProvider": "anthropic"
}
```

- Zod-validated (same pattern as `src/brain/settings.ts`); unknown providers rejected with a clear error.
- Resolution order per provider: explicit env var (`ANTHROPIC_API_KEY`, `MOONSHOT_API_KEY`) overrides the file when set — existing setups keep working; the file is the primary documented path.
- Malformed file → actionable error naming the file and offering `athena auth` to regenerate, never a raw parse stack.

## 2. First-run wizard

When `athena` starts and no key resolves for the active provider, it enters setup instead of erroring:

1. Pick provider (Anthropic / Kimi).
2. Paste key — masked input.
3. Live validation call (cheap: minimal message to the provider's smallest model). Reject with the provider's error message on failure; loop back to re-entry.
4. Save to `credentials.json`, set `activeProvider`, continue directly into the session.

Placement: the wizard runs pre-TUI, replacing the current hard exit at the missing-key check in `src/cli.ts` (the check currently errors and exits before the TUI starts). Masked input is a small manual raw-mode echo handler — Node's readline does not mask input natively.

Commands:
- `athena auth` — re-run the wizard any time (add/replace keys, switch active provider).
- `athena auth status` — list configured providers, active provider, and redacted keys (`sk-ant-...abc4`), plus whether an env var is overriding the file.

## 3. Kimi (Moonshot) provider

Moonshot exposes an Anthropic-compatible API endpoint, so no second client implementation:

- `AnthropicClient` gains an optional `baseURL` constructor option passed through to the SDK.
- A provider registry maps:
  - `anthropic` → default SDK URL; model families haiku/sonnet/opus/fable (existing `src/brain/models.ts`).
  - `kimi` → `https://api.moonshot.ai/anthropic`; Kimi model list (kimi-k2 lineage; exact ids resolved at implementation time against Moonshot docs).
- **Capability gating:** Anthropic-only request fields — adaptive `thinking` and `output_config.effort` — are attached only when the active provider supports them, so Kimi requests never send fields that would 400. Gating lives at the request-build seam (`resolveModelRequest` / client body construction), not scattered call sites.

**Model registry generalization (required):**

Today `ModelFamily` is a hard-coded four-Anthropic-family union (`src/brain/models.ts`) woven through the settings zod enum, `resolveModelRequest`, `engine.getModel()`, the orchestrator's model thunks, and `/model` normalization. Kimi models cannot exist in that type system. This design generalizes it: `MODELS` becomes a provider-scoped registry (`provider -> { modelKey -> { id, label, supportsEffort, supportsThinking } }`); `resolveModelRequest(provider, modelKey, effort)` becomes provider-aware and remains the single place request fields are assembled; `settings.model` validates against the active provider's model keys instead of a fixed enum (the four Anthropic family names keep working unchanged as Anthropic model keys); `/model` normalization matches within the active provider only.

## 4. Provider switching

One active provider per session:
- `athena --provider kimi` CLI flag (highest precedence).
- `/provider` command in the TUI to switch mid-run (starts the next request on the new provider).
- Persisted `activeProvider` in `credentials.json` as the default.
- The model picker shows only the active provider's models.
- Persistence: `--provider` and `/provider` are session-only overrides. Only the wizard / `athena auth` writes `activeProvider` to `credentials.json`.

Rejected alternatives: fallback chain (silently changes model quality mid-session) and mixed-model routing (muddies the model picker and capability story).

Mid-session switching must swap the client everywhere it is captured: the single `AnthropicClient` instance is closed over by the orchestrator's `clientFactory` and used by the compactor at startup (`src/cli.ts`). The implementation introduces a mutable client holder (a thunk or small wrapper) that the engine, orchestrator, and compactor all read through, so `/provider` cannot leave sub-agents or compaction on the old provider.

## 5. Error handling

- Auth failure (401/403) mid-session → "API key rejected for <provider> — run `athena auth`" instead of a raw SDK stack.
- Missing key for a provider selected via `--provider`/`/provider` → drop into the wizard scoped to that provider.

## 6. Testing

Unit tests cover:
- Credential resolution order (env var over file; per-provider).
- Wizard save path (file written, perms set, activeProvider updated).
- Provider gating: thinking/effort fields present for Anthropic, absent for Kimi.
- Redaction in `athena auth status` (no full key ever printed).
- Malformed credentials.json error path.
- Model registry: settings validation accepts Anthropic family names for anthropic and Kimi model keys for kimi; rejects cross-provider keys with a clear error.
- Client holder: after a provider switch, orchestrator sub-agent calls and compactor calls go through the new provider's client.

Engine tests keep using the scripted `ModelClient` test double — no live-provider tests.

## 7. Documentation

README setup section rewritten to: install → run `athena` → paste key when prompted. Env vars documented as an advanced override only.
