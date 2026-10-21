# MuScriptor instrument transcription

Implemented with Codex assistance in a fresh managed worktree, independently of the prior
Basic Pitch feature branch. The initial implementation started at canonical upstream `main`
`dc5a69372`; the focused contribution branch `codex/muscriptor-pr` is based on `c4ed4a05d`.
Related request: [openDAW #452](https://github.com/andremichelle/openDAW/issues/452).

## User flow

The feature is opt-in and disabled by default. Builders must set
`VITE_ENABLE_MUSCRIPTOR=true`; see [build and licensing boundaries](../packages/app/studio/MUSCRIPTOR.md).
Disabled builds omit the controls and exclude the implementation, worker and model URLs,
including from source maps. The SDK and `studio-core` have no changes in this contribution.

The dashboard's **Audio to MIDI** action and Import → **Audio to MIDI (MuScriptor)...**
accept an audio file, retain it on a source audio track, and transcribe it locally.
Arrangement regions and session audio clips also expose **Convert Instruments to MIDI...**.
The chosen clip's content is analyzed independently of playback, with progress and cancellation.
One new track and matching MIDI region/clip are created per nonempty detected instrument group,
directly below the source. Arrangement placement, trim, warp mapping, loops, pitch changes and
session slot/loop triggering are preserved. The result is selected and its first editor opened.
All generated tracks are one undoable edit. The file entry's source import is a separate edit.
Before the first model download, a popup states the missing size in MB, the full **616.3 MB**,
Hugging Face as the source, cache reuse and the non-commercial weight terms.
**Download & Continue** starts conversion; **Cancel**, closing the popup or Escape stops it.
For file imports this happens before creating a project or source track. Fully cached models
skip the popup. Cache-only execution cannot silently download files if another tab evicts them.
Cancelled/failed/empty analysis leaves no generated tracks. Source or tempo edits, deletion,
project switching and shutdown discard pending results.

Tracks use Neon for immediate note audition. Their names describe the detected instrument group;
this does not recreate the original instrument timbre. Drums retain MIDI drum keys but currently
also use Neon; replace their instrument with a drum kit for appropriate playback. The model's
velocity tokens encode on/off, not dynamics, so imported note velocity is fixed at 100/127.
There is no arbitrary highlighted-range UI, progressive note preview or real-time capture in this version.
To limit conversion, trim/split a source region first. Instrument categories do not recover original
DAW track identities; multiple parts assigned to the same category share a generated track.

## Model and implementation

The [community ONNX export](https://huggingface.co/cursedhelm/cubaser-muscriptor-medium-onnx)
is a format conversion of Kyutai/Mirelo MuScriptor Medium, not a new checkpoint.
Revision `18b368334ddaeafed4446377eb7d0b63d14ccc1f` is pinned in `muscriptor/Model.ts`.
The four assets total 616274526 bytes and are cached through the existing SHA-256-verified
`ModelStore`/OPFS infrastructure. No weights are committed. The download dialog discloses download
size, local processing, experimental output and CC BY-NC 4.0 (non-commercial) weight licensing.
The first-use size is displayed prominently in decimal megabytes (**616.3 MB**), including in
download/cache progress messages, with the Hugging Face source and browser cache behavior explained.
Official [source code](https://github.com/muscriptor/muscriptor) is MIT; weights have separate terms.
Do not describe this as an unrestricted commercial model or redistribute weights under openDAW's AGPL.

A dedicated worker owns both ONNX sessions and all autoregressive KV caches. This avoids the generic
inference host's per-run main-thread tensor transfers and limited float32/int tensor protocol.
It uses `onnxruntime-web/webgpu`, requires a WebGPU adapter with `shader-f16`, and does not silently
fall back to WASM or another transcription model. Cached bytes are transferred once to the worker.
Cancel terminates the worker, including during session creation or decoding; completion/errors also
terminate it. Sessions/tensors are disposed on ordinary completion. Audio never leaves the browser.

Audio is downmixed and low-pass resampled to 16 kHz inside the worker. Five-second chunks contain
80000 samples, with a zero-padded final chunk. Features follow the export: centered reflected
2048-point periodic-Hann STFT, 160-sample hop, magnitude spectrum, 512 HTK mel bands without
normalization and natural log with epsilon 1e-6. The conditioner emits FP16 embeddings; the decoder
uses 24 layers with 16 heads and 64-value head dimension. Greedy token decoding uses the valid
1393-event vocabulary. GPU-resident caches avoid copying the growing cache through the main thread.
The model's maximum 2000 decoding steps is enforced with an error rather than a silent partial result.

The independent MIDI decoder tracks open `(program, pitch)` pairs. The first chunk starts with
BOS only and generates its own prologue. It forces each subsequent chunk's tie prologue from
actual unfinished notes, matching the official source's boundary approach;
held notes are not split at five seconds. Drum hits are onset-only. Output is clipped to the requested
range. Unknown/unclosed final notes get only the available duration, not invented full-clip sustains.
App-local orchestration accepts an analyzer callback, maps file seconds back through the source timing,
and inserts results atomically. The helpers live in Studio's `src/service/InstrumentTranscription.ts`
and `AudioToMidiTiming.ts`; neither is exported by the SDK or core. The generic inference entry
point does not export MuScriptor; the enabled app loads its optional `/muscriptor` subpath.

## Validation

- Pristine upstream baseline build passed before implementation.
- Real Chrome/WebGPU inference on `audiomass-output.wav`: first five seconds produced 21 notes;
  full 32-second source produced 131 notes in one predicted Acoustic Piano group, about 19.2 seconds
  including session loading in the isolated local test. This is not an accuracy score.
- Official `headache_by_lost_deposit_10s.mp3`: actual model produced 90 drum hits, 16 Electric Bass
  notes and 8 Distorted Electric Guitar notes, about 16.1 seconds including loading.
- Focused tests cover low-pass audio preparation, model feature shape, polyphonic instrument identity,
  ties/retriggers, final range clipping, worker cancellation/errors, multi-track insertion, timing,
  session slots, stale-result rejection, first-editor focus and undo/redo.
- Consent/build-boundary revision: inference tests passed 84/84; focused Studio tests passed 21/21,
  covering consent, cancellation before import, cache-only execution, build gating, MIDI insertion
  and timing. Disabled Studio build passed 25 tasks; enabled Studio + manual build passed 26 tasks.
  Output audits found no MuScriptor model URLs, worker or conversion controls in the disabled build's
  223 scripts/maps, and confirmed the integration and worker in the enabled build's 231 scripts/maps.
- Actual production import/conversion ran in both the in-app browser and desktop Chrome, producing
  aligned source + Drums, Electric Bass and Distorted Electric Guitar tracks. Live undo removed all
  generated tracks together and redo restored them. Temporary integration fixture controls were
  removed before the final build.
- Desktop Chrome's native file picker imported `audiomass-output.wav`. A subsequent run visibly read
  the cached model, reached inference, and Cancel left only the source audio track.

## Local preview

The isolated preview runs at `http://localhost:8092`. The public stock asset catalog does not allow
that origin through CORS (the documented localhost:8080 origin is allowed). Its existing indefinite
catalog retry can therefore block project reopening on a plain preview. The local preview server
proxies the fixed public `https://assets.opendaw.studio` host and rewrites that asset base only in served
JavaScript; no browser security flags or production source URLs were changed. Model URLs remain pinned
Hugging Face URLs. OPFS projects, samples and model cache remain specific to this browser and origin.

The prototype was written against the actual ONNX graph signatures and public tokenizer/conditioning
source. No claim of browser parity with the original PyTorch model or exact instrument recovery is made.

## First-chunk inference correction

The initial browser implementation teacher-forced an empty tie prologue on the first chunk as well
as continuations on later chunks. Upstream's `_generate_token_stream` passes no prompt for the first
chunk and only teacher-forces later chunks (`batch_start > 0`). The decoder now returns BOS alone
for the first chunk; generated prologue tokens pass through the same state machine as ordinary model
output. Later chunks still receive sorted `(program, pitch)` ties, preserving sustained notes.
A regression test covers the first prompt and subsequent continuation of the same bass note.

Real Chrome/WebGPU comparison on the same official ten-second example, with identical model assets,
audio preparation and greedy decoding (only first-chunk prompt initialization changed):

| Instrument | First five seconds before | First five seconds after | First onset before | First onset after |
| --- | ---: | ---: | ---: | ---: |
| Electric Bass | 0 notes | 16 notes | 5.23 s | 0.16 s |
| Distorted Electric Guitar | 0 notes | 8 notes | 6.39 s | 0.16 s |
| Drums | 47 hits | 44 hits | 0.00 s | 0.16 s |

Full output changed from 16 bass / 8 guitar / 90 drum events to 32 bass / 16 guitar / 87 drum events.
This confirms recovery of the missing instrument parts, not a ground-truth accuracy score or parity
with the hosted service. Inference tests after the correction passed 81/81; focused lint and whitespace
checks passed, and the rebuilt Studio dependency graph passed all 25 tasks.
