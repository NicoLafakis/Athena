# Direct PCM Voice Capture & GPT-Live-1.1 Engine Upgrade

**Tier:** 3 — voice transport, audio capture, and live model protocol
**Date:** 2026-11-20
**Status:** Implemented on `feat/design-features-buildout`
**Parent:** [Blind-first Jarvis overview](00-overview.md) | [Direct-harness voice](direct-harness-voice.md)

## Problem verified in live use (2026-11-20)

During live testing of `athena voice`, two compounding defects degraded conversational quality:

1. **Windows `System.Speech` dictation bottleneck:** In open-conversation mode, `WindowsPersistentWakeInput` still routed microphone audio through the legacy Windows `System.Speech` offline dictation recognizer. That recognizer clipped sentences on brief pauses and produced garbled `wakeTranscript` strings ("lost in translation") displayed as `You:` in the Voice HUD.
2. **Realtime model ceiling:** `src/voice/realtime.ts` only exposed `gpt-realtime-2.1-mini` and `gpt-realtime-2.1`, and did not request OpenAI input audio transcription (`gpt-live-transcribe`), even though the account has access to `gpt-live-1`, `gpt-live-1.1`, `gpt-live-transcribe`, `gpt-realtime-2.1`, and `gpt-realtime-2.1-mini` (verified against `GET /v1/models` on 2026-11-20).

## Architecture

Keep `VoiceRealtimeClient` and `VoiceCommandInput` as the stable seams in `src/voice/daemon.ts` so the harness controller, permission rails, turn ledger, and Ink `VoiceHud` require zero authority changes:

```text
Open conversation (default):
  Windows winmm.dll (24 kHz PCM16LE)
    -> PcmVadSegmenter (pre-roll + RMS onset + silence tail + playback mute)
    -> LiveVoiceClient (gpt-live-1.1 / gpt-live-1 at /v1/live/sessions)
       OR RealtimeVoiceClient (gpt-realtime-2.1* at /v1/realtime + gpt-live-transcribe)
    -> VoiceHud (real OpenAI userTranscript + dual live waveforms)
    -> HarnessSessionController (submit_turn / local_control)

Wake-word gated (--wake-word):
  WindowsPersistentWakeInput (System.Speech on-device wake gate) -> same client seam
```

## Components

1. **`src/voice/windows-pcm-capture.ts`**
   - `PcmVadSegmenter`: pure deterministic energy/silence VAD over 24 kHz mono PCM16LE chunks with a 300 ms pre-roll ring buffer (never clips the first syllable), configurable onset RMS threshold, 850 ms silence tail, 300 ms minimum utterance guard (drops clicks/coughs), and mute-during-playback guard.
   - `WindowsDirectPcmInput`: supervised PowerShell + compiled C# `winmm.dll` (`waveInOpen`/`waveInAddBuffer`) 24 kHz 16-bit mono PCM streamer emitting 60 ms JSONL frames (`{ pcm, level }`) with zero native npm build dependencies.
2. **`src/voice/live-client.ts`**
   - `LiveVoiceClient`: implements `VoiceRealtimeClient` for `gpt-live-1.1` and `gpt-live-1` over `wss://api.openai.com/v1/live/sessions`, initializing with `session.start` (`delegation: { type: 'client' }`, 24 kHz PCM, Marin voice) and surfacing both `transcript` (Athena) and `userTranscript` (user).
3. **`src/voice/realtime.ts`**
   - Enables `audio.input.transcription: { model: 'gpt-live-transcribe' }` in `session.update` and captures `conversation.item.input_audio_transcription.completed` into `RealtimeTurnResult.userTranscript`.
4. **CLI & HUD (`src/cli/args.ts`, `src/cli/voice.ts`)**
   - Supports `--model gpt-live-1.1|gpt-live-1|gpt-realtime-2.1|gpt-realtime-2.1-mini`.
   - Default open conversation uses `WindowsDirectPcmInput` (direct 24 kHz PCM, no `System.Speech` dictation) and displays OpenAI's real `userTranscript` in `VoiceHud`.

## Invariants preserved

- **Permissions & authority:** Unchanged. Neither `gpt-live-1.1` nor `gpt-realtime-2.1` holds file tools or permission authority; all work runs through `HarnessSessionController` and `VoiceAttentionBridge`.
- **Accessibility:** `--accessibility screen-reader` and `--keyboard` remain append-only and never mount the visual HUD.
- **Privacy & wake-word mode:** `--wake-word` retains strict on-device `"Athena"` gating before any audio leaves the machine.
