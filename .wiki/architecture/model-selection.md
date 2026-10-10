# Model selection and reasoning

`src/brain/models.ts` is the canonical provider/model registry. CLI normalization,
settings loading, the engine, the effort picker, and OpenAI request validation use
its capabilities. The existing Responses API translation remains the only OpenAI
wire boundary; the engine and harness retain their shared execution path.

## Verified OpenAI matrix (2026-10-10)

The existing account's read-only `/v1/models` catalog and official model pages
agree on four GPT-6/6.1 models:

| Local key | Exact API model | Reasoning efforts |
|---|---|---|
| `luna` | `gpt-6-luna` | none, low, medium, high, xhigh, max |
| `sol` | `gpt-6-sol` | none, low, medium, high, xhigh, max |
| `astra` | `gpt-6-astra` | low, medium, high, xhigh, max |
| `sol-6.1` | `gpt-6.1-sol` | low, medium, high, xhigh, max |

Sources: [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna),
[Sol](https://developers.openai.com/api/docs/models/gpt-6-sol),
[Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), and
[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol).

OpenAI's default is GPT-6.1 Sol at medium. Auth validation still uses the cheapest
Luna model. Existing explicit GPT-6 selections are preserved; `sol` remains the
older Sol. Exact keys and full IDs normalize case-insensitively. Unknown OpenAI
versions are rejected rather than guessed by substring. Legacy Anthropic/Kimi
normalization and defaults remain unchanged.

`Effort` is a union of legal values across models, not proof that every value
works on every model. `effortLevels` supplies the model-specific selector;
`assertModelEffort` and `resolveModelRequest` enforce that list. GPT-6 Sol/Luna
`none` requests omit reasoning summaries. Anthropic's existing reasoning models
retain low through max; Haiku/Kimi have no effort picker or effort wire parameter.
Unsupported typed effort changes leave engine state unchanged. Switching models
keeps a compatible effort or resets it to medium for OpenAI / high for other
providers, updating visible status. Loading an incompatible saved effort warns
and uses that safe default without rewriting the settings file.

Durable children resolve their explicit/inherited model before running hooks,
creating a record/trace, or creating an isolated worktree. A child-specific model
keeps compatible parent effort or uses the provider default. An explicit unknown
OpenAI model returns an error without a provider call or a stranded running record.
Known foreign-provider frontmatter retains the legacy parent-model fallback, as
do existing non-OpenAI agent definitions.

Headless `exec` uses the provider's default effort when `--effort` is absent;
an explicit flag is validated after selecting the active model. The settings
model may still come from the normal global/project cascade. VMP settings saves
use the selected model's provider schema rather than an Anthropic-only schema.

## Journal and provider calls

The open-app journal reads the engine's current OpenAI model and effort at call
time. Manual `journal run` reads the global provider/model/effort. One-shot
OpenAI completions can now forward effort, with validation before HTTP/retries;
the journal's single physical attempt and durable daily budget are unchanged.
The separately approved machine-local scheduled worker pins GPT-6.1 Sol medium.
It shares the same journal ledger, lock, and completed-day checkpoint.

## Live validation (2026-10-10)

One isolated synthetic manual-memory consolidation used the actual Responses
adapter and shared journal runtime. Request interception confirmed `gpt-6.1-sol`,
`reasoning.effort: medium`, `store: false`, no tools, and 1,400 requested output
tokens. One physical POST returned HTTP 200 and a completed `gpt-6.1-sol` response:
454 input / 304 output tokens, including 73 reasoning tokens. The runtime's
30-second deadline and one-attempt policy were retained; the successful call did
not exercise a timeout failure.

A durable fixture reservation preceded the call. The accepted reflection treated
the authored synthetic preference as unverified and its hash as integrity rather
than truth. One derived source summary and one inferred interpretation remained
provisional at confidence 0.25. Independent reload checked citations, revision,
transactions and materialized memory; repeat preserved the ledger and call count.
The real profile and daily checkpoint were unchanged. This establishes one live
medium lifecycle, not live availability or semantic quality for all 22 pairs,
and not a provider call through the installed OS task.

## Limits

The matrix represents documented API support, confirmed model visibility for this
account, and local contract/request tests. It does not claim paid live calls were
made for every effort/model pair. The registry is static and needs an explicit
update when API capabilities change. `minimal` and `ultra` are not documented
efforts for these models. Fast/Ultrafast service tiers and reasoning mode are
separate API controls and are outside this model/effort selector change.

Pricing entries describe standard base tariffs. GPT-6.1 Sol has $2 input, $10
output, $0.10 cached input, and $2.50 cache writes per million tokens. Local cost
estimates do not account for long-context surcharges, regional processing, or
nonstandard service tiers; provider billing remains authoritative.
