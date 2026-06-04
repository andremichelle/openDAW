# Mixdown offline-render OOM

- **status:** OPEN · **priority:** P3
- **occurrences:** 4 · **ids:** [70, 71, 291, 302]
- **assessment:** Array-buffer allocation / quota during large render (Mixdowns.ts, AudioOfflineRenderer.ts).
- **action:** Catch allocation/quota, surface 'render too large' message instead of crash.

[< back to index](error-triage.md)

## Reports

### RangeError: Array buffer allocation failed
- **occurrences:** 2 · **ids:** [291, 302] · **span:** 2025-10-29->2025-11-02 · **builds:** 2 · **browsers:** Chrome/Win
- **source:** `src/service/Mixdowns.ts:105`
- **stack:**
  - `at new ArrayBuffer (<anonymous>)`
  - `at n.encodeFloats (../../../studio/core/dist/WavFile.js:70:20)`
  - `at o (src/service/Mixdowns.ts:105:33)`
  - `at async n.exportStems (src/service/Mixdowns.ts:46:8)`

### Error: QuotaExceededError: The operation failed because it would cause the application 
- **occurrences:** 1 · **ids:** [71] · **span:** 2025-08-16->2025-08-16 · **builds:** 1 · **browsers:** Chrome/Win
- **source:** `src/audio/AudioOfflineRenderer.ts:57`
- **stack:**
  - `at ne (../../../lib/std/dist/lang.js:22:73)`
  - `at e (src/audio/AudioOfflineRenderer.ts:57:12 (panic))`
  - `at async r.start (src/audio/AudioOfflineRenderer.ts:40:12)`
  - `at async src/service/StudioService.ts:288:16`

### RangeError: Array buffer allocation failed
- **occurrences:** 1 · **ids:** [70] · **span:** 2025-08-16->2025-08-16 · **builds:** 1 · **browsers:** Chrome/Win
- **source:** `src/audio/AudioOfflineRenderer.ts:68`
- **stack:**
  - `at new ArrayBuffer (<anonymous>)`
  - `at Ii (../../../studio/core/dist/Wav.js:23:16)`
  - `at t (src/audio/AudioOfflineRenderer.ts:68:25 (encodeWavFloat))`
  - `at r.start (src/audio/AudioOfflineRenderer.ts:42:18 (saveZipFile))`

## Investigation (root cause + recommended fix)

**Root cause:** Resource exhaustion, not a logic bug. A large/long render produces an `AudioData`/`AudioBuffer` whose WAV encoding requires `new ArrayBuffer(44 + numberOfFrames * numberOfChannels * 4)` at `packages/lib/dsp/src/wav-file.ts:148-149` (`WavFile.encodeFloats`). For very long mixdowns or many stems this single contiguous allocation exceeds the engine limit (RangeError) or the storage write trips the quota (QuotaExceededError). The app's `src/audio/AudioOfflineRenderer.ts` referenced in the older stacks (ids 70/71) no longer exists; it was replaced by `OfflineEngineRenderer` driven through `packages/app/studio/src/service/Mixdowns.ts` (current stem encode is `WavFile.encodeFloats(stemData)` at `Mixdowns.ts:160`, mixdown encode at `Mixdowns.ts:95`/`:132`).

**Evidence:** Stacks 291/302 (current build): `RangeError: Array buffer allocation failed → new ArrayBuffer → WavFile.encodeFloats → Mixdowns.exportStems`. Stacks 70/71 (Aug-2025 build) hit the deprecated app renderer. In current source, `exportStems`'s `saveZipFile` is already wrapped by `Promises.tryCatch` (`Mixdowns.ts:85-90`), and `exportMixdown` is wrapped at the call site (`StudioService.ts:227-229`), so neither path crashes the app today — but the surfaced message is the raw `String(error)` ("Array buffer allocation failed"), which is unfriendly.

**Recommended fix:** Two parts. (1) Wrap the encode allocation itself with `tryCatch` from `@opendaw/lib-std` around `WavFile.encodeFloats(...)` in `Mixdowns.ts` (the stem-loop call at :160 and the mixdown calls at :95/:132) so the `RangeError`/`QuotaExceededError` is caught at the allocation site rather than relying on outer wrappers; on failure show a friendly `RuntimeNotifier.info({headline: "Render Too Large", message: "This mixdown is too large to fit in memory. Try shortening the project, lowering the sample rate, or exporting fewer stems."})`. (2) Optionally pre-check projected byte size from `numberOfFrames * numberOfChannels * 4` before encoding and short-circuit with the same friendly message (and/or stream stems to the zip one at a time, which the loop already does) to avoid attempting a doomed allocation. Use `tryCatch`, not raw `try/catch`, per repo style.
