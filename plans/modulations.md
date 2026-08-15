# Modulations

Modulators are project-global sources (LFO, step sequencer, random, macro) that offset device
parameters in normalized space, on top of automation.

## The formula

```
base   = automation value at position, else the parameter's storage value   (both in 0..1)
sum    = total over all enabled assignments of (depth * source shape)
final  = clamp(base + sum, 0, 1)
```

`final` is then mapped to the parameter's real value by whoever owns the mapping.

## How the engine fetches parameter values today

The TS DSP engine is gone (`packages/studio/core-processors/src/register.ts` registers only the
meter and the recorder), so this is a WASM-engine-only feature.

Binding
`crates/engine/src/audio_unit/params.rs:336` `bind_device` calls the device's `init`, which calls
`abi::bind_parameter(&FIELD_PATH)` once per parameter and gets back an integer id. The host records
the field paths, then `observe_param` (`params.rs:548`) watches the box field's value, watches the
field's pointer hub, and looks for a Value `TrackBox` targeting exactly that `(box uuid, field
path)` (`build_param_track`, `params.rs:158`).

Resolution
`ParamHandle::resolve` (`crates/engine/src/param_automation.rs:50`) returns one of two things.
Automated and covered by a curve gives the uniform `0..1` value tagged `PARAM_KIND_UNIT`, and the
device maps it. Otherwise it gives the box field's real stored value tagged with its primitive kind
(`_INT` / `_FLOAT` / `_BOOL`), and the device uses it directly.

Delivery, two paths
Push, for edits and for build time. `refresh_params` (`params.rs:68`) resolves, diffs against
`handle.last`, and calls the device's `parameter_changed(state_ptr, id, kind, value)` export.
Pull, during render. A device's render template walks the update-clock grid with
`abi::first_update_position` / `next_update_position` and calls `abi::update_parameters(position,
&mut changes)`, which reaches `host_update_parameters` (`crates/engine/src/lib.rs:980`). That
resolves only parameters that have a track, diffs, and writes `ParamChange {id, kind, value}` into
the device's scratch. `abi::apply_param_changes` (`crates/abi/src/lib.rs:909`) decodes each one and
calls the device's `parameter_changed`.

The clock
`UPDATE_CLOCK_RATE = 10` pulses (`crates/dsp/src/ppqn.rs:15`), mirroring lib-dsp
`UpdateClockRate = PPQN.fromSignature(1, 384)`. At 960 PPQN that is one tick per 1/96 quarter, about
192 Hz at 120 BPM. The grid is a WASM contract shared with the TS side. Both grid exports return
`INFINITY` when the current device has no automated parameter or when the quantum is not
transporting (`lib.rs:809`, `lib.rs:824`), so an unautomated device never fragments its render.

Host-side parameters
The channel strip volume, pan, mute and solo, and the aux send gain and pan, do not go through a
device. They are resolved in the host, which knows their mappings explicitly
(`bind_strip_automation`, `params.rs:248`, with `Decibel::new(-96, -9, 6)` and `Linear::bipolar()`).

UI feedback
While a track is attached, the host registers a broadcast slot at the parameter's field address and
`resolve` writes the current unit value into it (`params.rs:604`). `AutomatableParameterFieldAdapter`
subscribes to it and exposes `getControlledUnitValue()`, which is what `Knob.tsx:96` draws. `NaN`
means "no automated value here, show the storage value".

Groundwork that already exists
`Pointers.Modulation` is declared (`packages/studio/enums/src/Pointers.ts:31`) and every parameter
field already accepts it through `ParameterPointerRules`
(`packages/studio/forge-boxes/src/schema/std/Defaults.ts`). `ControlSource` already has
`"modulated"` (`packages/lib/std/src/parameters.ts:22`), `AutomatableParameterFieldAdapter` already
maps that pointer type to it, and `AutomatableControl.tsx:27` already puts a `modulated` class on
the control. Nothing uses any of it yet. The parameter's pointer-hub subscription in `observe_param`
already fires the heavy rebind signal when any pointer attaches to a parameter field, so attaching a
modulation will re-bind the parameter with no extra plumbing.

## Where the sum is applied

The host cannot normalize a storage value. It holds the parameter's real unit (Hz, dB, semitones, a
bool) and the mapping lives in the device, at the call site
(`float_value(value, &LFO_SPEED_MAPPING)` inside `parameter_changed`). The generated Rust box
registry carries field types only, no constraints (`crates/studio-boxes/src/registry.rs`), and the
authoritative mappings live in the TS `*BoxAdapter` and are mirrored in the device, not in the
schema.

So the host does not normalize anything. It ships the base value exactly as it does today and adds
the modulation sum as a second number, and the sum is resolved inside the helper the device already
calls with its mapping.

`ParamValue` gains one variant.

```rust
pub enum ParamValue {
    Unit(f32),
    Int(i32),
    Float(f32),
    Bool(bool),
    /// A modulated parameter: the base as it would have arrived (`kind` says how to read it) plus the
    /// summed modulation in normalized space.
    Modulated {base: f32, kind: u32, sum: f32}
}
```

`float_value` / `int_value` / `bool_value` gain one arm, and that arm is the entire feature.

```rust
pub fn float_value<M: ValueMapping<f32>>(value: ParamValue, mapping: &M) -> f32 {
    match value {
        ParamValue::Unit(unit) => mapping.y(unit),
        ParamValue::Float(real) => real,
        ParamValue::Modulated {base, kind, sum} => {
            let unit = if kind == PARAM_KIND_UNIT {base} else {mapping.x(base)};
            mapping.y(clamp(unit + sum, 0.0, 1.0))
        }
        ParamValue::Int(_) | ParamValue::Bool(_) => panic!("expected a float parameter")
    }
}
```

What that does to a device, taking the crusher.

```rust
fn parameter_changed(state: &mut CrusherState, id: u32, value: ParamValue) {
    if id == state.crush_id {
        state.dsp.set_crush(1.0 - float_value(value, &CRUSH_MAPPING));
    } else if id == state.bits_id {
        state.dsp.set_bit_depth(int_value(value, &BITS_MAPPING));
    }
    ...
```

Not one line changes, and the device is fully modulatable. The mapping is already at the call site.
The device's own post-processing (`1.0 - ...`) still applies after the mapping, in the right order.

The properties that follow

The mapping never leaves the device. Nothing is copied, so a mapping that later carries internal
state stays correct with no synchronisation protocol, because it is applied where it lives.

The host never calls back into a device that is inside its own `process`, so there is no re-entrancy
question.

The sum travels with the value on the existing delivery, so it is computed exactly when a value is
delivered. A quantum with no update tick does no work, and a quantum with two ticks resolves each one
independently.

The host stays mapping-agnostic, which is the property the engine was built around.

Modulation is not visible at any consumption site. `parameter_changed` bodies are untouched, in every
device.

## What changes in the ABI

The wire gains one f32, with NaN as the "no modulation" sentinel, the same sentinel the codebase
already uses for `ParamHandle::last` and for the UI broadcast.

```
parameter_changed(state_ptr, id, kind, value, modulation)      // 26 exported shims, one line each
ParamChange {id, kind, value, modulation}                      // the pull path's struct
ParamValue::from_wire(kind, value, modulation)                 // builds Modulated when not NaN
```

`abi::apply_param_changes` (`crates/abi/src/lib.rs:909`) is the only decode site for the pull path,
and the device templates are the only ones for the push path, so this stays inside the ABI.

Devices that match `ParamValue` directly get a compile error and one new arm. There are about a dozen
real ones (`sync_index` in `device-delay/src/lib.rs:79`, the local converters in
`device-cubed/src/device.rs:210`, and a handful more), and the fix is to delegate to the generic
helper with the mapping that site already knows. The other 101 hits of `ParamValue::` in the stock
devices are test constructors, which keep compiling untouched. The 277 helper call sites need no
change whatsoever.

A parameter whose call site genuinely has no mapping cannot be modulated. The helper's `Modulated`
arm has nothing to normalize with, so it falls back to the base. Those are rare (a raw pass-through
like Cubed's tuning in cents) and it is a per-device migration note, not a design hole.

Round-trip precision. `y(x(v))` is not bit-identical to `v` for exponential and power mappings, so a
parameter only takes the `Modulated` path when it actually has an enabled assignment. Everything else
arrives byte for byte as today and no existing project changes its sound.

Integer and boolean parameters fall out for free. `x` normalizes, the sum happens in unit space, `y`
rounds or thresholds. A modulated toggle flips, a modulated sync division steps.

## Decisions taken

Modulators live globally on `RootBox`, not per audio unit.

A modulator and an assignment are separate boxes, so one LFO can drive many parameters, each with
its own depth.

The LFO is position derived and tempo synced. Phase is a function of the transport position, so a
locate, a loop wrap and an offline render all reproduce the same value with no state to reset.

Modulation is applied on the existing update clock, same grid as automation.

Modulation keeps running while the transport is stopped.

Depth is signed and the shape is bipolar, so modulation is centred on the base value and a negative
depth inverts.

Device level only, no per-voice modulation.

Per-assignment enable and per-modulator enable. No global bypass.

No control indicator work in this plan beyond what falls out for free.

## Box schema

`RootBox` gains a collection field.

```
50: {type: "field", name: "modulators", pointerRules: {accepts: [Pointers.ModulatorCollection], mandatory: false}}
```

New pointer type `Pointers.ModulatorCollection` (appended to the enum, values are runtime only and
not persisted, so appending is safe). `Pointers.Modulation` already exists and is what an assignment
uses to point at its target parameter.

`ModulationBox`, the assignment.

```
1: pointer  "source"      -> Pointers.ModulatorSource, mandatory   (the modulator's assignments hub)
2: pointer  "target"      -> Pointers.Modulation, mandatory        (the parameter field)
3: float32  "depth"       bipolar, value 0
4: boolean  "enabled"     value true
5: int32    "index"       index constraints
```

The `depth` field itself carries `ParameterPointerRules`, so an assignment depth is automatable and
modulatable later at no extra cost.

`LfoModulatorBox`, the first source.

```
1: pointer  "collection"  -> Pointers.ModulatorCollection, mandatory
2: field    "assignments" accepts [Pointers.ModulatorSource]
3: string   "label"
4: boolean  "enabled"     value true
5: int32    "index"
10: int32   "shape"       values [Sine, Triangle, Saw, Square], value 0
11: int32   "rate"        index into the adapter's musical fraction table, 0..11, value 8 (one bar)
12: float32 "phase"       unipolar, value 0
13: float32 "amount"      unipolar, value 1        (a master depth over all of this LFO's assignments)
```

All four shapes ship in phase 3, so the field never offers a shape the engine cannot render.

Note the two pointer directions. The assignment points at its source modulator, and it points at its
target parameter. Both are pointers on the assignment box, which keeps deletion of a modulator or a
device automatically pruning the assignments through the existing mandatory-pointer rules.

Later modulator boxes (`StepModulatorBox`, `RandomModulatorBox`, `MacroModulatorBox`) share fields
1 to 5 and add their own. A `ModulatorFactory` in the schema, mirroring `DeviceFactory`, keeps that
prefix in one place.

## Engine design

New module `crates/engine/src/modulation.rs`.

`Modulator`, a small enum with a `value_at(position: f64, tempo: &TempoMap) -> f32` returning
`-1..1`. The LFO computes `sin(TAU * (position / pulses_per_cycle + phase))`. It is pure, so it
needs no reset, no per-instance state, and it renders identically offline.

`ModulationChain`, what a `ParamHandle` holds: an `Rc<[BoundModulation]>` of
`{modulator: Rc<Modulator>, depth: Rc<Cell<f32>>, enabled: Rc<Cell<bool>>}`. Depth and enabled are
live cells so a depth drag is a light field edit, not a rebind.

`ModulatorTable`, the engine-level registry built from the `RootBox.modulators` hub, following the
existing `midi_output.rs` pattern for a RootBox-level collection. Membership changes and modulator
field edits invalidate every unit that has a bound assignment.

Changes to `ParamHandle` (`param_automation.rs:31`).

Add `modulation: Option<ModulationChain>`.

`resolve` returns `(value, kind, modulation)` and grows a second position argument,
`resolve(song_position, mod_position)`. It is the only place in the codebase that knows modulation
exists, and it needs no mapping, because it computes the sum and never resolves it.

```rust
let (value, kind) = /* today's two branches, byte for byte */;
(value, kind, self.modulation_sum(mod_position))   // NaN when nothing is assigned
```

`refresh_params` (`params.rs:68`) and `host_update_parameters` (`lib.rs:980`) carry the third number
through to the device, and both keep their change detection, now over the pair rather than the value
alone, so a moving modulation pushes on every tick while a static parameter still pushes nothing.

Wiring the assignments. `observe_param` (`params.rs:548`) additionally looks up the assignments
targeting this `(box uuid, field path)`. This has the same constraint as `build_param_track`, a
parameter address is often a dangling vertex and never appears in `graph.incoming`, so it is a scan
over `ModulationBox` instances comparing target uuid and field keys. Cost is O(assignments) per
bound parameter at bind time only, which is the same shape as the existing `TrackBox` scan. If the
scan ever shows up in a profile, the fix is a target-keyed index built once per reconcile.

Arming the clock. `observe_params` returns `armed`, which currently means "has a track". It becomes
"has a track or a modulation chain", so a modulated device fragments its render on the grid and
`host_update_parameters` visits the parameter. The `param.track.is_none()` early-continue in
`host_update_parameters` (`lib.rs:985`) becomes "no track and no modulation".

Running while stopped. While paused the blocks carry the free-running pulse range, not the frozen
song position (`Transport::render_paused`, `crates/transport/src/transport.rs:148`), and both clock
exports currently return `INFINITY` for a non-transporting quantum. Two changes.

The gates in `host_first_update_position` and `host_next_update_position` allow a paused quantum
when the current device has modulation, staying closed for automation-only devices so nothing about
today's behaviour moves.

`PullContext` gains `song_position: f64` and `transporting: bool`, set once per quantum. While
paused, the automation base is resolved at the frozen `song_position` while the modulator is
evaluated at the free-running position the render loop passes. Without this split, a paused project
would sweep its automation curves.

Host-side parameters. `observe_field_automation` (`params.rs:279`) builds the strip resolvers. It
gets the same chain and applies `map(clamp(x + sum, 0, 1))` itself, which is straightforward because
the host owns those mappings. Strip and send parameters are therefore modulatable from day one,
exactly like device parameters.

## UI

Assignment is done from the control's context menu. `attachParameterContextMenu`
(`packages/app/studio/src/ui/menu/automation.ts`) gains a `Modulate with` submenu listing the
project's modulators plus `New LFO`, and a `Remove modulation` entry per existing assignment on that
parameter. The parameter already knows its assignments through its pointer hub.

Control feedback needs no mapping in the host, because `AutomatableParameterFieldAdapter` already
owns the mapping on the main thread. The parameter's broadcast slot carries two floats, the automated
unit value (NaN when not automated, as today) and the modulation sum (NaN when not modulated). The
adapter combines them.

```
base       = isNaN(automated) ? getUnitValue() : automated
controlled = isNaN(sum) ? base : clamp(base + sum, 0, 1)
```

`getControlledUnitValue()` keeps its current meaning, so `Knob.tsx` and every other control animate
with no change at all.

New screen `modulation`, inserted after `mixer` in `DefaultWorkspace`
(`packages/app/studio/src/ui/workspace/Default.ts`), plus a `PanelType.Modulation` entry, a
`PanelFactory` case, and a shortcut in `StudioShortcutManager`. Layout mirrors the mixer screen.

Left, the modulator list.
The project's modulators, with add and remove, rename, enable toggle, and selection.

Centre, the selected modulator's inspector.
Shape preview drawn from the same `value_at` maths the engine uses, plus rate, phase and amount.

Right, the assignment list of the selected modulator.
One row per target with the parameter's name and its device and unit path, a depth slider, an enable
toggle, delete, and a click that reveals the target device in the device panel.

Below, the shared devices panel, as on the mixer screen.

New adapters in `packages/studio/adapters`, `ModulatorBoxAdapter` and `ModulationBoxAdapter`, plus a
`modulators` collection on `RootBoxAdapter`. `AutomatableParameterFieldAdapter` gains a
`modulations` accessor over its pointer hub, which is what the context menu and any later indicator
read.

Control indicator. Deferred, per decision. What comes for free is the existing `modulated` CSS class
and the live ring described above. A reachable-range arc can be added later without touching the
engine.

## Modulator catalogue

Shipping in this plan.

LFO, sine, tempo synced, position derived.

Reserved next, in the order they are worth doing.

Step sequencer, N steps with per-step value, rate as a musical fraction, glide amount. Same
position-derived evaluation as the LFO.

Random and sample-and-hold, stepped or smoothed noise on a rate grid, from a seeded hash of the step
index so offline render reproduces it.

Macro, a plain user-controlled value with no time base, which also becomes the natural target for
MIDI learn and for hardware controllers.

Later, needing machinery this plan does not build.

Envelope follower, needs audio access inside the modulator, a different evaluation path than a
position-derived shape.

Sidechain and note trigger envelopes, need note or transport events rather than a position.

Per-voice sources, envelope, velocity, key tracking, aftertouch, need per-voice parameter resolution,
which is a much larger ABI change and is explicitly out of scope.

Curve or shaper modulator, remaps another modulator's output, needs modulator-to-modulator routing
and a cycle check.

## Phases

Each phase ends green and audible or visible, per the incremental rule.

Phase 1, the wire. DONE (`6b12f536b`).
`ParamValue::Modulated` plus the new arm in `float_value` / `int_value` / `bool_value`, and
`unit_value(value, mapping)` for devices that keep a parameter normalized and map it themselves. The
`modulation` field on `ParamChange`, the fifth argument on `parameter_changed` through all 26 exported
shims, the templates, the `DeviceExports` type in the linker and the script bridge (a scriptable
device's mapping lives in its `@param` declaration, so the bridge is where its sum folds in).
`ParamHandle::resolve` returns `(value, kind, modulation)`, always NaN, and both delivery paths diff
over the pair through `changed` / `mark`, comparing the sum by BIT PATTERN since `NaN != NaN` would
otherwise report a change on every push. Three direct `ParamValue` matches needed a real arm
(`sync_index` in the Delay, `unit` and `real` in Cubed) and the Vaporisateur's `cutoff_unit` collapsed
into `unit_value`. Verified: rust workspace green, wasm parity suite 214 passed.

Phase 2, schema. DONE (`2dbee0146`).
`Pointers.ModulatorCollection` and `Pointers.ModulatorSource`, `RootBox.modulators` (key 11),
`LfoModulatorBox`, `ModulationBox`, forge, and the regenerated Rust registry. The pointer types are
APPENDED to the enum, never inserted: the values are ordinals, so inserting one renumbers every member
after it and every already-built package dist disagrees until rebuilt. Note also that the forge reads
`@opendaw/studio-enums` through its BUILT dist, so the enums package has to be rebuilt before the forge
run or the new pointer types generate as `Pointers.undefined`. Verified by
`ModulationSchema.test.ts` (an LFO plus its assignment through `.od` and back, the parameter reporting
a `modulated` control source, and the cascade delete), studio core 252 passed, wasm parity 214 passed.

Phase 3, engine.
`modulation.rs`, the `ModulatorTable`, the `ParamHandle` chain, the arming and clock changes, the
paused-position split, and the two-float broadcast. Verified with a Rust test that a sine LFO on a
known parameter produces the expected sequence over one bar, and one that a paused transport does not
move the automation base.

Phase 4, minimal UI.
The context menu entries and adapters only, no screen. At this point an LFO can be created and heard
on a filter cutoff, and the knob moves.

Phase 5, the screen.
Modulator list, inspector, assignment list, workspace entry, shortcut. Browser checkpoint per
sub-step.

Phase 6, further modulators.
Step sequencer, random, macro, each one schema plus a `Modulator` variant plus an inspector.

## Open risks

The update clock is about 192 Hz at 120 BPM, so an LFO above roughly 90 Hz aliases and a fast LFO on
a parameter a device does not glide will zipper. If that turns out to matter, the fix is either a
finer grid, which is a WASM contract change on both sides, or per-block evaluation, which is a second
update path.

`parameter_changed` changes arity, so this is a flag day: every stock device wasm and every prebuilt
bundle must be rebuilt with the engine in one pass. A stale device would read the modulation argument
as garbage. This is the one place in the plan with no incremental path, so phase 1 lands alone and is
verified by the existing parity suites before anything else starts.

A device that matches `ParamValue` directly and adds a `Modulated` arm that ignores the sum will
silently not modulate. The compiler forces the arm to exist but cannot force it to be right, so each
of the dozen sites gets checked by hand against the mapping it uses.

A parameter whose consumption site has no mapping cannot be modulated. The UI should not offer an
assignment for it, which means the device has to be able to say so. Simplest answer is a per-device
list of unmodulatable parameter ids, worst case the assignment exists and does nothing. Phase 1 found
exactly one such device, Cubed, and it was fixed in `0b08bb0ef` rather than exempted: its `real()`
served tuning, volume and waveform with the conversions inline instead of as mappings, which also
meant an automated value was read as if it were already real (an automated tuning moved by at most 1
cent, an automated volume played at 0..1 dB). Those three now carry mapping consts mirroring
`CubedDeviceBoxAdapter` and resolve through `float_value` / `int_value` like every other device. No
stock device is exempt today, so the UI can offer an assignment on any parameter.

The assignment lookup scans `ModulationBox` instances per bound parameter. Fine at project sizes we
have, worth measuring before it grows.

`.od` and `.odsl` files written after phase 2 will not open in older builds. That is normal for an
additive schema change, but it is worth confirming before the first commit that lands the boxes.
