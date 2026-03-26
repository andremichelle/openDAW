# Capture MIDI at Play Phase

**Issue**: https://github.com/andremichelle/openDAW/issues/215

## Summary

Silently buffer all incoming MIDI notes on armed tracks and let the user commit them to a region on demand via a "Capture MIDI" action. This is a retroactive recording feature: notes are captured passively, and the user decides after the fact to keep them.

## Scenarios (from issue discussion)

### Scenario 1 — Transport stopped
- User plays MIDI while transport is idle.
- User clicks "Capture MIDI."
- A region is created spanning from the first buffered note to the last, positioned at the current playhead.
- Note positions within the region are relative to each other (preserving timing offsets between notes using wall-clock deltas converted to ppqn via current BPM).

### Scenario 2 — Transport playing
- Buffer resets when playback starts.
- Notes are timestamped against the engine's current position (ppqn) as they arrive.
- User clicks "Capture MIDI."
- A region is created spanning from the first note to the last, positioned at the actual timeline position where the first note was played.
- Notes are placed exactly where they would have been if recording had been active.

### Buffer lifecycle
- **Playback starts**: Buffer clears. New capture session begins in Scenario 2 mode.
- **Playback stops**: Buffer clears. New capture session begins in Scenario 1 mode.
- **Capture committed**: Buffer clears. New capture session begins (mode depends on current transport state).
- **Track disarmed**: Buffer clears.

## Architecture

### Where buffering fits in the signal flow

```
WebMIDI → CaptureMidi.#notifier
                ├─→ engine.noteSignal()         (existing: real-time monitoring/synthesis)
                ├─→ RecordMidi subscriber        (existing: only active during recording)
                └─→ MidiCaptureBuffer subscriber (NEW: always active when armed)
```

The buffer is a subscriber on the same `#notifier` that already drives monitoring and recording. It runs in parallel, not in place of either.

### New class: `MidiCaptureBuffer`

**Location**: `packages/studio/core/src/capture/MidiCaptureBuffer.ts`

**Key principle**: The buffer stores only lightweight raw events (plain arrays/objects). No boxes, no graph nodes, no editing transactions. Box creation happens only at commit time, keeping the buffer zero-cost in terms of graph dependencies and memory.

Responsibilities:
- Subscribe to `CaptureMidi.#notifier` when armed
- Track transport state via `engine.isPlaying` to switch between Scenario 1 and Scenario 2 timing
- Buffer raw note-on/note-off events as simple data (no BoxGraph involvement)
- Resolve note durations from on/off pairs at commit time
- Clear buffer on transport transitions
- On commit: convert raw events into NoteRegionBox + NoteEventBoxes via `editing.modify()`

```
// delta: time elapsed since capture session started
//   Scenario 1 (stopped): milliseconds (wall clock), converted to ppqn at commit
//   Scenario 2 (playing): ppqn (engine position minus session start position)
type RawNoteOn = { pitch: byte, velocity: unitValue, delta: number }
type RawNoteOff = { pitch: byte, delta: number }
type RawNoteEvent = RawNoteOn | RawNoteOff

MidiCaptureBuffer
├── #events: Array<RawNoteEvent>          // raw on/off stream, append-only
├── #mode: "stopped" | "playing"
├── #origin: number                       // reference point for delta computation
│   │                                     //   stopped: performance.now() at first event
│   │                                     //   playing: engine position (ppqn) at playback start
├── #bpmAtOrigin: bpm                     // BPM snapshot for Scenario 1 ms→ppqn conversion
├── #subscription: Terminable             // notifier subscription
│
├── reset(): void                         // clear events array
├── commit(project): void                 // resolve durations, create boxes, create region
├── hasNotes(): boolean                   // does the buffer contain any note-on events?
└── readonly noteCount: ObservableValue<int>  // for UI feedback (count of note-ons)
```

Every event stores `delta` — the elapsed time since the capture session's origin. This is always relative, never absolute.

At note-on/off time, the hot path computes `delta` and pushes to the array:
- **Scenario 1**: `delta = performance.now() - #origin` (milliseconds)
- **Scenario 2**: `delta = (engine.position.getValue() + latency) - #origin` (ppqn)

At commit time, note-ons are paired with their corresponding note-offs to compute durations. Notes still held at commit time are either truncated to the commit delta or excluded (see open question 9).

This keeps the hot path (every note-on/off while playing) as cheap as a subtraction and an array push — no box allocation, no graph wiring, no editing transactions until the user explicitly commits.

### Timing strategy

**Scenario 1 (stopped)**: Deltas are in milliseconds. At commit time, convert all deltas to ppqn using `PPQN.secondsToPulses(delta / 1000, #bpmAtOrigin)`. Region position = current playhead. Note positions within the region = converted delta of each note-on (first note naturally lands at position 0).

**Scenario 2 (playing)**: Deltas are already in ppqn. Region position = `#origin + firstNoteDelta`. Note positions within the region = `noteDelta - firstNoteDelta` (so first note lands at position 0).

### Modifications to existing files

#### `CaptureMidi.ts`
- Expose a `MidiCaptureBuffer` instance (created when armed, destroyed when disarmed)
- Or: create buffer externally and subscribe to `subscribeNotes()`
- The buffer subscribes to `engine.isPlaying` to manage mode transitions and resets

#### `Project.ts`
- Add `commitMidiCapture(): void` method
- Iterates armed MIDI captures, calls `buffer.commit()` on each, wraps in `editing.modify()`
- Calls `editing.mark()` after commit for undo boundary

#### `CaptureDevices.ts`
- Add `filterArmedMidi(): ReadonlyArray<CaptureMidi>` (filter to only MIDI captures)
- Or the existing `filterArmed()` + type narrowing is sufficient

### Region creation (in `commit()`)

Uses the same pattern as `RecordMidi`:
1. `RecordTrack.findOrCreate(editing, audioUnitBox, TrackType.Notes, null)` — find or create a track
2. `NoteEventCollectionBox.create(boxGraph, UUID.generate())` — create event collection
3. `NoteRegionBox.create(boxGraph, UUID.generate(), box => { ... })` — create region at correct position
4. For each buffered note: `NoteEventBox.create(boxGraph, UUID.generate(), box => { ... })` — create note event

### UI: "Capture MIDI" button

**Option A — Transport bar button** (recommended):
Add a dedicated button in `TransportGroup.tsx` next to the record button. Uses an appropriate icon (e.g., `IconSymbol.Midi` or `IconSymbol.Record` with distinct styling). Only visible/enabled when there are armed MIDI captures.

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

These decisions affect scope and UX. Answers needed before implementation:

1. **Button placement**: Should "Capture MIDI" be a transport bar button, a track-header action, a keyboard-shortcut-only feature, or a combination?

2. **Visual feedback while buffering**: Should there be a visible indicator (e.g., note count badge, pulsing icon) showing that notes are being buffered? Or is the armed state sufficient?

3. **Quantization**: Should captured notes be quantized to the current grid? Or always captured raw (user can quantize after)?

4. **Loop playback**: During looped playback, should each loop cycle reset the buffer (like recording takes), or accumulate notes across loops?

5. **Multiple armed tracks**: If multiple MIDI tracks are armed, should capture commit to all of them (each getting the same notes), or only the focused/selected one?

6. **Buffer size limit**: Should there be a maximum buffer duration or note count to prevent unbounded memory use?

7. **Latency compensation**: Apply the same `audioContext.outputLatency` compensation as recording? (Likely yes for consistency.)

8. **Undo**: Should the capture commit be a single undo step? (Likely yes — same as recording finalization.)

9. **Note held during commit**: If the user is still holding a key when they click "Capture MIDI," should that note be included (truncated at the commit point) or excluded?

10. **Label**: What should the created region be labeled? "Capture 1", "MIDI Capture", or something else?

## Implementation Steps

### Phase 1 — Core buffer
1. Create `MidiCaptureBuffer` class in `packages/studio/core/src/capture/`
2. Implement note buffering with dual timing modes (stopped vs playing)
3. Implement `reset()` with transport state subscriptions
4. Implement `commit()` using the `RecordMidi` region creation pattern
5. Unit-testable: buffer logic has no DOM/WebMIDI dependencies

### Phase 2 — Integration
6. Wire `MidiCaptureBuffer` into `CaptureMidi` (create when armed, destroy when disarmed)
7. Add `commitMidiCapture()` to `Project`
8. Subscribe to `engine.isPlaying` for automatic buffer resets

### Phase 3 — UI
9. Add keyboard shortcut to `GlobalShortcuts`
10. Add "Capture MIDI" button to `TransportGroup.tsx` (or chosen location)
11. Wire button click to `project.commitMidiCapture()`
12. Add enabled/disabled state based on buffer having notes
13. Optional: visual note count indicator

## Files to create
- `packages/studio/core/src/capture/MidiCaptureBuffer.ts`

## Files to modify
- `packages/studio/core/src/capture/CaptureMidi.ts` — integrate buffer
- `packages/studio/core/src/project/Project.ts` — add `commitMidiCapture()`
- `packages/app/studio/src/ui/header/TransportGroup.tsx` — add capture button
- `packages/app/studio/src/ui/shortcuts/GlobalShortcuts.ts` — add shortcut
- Possibly `packages/studio/core/src/capture/CaptureDevices.ts` — add MIDI-specific filter

## Files as reference (read-only)
- `packages/studio/core/src/capture/RecordMidi.ts` — region/note creation pattern
- `packages/studio/core/src/capture/RecordTrack.ts` — track allocation
- `packages/studio/core/src/capture/Recording.ts` — session lifecycle pattern
- `packages/studio/core/src/EngineFacade.ts` — transport observables
- `packages/studio/adapters/src/NoteSignal.ts` — signal types
- `packages/studio/boxes/src/NoteEventBox.ts`, `NoteRegionBox.ts`, `NoteEventCollectionBox.ts` — box types
