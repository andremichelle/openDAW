# Automation: recording and manual control

How a parameter's automation is recorded, and what happens when a hand (or a MIDI controller) touches an
automated parameter while the transport runs. Two changes are documented here:

- **write-driven latch recording**, which replaced a touch-gated recorder that only ever worked for one UI
  component,
- **[#347](https://github.com/andremichelle/openDAW/issues/347) manual control**, which suspends a parameter's
  automation while it is being written.

## Recording model

**Write-driven.** Any write through `AutomatableParameterFieldAdapter.setValue` opens a take while the transport
records. Nothing opts in. A knob, a MIDI controller, a checkbox, a wheel, a typed value, a graph handle and
`Reset Value` all record the same way.

**Latching.** A take stays open until the transport stops. A loop wrap closes the take at the loop end and opens
the next one at the loop start. Releasing the pointer does nothing, which is what makes a controller with no
release event record like everything else.

### Why the old model failed

Recording used to be gated on a `touched` flag that only `AutomationControl` ever set, from its pointerdown and
pointerup listeners. Every control outside that wrapper was silently unrecordable: all modulator controls, the
Frequency Splitter graph handles, the Playfield and Vaporisateur checkboxes, wheel edits and typed values, and
MIDI, which has no pointer events at all. Patching each call site would only have lengthened an opt-in list, so
the gate was removed instead.

### Why it is safe to record every write

Only `adapter.setValue` notifies a write. Undo, redo and remote collaboration mutate box fields directly, and
engine playback publishes through the LiveStream into `#controlledValue`. None of them pass through the adapter,
so none of them can open a take. Two tests pin this.

### Lane ownership

A parameter's automation lanes resolve without any UI:

    AutomatableParameterFieldAdapter.optTracks()
      -> the registered owner, which is how a modulator keeps its parameters' lanes on itself
      -> otherwise ParameterOwner.audioUnitOf, the audio unit the parameter belongs to

Registration used to happen in `AutomationControl`, so a lane could only be found while its device editor was
mounted. A MIDI-mapped knob with the editor closed hit the "no lane owner" path on every single write.

The walk back is the same in reverse: from a lane, `trackBoxAdapter.target` points at the parameter, and that
parameter's `optTracks()` gives the owner. The modulator lane's track header uses it for the delete key and for
its "Remove Automation" menu entry, and the knob's context menu takes the same route.

`ParameterTracks.create` returns the created `TrackBox`, and the recorder takes the adapter straight from it. A
new lane only joins its collection on commit, so looking it up inside the transaction that created it returned
nothing and the first write was swallowed. That mattered once single-write controls could record: a checkbox
sends exactly one write.

## Manual control (#347)

While the transport runs, a parameter that is written by hand or by MIDI takes over from its own curve.

**Why.** Without it, re-recording over an existing pass flaps between the take being written and the pass
underneath it. The take's region only grows *behind* the playhead, once per animation frame, from a position
that has already been played (the worklet writes its state per render quantum, the main thread reads it per
frame in `EngineWorklet`). The clip resolver puts the old region's start exactly at the new region's end, and
both readers resolve the rightmost region at or before the playhead: TS `lowerEqual` in
`TrackBoxAdapter.valueAt`, wasm `floor_last_index` in `param_automation.rs`. So from the moment the playhead
crosses that edge until the next frame extends it, the old curve wins. It recurs at every grid boundary and
frame jitter makes it feel random.

No amount of geometry fixes this, because the main thread cannot keep a region end ahead of a playhead it only
learns about after the fact.

**How.** `SUSPENDED_AUTOMATION`, a runtime static in the engine beside `IGNORED_REGIONS`:

- `ParamHandle::resolve_base` returns early with the parameter's own field value, so the curve is bypassed
  whole, with no region lookup and no clip section,
- `publish` writes NaN into the UI slot, so the knob shows the manual value instead of a frozen automated one,
- cleared in `pause`, `stop` and `stop_recording`, the same three exits that clear the ignored note regions.

Modulation is untouched. It is summed separately in `resolve_split` and added on top, so a suspended parameter
still moves with its modulators, around the manual value instead of around the curve.

Nothing is written to the box graph. No `region.mute`, no `track.enabled`, no schema field. Nothing lands in
undo history, nothing is saved with the project, nothing syncs to collaborators, and the timeline looks
untouched. Keeping the set in its own cell rather than inside `CurveState` is what lets it survive a rebind, and
the parameter binding is rebuilt constantly while recording.

The command is plumbed exactly like `ignoreNoteRegion`: `protocols.ts`, `Engine.ts`, `EngineFacade`,
`EngineWorklet`, the core-wasm processor and its export typing, a no-op in the offline worker, and the dispatch
in `OfflineEngineRenderer`. Only the wasm engine needs the DSP side.

The trigger is `AutomationSuspension` (`packages/studio/core/src/project/AutomationSuspension.ts`), started from
the `Project` constructor. It suspends a parameter's lane the first time it is written while `isPlaying`, then
clears its dedup cache when the transport stops. It sends nothing for a parameter that has no lane, because then
the field value already rules. `RecordAutomation` knows nothing about any of this: the recording case falls out
of the general rule.

## Behaviours worth knowing

**A loop pass eats the pass beneath it.** As the new take grows, the clip resolver trims the older region until
it disappears, so a lane settles at the take being written plus the remains of the one before it, never one
region per pass.

**Punching in splits, it does not erase.** Recording into the middle of an existing region leaves its head and
its tail in place.

**A lane created by the take itself is suspended one write late.** `AutomationSuspension` listens on the same
write notifier as the recorder and runs first, so the write that creates a lane cannot suspend one yet. Harmless,
since a fresh lane has no older curve to fight, and the case that matters (a parameter that already owns a lane)
is suspended on its first write.

**Region boundaries are quantized forward.** The take's growth and its close both `quantizeCeil` to a semiquaver,
which trims old material up to a semiquaver ahead of where you actually played. Inaudible now that the curve is
suspended, but it is still material destroyed ahead of the playhead. Open.

## Tests

`crates/engine/src/audio_unit/tests.rs`

- a suspended lane reads the parameter field, and the curve returns after the transport stops
- a suspended lane still receives its modulation, and exactly as much as before
- a suspended lane publishes no automated value to the UI
- a rebound parameter stays under manual control
- every transport exit drops the manual control (pause, stop, ending a recording)

`packages/studio/core/src/capture/RecordAutomation.test.ts` (headless `Project` plus a fake worklet driving
`position` and `isRecording`)

- gates: not recording, an unchanged value, a field written behind the adapter, an undo
- opening a take: the first write, a single write (the checkbox case), start quantization, lane reuse, the
  seeded previous value
- writing events: overwrite in place, one event per advanced position, writes behind the last position,
  interpolation for floating and stepped parameters
- latching: a gap in the writes, growth with the transport, close on stop with the tail event, a zero-length
  take, collinear simplify, the loop wrap
- manual control: suspension during playback, once rather than per write, while recording over an older pass,
  no lane, transport idle, re-arming after a pause
- living beside existing material: a legal track after several loop passes (`RegionClipResolver.validateTrack`),
  punching into a region, two parameters at once
- midi: a take driven by a real `MIDIControllerBox` with `MidiDevices` stubbed and raw CC bytes fed in
- modulators: a modulator's own parameter, an assignment's depth, and that neither lands on the audio unit

Gotcha for anyone extending the suite: a fresh timeline has its loop **enabled** over four bars, so any backwards
seek wraps the take. The harness disables it and the wrap tests enable it explicitly.

## Not covered by tests

- a stream of CCs through the `AnimationFrame.once` batching, only the first CC is asserted
- that a live suspension cannot leak into an offline bounce (it cannot, the export renders on its own engine
  instance with an empty set, but that is reasoning rather than a test)
- everything audible, which needs the browser
