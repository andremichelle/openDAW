# Advanced Monitoring — Independent Controls & Output Routing

**Issue:** [#230](https://github.com/andremichelle/opendaw/issues/230)

## Goal

When a track is armed for recording, the live input signal splits into two independent paths:
1. **Recording path** — goes to the `RecordingWorklet` through the existing capture `gainNode` (unchanged)
2. **Monitoring path** — has its own volume, pan, mute, and optional output device routing

The monitoring controls do **not** affect the recorded signal.

## Decisions (from Q&A)

| Question | Answer |
|----------|--------|
| Signal split point | After **source node** (option A) — capture gain only affects recording |
| Monitoring controls | Volume (dB), pan, mute — all three |
| "Effects" mode behavior | Signal goes through effects chain + channel strip, then monitoring volume/pan/mute applied **on top** |
| "Direct" mode behavior | Monitoring volume/pan/mute applied before output |
| Output routing | Both modes — via `MediaStreamDestination` → `<audio>` element with `setSinkId` |
| Persistence | **Ephemeral** — runtime-only state, lost on reload |
| UI | New menu entry in track header right-click menu → opens **modal dialog** |
| Force-mono | Stays where it is (not in the dialog) |
| Worklet second output | Pre-allocate **8 channels** (4 stereo sources max) — `outputChannelCount` is immutable after construction |

## Current Signal Flow

```
MediaStream → SourceNode → GainNode (capture gainDb)
                                ├── RecordingWorklet
                                ├── [direct]  → audioContext.destination
                                └── [effects] → EngineWorklet → effects → channelStrip → output
```

Both recording and monitoring share the same `gainNode`, so `gainDb` affects both.

## New Signal Flow

```
MediaStream → SourceNode ─┬── RecordGainNode (capture gainDb) → RecordingWorklet
                           │
                           └── [monitoring path, mode-dependent]:

  [direct]
    SourceNode → MonitorGainNode → MonitorPanNode → MonitorDestination

  [effects]
    SourceNode → EngineWorklet input[0] → effects → channelStrip
                                                         │
                                          EngineWorklet output[1] (channels assigned per track)
                                                         │
                                          ChannelSplitterNode (main thread)
                                                         │
                                          MonitorGainNode → MonitorPanNode → MonitorDestination
```

### Worklet Second Output — Channel Allocation

Mirrors the existing input-side `#rebuildMonitoringMerger` pattern, but in reverse:

- `EngineWorklet` constructed with `numberOfOutputs: 2, outputChannelCount: [numberOfChannels, 8]`
- `outputs[0]` = main mix (unchanged)
- `outputs[1]` = monitoring output, 8 channels pre-allocated (supports up to 4 stereo monitoring sources)
- The existing `MonitoringMapEntry` already assigns channel indices per audio unit — the same map drives both input and output channel allocation
- In `EngineProcessor.render()`, each audio unit with active monitoring writes its post-channel-strip signal to assigned channels in `outputs[1]`
- On the main thread, a `ChannelSplitterNode` on `outputs[1]` feeds each track's monitoring gain/pan chain

### MonitorDestination

- **Default (no output routing):** `audioContext.destination`
- **Custom output device:** `MediaStreamAudioDestinationNode` → `<audio>` element with `setSinkId(deviceId)`

### Mute

Mute silences the monitoring path but keeps the chain alive (no teardown). Implemented by setting `MonitorGainNode.gain.value = 0` when muted, restoring the monitoring volume when unmuted.

## Implementation Steps

### Step 1 — Split the signal in `CaptureAudio.ts`

Restructure `#audioChain` to have two gain nodes:

```
#audioChain: Nullable<{
    sourceNode: MediaStreamAudioSourceNode
    recordGainNode: GainNode        // for recording (existing gainDb)
    monitorGainNode: GainNode       // for monitoring (independent volume)
    monitorPanNode: StereoPannerNode // for monitoring pan
    channelCount: 1 | 2
}>
```

In `#rebuildAudioChain`:
- `sourceNode.connect(recordGainNode)` — recording path
- `sourceNode.connect(monitorGainNode)` — monitoring path (direct mode only; effects mode connects sourceNode to engine)
- `monitorGainNode.connect(monitorPanNode)` — pan after volume
- `recordGainNode.gain.value = dbToGain(this.#gainDb)` (existing behavior)
- `monitorGainNode.gain.value = muted ? 0 : dbToGain(this.#monitorVolumeDb)`
- `monitorPanNode.pan.value = this.#monitorPan`

Update `prepareRecording` / `startRecording` to use `recordGainNode` instead of `gainNode`.

### Step 2 — Add ephemeral monitoring state to `CaptureAudio`

New private fields (not persisted — no box changes):

```typescript
#monitorVolumeDb: number = 0.0
#monitorPan: number = 0.0       // -1 (L) to +1 (R)
#monitorMuted: boolean = false
```

Expose as getters/setters. Setters update the Web Audio nodes in real time:
- `monitorVolumeDb` → sets `monitorGainNode.gain.value`
- `monitorPan` → sets `monitorPanNode.pan.value`
- `monitorMuted` → sets `monitorGainNode.gain.value` to 0 or restores volume

### Step 3 — Update `#connectMonitoring` / `#disconnectMonitoring`

**"direct" mode:**
- Connect `sourceNode → monitorGainNode → monitorPanNode → MonitorDestination`
- Monitoring controls applied directly on the main-thread Web Audio graph

**"effects" mode:**
- Register `sourceNode` (raw, no capture gain) as the monitoring source with the engine
- Engine routes through effects + channel strip as today
- Post-channel-strip signal written to `outputs[1]` at assigned channels (worklet side)
- On the main thread, `ChannelSplitterNode` extracts this track's channels from `outputs[1]`
- Splitter output → `monitorGainNode → monitorPanNode → MonitorDestination`

### Step 4 — Worklet changes (second output for "effects" mode)

**`EngineWorklet.ts` (main thread):**
- Change constructor: `numberOfOutputs: 2, outputChannelCount: [numberOfChannels, 8]`
- Add `#monitoringSplitter: Nullable<ChannelSplitterNode>` for splitting `outputs[1]`
- In `#rebuildMonitoringMerger`, also rebuild the output-side splitter:
  - Create `ChannelSplitterNode(8)` connected to the worklet's second output
  - For each monitoring source, connect the assigned splitter output channels back to the corresponding `CaptureAudio`'s `monitorGainNode`
- Expose a method for `CaptureAudio` to receive its splitter output connection

**`EngineProcessor.ts` (worklet thread):**
- In `render()`, after processing all audio units:
  - For each audio unit with active monitoring channels, copy its post-channel-strip audio to the assigned channels in `outputs[1]`
  - Clear unused channels in `outputs[1]` to silence

**`AudioDeviceChain.ts` / `AudioUnit.ts`:**
- After the channel strip processes the monitoring-mixed signal, the post-channel-strip buffer must be readable
- The audio unit needs to expose its post-channel-strip monitoring contribution
- Key question: the channel strip processes the entire audio unit signal (instrument + monitoring). We need only the monitoring contribution post-effects. This may require the `MonitoringMixProcessor` to keep a copy of what it mixed in, so the post-channel-strip result can be attributed

**Simpler alternative:** Since the monitoring mix is additive (mixed into the instrument buffer), and in a recording scenario the instrument is likely silent (no playback while recording), the post-channel-strip output effectively IS the monitoring signal. If instrument playback is active simultaneously, we'd need separation — but that's an edge case we can defer.

### Step 5 — Output device routing

Add to `CaptureAudio`:

```typescript
#monitorOutputDeviceId: Option<string> = Option.None
#monitorAudioElement: Nullable<HTMLAudioElement> = null
#monitorStreamDest: Nullable<MediaStreamAudioDestinationNode> = null
```

When a custom output device is selected:
1. Create `MediaStreamAudioDestinationNode` on the `audioContext`
2. Connect `monitorPanNode → monitorStreamDest`
3. Create `<audio>` element, set `srcObject = monitorStreamDest.stream`
4. Call `audio.setSinkId(deviceId)`
5. Call `audio.play()`

When cleared (back to default):
1. Disconnect `monitorStreamDest`
2. Connect `monitorPanNode → audioContext.destination`
3. Clean up `<audio>` element

### Step 6 — Modal dialog UI

New menu entry in `TrackHeaderMenu.ts`:
```
"Monitoring Settings..." → opens MonitoringDialog
```

**MonitoringDialog** contents:
- **Volume** knob/slider (dB, default 0)
- **Pan** knob (-1 to +1, default center)
- **Mute** toggle
- **Output Device** dropdown (lists available output devices via `AudioDevices.queryListOutputDevices()`, with "Default" as first option — hidden when `setSinkId` not supported)

Dialog reads/writes the ephemeral state on `CaptureAudio`.

Only visible when `captureDevices.get(uuid)` returns a `CaptureAudio` instance (i.e., audio tracks with capture configured).

## Open Questions / Risks

1. **Monitoring + playback overlap in "effects" mode:** If an armed track also has instrument playback active, the post-channel-strip signal contains both instrument and monitoring audio. Separating them would require tracking the monitoring contribution through the effects chain. For now, assume armed tracks don't play back simultaneously — revisit if needed.

2. **Channel exhaustion:** With 8 pre-allocated channels, arming a 5th stereo track for monitoring will fail silently. Should we warn the user or fall back to "direct" mode?

3. **Latency:** The `MediaStreamDestination` → `<audio>` → `setSinkId` path adds latency. Acceptable for monitoring but worth noting.

4. **Browser support:** `setSinkId` is Chrome-only (already gated by `AudioOutputDevice.switchable`). The dialog hides the output device selector when not supported.

## Files to Modify

| File | Changes |
|------|---------|
| `packages/studio/core/src/capture/CaptureAudio.ts` | Split signal, add monitoring state, update connect/disconnect |
| `packages/studio/core/src/EngineWorklet.ts` | Second output (8ch), output-side splitter, connect to per-track monitoring chain |
| `packages/studio/core-processors/src/EngineProcessor.ts` | Write post-channel-strip monitoring to `outputs[1]` |
| `packages/studio/core-processors/src/AudioDeviceChain.ts` | Expose post-channel-strip buffer for monitoring extraction |
| `packages/app/studio/src/ui/timeline/tracks/audio-unit/headers/TrackHeaderMenu.ts` | Add "Monitoring Settings..." menu entry |
| `packages/app/studio/src/ui/monitoring/MonitoringDialog.ts` | New file — modal dialog component |
