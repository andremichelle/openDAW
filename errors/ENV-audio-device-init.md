# Audio device-init

- **status:** FIXED (#765 handled; #704 old environmental) · **priority:** ENV
- **occurrences:** 2 · **ids:** [704, 765]
- **assessment:** #765 (`AudioWorkletNode` ctor `InvalidStateError`) is caught: `startAudioWorklet` is synchronous (`Project.ts:266`, constructs the worklet inline), so the `tryCatch(() => project.startAudioWorklet(...))` at `StudioService.ts:511` shows a graceful "Audio-Engine Error" dialog instead of crashing (verified). #704 ("Failed to start the audio device") is an old (2026-02-08) single-occurrence iOS-Safari device refusal (suspended `AudioContext`) — OS-level/environmental, no recurrence in ~4 months. No new code needed.

[< back to index](error-triage.md)

## Reports

### InvalidStateError: [DOMException] Failed to construct 'AudioWorkletNode': AudioWorkletNode cannot b
- **occurrences:** 1 · **ids:** [765] · **span:** 2026-03-07->2026-03-07 · **builds:** 1 · **browsers:** Chrome/Win
- **source:** `src/service/StudioService.ts:457`
- **stack:**
  - `at new mC (../../../studio/core/dist/EngineWorklet.js:54:8)`
  - `at $m.createEngine (../../../studio/core/dist/AudioWorklets.js:31:15)`
  - `at Br.startAudioWorklet (../../../studio/core/dist/project/Project.js:134:62)`
  - `at t (src/service/StudioService.ts:457:47)`

### InvalidStateError: [DOMException] Failed to start the audio device
- **occurrences:** 1 · **ids:** [704] · **span:** 2026-02-08->2026-02-08 · **builds:** 1 · **browsers:** ?/macOS

## Investigation (root cause + recommended fix)

**Root cause:** Environmental audio-device failure at engine start. 765 = `AudioWorkletNode` ctor throws because `engine-processor` was never registered in the worklet global scope (the `addModule` worklet script failed to load, e.g. blocked/aborted), reported through `StudioService.ts:457` in that build (`this.engine.setWorklet(project.startAudioWorklet(...))`). 704 = `Failed to start the audio device` on iOS Safari (logtail `iPhone OS 18_7 ... AudioContext state: suspended`), where the OS refused to start the device (busy/blocked/no gesture). Both are device/platform conditions, not logic bugs.

**Evidence:** 765 stack: `new EngineWorklet` -> `createEngine` -> `Project.startAudioWorklet` -> `StudioService.ts:457:47`. 704 logtail: mobile Safari, `AudioContext state: suspended, sampleRate 48000`, `isTrusted:false`. `looksLikeExtension:false`, `foreignOrigin:null`.

**Recommended fix:** Already largely fixed in current source: the call site moved to `StudioService.ts:511` and is now wrapped, `const {status, value: worklet, error} = tryCatch(() => project.startAudioWorklet(restart, {}))`, showing an "Audio-Engine Error" `Dialogs.info` on failure (`StudioService.ts:512-519`) instead of crashing. Recommendation: confirm this guard catches the async `addModule`/device-start path that 704 hit (the worklet-module load and `AudioContext` resume may reject outside this synchronous `tryCatch`); if so, wrap those in the same graceful "audio unavailable" dialog. No ignore-list entry needed once the dialog path covers both.
