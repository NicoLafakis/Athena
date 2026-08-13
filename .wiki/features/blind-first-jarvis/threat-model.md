# Blind-first Jarvis upgrade - threat model

> [Objective overview](00-overview.md) | [PRD](prd.md)

## Assets and trust boundaries

Assets:

- user attention and correct understanding of Athena's state;
- permission decisions and queued actions;
- prompts, tool inputs/outputs, diffs, paths, credentials, and traces;
- accessibility preferences and speech ownership;
- explicit watch definitions and observed resources.

Trust boundaries:

- model/agent assertions versus runtime facts;
- untrusted project settings/content versus global user preferences;
- tool output versus announcement text;
- terminal presentation versus engine/permission state;
- optional OS speech/notification/watch backends versus Athena core.

## Threats and mitigations

| Threat | Example | Mitigation |
|---|---|---|
| Spoofed completion | Model says tests passed after a failed tool | Runtime precedence; verified outcome fields cannot be agent-set |
| Attention suppression | Tool text resembles a control message or changes dedupe keys | Typed source events; untrusted strings cannot set priority/control fields |
| Permission confusion | Concurrent asks overwrite or are announced without target | Stable request IDs, FIFO queue, blocking retention, exact resolution pairing |
| Secret disclosure | API key appears in spoken status or watch notification | Existing redaction, bounded normalized summaries, secret fixtures |
| Project preference override | Repository disables screen-reader mode or enables speech | Accessibility settings global-only; project value ignored with warning |
| Denial by noise | Rapid progress/tool events monopolize speech | Default silence, coalescing, rate bounds, interrupt priority |
| Lost critical event | Ring buffer evicts unresolved permission | Blocking items persist until resolution and are outside ordinary eviction |
| Malicious watcher | Project starts monitoring outside workspace | Explicit user-created scope, resource policy, trust checks; only explicit `athena voice` may start the tracked voice daemon |
| Optional-backend boot abort | Speech/watch migration throws during startup | Best-effort initialization, verified fallback, actionable warning |
| Trace ambiguity | Semantic claim cannot be tied to evidence | Run ID, sequence, source type/ref, reducer version in trace metadata |
| Detector secret retention | Repeated failure keeps raw tool arguments to compare retries | Run-local bounded canonical digests only; no tool input/output in detector state or advisory |
| Double speech | Athena TTS and screen reader both announce | Direct speech default off; explicit exclusive/supplemental ownership |
| Accessibility downgrade | Standard fallback silently restores inaccessible fullscreen | Plain warning names fallback and user command; never silent mode change |
| Watch-scope escape | Symlink or absolute path reaches outside the approved workspace | Resolve through `ResourcePolicy` before persistence; only existing files/directories are accepted |
| Watch event mistaken for authority | A filesystem notification is treated as proof of success or a safety decision | Observations are advisory change facts only; they cannot authorize, block, or verify work |
| Voice self-confirmation | Realtime tool call includes its own `confirmed: true` for approval | No adapter tool can carry approval. A permission is settled only by a later turn naming the opaque ID; a reply in the same turn the question was asked is refused as `same-turn`, so the model cannot answer itself and a "yes" spoken before the question was heard cannot land |
| Ambient voice disclosure | Always-listening audio is streamed before a wake decision | The confidence-thresholded `Athena` gate runs locally; only the recognized post-wake utterance's raw PCM crosses the Realtime boundary |
| Voice bypasses coding permissions | Realtime calls file or shell tools directly | The session advertises only `submit_turn` and `local_control`; neither can run a tool. Work reaches tools solely as harness input, where the existing permission engine stays authoritative and unchanged |
| Voice widens the session gate | An approval spoken for one action silently authorizes every later tool call | Voice resolves to `allow-once` only. Nothing in the spoken contract distinguishes "yes to this" from "yes to all of these", so `allow-always` is unreachable by voice and remains a keyboard decision |
| Spoken permission laundering | A model-authored sentence claims an action was allowed or denied | Only a tool result settles a permission, and the session instructions forbid reporting an outcome that no tool result carries. Unknown, stale, and ambiguous replies are refused rather than guessed, and closing the bridge denies everything still outstanding |
| Voice ledger becomes a second transcript | Lifecycle counters accumulate utterances, paths, or keys in `voice-usage.jsonl` | The record carries no free-text field: every value is a literal, closed enum, bounded integer, generator-shaped ID, or numbers-only meters tree, and `.strict()` rejects an unexpected key. A rejected wake stores a label, never what was said |

## Security invariants

- Presentation cannot grant permission.
- Agent status cannot mark mutation, tool success, gate success, or completion verified.
- Untrusted project state cannot weaken global accessibility or resource policy.
- Advisory memory/experience cannot deny or auto-approve a tool.
- Optional subsystem failure cannot prevent the first user interaction when core state
  remains working.
- No announcement requires disclosure of raw secret-bearing values.
- Proactive detectors can emit advisory attention only; they cannot approve, deny, or
  mark an outcome verified.
- A non-voice watch exists only after an explicit user request, watches one resolved
  in-workspace resource, and owns no process after its foreground invocation exits.
- The reusable voice router never silently selects an ambiguous session. The direct-harness
  adapter cannot authorize or resolve a canonical permission from model-authored text
  alone, and it cannot reach `allow-always`.
- A spoken work turn is idempotent under retry: a turn is keyed by utterance plus
  normalized text, so a reconnect or a repeated tool call resumes the existing record
  rather than running the work twice, and an in-flight turn cannot be evicted.

## Review gates

- Fuzz malformed and out-of-order semantic envelopes.
- Replay prompt/tool output containing fake status prefixes and escape sequences.
- Test secret-shaped values in paths, summaries, errors, and watcher payloads.
- Test concurrent parent/child permission and announcement isolation.
- Verify project settings cannot override accessibility settings.
- Verify screen-reader mode never emits control sequences from untrusted content without
  sanitization.
