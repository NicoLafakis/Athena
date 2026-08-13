# Direct-harness voice - live acceptance runbook

**Parent:** [Direct-harness voice specification](direct-harness-voice.md) |
[Voice component](voice.md) | [Observability](observability.md)

This is sequence item 8, the one thing between the voice upgrade and complete. It cannot
be automated: it needs a real microphone, a human who can hear, and two screen readers.
Everything else in the package is gated and green.

Every statement below must be **observed, not inferred**. Tick the boxes in the
[acceptance script](direct-harness-voice.md#acceptance-script) as you go, and record what
actually happened next to any box that does not pass cleanly. A box that "probably works"
is a box that failed.

## Before you start

```sh
git pull
pnpm install --frozen-lockfile
pnpm build
```

`dist/` is gitignored and `bin/athena.js` loads `dist/cli.js`, so skipping the build runs
the previous machine's binary against this source (AGENTS.md rule 7).

Then prove the microphone path on its own, before involving the paid provider:

```sh
node bin/athena.js voice probe
```

It asks you to say **"Athena voice probe"**. It now drives the production persistent
listener, so a pass here means the real wake chain works: process spawn, readiness round
trip, JSONL framing, PCM conversion, wake state machine, then Realtime understanding and
playback. A failure names which of those stages broke.

Have ready: a machine that is already authenticated (`athena voice auth` done once), a
quiet room, and — for the last item — NVDA and Narrator installed.

## The run

Launch once and do not touch the keyboard again until step 8:

```sh
node bin/athena.js voice
```

| # | Do this | Observe |
|---|---|---|
| 1 | Launch | Marin audibly says Athena is ready |
| 2 | Leave idle > 2 old timeout windows (~3 min) | Microphone does **not** cycle; the Windows privacy icon stays steady; no paid request is made |
| 3 | "Athena, tell me what repository you are in and summarize the current objective" | The answer comes from the harness session, not model knowledge |
| 4 | Ask for a safe read-only inspection | The run trace contains the turn and its tool evidence |
| 5 | Request a mutation | The spoken permission names tool, target, and consequence. Try to break it: answer with a wrong ID, answer twice, and say "yes" immediately in the same breath — none of those may authorize it |
| 6 | "Athena status" during longer work | Matches semantic runtime state, including `waiting-permission`; not a model guess |
| 7 | Let Marin finish | Returns to wake standby with no keyboard action; falling tone plays |
| 8 | "Athena stop listening" | Microphone closes, process exits cleanly, the session remains resumable |
| 9 | Disconnect the network mid-session | Harness state preserved; Athena says whether the utterance needs repeating, and reopens |
| 10 | Repeat 1-8 with NVDA on, then Narrator on | No critical state missing; routine speech not duplicated |

Step 5 is the one to be adversarial about. It is the only step where a bug is a security
bug rather than an annoyance, and the refusal paths are exactly what was hardest to get
right.

Step 9 has two distinct correct answers and you must check which one you got: if the drop
landed **after** the harness turn started, Athena should say the work survived and you need
not repeat it; if the request never crossed, she should ask you to say it again. Saying the
wrong one is a defect even though both sound reassuring.

## Reading the measurements afterward

Latency and cost land in `~/.athena/voice-usage.jsonl`, one JSON object per line. Nothing
in that file contains what you said — see [observability](observability.md).

```sh
# ready cue: budget is p95 < 3s
grep '"event":"session.ready"' ~/.athena/voice-usage.jsonl

# speech -> first spoken feedback: budget is p95 < 2.5s
grep '"event":"turn.feedback"' ~/.athena/voice-usage.jsonl

# harness work, measured separately from the feedback budget
grep -E '"event":"turn.(completed|failed)"' ~/.athena/voice-usage.jsonl

# provider cost for the session
grep '"event":"provider.usage"' ~/.athena/voice-usage.jsonl
```

Record the p95 of each `ms` field against its budget in the spec's Performance section.

## The measurement that decides the next build

Count `wake.accepted` against `wake.rejected` across the run, and note every time Athena
woke when you did not address her, or missed you when you did:

```sh
grep -c '"event":"wake.accepted"' ~/.athena/voice-usage.jsonl
grep -c '"event":"wake.rejected"' ~/.athena/voice-usage.jsonl
```

The spec leaves one question open on purpose: whether constrained continuous
`System.Speech` has an acceptable false-positive and false-negative rate, or whether a
dedicated local wake-word sidecar is needed behind the existing detector seam. That is a
**measurement**, not a preference — this run is what answers it. Do not return to
free-form Windows dictation, and do not stream pre-wake audio to the provider, whatever
the numbers say.

## If something fails

Voice failure is designed to be nonfatal: ordinary `athena` and `athena exec` keep working,
the credential is untouched, and the session stays resumable. Capture the stable text — it
names the component, the backend, and a recovery command — and file it against the
relevant sequence item rather than patching around it.
