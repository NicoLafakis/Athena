# Live speaker diarization and optional voice-to-name matching

**Tier:** 3 - audio, biometric profiles, attribution, permissions
**Date:** 2026-10-06
**Status:** DESIGN ONLY; implementation and real-hardware evaluation pending
**Product owner:** Nico

## Objective and boundary

Give Athena a speaker-tagged transcript of an explicitly consented conversation. First
answer who spoke when using anonymous session labels; optionally suggest a name from
separately consented enrolled profiles. A suggestion can be wrong and is never proof of
identity or authorization to run a tool, approve a permission, access a project, or
disclose another person's memory.

This package authorizes no recording, installation, model download, enrollment, runtime
change, or deployment. It prepares implementation. Existing single-user voice behavior
and its outstanding [live acceptance](../blind-first-jarvis/acceptance-runbook.md) remain
separate from this feature's future acceptance.

## Goals

- Stable anonymous labels within one uninterrupted capture session, including unknown
  speakers, overlap, corrections, disconnects, and explicit state resets.
- Inspectable attribution provenance and uncertainty in text and accessible speech.
- Optional local profile matching with participant opt-in, review, retention and deletion.
- Replaceable local diarization/identity workers feeding one authoritative Athena harness.

## Non-goals

Voice authentication, guaranteed identity, covert enrollment, passive room surveillance,
cross-device biometric sync, automatic durable memory about named people, a second agent
or competing session writer, and automatic execution of everything said in a meeting.
Meeting transcription and spoken command admission are different product modes.

## Proposed implementation decisions

Prefer separate conferencing participant tracks and platform metadata when available.
They avoid unnecessary biometric inference, but an account label may represent a shared
microphone rather than an individual. Preserve that distinction visibly.

For mixed audio, evaluate Nemotron-3-Diarization as the GPU candidate, SpeechBrain ECAPA
as an optional enrollment matcher, diart as a CPU prototype candidate, and Community-1
as an offline comparison. These are candidates, not selected dependencies or proven
Helios performance. See [research and licenses](research.md).

Ship anonymous attribution before enrollment. Match only clean single-speaker segments,
permit abstention, and keep human corrections separate from automatic enrollment.

## Implementation package

- [Technical design and proposed event contract](design.md)
- [Consent, storage, retention and threat controls](privacy.md)
- [Candidate research and separate code/weight licenses](research.md)
- [Phased backlog, acceptance tests and release gates](tasks.md)

## Decisions Nico still needs to make

1. First product mode: post-wake commands, explicitly started room conversation, or
   conferencing tracks. Room/conference capture cannot inherit wake-only consent.
2. ASR choice: fully local speech-to-text or explicitly disclosed existing cloud audio
   use. A local diarizer does not make Realtime audio processing local.
3. Whether persistent profile matching is needed at all; who may enroll and review
   names; accepted profile expiry and transcript retention periods.
4. Target simultaneous speaker count, supported devices/languages/acoustics, and numeric
   latency, diarization error and false-name budgets before the evaluation begins.
5. Native Windows GPU worker feasibility versus a separately approved Linux/WSL worker;
   deployment location, dependency versions, and license/notice approval.

The first implementable step is schema and consent-state fixtures using synthetic events.
Real participant capture and enrollment require each actual participant's affirmative
opt-in in a later session; Nico's request for paperwork supplies neither.
