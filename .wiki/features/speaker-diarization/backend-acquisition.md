# Proposed local backend acquisition

**Verified:** 2026-10-06. **State:** proposal only; nothing installed or downloaded.

This is a bounded acquisition decision for the next backend experiment. It does not
approve recording, microphone access, voice enrollment, persistent transcripts,
cloud ASR, deployment, or system changes. See [implementation status](implementation-status.md)
for the synthetic contracts already merged and [privacy](privacy.md) for participant consent.

## Recommended first experiment

Use one native Windows Python environment with PyTorch CUDA wheels and Transformers
for anonymous Nemotron diarization and local Whisper ASR. Add SpeechBrain ECAPA for
synthetic embedding-interface evaluation, keeping identity matching disabled until
separate enrollment consent and calibration exist. All audio processing should remain
local. Public acquisition necessarily contacts package/model hosts; offline inference
must use only the acquired files and must not silently fall back to a cloud service.

The smallest ASR decision is **approve multilingual local `openai/whisper-small` as
the first measured baseline**. This is chunked Whisper inference, not a claim of native
streaming or production latency. Word timestamps need measured alignment tests; they
are estimates. Start with synthetic non-speech inputs after acquisition, then use
separately approved test audio. If the measured baseline misses the chosen latency
budget, bring back a concrete alternative instead of switching providers silently.

## Exact model sources and licenses

The [machine-readable manifest](backend-acquisition-manifest.json) records exact
revisions, file allowlists, sizes and available Git/LFS digests. Never acquire an
entire repository snapshot without its allowlist: duplicate framework weights and
example recordings are deliberately excluded.

| Role | Pinned official snapshot | Code / weight terms |
|---|---|---|
| Diarization | [NVIDIA Nemotron](https://huggingface.co/nvidia/Nemotron-3-Diarization/tree/f667ed73aee57d40cc39428eb768b4fd87a0a29e) | Transformers Apache-2.0; weights [OpenMDW 1.1](https://openmdw.ai/license/1-1/). NeMo Speech Apache-2.0 is a separate implementation, not required by this proposal. |
| ASR | [OpenAI Whisper small](https://huggingface.co/openai/whisper-small/tree/973afd24965f72e36ca33b3055d56a652f456b4d) | Transformers Apache-2.0; this HF snapshot declares Apache-2.0. [Original OpenAI Whisper](https://github.com/openai/whisper/blob/main/LICENSE) is MIT. Preserve both provenance notices rather than silently replacing the HF declaration. |
| Optional embedding backend | [SpeechBrain ECAPA](https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb/tree/0f99f2d0ebe89ac095bcc5903c4dd8f72b367286) | SpeechBrain code and model card Apache-2.0. Cosine similarity is not a calibrated identity probability. |

All three API snapshots report `gated: false`; no new account, token, contact sharing
or gated acceptance was required to read their metadata. Their licenses still apply.
No pyannote Community-1 acquisition is proposed: its contact-sharing gate and terms
would be a separate decision. No NeMo, faster-whisper, WSL, Docker, CUDA Toolkit,
driver upgrade or system PATH change is included.

Nemotron offers up to eight anonymous speakers. Its advertised buffering durations
exclude computation and ASR; no Helios performance has been measured. Native support
was verified in the pinned Transformers source, not by executing the model.

## Environment and package plan

Read-only inventory on Helios: RTX 5070 Ti Laptop GPU, **12,227 MiB VRAM**, driver
577.13 (`nvidia-smi` reports CUDA capability 12.9), approximately 31.4 GiB RAM and
625 GiB free on C:. The CUDA report is driver capability, not proof of an installed
toolkit. Python 3.12.10 exists. Node/pnpm and the Athena dependencies exist; `torch`,
`torchaudio`, `transformers`, `nemo-toolkit`, `speechbrain`, `faster-whisper`,
`ctranslate2`, `numpy`, `soundfile` and `huggingface-hub` were absent from this Python.

Proposed top-level pins:

| Package | Pin and official source | Purpose |
|---|---|---|
| torch | `2.8.0+cu128`, [official Windows/CUDA instructions](https://pytorch.org/get-started/previous-versions/) | Shared inference; BSD-style code license and bundled dependency notices |
| torchaudio | `2.8.0+cu128`, same official index | Matching audio tensor stack; BSD-style code license |
| transformers | `5.19.0`, [release](https://github.com/huggingface/transformers/releases/tag/v5.19.0), commit `c4c4605f961877852b89b97478536bb3a26b6fd1` | Native Nemotron and Whisper support; Apache-2.0 |
| speechbrain | `1.1.1`, [tag](https://github.com/speechbrain/speechbrain/tree/89ead74d163463d30c62329a09cfdb4c54f5abc1) | ECAPA; Apache-2.0 |

The published Windows CPython 3.12 PyTorch wheel index lists these hashes:

- torch: `0ad925202387f4e7314302a1b4f8860fa824357f9b1466d7992bf276370ebcff`
- torchaudio: `cce3a60cd9a97f7360c8f95504ac349311fb7d6b9b826135936764f4de5f782d`

Transitive packages are **not yet resolved or locked**. The first approved acquisition
step must create and review a complete Windows/Python 3.12 lock with versions,
artifact hashes, sources and notices, including numpy, tokenizers, safetensors,
huggingface-hub, SpeechBrain's scientific/YAML dependencies and any audio helpers.
Do not run a loosely pinned installation from this table. Prefer binary wheels;
stop if resolution requires a source build, a missing wheel, a new host dependency,
unreviewed source, or different top-level versions. Transformers 5.19.0 was released
on this verification date; integration compatibility remains untested.

SpeechBrain's pinned HyperPyYAML config constructs Python objects and its checkpoints
need a trusted loader. Review the pinned config, bind paths to the acquired local
directory, disallow arbitrary user configs and avoid permissive pickle loading.
Use Transformers' native implementation with `trust_remote_code=False`.

## Size, isolation and proposed command scope

The selected model files total approximately **1.46 GB decimal** (see exact manifest);
weights are about 397 MB Nemotron, 967 MB Whisper, and 89 MB ECAPA. Downloads for the
CUDA runtime and transitive wheels are larger. Planning estimate: **4–8 GB total
download and 10–20 GB working storage** including wheelhouse/environment/cache.
These package estimates are not verified artifact totals: wheel HEAD size checks
were refused by the host. Proposed hard caps are **10 GB download / 25 GB disk**;
stop and report rather than exceed them. Concurrent memory and latency are unknown.

Keep everything in the isolated task workspace's `athena-runtime` directory, outside
tracked Athena files: `.venv`, `wheelhouse`, `models`, `cache`, `tmp`, and notices.
No global Python installation or user/system configuration writes. Proposed commands
are a plan, not executed commands:

```powershell
# After explicit acquisition approval and review of the complete hash lock:
& 'C:\Users\Nico\AppData\Local\Programs\Python\Python312\python.exe' -m venv $runtimeVenv
& $runtimePython -m pip download --only-binary=:all: --require-hashes -r $reviewedLock -d $wheelhouse
& $runtimePython -m pip install --no-index --find-links $wheelhouse --require-hashes -r $reviewedLock
```

Variables must resolve under the approved workspace; the reviewed lock must use the
official PyTorch CUDA 12.8 index for those wheels and PyPI for reviewed dependencies.
Then a downloader reads the checked-in manifest, requests each fixed revision and
only its listed paths, checks artifact digests, and writes license/provenance notices.
Use fixed revisions, never `main` or unbounded `snapshot_download`. Do not commit
weights, environments, caches, secrets or audio. Set local cache/temp paths and
`HF_HUB_DISABLE_TELEMETRY=1` before acquisition; set `HF_HUB_OFFLINE=1` and local-only
loaders for inference. Verify that offline reload cannot request missing artifacts.

## Work that can proceed before acquisition

Synthetic worker IPC framing, size limits, queue backpressure, process restart,
deadline/abort and epoch fencing can be implemented without models. Add strict worker
ASR/activity messages feeding the existing alignment functions. Build local status
and consent presentation adapters against the existing trusted control seam. Test
missing-backend diagnostics, manifest validation, timestamp offsets, stale worker
events and shutdown with a fake worker. Do not expose model-controlled consent or
authority. Real model adapters, GPU probes and measured latency follow acquisition;
real capture and enrollment remain later, separately consented work.

## Concrete approval to request

Approve the bounded, project-local package/model acquisition above, with local
Whisper-small as the initial ASR baseline, a reviewed transitive hash lock, and the
10 GB download / 25 GB storage caps. Permit synthetic-only offline backend probes.
This approval must not be interpreted as participant opt-in to audio capture or
enrollment. Budget targets for real latency/accuracy and retained transcript/profile
policy still need Nico's decisions before their respective live acceptance phases.
