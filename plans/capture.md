# Capture and recording pipeline: clean rewrite with abstracted IO

Status: plan 2026-10-20, dry run and corrections 2026-10-30 (section 7), implemented on branch
`capture-recording` (section 8). Triggered by issue #479 (fixed in 8280789a4).

## 1. What the pipeline is today

Audio and MIDI capture live in `packages/studio/core/src/capture` (about 2.2k lines, 2.3k lines of tests) plus
`RecordingWorklet.ts`, `MonitoringRouter.ts`, `AudioDevices.ts` and `midi/*` in core, `RecordingProcessor.ts` in
core-processors, and a second `AudioDevices.ts` in `packages/app/studio/src/audio`. The engine is the wasm engine
only: its recording reports come from `packages/studio/core-wasm/src/processor.ts` (`recordingStarted` on the
engine to client channel, `recordingStopTime` in `EngineStateSchema`) over `crates/engine/src/lib.rs`.

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

Superseded by the corrected phases in section 7.3.

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

Settled in the dry run, see section 7.2. Revisit any of them on review.

1. Package name and split: `studio-io` for ports plus browser implementation, take writing stays in core.
   Alternative: `core-capture` holding both, which needs the box graph and `Project` and so drags core along.
2. Segment transport: extend `EngineState` (atomic with the flags, as done for #479) or a stamped event channel
   (ordered, no loss, but arrives separately from the flags).
3. Live take growth: keep writing boxes per frame (collaboration sees the growing region) or show an ephemeral
   overlay and write boxes at wrap and stop (far fewer transactions).
4. `InputLatency` preference: keep it as a browser-only override or drop it once ports report real latency.
5. The 8 channel effects monitoring cap: lift it with the port rewrite or keep it.

## 6. Vendor behaviour the browser IO must absorb

Source: [opendaw-test known-vendor-issues.md](https://github.com/naomiaro/opendaw-test/blob/main/docs/known-vendor-issues.md)
(measured on SDK 0.0.177, Chrome 155, macOS, 2026-10-22). Read it before attributing a timing symptom to the SDK.
Every entry below belongs in `studio-io/browser`, never in the domain code.

### Clock
1. Chromium 442866743: `currentFrame` stands still for a quantum while the main thread changes the graph (connect,
   disconnect, building a worklet or stream source). Both take start stamps are read exactly then. `QuantumClock`
   (lattice anchored at the largest `currentFrame - calls * 128`) repairs it. Every frame stamp in the ports must go
   through it.
2. Chromium 571344687: a processor built right after `addModule()` reads a stale frame in its constructor and first
   `process()` (up to 110 ms with a slow load). Never seed a clock from the constructor.
3. Firefox 1629478 (spec): `inputs[0]` is empty until the stream source delivers. `RecordingProcessor` already waits
   for the expected channel count before stamping. Keep that in the port.
4. Chromium 575891839: after a back/forward-cache restore the worklet clock runs at half speed. Candidate: tear the
   engine down on `pageshow` with `persisted`.
5. Chromium 560233271: `suspend()` / `resume()` after a worklet-thread stall halves the render rate until reload.
   Never suspend.
6. Hidden or fully covered window stops rAF, so every main-thread timing read freezes. Principle 1 (no main-thread
   timing) removes this class.

### Latency
7. Chromium 516995393 (spec gap, all vendors): no input latency figure. `getSettings().latency` is nominal (2.67 ms
   reported, 35 to 63 ms measured). Loopback calibration (PR #380) or the `InputLatency` override stays the only
   source in the browser (decision 4).
8. Chromium 388871416: `outputLatency` is wrong on Bluetooth (161 ms reported, 200 to 280 ms real, varies per
   stream), follows the system default device instead of the context sink, and reads 0 right after `resume()`.
9. Each `MediaStreamAudioSourceNode` has its own start delay (0 to 4 quanta between two nodes on one stream, a
   441 frame step at 44.1 kHz in the first second). Two inputs recorded together are skewed by the browser. A worklet
   module still loading delays the first take frame (117 ms measured).

### Input integrity
10. Chromium 40103985: a render-thread stall (80 ms) leaves about 32 ms of zeros in `getUserMedia` input. More than
    30 s of exact digital silence on the output also produces one hole. A dither of `(n & 1) / 10000` on the output
    removed it. Keep the worklet thread free of long tasks during a take, consider the dither while recording.
11. A `MediaStreamAudioDestinationNode` stream from another `AudioContext` captures silent, and `track.stop()` on a
    shared stream kills it for every consumer. Hand each consumer a `stream.clone()`.
12. WebKit 326286, 211959, 210231: on iOS echo cancellation crackles the output, capture turns all output mono, no
    stereo `getUserMedia`. Not measured here.
13. WebKit 328462: Safari "Enhanced Security" disables `SharedArrayBuffer`, which the recording ring needs.

### Desktop port
14. None of these apply to the `cpal` / `midir` implementation. It reports real input and output latency and stamps
    in driver frames, which is the reason the domain must not know any of the above.

## 7. Dry run 2026-10-30

Walked every phase against the code. Issues found, then the corrected target and phases.

### 7.1 Issues in sections 3 and 4
1. The second `AudioDevices.ts` lives in `packages/app/studio/src/audio`, not `app/studio/src/audio`. It is app UI
   (dialogs, manuals), so it stays in the app and is not merged with the core one.
2. `RecordingWorklet` cannot move to a package below core. It is a `SampleLoader` and imports `SampleService`,
   `SampleStorage` and `PeaksWriter` from core, so `studio-io/browser` would import core and core would import
   `studio-io`: a cycle. `RecordingProcessor` cannot move either, it is part of the core-processors worklet bundle.
3. A new published package costs a build, lerna and SDK entry for code that still needs core. The ports go to a
   folder `packages/studio/core/src/io` first (decision 1). Extracting a package later is a move once nothing in
   `io/` imports core.
4. There is no TS engine any more. "Engine side" means two places: the Rust engine
   (`crates/engine/src/lib.rs`) and the worklet glue (`packages/studio/core-wasm/src/processor.ts`). Every new
   report needs both plus a rebuilt `core-wasm` bundle (a schema change without a rebuild freezes the tab, see
   `EngineStateSchema` history).
5. A loop wrap is not visible in the engine state: it only carries the latest position, read on animation frames.
   Two wraps between two reads (hidden tab, slow frame, a loop shorter than a frame) look like one or none. The
   wraps need an ordered channel (decision 2), and the Rust transport already flags them: the first block after a
   jump is `discontinuous`, its `s0` is the sample inside the quantum.
6. "Stamped live notes in the engine (closes #356 for input)" is wrong. A live note always arrives after its stamp,
   so stamping can only delay it to a constant offset. That trades jitter for added latency on every key press.
   Live notes keep reaching the engine immediately. The stamp is used for the recorded position only.
7. Finding 3 (MIDI latency sign) resolves itself once MIDI is stamped on the audible clock:
   `AudioContext.getOutputTimestamp()` maps a `MIDIMessageEvent.timeStamp` to the context time that was audible at
   the key press, and the note lands at the transport position rendered at that context time minus the plugin
   delay compensation. No output latency term is added or subtracted by hand. Today's `+ outputLatency` places a
   note about two output latencies late. This changes where recorded MIDI notes land and needs an ear check.
8. `RecordAutomation` records a parameter at the rendered position of the write, without any latency term, and its
   `performance.now()` hold detection measures the gesture, not the transport. Moving it onto stamps would move
   every recorded automation point. It stays as it is (section 7.3 phase 6).
9. The retroactive MIDI capture places notes at the last animation frame position in "playing" mode (up to one
   frame of jitter, no latency). Merging it onto the stamped notes and the transport log fixes that. The result
   shape `CaptureResult` and `Project.commitMidiCapture` stay unchanged.
10. Phase 7 (desktop ports) depends on the native engine phase of `plans/tauri.md` and is not part of this run.
11. `Recording.wasCountingIn()` is used by `RecordAudio`'s wallclock fallback and by `Project.restartRecording`, and
    `Recording.isRecording` by the capture menu. The statics stay as a facade over the per project session.

### 7.2 Decisions taken
1. Ports in `packages/studio/core/src/io` with the browser implementation in `io/browser`, no new package.
2. Transport anchors on the engine to client channel (ordered, no loss), not in `EngineState`.
3. Live take growth keeps writing boxes per frame (collaboration sees it). Not measured, not changed.
4. `InputLatency` stays as the browser override. It is the only input latency source in a browser.
5. The 8 channel effects monitoring cap stays.

### 7.3 Corrected phases
1. Characterization. The 114 capture tests are the baseline. Add tests for the new pieces (transport log,
   audible clock, wrap anchors) and for the cases the old code gets wrong (two wraps between two frames).
2. Ports. `io/AudioInputPort`, `io/MidiInputPort`, `io/ContextClock` with `io/browser` implementations over the
   existing `AudioDevices`, `MidiDevices` and `AudioContext`. The vendor workarounds that are browser facts move
   there: the `outputLatency` approval dialog, the device fallback of `getUserMedia`, the `outputLatency` re-read.
   Old exports stay.
3. Engine anchors. Rust collects every discontinuous block (`s0`, position) and the mid quantum pause of
   `pauseOnLoopDisabled`. The processor adds play and stop edges, converts samples to context time and sends
   `transportAnchors` once per quantum that has any. Every recorder keeps its own `TransportLog` from them. The stop
   time becomes exact inside the quantum for `pauseOnLoopDisabled`.
4. Audio takes on anchors. A take ends at the wrap anchor's context time, so its length is what the engine
   rendered. Every wrap creates its take even if no animation frame ran in between. The anchor wait and the
   wallclock fallback go: the take is created once `recordingStart` and `firstQuantumTime` both exist.
5. MIDI on the audible clock. Notes are stamped through `ContextClock`, placed through the `TransportLog`, and land
   in the take that was playing when they were heard. The retroactive capture uses the same stamps and log.
6. `RecordingSession` per project behind the `Recording` statics. One `TakePolicy` for the older take action and
   scope. `RecordAutomation` unchanged (7.1.8).
7. Desktop ports: later, with `plans/tauri.md`.

## 8. Implementation 2026-10-30 (branch `capture-recording`, uncommitted)

### Done
1. Engine anchors. Rust `transport_jump_count/sample/position` and `transport_pause_sample`
   (`crates/engine/src/lib.rs`), `TransportAnchorEdges` in core-wasm, `EngineToClient.transportAnchors`,
   `Engine.subscribeTransportAnchors`. A stop anchor also sets `recordingStop`, so a recording ends without an
   animation frame. Tests: `transport-jumps.test.ts` (real engine: wrap at sample 88200, laps in whole samples,
   pause at quantum 689 sample 8), `transport-anchor-edges.test.ts`.
2. `capture/TransportLog` (position and musical advance at a context time), `capture/TakePolicy` (the older take
   action, was duplicated), `capture/RecordingSession` per project, `Recording` statics as its facade.
3. `RecordAudio` splits takes at the wrap anchors, the anchor wait and the wallclock fallback are gone. A take is
   placed as soon as `recordingStart` and `firstQuantumTime` exist. Jumps at or before the start are ignored (the
   seek flags the first block of the start quantum).
4. `RecordMidi` and the retroactive capture in `CaptureMidi` use stamped notes on the audible clock and the log.
   Notes heard past the loop end wait for the wrap anchor and land in the next take. Note fields are rounded.
5. Ports in `core/src/io`: `ContextClock`, `MidiInputPort`, `RecordingLatency` with `io/browser`
   (`BrowserContextClock`, `BrowserMidiInput`, `BrowserRecordingLatency`, `BrowserAudioInput`). `CaptureMidi`
   takes the port and clock as optional constructor arguments.

### Behaviour that changed on purpose
1. Recorded MIDI notes land where the transport was heard, about two output latencies plus twice the delay
   compensation earlier than before (7.1.7). Needs an ear check with a real keyboard.
2. A note stamped before the last playhead update lands at its stamp, not at that update.
3. Every loop wrap makes its take even when no animation frame runs (hidden tab, two wraps in one frame).
4. `pauseOnLoopDisabled` ends the audio take at the exact loop end sample, not at the quantum end.
5. A recording finishes when the engine reports its stop, also in a hidden tab.

### Verified in Chrome (separate headless Chrome, fake microphone, software keyboard)
1. MIDI: three laps, notes within 1 ms of their audible targets, a key held over the wrap keeps its length.
2. Audio: takes of 1.9974 s (from position 5), 2.0 s and the rest, offsets chained exactly.
3. Hidden tab (animation frames stopped): the takes split while hidden, the recording finishes on the stop.
4. Count-in: the count-in jumps are ignored, the take starts at the punch in.
5. `pauseOnLoopDisabled`: the recording ends by itself at the loop end, take length to the sample.
6. Retroactive capture while looping: phrase across the wrap keeps its order and lengths.

6. Audio behind ports (finding 14). `io/AudioInputPort` (open, reuse or reopen per request, rechannel, close,
   gain, prepare and take a recording, latency reader), `io/RecordingSink` (what `RecordAudio` records into),
   `io/MonitorPort` (mode, volume, pan, mute, output device). `io/browser/BrowserAudioInput` and `BrowserMonitor`
   hold the former `CaptureAudio` graph code unchanged. `CaptureAudio` keeps arm state, box settings and the old
   getters as a facade, and takes an input factory (`CaptureAudio.InputFactory`) so a desktop input plugs in.
   The existing `CaptureAudio.test.ts` passes unedited through the port, `CaptureAudioPort.test.ts` drives the
   domain against a fake port. Chrome: recording, off/direct/effects monitoring levels (-12 dB reads 0.28),
   mute, output device fallback.

7. Automated audit `scripts/capture-audit/audit.mjs` (macOS): MIDI over a virtual CoreMIDI cable
   (`midi-loopback.swift`), audio through BlackHole 2ch, an off screen Chrome on the dev server. MIDI is judged
   against the receipt stamps: every scenario within 0.25 ms (tempi, a 150 ms main thread block, loop wraps,
   count-in). Covers #491 and #492. Diagnostics `--bare`, `--bisect`, `--takes`, `--ratchet`, `--steps`.
8. The 24 ms input step. A `MediaStreamAudioSourceNode` reads about 24 ms later, permanently, after it went
   unpulled (a suspended context, exports) or after another `getUserMedia` stream opened and closed on the
   device (arming a second capture, a permission request, the first output device query). A fresh source node on
   the same stream resets it, so `BrowserAudioInput.prepareRecording` builds one before every recording. On
   BlackHole every take then lands at a 18.5 to 21.6 ms round trip instead of 18 to 45 ms. A step that happens
   during a take is not caught.

### Not done
1. `RecordAutomation` unchanged (7.1.8). Phase 7 (desktop ports) later.
2. Round trip calibration per output and input device (the input part is unreported, Chrome's output figure is
   wrong on Bluetooth). Placement should not read `outputLatency` at a single instant, it scatters.
3. #493 count-in pickups (needs a decision), #494 takes of 1200 frames or fewer fail to import.
