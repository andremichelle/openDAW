# Automation Wrapper

## Problem

1. **Script device parameters can't record automation.** `RecordAutomation.findOrCreateTrack` resolves the device via `adapter.field.box`, which works for regular devices (field lives directly on the device box), but fails for Apparat/Werkstatt where the field lives on a `WerkstattParameterBox` child box.

2. **No unified automation wrapper.** Automation-related concerns (context menu, control source CSS, recording interaction) are scattered across `attachParameterContextMenu`, `AutomatableControl`, `ControlIndicator`, and individual call sites. There is no single wrapper that handles all automation behavior.

3. **No automation modes.** The system has no concept of touch, latch, read, or write modes. Adding modes requires a per-control interaction model (detecting when the user grabs/releases a control), which needs a wrapper around each automatable control.

---

## Design

### New Component: `AutomationControl`

**Location:** `packages/app/studio/src/ui/components/AutomationControl.tsx`

A JSX wrapper that attaches to every automatable control element. It replaces `AutomatableControl`, `ControlIndicator`, and direct `attachParameterContextMenu` calls.

```tsx
type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    midiLearning: MIDILearning
    adapter: DeviceBoxAdapter
    parameter: AutomatableParameterFieldAdapter
    disableAutomation?: boolean
}
```

**Responsibilities:**

1. **Context menu** — Calls `attachParameterContextMenu` on the wrapped element (create/remove automation, MIDI learn, reset value).

2. **Control source CSS** — Subscribes to `parameter.catchupAndSubscribeControlSources` and toggles CSS classes (`automated`, `midi`, etc.) on the element. Merges what `AutomatableControl` and `ControlIndicator` currently do separately.

3. **Interaction tracking** — Detects when the user starts and stops interacting with the control (pointerdown/pointerup on the element). Emits interaction start/end events that the recording system can observe. This is the foundation for touch/latch modes.

4. **Track resolution for recording** — On mount, registers a mapping from parameter address to `AudioUnitTracks` with `ParameterFieldAdapters`. On unmount, removes it. `RecordAutomation.findOrCreateTrack` consults this mapping instead of trying to resolve the device from `adapter.field.box`. The wrapper already has `adapter: DeviceBoxAdapter`, so it can compute `adapter.deviceHost().audioUnitBoxAdapter().tracks` directly — no need to store device knowledge on the parameter adapter.

---

### Fix: Track Resolution in `ParameterFieldAdapters`

**Problem:** `RecordAutomation.findOrCreateTrack` does `adapter.field.box` to get the device box. For `WerkstattParameterBox`, this returns the child box, not the device box.

**Solution:** The `AutomationControl` wrapper registers the parameter's `AudioUnitTracks` with `ParameterFieldAdapters` when it mounts. `findOrCreateTrack` looks up the tracks directly instead of resolving through the box hierarchy.

**`packages/studio/adapters/src/ParameterFieldAdapters.ts`:**
- Add a `Map<Address, AudioUnitTracks>` for parameter-to-tracks mappings
- Add `registerTracks(address: Address, tracks: AudioUnitTracks): Terminable`
- Add `getTracks(address: Address): Option<AudioUnitTracks>`

**`packages/studio/core/src/capture/RecordAutomation.ts`** — simplify `findOrCreateTrack`:
```
const findOrCreateTrack = (adapter: AutomatableParameterFieldAdapter): Option<TrackBoxAdapter> => {
    const tracksOpt = parameterFieldAdapters.getTracks(adapter.address)
    if (tracksOpt.isEmpty()) { return Option.None }
    const tracks = tracksOpt.unwrap()
    const existing = tracks.controls(adapter.field)
    if (existing.nonEmpty()) { return Option.wrap(existing.unwrap()) }
    // create track...
}
```

The old `Devices.isAny` lookup and `audioUnitBoxAdapter()` traversal are removed from `findOrCreateTrack` entirely — the wrapper provides the tracks.

---

### Automation Modes (Future)

The wrapper's interaction tracking enables automation modes per-parameter or per-track:

| Mode | Behavior |
|------|----------|
| **Read** | Control follows automation playback. User interaction is ignored during playback. |
| **Touch** | User interaction overrides automation and records. On release, control returns to automated value. |
| **Latch** | User interaction overrides and records. On release, the last value is held (does not return to automated value). |
| **Write** | Automation is always overwritten during playback, even without user interaction. |

The mode would be stored per automation track (or globally in preferences). The `AutomationControl` wrapper detects interaction start/end via pointer events and communicates this to the recording system. `RecordAutomation.handleWrite` would then check the mode before creating/finalizing regions.

This is a separate implementation step that builds on the wrapper foundation.

---

## Migration

### Components to Remove

| Component | Replaced By |
|-----------|-------------|
| `AutomatableControl` (`ui/components/AutomatableControl.tsx`) | `AutomationControl` |
| `ControlIndicator` (`ui/components/ControlIndicator.tsx`) | `AutomationControl` |

### Call Sites to Migrate

Every direct `attachParameterContextMenu` call gets replaced by wrapping the control with `<AutomationControl>`:

| File | Current Pattern |
|------|----------------|
| `ParameterLabelKnob.tsx` | `lifecycle.own(attachParameterContextMenu(...))` after element creation |
| `ParameterLabel.tsx` | Conditional `attachParameterContextMenu` when `standalone === true` |
| `RevampDeviceEditor.tsx` | `lifecycle.own(attachParameterContextMenu(..., checkbox))` |
| `ChannelStrip.tsx` | 4 calls for volume, panning, mute, solo controls |
| `AudioUnitChannelControls.tsx` | 4 calls for volume, panning, mute, solo controls |
| `VaporisateurDeviceEditor.tsx` | Uses `AutomatableControl` wrapper |
| `ScriptDeviceEditor.tsx` | **Currently missing** — must be added for bool and knob controls |

---

## Implementation Order

1. **Add track registration to `ParameterFieldAdapters`** — `registerTracks` / `getTracks`
2. **Create `AutomationControl` component** — context menu + CSS + interaction tracking + `registerTracks` on mount
3. **Update `RecordAutomation.findOrCreateTrack`** — use `parameterFieldAdapters.getTracks()` instead of box traversal
4. **Migrate all call sites** — replace `attachParameterContextMenu` / `AutomatableControl` / `ControlIndicator`
5. **Add wrapper to `ScriptDeviceEditor.tsx`** — wrap both knob and bool controls

Steps 1-3 fix the recording bug. Steps 4-5 complete the migration.

---

## Files

| File | Change |
|------|--------|
| `packages/studio/adapters/src/ParameterFieldAdapters.ts` | Add `registerTracks` / `getTracks` |
| `packages/studio/core/src/capture/RecordAutomation.ts` | Use `getTracks()` instead of box traversal |
| `packages/app/studio/src/ui/components/AutomationControl.tsx` | **New** — unified wrapper component |
| `packages/app/studio/src/ui/components/AutomationControl.sass` | **New** — styles (merge from AutomatableControl.sass) |
| `packages/app/studio/src/ui/devices/ParameterLabelKnob.tsx` | Use `AutomationControl` wrapper |
| `packages/app/studio/src/ui/components/ParameterLabel.tsx` | Use `AutomationControl` wrapper |
| `packages/app/studio/src/ui/devices/audio-effects/RevampDeviceEditor.tsx` | Use `AutomationControl` wrapper |
| `packages/app/studio/src/ui/mixer/ChannelStrip.tsx` | Use `AutomationControl` wrapper |
| `packages/app/studio/src/ui/timeline/tracks/audio-unit/AudioUnitChannelControls.tsx` | Use `AutomationControl` wrapper |
| `packages/app/studio/src/ui/devices/instruments/VaporisateurDeviceEditor.tsx` | Replace `AutomatableControl` with `AutomationControl` |
| `packages/app/studio/src/ui/devices/ScriptDeviceEditor.tsx` | Wrap knob and bool controls with `AutomationControl` |
| `packages/app/studio/src/ui/components/AutomatableControl.tsx` | **Remove** after migration |
| `packages/app/studio/src/ui/components/ControlIndicator.tsx` | **Remove** after migration |
