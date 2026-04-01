# Advanced Monitoring — Independent Controls & Output Routing

**Issue:** [#230](https://github.com/andremichelle/opendaw/issues/230)

## Goal

When a track is armed for recording, the live input signal splits into two independent paths:
1. **Recording path** — goes to the `RecordingWorklet` through `recordGainNode` (capture `gainDb`)
2. **Monitoring path** — has its own volume, pan, mute, and optional output device routing

The monitoring controls do **not** affect the recorded signal.

## Decisions

| Question | Answer |
|----------|--------|
| Signal split point | After **source node** — capture gain only affects recording |
| Monitoring controls | Volume (dB), pan, mute — all three |
| "Effects" mode behavior | Signal goes through effects chain + channel strip, then monitoring volume/pan/mute applied **on top** |
| "Direct" mode behavior | Monitoring volume/pan/mute applied before output |
| Output routing | Both modes — via `MediaStreamDestination` → `<audio>` element with `setSinkId` |
| Persistence | **Ephemeral** — runtime-only state, lost on reload |
| UI | New menu entry in track header right-click menu → opens **modal dialog** |
| Force-mono | Stays where it is (not in the dialog) |
| Worklet second output | Pre-allocate **8 channels** (4 stereo sources max) — `outputChannelCount` is immutable after construction |
| `outputNode` getter | Returns `recordGainNode` (shows what's being recorded); dialog gets its own peak meter on `monitorPanNode` |
| Channel strip mute/solo | Affects monitoring in "effects" mode (accepted) |
| Dialog without armed state | Auto-arms the track when dialog opens |
| `setSinkId` failure | Show error dialog, revert to previous device |

## Signal Flow

### Current

```
MediaStream → SourceNode → GainNode (capture gainDb)
                                ├── RecordingWorklet
                                ├── [direct]  → audioContext.destination
                                └── [effects] → EngineWorklet → effects → channelStrip → output
```

### New

```
MediaStream → SourceNode ─┬── RecordGainNode (capture gainDb) → RecordingWorklet
                           │
                           └── [monitoring path, mode-dependent]:

  [direct]
    SourceNode → PassThrough → MonitorGainNode → MonitorPanNode → MonitorDestination

  [effects]
    SourceNode → EngineWorklet input → effects → channelStrip
                                                      │
                                       EngineWorklet output[1] (per-track channels)
                                                      │
                                       ChannelSplitterNode (main thread)
                                                      │
                     PassThrough → MonitorGainNode → MonitorPanNode → MonitorDestination
```

A pass-through `GainNode` (gain=1.0) sits before `MonitorGainNode`. Switching modes only means rewiring the **input** of the pass-through — everything downstream stays connected.

### MonitorDestination

- **Default (no output routing):** `audioContext.destination`
- **Custom output device:** `MediaStreamAudioDestinationNode` → `<audio>` element with `setSinkId(deviceId)`

### Mute

Sets `MonitorGainNode.gain.value = 0` when muted, restores volume when unmuted. Chain stays alive for instant unmute.

## Implementation Steps

### Step 1 — Split the signal in `CaptureAudio.ts`

Restructure `#audioChain`:

```typescript
#audioChain: Nullable<{
    sourceNode: MediaStreamAudioSourceNode
    recordGainNode: GainNode           // for recording (existing gainDb)
    monitorPassThrough: GainNode       // gain=1.0, input rewired per mode
    monitorGainNode: GainNode          // monitoring volume
    monitorPanNode: StereoPannerNode   // monitoring pan
    channelCount: 1 | 2
}>
```

In `#rebuildAudioChain`:
- `sourceNode.connect(recordGainNode)` — always connected
- `monitorPassThrough.gain.value = 1.0` — never changes
- `monitorPassThrough.connect(monitorGainNode)`
- `monitorGainNode.connect(monitorPanNode)`
- `recordGainNode.gain.value = dbToGain(this.#gainDb)`
- `monitorGainNode.gain.value = muted ? 0 : dbToGain(this.#monitorVolumeDb)`
- `monitorPanNode.pan.value = this.#monitorPan`
- Do **NOT** connect `sourceNode → monitorPassThrough` here — that's mode-dependent, handled by `#connectMonitoring`

Update `outputNode` getter to return `recordGainNode`.

Update `#destroyAudioChain` to disconnect all nodes: `sourceNode`, `recordGainNode`, `monitorPassThrough`, `monitorGainNode`, `monitorPanNode`.

Update `prepareRecording` / `startRecording` to use `recordGainNode`.

### Step 2 — Add ephemeral monitoring state to `CaptureAudio`

New private fields (not persisted):

```typescript
#monitorVolumeDb: number = 0.0
#monitorPan: number = 0.0       // -1 (L) to +1 (R)
#monitorMuted: boolean = false
```

Getters/setters that update Web Audio nodes in real time:
- `monitorVolumeDb` → `monitorGainNode.gain.value = muted ? 0 : dbToGain(value)`
- `monitorPan` → `monitorPanNode.pan.value = value`
- `monitorMuted` → `monitorGainNode.gain.value = 0` or restore

### Step 3 — Update `#connectMonitoring` / `#disconnectMonitoring`

**"direct" mode:**
- Connect `sourceNode → monitorPassThrough` (main-thread Web Audio)
- Connect `monitorPanNode → MonitorDestination`

**"effects" mode:**
- Register `sourceNode` (not `recordGainNode`) as monitoring source with engine
- Engine processes through effects + channel strip
- Engine provides a way for `CaptureAudio` to receive the post-channel-strip signal back from `output[1]` → splitter → `monitorPassThrough`
- Connect `monitorPanNode → MonitorDestination`

**"off" mode:**
- Disconnect `monitorPassThrough` input
- Disconnect `monitorPanNode` output

Fix `requestChannels` subscriber (lines 49-54) to use `sourceNode` instead of `gainNode`.

### Step 4 — Worklet changes (second output)

**`EngineWorklet.ts` (constructor):**
```typescript
numberOfOutputs: 2,
outputChannelCount: [numberOfChannels, 8]
```

**`Project.ts` (connection):**
```typescript
worklet.connect(worklet.context.destination, 0)  // Only output 0 to speakers
```

**`EngineProcessor.ts` (render):**
- Change destructuring: `render(inputs, [mainOutput, monitoringOutput])`
- After processing all audio units, for each unit with active monitoring channels:
  - Copy its post-channel-strip audio (`audioUnit.audioOutput()`) to assigned channels in `monitoringOutput`
- Assumption: armed tracks have no simultaneous tape playback, so post-channel-strip = monitoring signal

**`EngineWorklet.ts` (output splitter):**
- Add `#monitoringSplitter: Nullable<ChannelSplitterNode>`
- Rename `#rebuildMonitoringMerger` → `#rebuildMonitoring` (or similar)
- In the rebuild, handle BOTH:
  - **Input side:** ChannelMergerNode aggregating sources → worklet input (as today)
  - **Output side:** ChannelSplitterNode on worklet output[1] → per-track pass-through nodes
- When a source is added/removed, rebuild both sides in one pass
- Channel assignments (from `MonitoringMapEntry`) are shared by both sides

**New engine API:**
- The engine needs to provide a way for `CaptureAudio` to receive the processed monitoring signal back from `output[1]`. Exact API shape to be determined during implementation — either extend `registerMonitoringSource` to accept a destination node, or provide a separate getter.

### Step 5 — Output device routing

Add to `CaptureAudio`:

```typescript
#monitorOutputDeviceId: Option<string> = Option.None
#monitorAudioElement: Nullable<HTMLAudioElement> = null
#monitorStreamDest: Nullable<MediaStreamAudioDestinationNode> = null
```

When a custom output device is selected:
1. Create `MediaStreamAudioDestinationNode` on the `audioContext`
2. Disconnect `monitorPanNode` from current destination
3. Connect `monitorPanNode → monitorStreamDest`
4. Create `<audio>` element, set `srcObject = monitorStreamDest.stream`
5. Call `audio.setSinkId(deviceId)` — on failure, show error dialog and revert to previous device
6. Call `audio.play()`

When cleared (back to default):
1. Disconnect `monitorStreamDest`
2. Connect `monitorPanNode → audioContext.destination`
3. Clean up `<audio>` element

Device list sourced from `AudioDevices.queryListOutputDevices()`.

### Step 6 — Modal dialog UI

New menu entry in `TrackHeaderMenu.ts`:
```
"Monitoring Settings..." → auto-arms the track, then opens MonitoringDialog
```

**MonitoringDialog** contents:
- **Peak meter** tapping `monitorPanNode` (shows what the user hears)
- **Volume** knob/slider (dB, default 0)
- **Pan** knob (-1 to +1, default center)
- **Mute** toggle
- **Output Device** dropdown (hidden when `setSinkId` not supported)

Dialog reads/writes ephemeral state on `CaptureAudio`.

Only visible when `captureDevices.get(uuid)` returns a `CaptureAudio` instance.

## Risks

1. **Monitoring + playback overlap in "effects" mode:** If an armed track also plays back, the post-channel-strip signal contains both. We assume armed tracks don't play back simultaneously — revisit if needed.

2. **Channel exhaustion:** 8 channels = 4 stereo sources max. Arming a 5th stereo track silently gets no monitoring. Consider warning the user or falling back to "direct" mode.

3. **Latency:** `MediaStreamDestination` → `<audio>` → `setSinkId` adds latency. Acceptable for monitoring.

4. **Browser support:** `setSinkId` is Chrome-only (gated by `AudioOutputDevice.switchable`). Dialog hides output device selector when unsupported.

5. **Output splitter timing:** Brief silence (1-2 frames) when splitter rebuilds before worklet receives updated map. Inaudible.

## Files to Modify

| File | Changes |
|------|---------|
| `packages/studio/core/src/capture/CaptureAudio.ts` | Split signal, add monitoring state, pass-through node, update connect/disconnect |
| `packages/studio/core/src/EngineWorklet.ts` | Second output (8ch), output splitter, rebuild both sides, new API for monitoring output |
| `packages/studio/core/src/Engine.ts` | Interface update for new monitoring output API |
| `packages/studio/core/src/EngineFacade.ts` | Delegate new API |
| `packages/studio/core/src/project/Project.ts` | `worklet.connect(destination, 0)` — only output 0 |
| `packages/studio/core-processors/src/EngineProcessor.ts` | Destructure both outputs, write monitoring to `monitoringOutput` |
| `packages/app/studio/src/ui/timeline/tracks/audio-unit/headers/TrackHeaderMenu.ts` | Add "Monitoring Settings..." entry, auto-arm |
| `packages/app/studio/src/ui/monitoring/MonitoringDialog.ts` | New file — modal dialog with volume, pan, mute, peak meter, output device |
