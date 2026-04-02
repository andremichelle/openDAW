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
| UI | New menu entry in track header right-click menu → opens **modal dialog** (auto-arms the track) |
| Force-mono | Stays where it is (not in the dialog) |
| Worklet second output | Pre-allocate **8 channels** (4 stereo sources max) — `outputChannelCount` is immutable after construction |
| `outputNode` getter | Returns `recordGainNode` (shows what's being recorded); dialog gets its own peak meter on `monitorPanNode` |
| Channel strip mute/solo | Affects monitoring in "effects" mode (accepted) |
| `setSinkId` failure | Show error dialog, revert to previous device |
| Monitoring in main mix | **No** — skip output bus AND aux sends for units with active monitoring |
| Monitoring node channelCount | Same as track channelCount (explicit mode) |
| Aux sends with monitoring | **Skipped** — monitoring signal does not leak into aux buses |

## Signal Flow

### Current

```
MediaStream → SourceNode → GainNode (capture gainDb)
                                ├── RecordingWorklet
                                ├── [direct]  → audioContext.destination
                                └── [effects] → EngineWorklet → effects → channelStrip → outputBus → mainMix
```

### New

```
MediaStream → SourceNode ─┬── RecordGainNode (capture gainDb) → RecordingWorklet
                           │
                           └── [monitoring path, mode-dependent]:

  [direct]
    SourceNode → PassThrough → MonitorGainNode → MonitorPanNode → MonitorDestination

  [effects]
    SourceNode → EngineWorklet input → MonitoringMix → effects → channelStrip
                                                                      │
                                                        (NO output bus, NO aux sends)
                                                                      │
                                                       EngineWorklet output[1] (per-track channels)
                                                                      │
                                                       ChannelSplitterNode (main thread)
                                                                      │
                                                       ChannelMergerNode (per-track, recombines L/R)
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

### Step 1 — New class `MonitoringRouter`

**File:** `packages/studio/core/src/MonitoringRouter.ts`

Extracts all monitoring wiring logic from `EngineWorklet` into a dedicated class.

**Owns:**
- `#monitoringSources` map (uuid → `{node, numChannels}`)
- Input-side `ChannelMergerNode` (sends audio into the worklet)
- Output-side `ChannelSplitterNode(8)` (receives processed audio from worklet output[1])
- Per-track output `ChannelMergerNode(2)` (recombines L/R from splitter before feeding to pass-through)

**Constructor receives:** `EngineWorklet` (gets `AudioContext` from it, connects merger/splitter to it)

**API:**
- `registerSource(uuid, sourceNode, numChannels, destinationNode)` — registers input source AND output destination (the pass-through node)
- `unregisterSource(uuid)` — removes source and destination, rebuilds wiring
- `#rebuild()` — rebuilds both input merger and output splitter in one pass, sends `updateMonitoringMap` command, enforces 8-channel limit

**`EngineWorklet` changes:**
- Remove `#channelMerger`, `#monitoringSources`, `#rebuildMonitoringMerger`
- Create and own a `MonitoringRouter` instance
- Delegate `registerMonitoringSource` / `unregisterMonitoringSource` to the router
- Constructor: `numberOfOutputs: 2, outputChannelCount: [numberOfChannels, 8]`

### Step 2 — Split the signal in `CaptureAudio.ts`

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
- `monitorPassThrough` → `monitorGainNode` → `monitorPanNode` — always connected
- All monitoring nodes get `channelCount` and `channelCountMode = "explicit"` matching the track
- Do **NOT** connect `sourceNode → monitorPassThrough` here — that's mode-dependent, handled by `#connectMonitoring`
- `recordGainNode.gain.value = dbToGain(this.#gainDb)`
- `monitorGainNode.gain.value = muted ? 0 : dbToGain(this.#monitorVolumeDb)`
- `monitorPanNode.pan.value = this.#monitorPan`

Update `outputNode` getter to return `recordGainNode`.

Update `#destroyAudioChain` to disconnect all nodes: `sourceNode`, `recordGainNode`, `monitorPassThrough`, `monitorGainNode`, `monitorPanNode`.

Update `prepareRecording` / `startRecording` to use `recordGainNode`.

Update `gainDb` subscriber to set `recordGainNode.gain.value`.

Update `requestChannels` subscriber to re-register with `sourceNode` (not `gainNode`).

### Step 3 — Add ephemeral monitoring state to `CaptureAudio`

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

### Step 4 — Update `#connectMonitoring` / `#disconnectMonitoring`

**"direct" mode:**
- Connect `sourceNode → monitorPassThrough`
- Connect `monitorPanNode → MonitorDestination`

**"effects" mode:**
- Call `MonitoringRouter.registerSource(uuid, sourceNode, channelCount, monitorPassThrough)`
- This wires: sourceNode → engine input, engine output[1] → splitter → per-track merger → monitorPassThrough
- Connect `monitorPanNode → MonitorDestination`

**"off" mode:**
- Disconnect `monitorPassThrough` input
- Disconnect `monitorPanNode` output

### Step 5 — Worklet-side changes

**`Project.ts`:**
```typescript
worklet.connect(worklet.context.destination, 0)  // Only output 0 to speakers
```

**`EngineProcessor.ts` render method:**
- Change destructuring: `render(inputs, [mainOutput, monitoringOutput])`
- Store the monitoring map as a field (set via `updateMonitoringMap` command)
- After processing all units, iterate the stored map:
  - For each entry, copy `audioUnit.audioOutput().channels()` to assigned channels in `monitoringOutput`
- Assumption: armed tracks have no simultaneous tape playback

**`AudioDeviceChain.ts` `#wire()` method:**
- When `MonitoringMixProcessor` is active:
  - **Skip output bus connection** (lines 202-206) — monitoring audio does NOT reach the main mix
  - **Skip aux sends** (lines 191-198) — monitoring audio does NOT leak into aux buses
  - Still wire: MonitoringMix → effects → channelStrip (so effects and channel strip still process the signal)

### Step 6 — Output device routing

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

### Step 7 — Modal dialog UI

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

### Step 8 — Update `Engine` interface and `EngineFacade`

**`Engine.ts`:** Update `registerMonitoringSource` signature to include destination node, or add new method for the router API. Exact shape TBD during implementation.

**`EngineFacade.ts`:** Delegate new API to the underlying worklet's `MonitoringRouter`.

## Risks

1. **Monitoring + playback overlap in "effects" mode:** If an armed track also plays back, the post-channel-strip signal contains both. We assume armed tracks don't play back simultaneously — revisit if needed.

2. **Channel exhaustion:** 8 channels = 4 stereo sources max. Arming a 5th stereo track silently gets no monitoring. Consider warning the user or falling back to "direct" mode.

3. **Latency:** `MediaStreamDestination` → `<audio>` → `setSinkId` adds latency. Acceptable for monitoring.

4. **Browser support:** `setSinkId` is Chrome-only (gated by `AudioOutputDevice.switchable`). Dialog hides output device selector when unsupported.

5. **Output splitter timing:** Brief silence (1-2 frames) when splitter rebuilds before worklet receives updated map. Inaudible.

## Files to Modify

| File | Changes |
|------|---------|
| `packages/studio/core/src/MonitoringRouter.ts` | **New file** — extracted monitoring wiring logic |
| `packages/studio/core/src/capture/CaptureAudio.ts` | Split signal, add monitoring state, pass-through node, update connect/disconnect |
| `packages/studio/core/src/EngineWorklet.ts` | Second output (8ch), delegate monitoring to `MonitoringRouter` |
| `packages/studio/core/src/Engine.ts` | Interface update for new monitoring API |
| `packages/studio/core/src/EngineFacade.ts` | Delegate new API |
| `packages/studio/core/src/project/Project.ts` | `worklet.connect(destination, 0)` — only output 0 |
| `packages/studio/core-processors/src/EngineProcessor.ts` | Destructure both outputs, store monitoring map, write monitoring to `monitoringOutput` |
| `packages/studio/core-processors/src/AudioDeviceChain.ts` | Skip output bus and aux sends when monitoring is active |
| `packages/app/studio/src/ui/timeline/tracks/audio-unit/headers/TrackHeaderMenu.ts` | Add "Monitoring Settings..." entry, auto-arm |
| `packages/app/studio/src/ui/monitoring/MonitoringDialog.ts` | **New file** — modal dialog with volume, pan, mute, peak meter, output device |
