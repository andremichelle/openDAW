# Audio Sink (issue #350)

An audio effect device that routes the signal at its position in the chain into an AudioBusBox. It is a 1:1 cable, no
gain, no pan, the target bus strip does the mixing. A `passThrough` boolean decides whether the signal also continues
down the chain (copy) or stops there (silence). Because it is a chain member it works in every audio chain: leaf unit,
tape unit, bus unit, Playfield / composite slot, effect composite entry. That is the #350 case: a Sink in a pad's
chain groups that pad on a bus.

Decisions (from the discussion):

1. passThrough off: the rest of the chain and the unit strip get silence, the unit contributes only via the bus.
   passThrough on: an identical copy continues.
2. No gain / pan.
3. Target unset, dangling, pointing at the primary bus, or a feedback loop: the tap is NOT wired, nothing falls back
   to the master (Ableton "No Output", Bitwig unassigned). With passThrough off that is silence.
4. `enabled` false = bypass: chain untouched, nothing sent.
5. UI reuses the mixer's bus dropdown (ChannelOutputSelector) incl. "New Output Bus...".
6. Stem export: always wired. The Sink is an output route, not a send, `includeSends` does not gate it.

Settled:

- Box class name: `AudioSinkDeviceBox` (every device box is `*DeviceBox`, DeviceFactory.createAudioEffect). UI
  name "Sink".
- Default `passThrough`: false. Adding the device is the act of re-routing.
- Freeze: `reconcile_frozen` replaces the whole chain by a PCM player, so a Sink inside a frozen unit would stop
  feeding its bus. "Freeze AudioUnit" stays in the menu, but with a Sink anywhere in the unit's chains it shows a
  dialog explaining that a unit with a Sink cannot be frozen, and does not freeze.

Nothing existing changes: a new `ProcHandle` variant, a new resolve pass that only visits Sink members, no edit to
any existing assertion. Projects without a Sink render bit-identical.

---

## 1. Box schema

`packages/studio/forge-boxes/src/schema/devices/audio-effects/AudioSinkDeviceBox.ts`, via
`DeviceFactory.createAudioEffect("AudioSinkDeviceBox", {...})`. Base fields 1..5 (host, index, label, enabled,
minimized) come from the factory.

    10: {type: "boolean", name: "pass-through", value: false}
    11: {type: "pointer", name: "target-bus", pointerType: Pointers.AudioOutput, mandatory: false}

`mandatory: false` on purpose (AuxSendBox has true): deleting the bus must not cascade-delete a device out of a
chain, the Sink just goes silent.

Register in `schema/devices/index.ts`, then `npm run build -w @opendaw/studio-forge-boxes` regenerates
`studio/boxes/src` (class, visitor, io, index) and `crates/studio-boxes/src/registry.rs`.

## 2. Engine (Rust)

WASM CONTRACT constants in `audio_unit/mod.rs`: `SINK_BOX_TYPE = "AudioSinkDeviceBox"`, `SINK_PASS_THROUGH_KEY = 10`,
`SINK_TARGET_KEY = 11`.

### 2.1 engine-env `audio_sink.rs`

`AudioSinkProcessor: AudioProcessor`, sibling of `aux_send.rs`. State: `source: Option<SharedAudioBuffer>`,
`output` (the chain continuation), `tap` (what the bus sums), `pass_through: bool`. Per block: `tap = source`,
`output = pass_through ? source : silence`. No source: both silent. `set_audio_source`, `clear_audio_source`,
`set_pass_through`, `audio_output`, `tap_output`.

### 2.2 Chain member

- `ProcHandle::Sink(Rc<RefCell<AudioSinkProcessor>>)`.
- `Member.sink: Option<SinkBinding>` next to `sidechain`. `SinkBinding {device_uuid, node_id, proc, target:
  Option<(Uuid, NodeId)>, pointer_sub, pass_sub}`. `pointer_sub` = `Propagation::This` monitor on
  `Address::of(uuid, [11])` calling `signal()` (marks the unit dirty, like a sidechain port). `pass_sub` =
  `catchup_and_subscribe` on `[10]` pushing `set_pass_through` (live cell, no rewire, like `BUS_ENABLED_KEY`).
- `effect_composite.rs take_or_build_audio_member`: before the device lookup, `name == SINK_BOX_TYPE` →
  `take_or_build_sink` (pool reuse when the existing proc is a Sink, else terminate + build). Registers the
  processor node, `set_label`, `output_registry` under the device address (a sidechain can tap it), `enabled_sub`
  via `subscribe_enabled`. No `params` (no device ABI).
- The five edge-only wire loops (`wiring.rs` reconcile_bus, reconcile_tape, wire_cluster, composite child,
  effect composite entry at ~145 / 301 / 502 / 653 / 971) get one arm: `ProcHandle::Sink(node) =>
  node.borrow_mut().set_audio_source(output.clone())`. Chain continues from `member.output` = the sink's `output`
  buffer, so passThrough semantics fall out of the existing loop.
- `terminate_member`: a Sink detaches its tap from its target sum, removes the edge, unsubscribes `pointer_sub` /
  `pass_sub`, removes the node (mirror `teardown_send`).
- Visitors: `visit_member_sinks` next to `visit_member_sidechains`, `SlotCluster::for_each_sink`,
  `EffectCompositeBinding::for_each_sink`, `AudioUnitBinding::for_each_sink` (mirror `for_each_sidechain`, so a
  Sink nested in a Playfield slot or an FX stack entry is reached).

### 2.3 `routing.rs resolve_sinks()`

Called in `reconcile_units` right after `resolve_sends()`. For every unit, `for_each_sink`:

    wanted = device_enabled(uuid)
        .then(|| graph.target_of(Address::of(uuid, [SINK_TARGET_KEY])))
        .flatten().map(|t| t.uuid)
        .filter(|uuid| bus_registry.contains_key(uuid))   // primary bus is not registered → None
        .and_then(|uuid| sum_of(Some(uuid)).map(|(sum, id)| (uuid, sum, id)))

Diff against `binding.target`: unchanged → return. Otherwise detach the old (remove tap from the old sum if it
still exists, `remove_edge`), then if `wanted` and `!would_cycle(sink_node, sum_id)`: `add_audio_source(tap)`,
`register_edge(sink_node, sum_id)`, store target. A disabled Sink is skipped by the chain loop (stale tap), so
`wanted = None` there is what keeps the bus clean. Every trigger already reaches this pass: `enabled` toggle →
rewire, pointer re-point → signal, bus add / remove → structural.

### 2.4 Solo

`update_solo` `Entry.sends` additionally collects every Sink target of the unit (via `for_each_sink`), so a
soloed unit keeps its Sink bus audible and a soloed bus keeps its Sink feeders audible, same rule as a send.

### 2.5 Stem export

No `include_sends` gate. `unit_options` untouched.

## 3. TS adapters / core

- `adapters/src/devices/audio-effects/AudioSinkDeviceBoxAdapter.ts` implements `AudioEffectDeviceAdapter`
  (StereoToolDeviceBoxAdapter template): `targetBus: AudioUnitOutput` (reuse, it already takes a
  `PointerField<Pointers.AudioOutput>`), `namedParameter.passThrough` via `ParameterAdapterSet`
  (`ValueMapping.bool`, "Pass Through"), `labeledAudioOutputs` yields its own address. Register in
  `BoxAdapters.ts` visitor, `index.ts` export, `DeviceManualUrls.Sink`.
- `core/src/EffectBox.ts` union, `EffectFactories.AudioNamed.Sink` (type "audio", external false, defaultName
  "Sink", icon TBD from IconSymbol, brief "Routes to a bus").
- `core/src/Mixer.ts` upstream walk: `visitAudioSinkDeviceBox` → host → audio unit adapter, next to
  `visitAuxSendBox` (the TS solo mirror of 2.4).
- Verify copy paths: `DevicesClipboardHandler`, `PresetEncoder/Decoder`, `TransferUtils` (issue 385 pattern).
  Same project: pointer kept. Preset / other project: pointer dropped, Sink silent. Add a test per path.

## 4. UI (app/studio)

- Extract the menu of `ChannelOutputSelector` into `BusOutputSelector({lifecycle, project, output:
  AudioUnitOutput, pointer: PointerField<Pointers.AudioOutput>, exclude: (bus) => boolean})`.
  `ChannelOutputSelector` becomes a thin wrapper (unchanged behaviour). The Sink excludes the primary bus and,
  when hosted in a bus unit, that unit's own bus.
- `devices/audio-effects/AudioSinkDeviceEditor.tsx` + sass: `DeviceEditor` with the selector and a `Checkbox`
  for passThrough, `MenuItems.forEffectDevice`. `DeviceEditorFactory` visit case.
- Freeze: `AudioUnitFreeze.freeze` (or the menu trigger) checks the unit's chains for a Sink first, shows an
  info dialog ("cannot freeze a unit with a Sink") and returns.
- `perf/DeviceBenchmark.ts` untouched (engine-owned, no plugin).

## 5. Scripting API

`Api.ts AudioSinkEffect {key: "Sink", targetBus: Option<BusAudioUnit>, passThrough: boolean}`,
`AudioEffects.ts` impl, `DeviceBoxes.ts` key / create / label maps, `Devices.test.ts` + `Parity.test.ts` cases,
`npm run docs`. Manual page `manuals/devices/audio/sink`.

## 6. Tests (all new, none edited)

- `crates/engine-env/tests/audio_sink.rs`: pass-through copies, sink silences, tap always copies, no source
  silent.
- `crates/engine/src/audio_unit/tests.rs`: Sink member builds in a leaf chain and edges into the bus sum, disabled
  detaches, target re-point moves the tap, bus removal detaches, primary bus / unset stay unwired, cycle guard
  (Sink in a bus unit targeting its own bus), solo entries include Sink targets, Sink inside a slot cluster and an
  effect composite entry is reached by `for_each_sink`.
- `packages/studio/core-wasm/test/audio-sink.test.ts` (send-return.test.ts template, peak rendering):
  1. Sink, no target, passThrough off → master silent.
  2. Sink → bus, passThrough off → signal at master only via the bus, bus strip at -12 dB attenuates it.
  3. passThrough on → dry + bus (sum louder than dry alone).
  4. enabled off → dry only.
  5. Playfield: Sink in one pad's chain → that pad on the bus, other pads dry (the #350 case).
  6. Sink inside an effect composite entry.
  7. Stem export with includeSends=false: the sunk signal is in the bus stem.
- Adapter tests for preset / clipboard / transfer pointer handling.
- Browser checkpoint: add Sink to a Playfield pad, pick a bus from the dropdown, create a new bus from it, strip
  meters show the move. Play, check, stop.

## 7. Status (2026-09-23)

Implemented on branch `vb-cable`, uncommitted. Engine 210 (10 new) + engine-env 6 new, core-wasm 7 new e2e (full
suite 323 green), adapters 182 + 1 new preset test, core 489, scripting 70 (Sink cases added). Browser checkpoint
done: Sink in the effect list, editor with bus dropdown + "New Output Bus..." + pass checkbox, Vaporisateur strip
silent while the Drums bus / sink meter / master show signal, "Cannot Freeze" dialog. Manual page + nav entry.

Lesson: the engine has SEVEN chain wire loops matching on `ProcHandle` (leaf, tape, bus, midi-out, composite
slot, composite cell chain, FX-stack entry). Five got the Sink arm in the first pass, the FX-stack entry and the
cell chain silently treated the Sink as an identity branch (`_ => continue`). The e2e stack case caught it; the
engine tests now assert `has_audio_source()` on every built sink. Any new `ProcHandle` variant must touch all
seven (grep `ProcHandle::EffectComposite(` for the list).

Revision (same day): `passThrough` boolean replaced by `pass` (field 10, float dB, -inf..0, default -inf,
automatable, `ValueMapping.DefaultDecibel` / `Decibel::default_volume`). The processor reuses `SendParams` +
`StripAutomation` like the aux send (ramped, update-clock split). The editor is the mixer's bus dropdown on top
and one Pass knob below. The bus side stays a unity cable, a wet/dry pair was rejected.

Not done: `npm run docs` (scripting docs regenerate in the build), a screenshot for the manual page.

## 8. Order

1 schema + regenerate → 2.1 engine-env + tests → 2.2 / 2.3 / 2.4 engine + tests → `npm run build-wasm` → 3 adapters
+ core → 6 core-wasm e2e → 4 UI + browser checkpoint → 5 scripting + docs.
