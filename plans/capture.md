# Capture and recording pipeline: clean rewrite with abstracted IO

Status: plan, 2026-10-20. Nothing implemented. Triggered by issue #479 (fixed in 8280789a4).

## 1. What the pipeline is today

Audio and MIDI capture live in `packages/studio/core/src/capture` (about 2.2k lines, 2.3k lines of tests) plus
`RecordingWorklet.ts`, `MonitoringRouter.ts`, `AudioDevices.ts` and `midi/*` in core, `RecordingProcessor.ts` in
core-processors, and a second `AudioDevices.ts` in `app/studio/src/audio`.

1. `CaptureDevices` builds one `Capture` per audio unit (`CaptureAudio` or `CaptureMidi`) from the `CaptureBox`.
2. `Recording.start` (static singleton) prepares every armed capture, calls `engine.prepareRecordingState` and
   terminates everything when `isRecording` and `isCountingIn` both read false on the main thread.
3. `CaptureAudio` owns the `getUserMedia` stream, the gain chain, a keep-alive sink, direct and effects monitoring
   and a prepared `RecordingWorklet`. `RecordAudio` turns the delivered frames into takes and regions.
4. `CaptureMidi` owns the Web MIDI subscriptions, forwards every note to the engine and keeps a separate
   retroactive capture buffer. `RecordMidi` turns notes into takes and note regions.
5. `RecordAutomation` records parameter writes into value regions.

## 2. Findings

### Timing
1. Three clocks are mixed. Audio takes are anchored on the audio-thread context time (engine `recordingStart`,
   processor `firstQuantumTime`, now `recordingStopTime`). MIDI notes are placed by extrapolating the main-thread
   `engine.position` (updated per animation frame) with `performance.now()` (`RecordMidi.writePositionAt`).
   The MIDI capture buffer uses `performance.now()` or the rAF position (`CaptureMidi.#computeCaptureDelta`).
   Automation uses `performance.now()` for its hold detection.
2. Loop wraps are detected on the main thread by "position went backwards" in both `RecordAudio` and `RecordMidi`.
   The engine knows the exact wrap frame but does not report it, so take boundaries are computed from the tempo
   map instead of from what the engine actually rendered.
3. MIDI latency is a single `outputLatency` converted to pulses with the bpm at record start, then ADDED to the
   write position. The audible position is the engine position minus the output latency, so the sign looks
   wrong, and a tempo change during the take makes the pulse value stale. To verify with a test before changing.
4. Live notes reach the engine through `engineCommands.noteSignal` without a timestamp: they start at the next
   quantum after the message arrives (message latency plus up to one quantum of jitter). Same class as #356
   (MIDI out timing).
5. #479 was one more instance of "the main thread observed it, so that is when it happened". Every remaining
   instance is listed above.

### Workarounds that leak into the recording logic
6. `RecordAudio` carries the Web Audio workarounds inline: anchor wait plus wallclock fallback
   (`ANCHOR_WAIT_SECONDS`), latency re-read at placement because `outputLatency` reads 0 before output started,
   the tail wait fallback added for #479, the `minTakeSeconds` placeholder for #1129, the zero-duration delete
   for #840.
7. `CaptureAudio.prepareRecording` asks the user to approve when `outputLatency` is undefined, the keep-alive sink
   keeps the source's input delay settled, `RecordingProcessor` waits `SETTLE_QUANTA` before reporting the first
   quantum. These are browser facts and belong in a browser IO implementation, not in core.
8. `InputLatency` mixes a per-track override, a preference and the "equals output" sentinel. A desktop driver
   reports the real input latency, so this becomes a browser-only fallback.

### Structure
9. `finalizeTake` (older take action and scope) is duplicated verbatim in `RecordAudio` and `RecordMidi`.
10. `Recording` is static global state (`#isRecording`, `#instance`, `wasCountingIn`, `wasStartingAt`) although it
    belongs to one project.
11. `CaptureMidi` has two recorders: the real one (`RecordMidi`) and the retroactive capture buffer, each with its
    own timing and note pairing.
12. Two `AudioDevices` classes (core and app/studio) with overlapping permission and enumeration logic.
13. `MidiDevices` is a static singleton over `navigator.requestMIDIAccess`. `SoftwareMIDIInput` and the software
    outputs fake the DOM `MIDIInput`/`MIDIOutput` interfaces, so everything downstream is typed against Web MIDI.
14. `CaptureAudio` (402 lines) mixes stream lifecycle, gain, channel count, two monitoring modes, a monitor output
    device via `HTMLAudioElement.setSinkId`, and recording preparation.
15. Live take growth. An audio take changes `duration`, `loopDuration` and the file's `endInSeconds` on every
    position update (every animation frame while recording), so each frame produces three field updates that sync
    to the engine and add one unmarked entry to the editing pending list. A MIDI take only changes its region at
    beat boundaries, plus the duration of each held note per frame. Cost not measured.
16. `MonitoringRouter` caps effects monitoring at 8 channels (`MAX_MONITORING_CHANNELS`).

## 3. Target

### Principles
1. One clock: the audio frame. Every input (audio frame, MIDI message) and every transport event (recording
   start, stop, loop wrap, count-in end) carries a frame stamp on the same timeline. The main thread never infers
   timing from when it observed something.
2. Recording is a pure function: `(transport segments, stamped input, latencies) -> takes`. It is testable without
   Web Audio, a project or a worklet.
3. IO is a port. Core talks to interfaces. The browser implementation (Web Audio, `getUserMedia`, Web MIDI) and a
   later desktop implementation (`cpal`, `midir`, see `plans/tauri.md`) sit behind them. Browser workarounds live
   only in the browser implementation.
4. SDK compatibility: `CaptureAudio`, `CaptureMidi`, `CaptureDevices`, `Recording`, `MidiDevices`, `AudioDevices`
   keep their exports as facades until a major SDK bump.

### Packages
Recommendation: a new package `@opendaw/studio-io` (folder `packages/studio/io`) for the ports and the browser
implementation. The take writing stays in core under `capture/`, because it writes boxes through `Project`,
`editing` and the box graph, and moving it out would create a cycle with core.

1. `studio-io` (no box graph, no project)
   1. `AudioInputPort`: list devices, open a stream with a channel count, report `inputLatency`, deliver chunks
      as `{frame: int, planes}` where `frame` is the context frame of the first sample.
   2. `MidiInputPort` / `MidiOutputPort`: list ports, hot-plug notifications, messages stamped in context frames.
      The browser implementation converts `MIDIMessageEvent.timeStamp` with `AudioContext.getOutputTimestamp`.
   3. `AudioOutputPort`: output device selection and `outputLatency` (today `setSinkId` plus `AudioOutputDevice`).
   4. `MonitorPort`: direct monitoring (desktop drivers can do it in hardware) and the effects monitoring route.
   5. `browser/`: the current code moved here, unchanged in behaviour first: `RecordingWorklet` plus ring,
      `RecordingProcessor`, the keep-alive sink, the settle quanta, the `outputLatency` fallback dialog,
      `SoftwareMIDIInput`, `MIDIReceiver`.
2. `core/capture` (domain)
   1. `RecordingSession` (per project, replaces the `Recording` statics) collects armed captures, drives the
      engine and owns the transport segment log.
   2. `TakeWriter` for audio and notes on one shared `TakePolicy` (older take action and scope).
   3. `CaptureAudio` and `CaptureMidi` shrink to arm state, settings and port binding.
   4. The retroactive MIDI capture becomes a `RecordingSession` that is always listening, on the same event log.

### Engine side
1. Transport segments reported by the engine with frame stamps: recording start (exists), recording stop (added
   for #479, quantum end, should become the exact frame inside the quantum for `pauseOnLoopDisabled`), loop wrap,
   count-in end. Rust: `crates/engine/src/lib.rs` already computes each of these inside `render`.
2. Live notes with a frame stamp so the engine starts them at the right sample inside the quantum.

## 4. Phases

Each phase ships on its own, with tests first and bit-identical behaviour where it is not the bug being fixed.

1. Characterization tests. Pin today's results for audio takes (start offset, loop takes, count-in, stop tail),
   MIDI takes (position, duration, wrap, pending notes), retroactive capture and automation. Add the MIDI latency
   sign test from finding 3 and confirm or reject it.
2. `studio-io` package with the port interfaces and the browser implementation as a move of the existing code.
   Core re-exports the old names. No behaviour change.
3. Engine segment reports (wrap, exact stop frame, count-in end) through the engine state or the engine to client
   protocol. No consumer yet.
4. Audio takes from segments plus stamped chunks. Delete main-thread wrap detection, anchor wait, wallclock
   fallback and placement re-read from `RecordAudio`. Live region growth throttled or moved to a view overlay
   (decision 3).
5. MIDI stamped in context frames. `RecordMidi` on segments. Merge the retroactive capture into it. Stamped live
   notes in the engine (closes #356 for input).
6. `RecordingSession` replaces the statics, `TakePolicy` is shared, `RecordAutomation` moves onto the same
   segments and frame stamps.
7. Desktop port implementation (`cpal`, `midir`), together with the native engine phase in `plans/tauri.md`.

## 5. Decisions for you

1. Package name and split: `studio-io` for ports plus browser implementation, take writing stays in core.
   Alternative: `core-capture` holding both, which needs the box graph and `Project` and so drags core along.
2. Segment transport: extend `EngineState` (atomic with the flags, as done for #479) or a stamped event channel
   (ordered, no loss, but arrives separately from the flags).
3. Live take growth: keep writing boxes per frame (collaboration sees the growing region) or show an ephemeral
   overlay and write boxes at wrap and stop (far fewer transactions).
4. `InputLatency` preference: keep it as a browser-only override or drop it once ports report real latency.
5. The 8 channel effects monitoring cap: lift it with the port rewrite or keep it.
