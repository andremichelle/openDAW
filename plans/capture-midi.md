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
- **Playback stops**: Buffer is **preserved**. The user can still commit notes captured during playback after stopping. The mode stays as-is (Scenario 2 timing data remains valid for region placement).
- **First note-on after playback stop**: Buffer clears. New capture session begins in Scenario 1 mode. This is the only way a stopped-transport session replaces a previous playback session's buffer.
- **Capture committed**: Buffer clears. New capture session begins (mode depends on current transport state).
- **Track disarmed**: Buffer clears.
- **Recording active**: Buffer is disabled. Commit action is disabled. Uses `engine.isRecording` (observable) to detect recording state — `Recording.isRecording` is a static boolean and cannot be subscribed to.

## Architecture

### Signal flow

```
WebMIDI → CaptureMidi.#notifier
                ├─→ engine.noteSignal()         (existing: real-time monitoring/synthesis)
                ├─→ RecordMidi subscriber        (existing: only active during recording)
                └─→ CaptureMidi.#bufferNote()    (NEW: buffers into #captureEvents when armed)
```

All buffering logic lives directly inside `CaptureMidi`. No separate buffer class. The `#notifier` subscriber calls a private method that appends to the events array.

### `CaptureMidi` — extended with capture buffering

**Existing responsibilities** (unchanged): MIDI stream management, device selection, channel filtering, armed state, `startRecording()`.

**New capture fields:**
```
#captureEvents: Array<RawNoteEvent>       // raw on/off stream
#captureMode: "stopped" | "playing"
#captureOrigin: number                    // delta reference (ms for stopped, ppqn for playing)
#captureOriginSet: boolean                // lazy init for Scenario 1
#capturePendingReset: boolean             // deferred reset after playback stop
#captureBpmAtOrigin: bpm                  // BPM snapshot for stopped mode conversion
#captureLoopOffset: ppqn                  // accumulated loop wraps
#captureLastPosition: ppqn               // for loop wrap detection
#captureLatency: ppqn                     // output latency in ppqn
#captureNoteOnCount: DefaultObservableValue<int>  // stable observable for UI
```

**New capture subscriptions** (added when armed, cleaned up when disarmed):
- `engine.isPlaying` — mode transitions, buffer reset on play start
- `engine.isRecording` — disable buffering during recording
- `engine.position` — track position for loop wrap detection and delta computation

**New public API:**
- `get captureNoteOnCount: ObservableValue<int>` — always accessible, 0 when not armed
- `resolveCapture(): Option<CaptureResult>` — resolve on/off pairs, return notes + mode + origin. Returns None if empty. Does NOT reset — caller decides when to reset.
- `resetCapture(): void` — clear buffer, restart session in current transport mode

**Private methods:**
- `#bufferNote(signal: NoteSignal): void` — append to `#captureEvents`, increment count
- `#captureReset(): void` — clear events, reset timing state
- `#resolveNotes(): Array<ResolvedNote>` — pair on/off, compute positions and durations
- `#computeCaptureDelta(): number` — delta from origin based on current mode

**Types returned by `resolveCapture()`:**
```
type ResolvedNote = { pitch: byte, velocity: unitValue, position: ppqn, duration: ppqn }
type CaptureResult = { mode: "stopped" | "playing", origin: number, notes: ReadonlyArray<ResolvedNote> }
```

### `Project` — orchestration and UI subscription

#### `commitMidiCapture(): void`
- Guards: `Recording.isRecording` → return
- Finds target `CaptureMidi` (focused track match or first armed)
- Calls `capture.resolveCapture()` → if None, return
- Creates boxes inside `editing.modify()`:
  - `RecordTrack.findOrCreate()` for track
  - Compute region position (playing: `origin + firstNoteDelta`, stopped: current playhead)
  - Compute region duration (`max(note.position - firstNote.position + note.duration)`)
  - `overlapResolver.fromRange()` before creating region
  - Create `NoteEventCollectionBox`, `NoteRegionBox`, `NoteEventBox` per note
  - Call solver, select region
- Calls `capture.resetCapture()` after commit

#### `subscribeMidiCaptureAvailable(observer: Observer<boolean>): Subscription`
- Single subscription point for the UI
- Aggregates: any armed CaptureMidi with `captureNoteOnCount > 0`?
- Fires on arm state changes and note count changes
- UI calls this once, never touches CaptureDevices or CaptureMidi internals

### Target capture selection

When multiple MIDI captures are armed:
1. If a track is selected (`project.timelineFocus.track`), find the armed MIDI capture whose `audioUnitBox` matches the focused track's `audioUnit`.
2. If no track is selected or no match, use the first armed MIDI capture.

### Timing strategy

**Scenario 1 (stopped)**: No latency compensation. Deltas in milliseconds. At commit, convert to ppqn via `PPQN.secondsToPulses(delta / 1000, bpmAtOrigin)`. Region position = current playhead. First note at position 0.

**Scenario 2 (playing)**: Latency compensated. Deltas in ppqn (monotonic via `#captureLoopOffset`). Region position = `origin + firstNoteDelta`. First note at position 0.

**Session origin**: Set at session start — playback start or post-commit reset.

**Deferred reset**: Transport stops with data → `#capturePendingReset = true`. Buffer preserved. Next note-on triggers reset → fresh Scenario 1 session.

**Loop handling**: Real-time `engine.position` subscription. On wrap (`currentPosition < lastPosition` with loop enabled), increment `#captureLoopOffset` by loop length.

### UI: "Capture MIDI" button

Button placed in `TransportGroup.tsx` next to the loop checkbox. Uses `IconSymbol.Capture` (new enum entry). Button becomes active (highlighted) when the buffer contains notes that can be committed. Clicking commits the capture. Requires adding `Capture` to `IconSymbol` enum and providing the corresponding SVG icon.

### Keyboard shortcut

Add to `GlobalShortcuts.ts`:
```typescript
"capture-midi": {
    shortcut: Shortcut.of(Key.KeyM, {ctrl, shift}),
    description: "Commit captured MIDI notes"
}
```

## Open Questions

All questions resolved. See Resolved Decisions below.

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
- **During recording**: Buffer disabled, commit disabled. Use `engine.isRecording` (observable), not `Recording.isRecording` (static boolean, not subscribable)
- **No separate buffer class**: All capture state and logic lives directly in `CaptureMidi`. No `MidiCaptureBuffer`. No Notifier passing.
- **Loop detection**: Requires real-time `engine.position` subscription, not just per-note checks
- **Origin after mid-playback commit**: Origin resets to current engine position, not original playback start
- **Orphan note-offs**: Silently skipped at commit time (no matching note-on in current session)
- **Buffer on playback stop**: Preserved, not cleared. User can commit after stopping. Cleared only on next note-on (deferred reset → fresh Scenario 1 session)
- **Visual feedback**: Capture button becomes active when buffer has notes. No additional indicator needed.
- **Quantization**: Raw capture only. User can quantize afterwards.
- **Multiple armed tracks**: Use the armed MIDI capture matching the selected track (`project.timelineFocus.track`). If no track selected or no match, use the first armed MIDI capture.
- **Overlap resolution**: Use `project.overlapResolver.fromRange()` before creating the region, call the returned solver after. Respects user's overlap preference (clip/push/keep).
- **Buffer size limit**: No bound.
- **Note held during commit**: Included, truncated to the commit delta.
- **editing.modify()**: Single call at commit time, default `mark: true` for one undo step
- **Selection**: Region is selected after commit
- **MIN_NOTE_DURATION**: Applied at commit time, same as RecordMidi
- **Region label**: `"Captured"`
- **Region hue**: `ColorCodes.forTrackType(TrackType.Notes)`

## Implementation Steps

### Phase 1 — Capture in CaptureMidi
1. Add capture fields, subscriptions, and private methods to `CaptureMidi`
2. Subscribe to `#notifier` → `#bufferNote()` (alongside existing engine forwarding)
3. Add engine subscriptions for mode/position tracking (managed per arm lifecycle)
4. Implement `resolveCapture()` — pair on/off, return `CaptureResult`
5. Implement `resetCapture()` — clear and restart session
6. Expose `captureNoteOnCount: ObservableValue<int>`

### Phase 2 — Project API
7. Add `CaptureDevices.allCaptures()` for aggregation
8. Add `Project.commitMidiCapture()` — find target, resolve, create boxes, reset
9. Add `Project.subscribeMidiCaptureAvailable(observer): Subscription` — single UI subscription

### Phase 3 — UI
9. Fix TransportGroup capture button — `Button` (not Checkbox), wire to `commitMidiCapture()`, subscribe via `subscribeMidiCaptureAvailable()`

### Existing (keep)
- `IconSymbol.Capture` — already added
- Capture button element in `TransportGroup.tsx` — already placed, needs rewiring
- `GlobalShortcuts.ts` — `capture-midi` shortcut already added
- `StudioShortcutManager.ts` — shortcut already wired

## Files to create
None — all logic goes into existing files.

## Files to modify
- `packages/studio/core/src/capture/CaptureMidi.ts` — add capture buffering, `commitCapture()`, `captureNoteOnCount`
- `packages/studio/core/src/capture/CaptureDevices.ts` — add `allCaptures()`
- `packages/studio/core/src/project/Project.ts` — `commitMidiCapture()`, `subscribeMidiCaptureAvailable()`
- `packages/app/studio/src/ui/header/TransportGroup.tsx` — rewire button to use `subscribeMidiCaptureAvailable()`

## Files as reference (read-only)
- `packages/studio/core/src/capture/RecordMidi.ts` — region/note creation pattern
- `packages/studio/core/src/capture/RecordTrack.ts` — track allocation
- `packages/studio/core/src/capture/Recording.ts` — session lifecycle pattern
- `packages/studio/core/src/EngineFacade.ts` — transport observables
- `packages/studio/adapters/src/NoteSignal.ts` — signal types
- `packages/studio/boxes/src/NoteEventBox.ts`, `NoteRegionBox.ts`, `NoteEventCollectionBox.ts` — box types
- `packages/studio/core/src/ui/timeline/RegionOverlapResolver.ts` — overlap resolution API (`fromRange()`)
- `packages/studio/core/src/ui/timeline/RegionClipResolver.ts` — clip resolver implementation
- `packages/studio/core/src/ui/timeline/TimelineFocus.ts` — focused track access (`project.timelineFocus.track`)
