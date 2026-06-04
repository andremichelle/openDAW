# Audio device-init

- **status:** ENV · **priority:** ENV
- **occurrences:** 2 · **ids:** [704, 765]
- **assessment:** AudioWorkletNode ctor / device start blocked.
- **action:** Graceful 'audio unavailable' dialog.

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
