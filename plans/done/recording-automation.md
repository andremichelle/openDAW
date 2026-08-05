# Record Automation

## Context

Record parameter value changes as value regions while the engine is in recording mode. Clip BEFORE creating/resizing — only the delta range — so the recording region is never inside the mask.

---

## Step 1: ParameterWriteEvent

`getUnitValue()` already returns the new value by the time `subscribeWrites` fires. Capture the previous unit value in `setValue()` before the field write.

**`packages/studio/adapters/src/ParameterFieldAdapters.ts`** — export `ParameterWriteEvent = { adapter, previousUnitValue }`, use as Notifier/Observer type

**`packages/studio/adapters/src/AutomatableParameterFieldAdapter.ts`** — in `setValue()`: `const old = this.getUnitValue()` before `this.#field.setValue(value)`, then `notifyWrite(this, old)`

---

## Step 2: RecordAutomation

**`packages/studio/core/src/capture/RecordAutomation.ts`**

### State

```
type RecordingState = {
    adapter: AutomatableParameterFieldAdapter
    regionAdapter: ValueRegionBoxAdapter
    floating: boolean
    lastValue: unitValue
    lastRelativePosition: ppqn
    lastEventBox: ValueEventBox
}
```

Derived from `regionAdapter`:
- `regionAdapter.position` → startPosition (set once)
- `regionAdapter.box` → regionBox
- `regionAdapter.trackBoxAdapter.unwrap()` → trackBoxAdapter
- `regionAdapter.optCollection.unwrap().box.events` → collection events ref for new ValueEventBoxes

Active recordings: `Address.newSet<RecordingState>(state => state.adapter.address)`

### Quantization

- Position: `quantizeFloor(position, PPQN.SemiQuaver)`
- Duration: `quantizeCeil(rawDuration, PPQN.SemiQuaver)`, minimum = `PPQN.SemiQuaver`
- Event positions: exact relative time (no quantization)

### Write Handler — First Write

Receives `{adapter, previousUnitValue}`:

1. `startPos = quantizeFloor(position, PPQN.SemiQuaver)`
2. Find/create track (existing logic)
3. Deselect selected regions on same track: `project.selection.deselect(...trackBoxAdapter.regions.collection.asArray().filter(r => r.isSelected).map(r => r.box))`
4. `fromRange(trackBoxAdapter, startPos, startPos + PPQN.SemiQuaver)()` — clip BEFORE creating
5. Create collectionBox, regionBox (position = startPos, duration = SemiQuaver, loopDuration = SemiQuaver)
6. `project.selection.select(regionBox)`
7. `regionAdapter = boxAdapters.adapterFor(regionBox, ValueRegionBoxAdapter)`
8. `floating = adapter.valueMapping.floating()`
9. `interpolation = floating ? Interpolation.Linear : Interpolation.None`
10. Events at position 0:
    - If `previousUnitValue !== value`: event(index=0, value=previousUnitValue, interp=None), event(index=1, value=value, interp=interpolation)
    - If equal: event(index=0, value=value, interp=interpolation)
11. Set interpolation via `InterpolationFieldAdapter.write(eventBox.interpolation, ...)`

### Write Handler — Subsequent Writes

Same dedup logic (same position → update lastEventBox, new position → create new event). Set `InterpolationFieldAdapter.write(eventBox.interpolation, state.floating ? Interpolation.Linear : Interpolation.None)` on each new event.

### Position Handler

```
if not recording or no active recordings: return
currentPosition = owner.getValue()

// Loop detection
if loopEnabled && currentPosition < lastPosition:
    for each state:
        finalize region (set duration to loopTo - startPos, add hold event, clip delta, deselect)
        restart at loopFrom (deselect track, clip, create new region/collection/events, select)
lastPosition = currentPosition

// Delta-range clip + resize
for each state:
    oldDuration = regionAdapter.box.duration.getValue()
    maxDuration = loopEnabled ? loopTo - regionAdapter.position : Infinity
    newDuration = max(SemiQuaver, quantizeCeil(min(maxDuration, currentPosition - regionAdapter.position), SemiQuaver))
    if newDuration > oldDuration:
        fromRange(trackBoxAdapter, regionAdapter.position + oldDuration, regionAdapter.position + newDuration)()
    regionAdapter.box.duration.setValue(newDuration)
    regionAdapter.box.loopDuration.setValue(newDuration)
```

### Termination Handler

```
finalPosition = engine.position.getValue()
for each state:
    finalDuration = max(0, quantizeCeil(finalPosition - regionAdapter.position, SemiQuaver))
    if finalDuration <= 0: regionAdapter.box.delete(); continue
    oldDuration = regionAdapter.box.duration.getValue()
    if finalDuration > oldDuration:
        fromRange(trackBoxAdapter, regionAdapter.position + oldDuration, regionAdapter.position + finalDuration)()
    if finalDuration !== state.lastRelativePosition:
        create hold event at finalDuration with state.lastValue
    regionAdapter.box.duration.setValue(finalDuration)
    regionAdapter.box.loopDuration.setValue(finalDuration)
```

---

## Files

| File | Change |
|------|--------|
| `packages/studio/adapters/src/ParameterFieldAdapters.ts` | `ParameterWriteEvent` type, change notifier/observer generic |
| `packages/studio/adapters/src/AutomatableParameterFieldAdapter.ts` | Capture old unit value in `setValue()` |
| `packages/studio/core/src/capture/RecordAutomation.ts` | Complete implementation |

## APIs

- `InterpolationFieldAdapter.write(field, interpolation)` — `studio-adapters/.../InterpolationFieldAdapter.ts`
- `Interpolation.None` / `.Linear` — `lib-dsp/src/value.ts`
- `ValueMapping.floating()` — `lib-std/src/value-mapping.ts`
- `PPQN.SemiQuaver` (240) — `lib-dsp/src/ppqn.ts`
- `quantizeFloor` / `quantizeCeil` — `lib-std/src/math.ts`
- `Address.newSet()` — `lib-box/src/address.ts`
- `RegionClipResolver.fromRange(track, pos, complete)` — `studio-core/.../RegionClipResolver.ts`
- `project.selection.select/deselect` — `studio-adapters/.../VertexSelection.ts`
- `project.timelineBox.loopArea` (enabled/from/to) — `studio-boxes/src/TimelineBox.ts`

## Verification

1. `npx tsc -b packages/studio/adapters/tsconfig.json` then `npx tsc -b packages/studio/core/tsconfig.json`
2. Record continuous param → linear interpolation; discrete → step
3. Different value at start → two events at position 0 (hold + new)
4. Regions clipped as recording grows (delta clipping)
5. Loop: finalize at loop-end, new at loop-from, previous kept
6. Semiquaver-quantized position (floor) and duration (ceil)
7. Track selection managed correctly
