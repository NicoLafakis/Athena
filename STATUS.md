# Voice capability ("blind-first Jarvis")

Last updated: 2026-09-24
Spec of record: [`.wiki/features/blind-first-jarvis/direct-harness-voice.md`](.wiki/features/blind-first-jarvis/direct-harness-voice.md)

## Current state

The voice flow uses the shared `HarnessSessionController`, canonical permission decisions through `VoiceAttentionBridge`, a persistent Windows wake listener, reconnectable Realtime sessions, and local lifecycle telemetry. Voice and keyboard answers share the same validated permission path. The wake listener now drops recognized phrases while Athena audio is playing, preventing output from feeding back as a new command.

The GPT-6 provider lineup and pricing metadata were updated against the OpenAI API catalog on 2026-09-24.

## Remaining work

- Complete the live acceptance run with screen reader off, NVDA, and Narrator, using the procedure in the spec's [acceptance runbook](.wiki/features/blind-first-jarvis/acceptance-runbook.md).
- Reconcile any new findings from that hardware run with the spec and implementation.

The remote `main` already contains the automated voice work described in the spec; the local update adds the playback echo guard and keeps the status summary aligned with that implementation.
