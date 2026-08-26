# Advanced Monitoring — Independent Controls & Output Routing

**Issue:** [#230](https://github.com/andremichelle/opendaw/issues/230)

## Overview

Split the capture input signal into two independent paths: one for recording (through `recordGainNode` with capture `gainDb`) and one for monitoring (through its own volume/pan/mute chain with optional output device routing). The monitoring controls do not affect the recorded signal.

## Architecture

### Signal Flow

```
                                ┌─ recordGainNode (capture gainDb) ─── RecordingWorklet
                                │
MediaStream ─── sourceNode ─────┤
                                │         ┌─────────────────────────────────────────────────┐
                                │         │ Monitoring (persistent, always stereo)           │
                                └─ ... ─► │ monitorGainNode ─── monitorPanNode ─── output   │
                                          └─────────────────────────────────────────────────┘
```

The `...` input to `monitorGainNode` depends on the monitoring mode:

| Mode | Input to monitorGainNode | Processing |
|------|-------------------------|------------|
| off | nothing (silence) | — |
| direct | sourceNode | none |
| effects | MonitoringRouter output | effects → channelStrip (no output bus, no aux sends) |

### Effects Mode — Worklet Second Output

The monitoring signal must go through the worklet's effect chain and come back out separately from the main mix. This requires a second output on the `AudioWorkletNode`.

**Input side** (exists today): `ChannelMergerNode` aggregates all monitoring sources → worklet `input[0]` → `MonitoringMixProcessor` mixes into audio unit buffer → effects → channelStrip.

**Output side** (new): `EngineProcessor` copies post-channel-strip audio to worklet `output[1]` at assigned channels → main thread `ChannelSplitterNode` demuxes → per-track `ChannelMergerNode(2)` recombines L/R → `monitorGainNode`.

Both sides share the same channel assignments from `MonitoringMapEntry`.

Pre-allocated: `outputChannelCount: [numberOfChannels, 8]` — supports 4 stereo sources. Immutable after construction.

### Monitoring Output

- **Default**: `monitorPanNode → audioContext.destination`
- **Custom device**: `monitorPanNode → MediaStreamAudioDestinationNode → <audio> element with setSinkId`

### Key Decisions

- Monitoring controls are **ephemeral** (lost on reload)
- Monitoring chain is **always stereo** (force-mono only affects input before the split)
- `monitorGainNode` is the stable entry point — no pass-through needed
- Channel strip mute/solo affects monitoring in effects mode (accepted)
- `outputNode` getter returns `recordGainNode` (for recording peak meter)
- Dialog gets its own peak meter tapping `monitorPanNode`
- Opening the dialog **auto-arms** the track
- `setSinkId` failure → error dialog, revert to previous device
- Armed tracks assumed to have no simultaneous tape playback

## Implementation

### 1. Fix monitoring cleanup bugs in `CaptureAudio.ts`

Prerequisite. Three paths destroy the audio chain without cleaning up engine registrations:

**`#stopStream`** — add `#disconnectMonitoring()` before `#destroyAudioChain()`:
```typescript
#stopStream(): void {
    this.#disconnectMonitoring()
    this.#destroyAudioChain()
    this.#stream.clear(stream => stream.getAudioTracks().forEach(track => track.stop()))
}
```

**`#rebuildAudioChain`** — replace `wasMonitoringMode` pattern with explicit disconnect + reconnect:
```typescript
#rebuildAudioChain(stream: MediaStream): void {
    this.#disconnectMonitoring()
    this.#destroyAudioChain()
    // ... create new sourceNode, recordGainNode ...
    this.#connectMonitoring()
}
```

**Termination** — register cleanup in constructor:
```typescript
this.own(Terminable.create(() => {
    this.#disconnectMonitoring()
    if (isDefined(this.#monitorAudioElement)) {
        this.#monitorAudioElement.pause()
        this.#monitorAudioElement.srcObject = null
    }
}))
```

**Remove** the redundant re-registration in the `requestChannels` subscriber (lines 49-54). After this fix, `#rebuildAudioChain` already handles it.

### 2. `MonitoringRouter` — new class

**File:** `packages/studio/core/src/MonitoringRouter.ts`

Extracts monitoring wiring from `EngineWorklet`. Manages both input and output sides.

```
Constructor(worklet: EngineWorklet)
  - Gets AudioContext from worklet
  - Creates ChannelSplitterNode(8) connected to worklet output 1

registerSource(uuid, sourceNode, numChannels, monitorGainNode)
  - Stores {sourceNode, numChannels, monitorGainNode} in map
  - Calls #rebuild()

unregisterSource(uuid)
  - Removes from map (does NOT disconnect sourceNode — it's shared with the recording path)
  - Calls #rebuild()

#rebuild()
  - Disconnects old ChannelMergerNode (input side)
  - Disconnects all old per-track output ChannelMergerNode(2)s from their monitorGainNodes
  - If no sources: sends empty map to worklet, returns
  - Enforces 8-channel limit (log warning if exceeded)
  - Creates new ChannelMergerNode(totalChannels), connects to worklet input
  - For each source:
    - Splits sourceNode channels → merger inputs (input side, as today)
    - Creates new ChannelMergerNode(2), connects splitter outputs → merger → monitorGainNode (output side)
    - Records channel assignments
  - Sends updateMonitoringMap to worklet
```

**EngineWorklet changes:**
- Constructor: `numberOfOutputs: 2, outputChannelCount: [numberOfChannels, 8]`
- Remove `#channelMerger`, `#monitoringSources`, `#rebuildMonitoringMerger`
- Create and own `MonitoringRouter`
- Delegate `registerMonitoringSource` / `unregisterMonitoringSource` to router

### 3. Rework `CaptureAudio.ts`

**Persistent monitoring nodes** — created once in constructor, always stereo:
```typescript
readonly #monitorGainNode: GainNode          // volume, entry point for monitoring signal
readonly #monitorPanNode: StereoPannerNode   // pan
```
Wired once: `monitorGainNode → monitorPanNode`. Disconnected in terminator.

**Shrink `#audioChain`** to stream-dependent nodes only:
```typescript
#audioChain: Nullable<{
    sourceNode: MediaStreamAudioSourceNode
    recordGainNode: GainNode
    channelCount: 1 | 2
}>
```

**Ephemeral monitoring state:**
```typescript
#monitorVolumeDb: number = 0.0
#monitorPan: number = 0.0
#monitorMuted: boolean = false
```
Setters update Web Audio nodes directly (`monitorGainNode.gain.value`, `monitorPanNode.pan.value`). Mute sets gain to 0.

**`#rebuildAudioChain`**: creates `sourceNode` and `recordGainNode`, connects them. Calls `#connectMonitoring()` at the end.

**`#destroyAudioChain`**: disconnects `sourceNode` and `recordGainNode` only.

**`outputNode`**: returns `recordGainNode`.

**`prepareRecording`**: connects `recordGainNode` to `RecordingWorklet`.

**`startRecording`**: passes `recordGainNode` as `sourceNode` to `RecordAudio.start`.

**`gainDb` subscriber**: sets `recordGainNode.gain.value`.

**`#connectMonitoring`**:
```
off:     no connections
direct:  sourceNode → monitorGainNode
         monitorPanNode → monitorDestination
effects: engine.registerMonitoringSource(uuid, sourceNode, channelCount, monitorGainNode)
         monitorPanNode → monitorDestination
```
Where `monitorDestination` is `#monitorStreamDest` if set, else `audioContext.destination`.

**`#disconnectMonitoring`** — guards against null `#audioChain`, uses **targeted** disconnects to preserve dialog meter and recording path:
```
if #audioChain is null: return (nothing was connected)
off:     no-op
direct:  sourceNode.disconnect(monitorGainNode)
         monitorPanNode.disconnect(currentDestination)
effects: engine.unregisterMonitoringSource(uuid)  // does NOT disconnect sourceNode
         monitorPanNode.disconnect(currentDestination)
```
Where `currentDestination` is `#monitorStreamDest` if set, else `audioContext.destination`.

Note: `unregisterMonitoringSource` must NOT call `sourceNode.disconnect()` — sourceNode is shared with the recording path (`sourceNode → recordGainNode → RecordingWorklet`). The router only removes the source from its map and rebuilds internal wiring.

### 4. Worklet-side changes

**`Project.ts`**: `worklet.connect(worklet.context.destination, 0)` — only main output.

**`AudioOfflineRenderer.ts`**: `engineWorklet.connect(context.destination, 0)` — same fix for offline rendering.

**`EngineProcessor.ts`**:
- Change: `render(inputs, [mainOutput, monitoringOutput])`
- Add field: `#monitoringMap: ReadonlyArray<MonitoringMapEntry> = []`
- In `updateMonitoringMap` command: store the map in addition to configuring audio units
- After processing all units (line 378), before writing main output:
```typescript
if (isDefined(monitoringOutput)) {
    for (const {uuid, channels} of this.#monitoringMap) {
        this.optAudioUnit(uuid).ifSome(unit => {
            const [l, r] = unit.audioOutput().channels()
            monitoringOutput[channels[0]].set(l)
            if (channels.length === 2) {monitoringOutput[channels[1]].set(r)}
        })
    }
}
```

**`AudioDeviceChain.ts`** — in `#wire()`, when monitoring mixer is active, skip aux sends and output bus:
```typescript
const monitoringActive = this.#monitoringMixer.nonEmpty() && this.#monitoringMixer.unwrap().isActive
if (this.#options.includeSends && !monitoringActive) {
    // ... existing aux send wiring ...
}
// ... channel strip wiring (always) ...
if (optOutput.nonEmpty() && !isOutputUnit && !monitoringActive) {
    // ... existing output bus wiring ...
}
```

### 5. Output device routing in `CaptureAudio.ts`

```typescript
#monitorOutputDeviceId: Option<string> = Option.None
#monitorAudioElement: Nullable<HTMLAudioElement> = null
#monitorStreamDest: Nullable<MediaStreamAudioDestinationNode> = null
```

**New method `setMonitorOutputDevice(deviceId: Option<string>)`:**

Always creates/clears the destination infrastructure regardless of monitoring state — so `#connectMonitoring` can find it when monitoring starts later.

- Stores `#monitorOutputDeviceId`
- If monitoring is active: `monitorPanNode.disconnect(oldDestination)` — targeted disconnect, preserves meter connection
- If deviceId is set: create `MediaStreamAudioDestinationNode`, `<audio>` element with `setSinkId`. On failure: show error dialog, revert.
- If deviceId is none: clean up `<audio>` element (`pause()`, `srcObject = null`), clear `#monitorStreamDest`
- If monitoring is active: connect `monitorPanNode → newDestination`

`#connectMonitoring` checks `#monitorStreamDest` to decide where `monitorPanNode` connects.

### 6. Engine interface update

**`Engine.ts`**: add `destinationNode: AudioNode` parameter to `registerMonitoringSource`.

**`EngineFacade.ts`**: delegate with existing `ifSome` guard (safe no-op if worklet terminated).

### 7. Modal dialog

**`TrackHeaderMenu.ts`**: new entry "Monitoring Settings..." — auto-arms, opens `MonitoringDialog`.

**`MonitoringDialog.ts`** (new file): modal dialog with:
- **Mode selector** (off / direct / effects) — moved from TrackHeaderMenu
- **Volume** knob (dB)
- **Pan** knob
- **Mute** toggle
- **Peak meter** (tapping `monitorPanNode`)
- **Output device** dropdown (hidden when `setSinkId` unsupported)

Remove the existing "Input Monitoring" submenu from `TrackHeaderMenu.ts`.

## Testing

### Smoke Tests

1. **Direct monitoring basic**: Arm track → set monitoring to "direct" → speak into mic → hear yourself from speakers. Adjust volume knob → loudness changes. Adjust pan → signal moves. Mute → silence. Unmute → instant return.
2. **Effects monitoring basic**: Arm track → add a reverb effect → set monitoring to "effects" → speak into mic → hear yourself with reverb. Channel strip volume/pan should also affect monitoring.
3. **Recording independence**: Arm track → enable direct monitoring → set monitoring volume to -12dB → record → stop → play back region. Recorded audio should be at full capture gain, not affected by monitoring volume.
4. **Output device routing**: Open monitoring dialog → select a different output device (e.g. headphones) → monitoring plays from headphones, main mix from speakers. Switch back to default → monitoring returns to speakers.

### Mode Switching

5. **Off → direct → effects → off**: Each transition should be clean, no audio glitch longer than a couple of frames. No dangling connections (check console for errors).
6. **Direct → effects while monitoring**: Sound should briefly cut then resume with effects applied.
7. **Effects → direct while monitoring**: Sound should briefly cut then resume dry.

### Lifecycle

8. **Device change while monitoring**: Arm track → enable effects monitoring → change input device in capture menu → monitoring should resume on new device without errors.
9. **Channel count change while monitoring**: Switch from stereo to mono input (force-mono) → monitoring continues, effects re-register correctly.
10. **Disarm while monitoring**: Monitoring is on → disarm track → monitoring stops cleanly, no console errors, no dangling engine registrations.
11. **Delete track while monitoring**: Track with active effects monitoring → delete track → no errors, engine monitoring map is clean.
12. **Close project while monitoring**: Effects monitoring active → close project → no errors, all connections cleaned up (EngineWorklet terminates before CaptureDevices — verify `ifSome` guard works).

### Multiple Tracks

13. **Two tracks, direct monitoring**: Arm two tracks → both in direct mode → both audible with independent volume/pan/mute.
14. **Two tracks, effects monitoring**: Arm two tracks → both in effects mode → each gets its own channel pair in output[1]. Independent controls. Verify channel assignments update when one is disarmed.
15. **Mixed modes**: Track A in direct, Track B in effects → both work independently.
16. **Channel exhaustion**: Arm 5 stereo tracks in effects mode → first 4 get monitoring, 5th should fail gracefully (log warning, no crash). Verify monitoring works for the 4 that got channels.

### Output Routing

17. **Custom device + mode switch**: Set custom output device → switch from direct to effects → monitoring should still play from custom device.
18. **Custom device + disarm/rearm**: Set custom output device → disarm → rearm → re-enable monitoring → custom device should still be active (ephemeral state survives within session).
19. **Device removal**: Monitoring to custom device → unplug device → `setSinkId` should fail → error dialog → reverts to previous device.
20. **Default after custom**: Set custom device → set back to "Default" → monitoring returns to `audioContext.destination`.

### Recording Integration

21. **Record with direct monitoring**: Enable direct monitoring → start recording → monitoring stays active during recording → stop → recorded audio is clean, no monitoring artifacts.
22. **Record with effects monitoring**: Enable effects monitoring → start recording → monitoring continues through effects → stop → recorded audio is dry (no effects baked in, since recording taps `recordGainNode` before the engine).
23. **Count-in with monitoring**: Enable monitoring → record with count-in → monitoring should be audible during count-in.

### Main Mix Isolation

24. **Effects monitoring not in main mix**: Arm track → effects monitoring → check that the main output peak meters do NOT show the monitoring signal. Solo another track → monitoring should not appear in the solo'd output.
25. **Aux sends not leaking**: Track with effects monitoring + aux send to reverb bus → reverb bus should NOT receive monitoring signal. Main mix reverb bus output should be silent (assuming no other sources).

### Edge Cases

26. **Monitoring dialog on non-capture track**: Menu entry should not appear.
27. **Frozen track**: Cannot arm frozen tracks — monitoring dialog entry should not appear.
28. **Mute via channel strip in effects mode**: Mute the track's channel strip → monitoring goes silent (expected). Unmute → monitoring returns.
29. **Solo interaction in effects mode**: Solo a different track → armed track's channel strip is soloed out → monitoring goes silent (expected).
30. **Rapid mode switching**: Toggle off/direct/effects rapidly → no crashes, no orphaned connections.
31. **Open dialog, change nothing, close**: No state changes, no side effects beyond auto-arm.
32. **Set output device while monitoring is off**: Open dialog → select custom output device → set mode to "direct" → monitoring should play from custom device immediately.
33. **Set mode to off with custom device**: Custom device set, monitoring active → set mode to "off" → no audio, custom device setting preserved → set mode back to "direct" → plays from custom device.
34. **Dialog peak meter during output device switch**: Peak meter tapping `monitorPanNode` should survive output device changes (targeted disconnect preserves meter connection).
35. **Stream not ready when enabling monitoring**: Open dialog (auto-arms) → immediately set mode to "direct" before stream initializes → monitoring should start automatically when stream becomes available (no errors in between).
36. **Disconnect specificity**: Enable direct monitoring → verify recording path still works. `sourceNode.disconnect(monitorGainNode)` must not break `sourceNode → recordGainNode`.
37. **Mode switch in dialog preserves meter**: Open dialog → enable direct monitoring → meter shows signal → switch to effects → meter should survive the mode transition (targeted disconnect preserves connection).
38. **Output device switch in dialog preserves meter**: Open dialog → enable monitoring → meter active → switch output device → meter should survive (targeted disconnect).
39. **Offline render unaffected**: Export stems or offline render with armed tracks → offline output should not contain monitoring signal. Verify `AudioOfflineRenderer` connects only output 0.
40. **Set device then enable monitoring**: Open dialog → select custom device while mode is "off" → set mode to "direct" → monitoring should immediately play from custom device (not default speakers).
41. **Termination with active audio element**: Custom output device active, monitoring playing → delete track → no resource leaks (audio element paused, srcObject cleared, no console errors).
42. **Recording survives effects unregister**: Start recording → enable effects monitoring → switch to direct monitoring (unregisters from engine) → recording must continue without interruption. `sourceNode → recordGainNode` connection must survive the unregister.
43. **Mode switch before stream ready**: Set mode to "direct" → before stream arrives, switch to "effects" → `#disconnectMonitoring` with null `#audioChain` → must not crash (guard returns early).
44. **Multiple rebuild cycles don't leak mergers**: Arm track → effects monitoring → change input device 5 times → check console for no Web Audio warnings, verify old per-track mergers are disconnected on each rebuild.

## Risks

1. **Monitoring + playback overlap**: post-channel-strip signal contains both if armed track has playback. We assume armed tracks don't play back — revisit if needed.
2. **Channel exhaustion**: 8 channels = 4 stereo max. 5th track gets no effects monitoring. Consider warning or fallback to direct.
3. **Output device latency**: `MediaStreamDestination → <audio> → setSinkId` adds latency. Acceptable for monitoring.
4. **Browser support**: `setSinkId` is Chrome-only. Dialog hides selector when unsupported.
5. **Splitter timing**: 1-2 frames of silence when sources added/removed. Inaudible.
6. **Termination order**: EngineWorklet terminates before CaptureDevices. `EngineFacade.ifSome` ensures safe no-op.

## Files

| File | Change |
|------|--------|
| `studio/core/src/MonitoringRouter.ts` | **New** — input merger + output splitter + channel management |
| `studio/core/src/capture/CaptureAudio.ts` | Cleanup bugs, signal split, persistent monitoring nodes, ephemeral state |
| `studio/core/src/EngineWorklet.ts` | Second output (8ch), delegate to MonitoringRouter |
| `studio/core/src/Engine.ts` | Add destinationNode param to registerMonitoringSource |
| `studio/core/src/EngineFacade.ts` | Delegate updated signature |
| `studio/core/src/project/Project.ts` | `worklet.connect(destination, 0)` |
| `studio/core/src/AudioOfflineRenderer.ts` | `engineWorklet.connect(destination, 0)` |
| `studio/core-processors/src/EngineProcessor.ts` | Store map, write monitoring to output[1] |
| `studio/core-processors/src/AudioDeviceChain.ts` | Skip output bus + aux sends when monitoring active |
| `app/studio/src/ui/.../TrackHeaderMenu.ts` | Add menu entry |
| `app/studio/src/ui/monitoring/MonitoringDialog.ts` | **New** — modal dialog |
