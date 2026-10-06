# Candidate research and license ledger

**Verified:** 2026-10-06 against the linked primary sources. No models downloaded,
dependencies installed or Helios performance measured. Pin revisions and recheck
license files and transitive dependencies before future acquisition/distribution.

| Candidate / role | Code license | Weight license / access | Evidence and limits |
|---|---|---|---|
| Nemotron-3-Diarization: GPU streaming candidate | NeMo Speech Apache-2.0 | OpenMDW-1.1; model card permits commercial use | Released Sept 23, 2026; streaming/offline, up to 8 anonymous speakers. 0.32/0.64/1.04 s are input buffering, excluding compute and ASR. 16 kHz mono input; Linux preferred. Windows/Helios feasibility untested. [Model card](https://huggingface.co/nvidia/Nemotron-3-Diarization), [NeMo Speech](https://github.com/NVIDIA-NeMo/Speech), [weight terms](https://openmdw.ai/license/1-1/) |
| SpeechBrain ECAPA: optional enrolled-profile embeddings | SpeechBrain Apache-2.0 | Model Apache-2.0 | CPU/CUDA option; compare embeddings with cosine similarity/distance. A score is not a calibrated identity probability. [Model card](https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb), [code/license](https://github.com/speechbrain/speechbrain) |
| diart: CPU prototype candidate | MIT | Depends on selected segmentation/embedding checkpoints; audit separately | Streaming algorithm has adjustable 0.5-5 s latency. This is not measured end-to-end latency or a CPU performance guarantee. [Repository](https://github.com/juanmc2005/diart) |
| pyannote Community-1: offline baseline | pyannote.audio MIT | CC-BY-4.0; gated download requires terms/contact sharing | Can run offline after acquisition. Consider optional telemetry before local-only use. Offline baseline is not a drop-in live stream. [Model card](https://huggingface.co/pyannote/speaker-diarization-community-1), [code and telemetry](https://github.com/pyannote/pyannote-audio) |
| Older streaming Sortformer: comparison only | Audit pinned runtime separately | v2 CC-BY-4.0; v2.1 NVIDIA Open Model License | Both are 4-speaker variants; don't conflate their terms with Nemotron. [v2](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2), [v2.1](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1) |

[NVIDIA's ASR integration guide](https://huggingface.co/nvidia/Nemotron-3-Diarization/blob/main/ASR_INTEGRATION_GUIDE.md)
is the reference for the future alignment adapter. Athena still needs its own validated
timestamps, stream lifecycle, error handling and admission contract; a vendor example
does not establish compatibility with the current Realtime intent adapter.

## Acquisition and redistribution checklist for implementation

Record artifact URL, immutable model revision/hash, runtime commit/version, code license,
weight license, required notices/attribution, dependency weight terms, gates/contact
disclosure, intended use and redistribution format. Preserve license/notice files in a
future distribution. Code permissiveness does not supersede weight obligations. Do not
accept gated terms or share contact information on Nico's behalf during paperwork.

## Hardware and latency evaluation plan

Inventory Helios GPU/VRAM, CPU/RAM, driver, OS, worker runtime and supported acceleration
without inferring compatibility from a product name. Model support lists are not a real
probe. After separately approved acquisition, run warm/cold worker readiness and consented
or appropriately licensed fixture tests before microphone experiments.

Measure capture buffering, resampling, ASR word delay, diarizer buffer and compute,
alignment holdback, identity evidence accumulation, IPC/queue delay, transcript rendering
and harness admission separately. Report p50/p95/p99, real-time factor, peak RAM/VRAM,
CPU/GPU utilization, dropped frames and long-session growth. Compare all three buffering
configurations under idle and representative Athena contention, battery/thermal variation,
and reconnects. End-to-end attribution latency is not a model's advertised buffer value.
Record overlap-aware DER with scoring convention/collar, word-speaker attribution error,
unknown rate, label churn, false named matches, false rejects, and confidence intervals.

| Helios result | Status |
|---|---|
| Hardware inventory, worker compatibility, cold/warm startup | Not evaluated |
| Sustained streaming compute and full transcript delay | Not evaluated |
| Diarization/ASR quality and identity calibration | Not evaluated |
| Privacy/network-denial and deletion verification | Not evaluated |

Choose based on measured product budgets in [tasks](tasks.md), not vendor benchmark
rankings. No benchmark result or voice identity guarantee is claimed by this package.
