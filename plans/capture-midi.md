# Capture MIDI at Play Phase

**Issue**: https://github.com/andremichelle/openDAW/issues/215

## Summary

Silently buffer all incoming MIDI notes on armed tracks and let the user commit them to a region on demand via a "Capture MIDI" action. This is a retroactive recording feature: notes are captured passively, and the user decides after the fact to keep them.

## Scenarios (from issue discussion)

### Scenario 1 — Transport stopped
- User plays MIDI while transport is idle.
- User clicks "Capture MIDI."
- A region is created spanning from the first note to the end of the last note, positioned at the current playhead.
- Note positions within the region are relative to each other (preserving timing offsets between notes using wall-clock deltas converted to ppqn via current BPM).

### Scenario 2 — Transport playing
- Buffer resets when playback starts.
- Notes are timestamped against the engine's current position (ppqn) as they arrive.
- User clicks "Capture MIDI."
- A region is created spanning from the first note to the end of the last note, positioned at the actual timeline position where the first note was played.
- Notes are placed exactly where they would have been if recording had been active.
- Latency compensation (`audioContext.outputLatency`) is applied to deltas, matching RecordMidi behavior.

### Buffer lifecycle
- **Playback starts**: Buffer clears. New capture session begins in Scenario 2 mode.
- **Playback stops**: Buffer clears. New capture session begins in Scenario 1 mode.
- **Capture committed**: Buffer clears. New capture session begins (mode depends on current transport state).
- **Track disarmed**: Buffer clears.
- **Recording active**: Buffer is disabled. Commit action is disabled. No buffering while `Recording.isRecording` is true.

## Architecture

### Where buffering fits in the signal flow

```
WebMIDI → CaptureMidi.#notifier
                ├─→ engine.noteSignal()         (existing: real-time monitoring/synthesis)
                ├─→ RecordMidi subscriber        (existing: only active during recording)
                └─→ MidiCaptureBuffer            (NEW: owned by CaptureMidi, active when armed, disabled during recording)
```

The buffer is owned by `CaptureMidi` and subscribes directly to the private `#notifier`. It runs in parallel with monitoring, not in place of it.

### New class: `MidiCaptureBuffer`

**Location**: `packages/studio/core/src/capture/MidiCaptureBuffer.ts`

**Key principle**: The buffer stores only lightweight raw events (plain arrays/objects). No boxes, no graph nodes, no editing transactions. Box creation happens only at commit time, keeping the buffer zero-cost in terms of graph dependencies and memory.

Responsibilities:
- Subscribe to `CaptureMidi.#notifier` (owned by CaptureMidi, has direct access)
- Track transport state via `engine.isPlaying` to switch between Scenario 1 and Scenario 2 timing
- Pause buffering while `Recording.isRecording` is true
- Buffer raw note-on/note-off events as simple data (no BoxGraph involvement)
- Resolve note durations from on/off pairs at commit time
- Clear buffer on transport transitions
- On commit: convert raw events into NoteRegionBox + NoteEventBoxes via `editing.modify()`

```
// Discriminated union for raw events
type RawNoteOn = { type: "on", pitch: byte, velocity: unitValue, delta: number }
type RawNoteOff = { type: "off", pitch: byte, delta: number }
type RawNoteEvent = RawNoteOn | RawNoteOff

// delta: time elapsed since capture session started
//   Scenario 1 (stopped): milliseconds (wall clock), converted to ppqn at commit
//   Scenario 2 (playing): ppqn (engine position minus session start position + accumulated loop offset)

MidiCaptureBuffer
├── #events: Array<RawNoteEvent>          // raw on/off stream, append-only
├── #mode: "stopped" | "playing"
├── #origin: number                       // reference point for delta computation
│   │                                     //   stopped: performance.now() at first note-on (lazy init)
│   │                                     //   playing: engine position (ppqn) at playback start
├── #bpmAtOrigin: bpm                     // BPM snapshot for Scenario 1 ms→ppqn conversion
├── #loopOffset: ppqn                     // accumulated loop length across loop wraps (Scenario 2)
├── #lastPosition: ppqn                   // previous engine position, for detecting loop wraps
│
├── reset(): void                         // clear events array, reset origin/offsets
├── commit(project): void                 // resolve durations, create boxes, create region
├── hasNotes(): boolean                   // does the buffer contain any note-on events?
└── readonly noteCount: ObservableValue<int>  // for UI feedback (count of note-ons)
```

Every event stores `delta` — the elapsed time since the capture session's origin. This is always relative, never absolute.

At note-on/off time, the hot path computes `delta` and pushes to the array:
- **Scenario 1**: `delta = performance.now() - #origin` (milliseconds). `#origin` is lazily set on the first note-on.
- **Scenario 2**: `delta = (engine.position.getValue() + latency) - #origin + #loopOffset` (ppqn). Latency = `PPQN.secondsToPulses(audioContext.outputLatency, bpm)`.

**Loop handling (Scenario 2)**: On each position update, if `currentPosition < #lastPosition`, a loop wrap occurred. Add the loop length (`loopArea.to - loopArea.from`) to `#loopOffset`. This keeps deltas monotonically increasing across loop boundaries.

At commit time, note-ons are paired with their corresponding note-offs to compute durations (one active note per pitch, last-write-wins). Notes still held at commit time are truncated to the commit delta. Durations are clamped to `MIN_NOTE_DURATION` (`PPQN.fromSignature(1, 128)`).

This keeps the hot path (every note-on/off while playing) as cheap as a subtraction and an array push — no box allocation, no graph wiring, no editing transactions until the user explicitly commits.

### Timing strategy

**Scenario 1 (stopped)**: No latency compensation. Deltas are in milliseconds. At commit time, convert all deltas to ppqn using `PPQN.secondsToPulses(delta / 1000, #bpmAtOrigin)`. Region position = current playhead. Note positions within the region = converted delta of each note-on, offset so first note lands at position 0.

**Scenario 2 (playing)**: Latency compensated. Deltas are already in ppqn (monotonic across loop wraps). Region position = `#origin + firstNoteDelta`. Note positions within the region = `noteDelta - firstNoteDelta` (so first note lands at position 0).

### Region creation (in `commit()`)

All box creation wrapped in a single `editing.modify()` call (default `mark: true` for one undo step).

Uses the same pattern as `RecordMidi`:
1. `RecordTrack.findOrCreate(editing, audioUnitBox, TrackType.Notes, null)` — find or create a track
2. `NoteEventCollectionBox.create(boxGraph, UUID.generate())` — create event collection
3. `NoteRegionBox.create(boxGraph, UUID.generate(), box => { ... })` — create region at correct position
   - Set `position`, `duration`, `loopDuration` (duration = loopDuration)
   - Set `hue` via `ColorCodes.forTrackType(TrackType.Notes)`
   - Set `label` to `"Captured"`
   - Wire `regions` and `events` pointers
4. For each resolved note: `NoteEventBox.create(boxGraph, UUID.generate(), box => { ... })` — create note event
   - Set `position` (relative to region start), `duration` (clamped to MIN_NOTE_DURATION), `pitch`, `velocity`
   - Wire `events` pointer to collection
5. `project.selection.select(regionBox)` — select the new region

Region duration = `max(notePosition + noteDuration)` across all notes (covers the full extent of every note).

### Modifications to existing files

#### `CaptureMidi.ts`
- Create and own a `MidiCaptureBuffer` instance internally (has access to private `#notifier`)
- Buffer is created when armed, destroyed when disarmed
- Buffer subscribes to `engine.isPlaying` and `Recording.isRecording` for mode transitions and pausing
- Expose buffer via a getter for `Project.commitMidiCapture()` to call `commit()`

#### `Project.ts`
- Add `commitMidiCapture(): void` method
- Iterates armed MIDI captures, calls `buffer.commit()` on each
- Disabled when `Recording.isRecording` is true

#### `CaptureDevices.ts`
- Existing `filterArmed()` + `isInstanceOf(capture, CaptureMidi)` type narrowing is sufficient

### UI: "Capture MIDI" button

**Option A — Transport bar button** (recommended):
Add a dedicated button in `TransportGroup.tsx` next to the record button. Uses an appropriate icon (e.g., `IconSymbol.Midi` or `IconSymbol.Record` with distinct styling). Only visible/enabled when there are armed MIDI captures with notes in the buffer.

**Option B — Keyboard shortcut only**:
Add a global shortcut (e.g., `Ctrl+Shift+R` or `Ctrl+M`) in `GlobalShortcuts.ts`.

**Option C — Both**: Transport button + keyboard shortcut.

### Keyboard shortcut

Add to `GlobalShortcuts.ts`:
```typescript
"capture-midi": {
    shortcut: Shortcut.of(Key.KeyM, {ctrl, shift}),
    description: "Commit captured MIDI notes"
}
```

## Open Questions

Resolved questions moved to decisions above. Remaining:

1. **Button placement**: Should "Capture MIDI" be a transport bar button, a track-header action, a keyboard-shortcut-only feature, or a combination?

2. **Visual feedback while buffering**: Should there be a visible indicator (e.g., note count badge, pulsing icon) showing that notes are being buffered? Or is the armed state sufficient?

3. **Quantization**: Should captured notes be quantized to the current grid? Or always captured raw (user can quantize after)?

4. **Multiple armed tracks**: If multiple MIDI tracks are armed, should capture commit to all of them (each getting its own region from its own device/channel), or only the focused/selected one?

5. **Buffer size limit**: Should there be a maximum buffer duration or note count to prevent unbounded memory use?

6. **Note held during commit**: If the user is still holding a key when they click "Capture MIDI," should that note be included (truncated at the commit point) or excluded?

## Resolved Decisions

- **Type discriminator**: RawNoteEvent uses `type: "on" | "off"` discriminator field
- **Audition signals**: Not an issue — `NoteSignal.fromEvent()` only produces on/off, audition signals never reach `#notifier`
- **Same-pitch overlap**: Standard MIDI pairing — one active note per pitch, walk events in order
- **Region duration**: Covers full extent of all notes (`max(position + duration)`)
- **loopDuration**: Always set equal to duration
- **ignoreNoteRegion**: Not needed — region is created atomically after the fact, no concurrent write + playback
- **Origin init (Scenario 1)**: Lazy — set on first note-on, not at session start
- **Latency**: Only applied in Scenario 2, not Scenario 1
- **Loop wrapping**: Accumulate loop length in `#loopOffset` to keep deltas monotonic
- **During recording**: Buffer disabled, commit disabled
- **Buffer ownership**: Owned by `CaptureMidi` (direct access to `#notifier`)
- **editing.modify()**: Single call at commit time, default `mark: true` for one undo step
- **Selection**: Region is selected after commit
- **MIN_NOTE_DURATION**: Applied at commit time, same as RecordMidi
- **Region label**: `"Captured"`
- **Region hue**: `ColorCodes.forTrackType(TrackType.Notes)`

## Implementation Steps

### Phase 1 — Core buffer
1. Create `MidiCaptureBuffer` class in `packages/studio/core/src/capture/`
2. Implement raw event buffering with `type: "on" | "off"` discriminator
3. Implement dual timing modes (stopped: wall-clock ms, playing: ppqn with loop offset)
4. Implement `reset()` for transport state transitions
5. Implement `commit()` — pair on/off, convert to boxes, create region

### Phase 2 — Integration
6. Wire `MidiCaptureBuffer` into `CaptureMidi` (owned, created when armed, destroyed when disarmed)
7. Subscribe to `engine.isPlaying` for mode transitions and buffer resets
8. Subscribe to `Recording.isRecording` to disable buffering during recording
9. Add `commitMidiCapture()` to `Project`

### Phase 3 — UI
10. Add keyboard shortcut to `GlobalShortcuts`
11. Add "Capture MIDI" button to `TransportGroup.tsx` (or chosen location)
12. Wire button click to `project.commitMidiCapture()`
13. Disable button when no notes in buffer or when recording is active

## Files to create
- `packages/studio/core/src/capture/MidiCaptureBuffer.ts`

## Files to modify
- `packages/studio/core/src/capture/CaptureMidi.ts` — own and manage buffer
- `packages/studio/core/src/project/Project.ts` — add `commitMidiCapture()`
- `packages/app/studio/src/ui/header/TransportGroup.tsx` — add capture button
- `packages/app/studio/src/ui/shortcuts/GlobalShortcuts.ts` — add shortcut

## Files as reference (read-only)
- `packages/studio/core/src/capture/RecordMidi.ts` — region/note creation pattern
- `packages/studio/core/src/capture/RecordTrack.ts` — track allocation
- `packages/studio/core/src/capture/Recording.ts` — session lifecycle pattern
- `packages/studio/core/src/EngineFacade.ts` — transport observables
- `packages/studio/adapters/src/NoteSignal.ts` — signal types
- `packages/studio/boxes/src/NoteEventBox.ts`, `NoteRegionBox.ts`, `NoteEventCollectionBox.ts` — box types
