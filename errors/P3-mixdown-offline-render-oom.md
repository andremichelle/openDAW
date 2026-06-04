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
