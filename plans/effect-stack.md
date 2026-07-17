# Effect Composite

Effect Composite is virtually identical to a CompositeDeviceBox except it is made to house FX plugins.

input > effect stack (parallel) > output

The idea is that the user can create a stack and drag new effects into it. The incoming signal will now be processed by
all the effects in the stack in parallel, and their outcome mixed (dry/wet) into the rest of the signal chain with their
own gain and mute/solo. In theory, stacks can be nested indefinitely. Also see bitwig FX layers.

Misc:
There must be a way for a nested plugin with sidechain to pick the input of the container/stack/layers. This may be
needed an extra audio buffer to pick from. Background is that we want to get the new input if the previous plugin in the
chain has been replaced.

It should be clear that we will extend the system with different split containers (these are different devices) to give
the effects different parts of the signal (freq split, side/mid-split, stereo split, tonal split). The best case is that
you build the code in a way that respects that from the start.

The user-interface is basically a list of effects with their own mute, solo and gain. We then add a dry and wet control.

We need a plan for:

1. identify shared requirements for notes and audio stacks
2. introduce box schemas
3. rust implementation including runtime parameter editing and automation, audio graph
4. adapter / userinterface (editor, accessing individual effect chains similar to Playfield?)
5. presets

---

# Detailed Implementation Plan (2026-07-17)

## Decisions

- An entry is a full chain (a layer), not a single effect. Each entry is a cell box hosting its own effect chain, mirroring CompositeCellBox.
- Audio AND midi composites ship in this pass.
- Audio entries carry gain, mute, solo (all automatable). Midi entries carry mute and solo only.
- The audio composite has stack-level dry and wet gains. The midi composite has neither (output = merge of audible entries).
- Dry defaults to silent, wet to 0dB. The composite REPLACES the signal by default, raise dry for parallel-fx use.
- An EMPTY composite (zero entries) bypasses: identity pass-through regardless of dry/wet.
- Entries have NO separate `enabled`, mute is the gate. The composite device itself keeps the standard device `enabled` (field 4).
- Two entry box types (audio / midi), each with exactly the fields its kind needs, both with an `index` field.
- Sidechain input tap: devices INSIDE a composite can pick that composite's input as sidechain source. Registered as an address seam, resolvable generically.
- One split container ships now: stereo split (fixed L/R entries), proving the input-distributor seam. Frequency / mid-side / tonal splits come later as further box types on the same seam.
- UI: Playfield-style enter. The composite editor lists entries, clicking one swaps the devices row to that entry's chain (the entry is a DeviceHost).
- Naming: kind-explicit (AudioEffectComposite* / MidiComposite*), with the bare Effect* prefix reserved for what spans both. See Naming.
- Presets capture the whole subtree (entries, chains, nested composites) via the existing PresetEncoder path.

## Naming

The axis is the DEVICE KIND, matching the codebase's own `DeviceType` vocabulary (`"audio-effect"` / `"midi-effect"`): a concrete thing says which kind it is, and the bare `Effect*` prefix is reserved for what genuinely spans BOTH. ("Note" was rejected as asymmetric: a note composite IS an effect — a midi one.)

Boxes:
- `AudioEffectCompositeBox` (audio-effect device via `DeviceFactory.createAudioEffect`)
- `MidiCompositeBox` (midi-effect device via `DeviceFactory.createMidiEffect`)
- `StereoCompositeBox` (audio-effect device, the stereo split, same entry type as AudioEffectCompositeBox)
- `AudioEffectCompositeCellBox` (one audio entry: an audio-effects chain + gain/mute/solo)
- `MidiCompositeCellBox` (one midi entry: a midi-effects chain + mute/solo)

Pointers (appended to `Pointers.ts`, never renumbered):
- `Pointers.AudioEffectCompositeCell`
- `Pointers.MidiCompositeCell`

SHARED (spans both kinds, so it keeps the bare `Effect*` / `effect_*` prefix): `EffectCompositeSpec` (Rust + TS), `Distributor` / `EffectCompositeKind` / `EffectCompositeDistributor`, `EffectCompositeBinding`, `crates/engine/src/effect_composite.rs`, the `effect_composite_register` ABI export, and the `EFFECT_COMPOSITES` registration table.

UI labels are an implementation-time call (working proposal: "FX Composite", "Midi Composite", "Stereo Split").

## Part 1: shared requirements for midi and audio composites

Shared by both kinds:
- A `entries` collection field on the composite device box, entries ordered by their own `index` field (engine observes via `IndexedCollection`, exactly like CompositeSpec's `children_field` / `index_key`).
- Entry = cell box: mandatory `composite` pointer to the owning device, one chain host field, `index`, `label`, `minimized`.
- Per-entry mute and solo as automatable boolean params. Solo semantics: any solo makes non-soloed entries silent, resolved across the sibling set (mirrors the composite `child_infos` silent logic).
- A muted / not-soloed entry stays BUILT and keeps processing (audio: output dropped from the sum, notes: chain still pulled so stateful effects keep phase, output discarded).
- Playfield-style enter: entry boxes accept `Pointers.Editing` + `Pointers.Selection`, entry adapters implement `DeviceHost`, `userEditingManager.audioUnit.edit(cellBox)` swaps the device panel.
- Per-entry edge-only reconcile in the engine: entry add / remove / reorder builds only the joiner, tears down only the leaver, survivors keep DSP state (mirrors `reconcile_composite_children`).
- Nesting: an entry's chain may contain another composite, recursion falls out of the chain builders with no special case.
- Preset subtree capture and clipboard copy.

Audio-only:
- Per-entry gain (decibel param), stack-level dry and wet gains.
- Input distribution: every entry chain reads the composite input. The distributor is a strategy (broadcast for the plain composite, channel split for StereoCompositeBox, crossover etc. later).
- Sidechain input tap.

Midi-only:
- Pull-based tee and merge (midi effects are pull-chain stages, not buffer processors).

## Part 2: box schemas

All keys below become WASM CONTRACT once shipped (mirrored in `engine-modules.ts` and the Rust spec, frozen).

`AudioEffectCompositeBox` = `DeviceFactory.createAudioEffect("AudioEffectCompositeBox", {...})`:
- 10 field `entries`, accepts `[Pointers.AudioEffectCompositeCell]`
- 11 field `input`, accepts `[Pointers.SideChain]` (the input-tap target vertex, no children)
- 12 float32 `dry`, ParameterPointerRules, constraints "decibel", default = the decibel floor (silent)
- 13 float32 `wet`, ParameterPointerRules, constraints "decibel", default 0dB

`StereoCompositeBox` = same shape (fields 10-13), own box type so the engine spec selects the stereo distributor. Its factory creates exactly two `AudioEffectCompositeCellBox` entries labeled "L" / "R". The UI hides add / remove for it.

`MidiCompositeBox` = `DeviceFactory.createMidiEffect("MidiCompositeBox", {...})`:
- 10 field `entries`, accepts `[Pointers.MidiCompositeCell]`

`AudioEffectCompositeCellBox`:
- 1 pointer `composite`, `Pointers.AudioEffectCompositeCell`, mandatory
- 2 field `audio-effects`, accepts `[Pointers.AudioEffectHost]`
- 3 int32 `index`, constraints "index"
- 4 string `label`
- 5 boolean `minimized`
- 40 float32 `gain`, ParameterPointerRules, constraints "decibel", default 0dB
- 41 boolean `mute`, ParameterPointerRules
- 42 boolean `solo`, ParameterPointerRules
- box pointerRules accepts `[Pointers.Editing, Pointers.Selection]`

`MidiCompositeCellBox`:
- 1 pointer `composite`, `Pointers.MidiCompositeCell`, mandatory
- 2 field `midi-effects`, accepts `[Pointers.MIDIEffectHost]`
- 3 int32 `index`, 4 string `label`, 5 boolean `minimized`
- 41 boolean `mute`, 42 boolean `solo` (ParameterPointerRules)
- box pointerRules accepts `[Pointers.Editing, Pointers.Selection]`

Codegen: forge-boxes schema files under `schema/devices/`, regenerate `packages/studio/boxes` (visitor, io, index) and the Rust `crates/studio-boxes` registry in lockstep. No migration needed (new boxes only).

## Part 3: Rust engine

### Registration seam

New spec, registered like `CompositeSpec` (data, no box name hardcoded in the engine):

- `engine-modules.ts` gains `EFFECT_COMPOSITES: ReadonlyArray<EffectCompositeSpec>` with a WASM CONTRACT comment: `{boxType, kind: "audio" | "note", distributor: "broadcast" | "stereo", entriesField: 10, indexKey: 3, chainField: 2, labelKey: 4, gainKey: 40 (0 for note), muteKey: 41, soloKey: 42, dryKey: 12 (0 for note), wetKey: 13 (0 for note), inputTapField: 11 (0 for note)}`
- New abi export `register_effect_composite(...)` next to `register_composite` (crates/engine/src/lib.rs:2599 call site pattern), stored as `Vec<EffectCompositeSpec>` with an `effect_composite_for_type(&str)` lookup.
- The studio-contract worklet registration loop (app/studio wasm-engine processor) passes the new table exactly like COMPOSITES.

### Audio composite as a chain member

Integration point: both audio-chain builders, `build_cluster` (crates/engine/src/audio_unit/wiring.rs:1020, the wholesale cell path) and the pooled `Member` path used by `reconcile_leaf` / `reconcile_slot_cluster` (take_or_build_audio + wire_cluster). Today both resolve `device_for_type` and skip unknown box types. New: when `effect_composite_for_type(name)` matches (audio kind), build an `EffectCompositeBinding` as the chain member.

`Member` gets a body enum: `Plugin` (today's fields) or `EffectComposite(EffectCompositeBinding)`, with `take_or_build_effect_composite` mirroring `take_or_build_audio` (pooled by uuid, edge-only survival across chain reconciles). A disabled composite device is handled exactly like a disabled plugin effect: not wired into the chain (bypassed), state kept, the existing per-member `enabled` monitor / rewire seam applies unchanged.

`EffectCompositeBinding` (new file `crates/engine/src/effect_composite.rs`, closely mirroring `composite.rs`):
- `entries: IndexedCollection` observing `entriesField` ordered by `indexKey`, dirty enqueues the owning unit.
- Per-entry persistent records: chain observation (`observe_chain_opt` on the cell's `chainField`), built chain members, gain/mute/solo bindings, sum membership.
- Node topology per composite:
  - `DistributorProcessor` (new, engine-env): copies the upstream buffer into its own owned input buffer(s). Broadcast = one stereo copy. Stereo = two buffers (left-only, right-only, other channel zeroed). Edge: previous chain node -> distributor.
  - Per entry: chain head effect `set_audio_source(distributor branch buffer)`, chain built by the SAME chain-building code as any fx chain (so nesting recurses for free), chain tail -> `EntryStripProcessor` (new: applies gain with per-block automation values, outputs silence while muted / not-soloed) -> added as source of the wet `AudioBusProcessor` sum.
  - `DryWetMixProcessor` (new): `out = dry * input + wet * wetSum`, reading the distributor's input copy and the wet sum. When the entry count is zero it copies input to output (the empty-bypass invariant). Edges: distributor -> mixer, wet sum -> mixer. The mixer node is the member's `output` / `output_node`, the chain continues after it.
- Empty ENTRY CHAIN (a cell with zero effects) = identity branch: the entry strip reads the distributor buffer directly. Deliberate (that is how you mix dry-with-gain branches).
- Per-entry reconcile mirrors `reconcile_composite_children`: pool by uuid, joiners built, leavers torn down, survivors reconciled edge-only when their chain observation or a member `enabled` toggle fired, mute/solo/gain resolved across siblings each pass.
- Traversals extended so the unit reaches everything: `for_each_params` and `for_each_sidechain` equivalents recurse into `Member::EffectComposite` bodies (automation rebind + sidechain re-resolve must see nested devices). The existing `Wired::*` match arms in `resolve_sidechains` (routing.rs:14) pick this up via the member traversal.
- Teardown: unregister taps, remove all nodes / edges / subscriptions / ValueCollections, terminate chain members and observations. Leak-test coverage like the existing rebind leak tests.

### Parameters and automation

- Entry `gain`, `mute`, `solo` and composite `dry`, `wet` bind through the same update-clock machinery as strip volume and send gain (params.rs StripParams pattern: ValueCollection observation, per-block splitting on the dsp::ppqn grid). Values push into `EntryStripProcessor` / `DryWetMixProcessor`.
- Mappings come from the TS adapters (decibel mapping for gains, boolean for mute/solo), per the param-mappings-from-the-adapter rule.
- Rebinds terminate ValueCollections (the strip-automation leak lesson).

### Sidechain input tap

- The engine registers the distributor's owned input buffer in `output_registry` under `Address::of(composite_uuid, vec![inputTapField])`. Because the distributor COPIES into a buffer it owns, the tap's buffer identity survives replacing the plugin before the composite, which is exactly the stated requirement. Rewiring only re-points the distributor's source.
- `resolve_one_sidechain` (routing.rs:62) currently resolves `target.uuid` with a bare address. Extend it to try the FULL target address (uuid + field path) first, then fall back to the bare uuid, then the host-pointer fallback. A sidechain pointer targeting the composite's `input` field (11) resolves to the tap, one targeting the composite box itself keeps resolving to its output mix (unchanged).
- UI scoping (only devices inside the composite see the tap) is a picker-side rule, the engine resolution stays generic.

### Stereo split

- `StereoCompositeBox` registers with `distributor: "stereo"`. The distributor writes left into branch buffer 0 and right into branch buffer 1 (other channel zeroed), entries in index order map to branches. Recombination is the plain wet sum.
- Factory creates the two fixed cells. The engine does not enforce the count (extra entries beyond the distributor's branch count read branch 0, a robustness rule, not a feature).

### Midi composite as a pull stage

Integration point: the midi-fx fold in `build_cluster` (wiring.rs:1030) and the equivalent fold in `wire_cluster`. When a chain member is a `MidiCompositeBox` (midi kind spec):
- `NoteTee` (new): wraps the upstream `PullLink`, pulls it ONCE per (from, to) window and caches the events, serving all branches (same idea as the clip-sequencer replay cache for multi-sequencer pulls).
- Per entry: the entry's own midi-effects chain folds `PluginMidiEffect` stages over the tee, exactly like the normal fold, so nested note composites recurse for free.
- `NoteMerge` (new): pulls every branch each window. Muted / not-soloed branches are still pulled (stateful effects keep time) but their events are discarded. Output = merged events sorted by time, stable by entry index. The merge is the `PullLink::Source` the rest of the chain folds on.
- Entries, mute / solo subscriptions, and per-entry reconcile reuse the same binding pattern as the audio side (shared helper where practical).
- A disabled MidiCompositeBox is skipped in the fold like any disabled midi effect.

### Engine tests (cargo, native)

Layer-by-layer, each green before the next phase:
- Build / teardown lifecycle: nodes, edges, subscriptions, ValueCollections, output-registry entries all removed (leak checks mirroring the rebind leak tests).
- Entry add / remove / reorder is edge-only: survivor chain members keep instance identity (DSP state), only joiner built, only leaver torn down.
- Mute / solo resolution across siblings, solo cross-entry semantics, gain application, automation of gain / dry / wet at block boundaries on the update clock.
- Dry/wet math: default = pure wet, dry raised = parallel sum, empty composite = bit-exact identity.
- Empty entry chain = identity branch through its gain.
- Disabled composite device = bypass, state kept.
- Nesting: composite inside an entry of another composite, plus composite inside a Playfield slot chain and inside a CompositeCellBox cell chain (both builders).
- Sidechain input tap: resolves, and keeps feeding after the effect BEFORE the composite is replaced (the motivating case). Full-address resolution does not break existing bare-uuid targets.
- Stereo split: left/right isolation, recombination equals input when both chains are empty and dry is off, wet 0dB.
- Note composite: merge determinism (sorted, stable), muted branch still pulls (arp phase continuity test), solo, nesting, unit-level midi fold still applies below the composite.
- Automation rebind traverses into nested composites (for_each_params reach).

## Part 4: adapters and user interface

Adapters (`packages/studio/adapters`):
- `AudioEffectCompositeBoxAdapter`, `StereoCompositeBoxAdapter` (AudioEffectDeviceAdapter) and `MidiCompositeBoxAdapter` (MidiEffectDeviceAdapter), each exposing an `IndexedBoxAdapterCollection` of its entries and the dry/wet parameters (created with the decibel ValueMapping).
- `AudioEffectCompositeCellBoxAdapter` / `MidiCompositeCellBoxAdapter` implement `DeviceHost` following `PlayfieldSampleBoxAdapter` (delegate `inputField` / `tracksField` to the audio unit, own `minimizedField`). Entry params (gain/mute/solo) created here.
- One-sided hosts: an audio cell hosts no midi chain, a note cell hosts no audio chain and no instrument. The `DeviceHost` seam gets relaxed for this (chain accessors become capability-aware, e.g. Option-returning or paired with `hostsMidiEffects` / `hostsAudioEffects` flags), and `DevicePanel`, `DeviceMount`, and `DevicePanelDragAndDrop` render / accept only the declared sections. This touch is the main UI-infrastructure cost and lands before the editors.
- Register in `BoxAdapters`, extend `Devices` type guards if needed.

Studio UI (`packages/app/studio/src/ui/devices`):
- `EffectFactories`: three new factories (audio list: AudioEffectComposite, StereoComposite, midi list: MidiComposite). The StereoComposite factory creates the two fixed L/R cells in the same edit.
- `AudioEffectCompositeDeviceEditor.tsx` (audio-effects dir) and `MidiCompositeDeviceEditor.tsx` (midi-effects dir): header with dry / wet knobs (audio only), then the entry list. Each row: reorder drag handle (writes `index`), editable label, gain knob (audio), mute / solo toggles, and an enter button calling `userEditingManager.audioUnit.edit(cellBox)`. Add-entry button appends an empty cell. StereoComposite hides add / remove / reorder.
- Entry chain view: when the editing host is a cell, the device panel shows that cell's chain with a back control to the owning unit (`PlayfieldSampleEditor.goDevice` precedent, packages/app/studio/src/ui/devices/instruments/PlayfieldSampleEditor.tsx:29).
- Drag and drop: dropping an effect onto a composite editor creates a cell wrapping it. Dragging an existing effect between any two chain hosts (unit chain, cell chain, Playfield slot chain) re-points its `host` pointer and reindexes both chains in one edit. Extend `DevicePanelDragAndDrop` / `DeviceDragging` drop targets accordingly.
- Sidechain picker (`SidechainButton.tsx`): for the device being configured, walk up its host chain collecting enclosing effect composites and offer "<composite label> input" per level, the pointer targeting the composite's `input` field vertex. Only ancestors are offered (the agreed scoping).
- Delete handling in `DevicePanel` (delete selected devices, delete audio unit shortcut) must behave inside cell hosts.

## Part 5: presets

- `PresetEncoder` / `PresetDecoder`: capture and rebuild the composite subtree (device box, cells, each cell's chain, recursively including nested composites), following the Playfield subtree handling (PresetEncoder.playfield.test.ts is the template). Cell `composite` pointers re-target the new device on decode.
- `DevicesClipboardHandler`: copy / paste of a composite carries the subtree, paste into any chain host.
- Factory presets: out of scope this pass (per decision, whole-subtree capture only).
- dawproject import / export of composites: explicitly out of scope this pass, flagged in the exporter as unsupported device.

## Phases (each gated on green tests before the next)

1. Schemas + pointers + codegen: forge-boxes schemas, Pointers additions, regenerate boxes (TS) and studio-boxes registry (Rust). Gate: builds + box tests.
2. Adapters + presets + clipboard: adapters, DeviceHost relaxation, PresetEncoder/Decoder + tests, clipboard tests.
3. Engine audio composite (broadcast): registration seam, binding, distributor / entry strip / dry-wet processors, params + automation, sidechain input tap, full cargo test layer.
4. Engine note composite: tee / merge, binding reuse, cargo tests.
5. Stereo split: distributor strategy, factory cells, cargo tests.
6. UI: editors, panel navigation + back control, drag and drop, sidechain picker scoping.
7. End-to-end: app/wasm render tests (parallel sum parity, automation, sidechain tap survives plugin replacement), manual pass in the studio, wasm build via npm run build-wasm.

## Implementation notes (discovered while building, binding for later phases)

Resolved during phase 1-2:

- `dry` default encoding: `value: Number.NEGATIVE_INFINITY` with `constraints: "decibel"`. Precedent is the Vaporisateur volume field. The mapping's `x(-inf) = 0` (knob at the bottom) and `db_to_gain(-inf) = 0` (true silence), so this is exactly what the studio fader already writes when dragged to the bottom. The earlier "-72.0 floor" idea would have leaked -72dB of dry.
- DeviceHost relaxation shape: the chain accessors (`midiEffects` / `audioEffects` / `midiEffectsField` / `audioEffectsField`) became `Option`-returning. The `Option` IS the capability flag. Two helpers on the `DeviceHost` namespace express the rules once: `chainFieldOf(host, accepts)` and `takesEffect(host, accepts)`.
- A new `DeviceHost.hostsInstrument` flag was needed: the old "midi effects need a note consumer" rule was expressed as `inputAdapter.mapOr(input => input.accepts !== "midi", true)`, which rejects any host with no instrument. A note entry has no instrument but MUST take midi effects. `hostsInstrument` distinguishes "hosts no instrument at all" (a composite entry) from "no instrument YET" (an empty audio unit), so existing behaviour is unchanged for audio units and Playfield slots.
- Codegen gotcha: the forge resolves `@opendaw/studio-enums` from its BUILT `dist`. New `Pointers` members must be built (`npm run build` in packages/studio/enums) BEFORE running the forge, or every new pointer type generates as `Field<Pointers.undefined>`. Likewise `packages/studio/boxes` must be built after the forge (tests import its dist), and `test-files/all-boxes.od` must be regenerated (`npm run generate-all-boxes` in packages/studio/adapters) or the studio-boxes golden test fails on the box count.
- Preset chain encode/decode had a REAL bug (found by a failing test written first, now fixed): `PresetEncoder.encodeEffects` and `PresetDecoder.insertEffectChain` re-targeted EVERY `AudioEffectHost` / `MIDIEffectHost` pointer onto the destination chain field, which rips an effect nested inside a copied composite entry out of its entry and flattens the composite (the #265 shape one level down). Both now resolve an INTERNAL target (a box in the uuidMap) first and only fall back to the destination chain for a host pointing outside the copied set.

For phase 3 (read from the engine before writing it):

- REUSE `ChannelStripProcessor` (engine-env/channel_strip.rs) as the per-entry strip. It already is exactly what an entry needs: `volume_db` (the entry's gain), `mute`, `forced_silent` (the cross-entry solo gate, mirroring the mixer's solo resolution), de-click `LinearRamp`s, update-clock automation via `StripAutomation`, and a meter (which the entry-list UI wants anyway). Fix `panning` at 0.0 so the balance law yields gain on both channels. Do NOT write a new entry-strip processor. Solo stays engine-resolved across siblings (like `update_solo` / `resolve_automated_solo`), writing `forced_silent`.
- `bind_gain_pan_automation` cannot be reused verbatim: it observes a pan field key, and an entry has no pan. Add a sibling binder that binds gain (into the `volume` slot) + mute + solo and leaves `panning` as `None`.
- Chain integration seam: `Member` (audio_unit/mod.rs) gains an `input_node: Option<NodeId>` — the node the UPSTREAM edges INTO. For a plugin it equals `node_id`; for a composite it is the DISTRIBUTOR, while `node_id` stays the EXIT node (the dry/wet mixer). Then `wire_cluster`'s audio loop stays uniform: `set_audio_source` dispatches on the `ProcHandle` variant, the edge is registered to `input_node.unwrap_or(node_id)`, and `output` / `output_node` continue from the member's exit. `ProcHandle` gains an `EffectComposite` variant. This keeps the disabled-device bypass, the pooled survive-on-reconcile, and the per-member `enabled` monitor working for composites with no special case.
- Both audio-chain builders must learn composites: the pooled `take_or_build_audio` + `wire_cluster` path (leaf units and Playfield slots) AND the wholesale `build_cluster` path (composite cells). A composite must be buildable inside a Playfield slot chain and inside a CompositeCellBox cell chain, not only on a unit.
- The distributor OWNS its input copy, which is what makes the sidechain input tap survive replacing the plugin before the composite (the buffer identity is stable; only the distributor's source is re-pointed). Register it at `Address::of(composite_uuid, vec![INPUT_TAP_KEY])`.
- `resolve_one_sidechain` (audio_unit/routing.rs) currently resolves only the bare `target.uuid`. It must try the FULL target address (uuid + field path) first, then fall back to the bare uuid, then the existing host-pointer fallback — so a pointer at the composite's `input` field (11) finds the tap while every existing bare-uuid target keeps resolving exactly as today.

## FIXED: pre-existing knob bug found via the composite (affected EVERY parameter)

Attaching automation to any parameter pinned its knob to MIN until an event existed. Confirmed by the user on
stock knobs too — the composite only made it obvious, because the entry gain's default (0 dB) sits at knob MAX
under DefaultDecibel, so the jump was maximal.

Root cause: `Engine::observe_param`'s UI-broadcast seed did `curve.value_at(pos).unwrap_or(0.0)`. That slot
carries a UNIT value, so 0.0 is the minimum of EVERY mapping — and `ParamHandle::resolve` only writes the slot
while the curve DOES cover the position, so the bogus seed was never corrected and the LiveStream republished
it forever.

Why the engine cannot simply publish the storage value instead (it has it — `field.get()`): the slot's contract
is a UNIT value, while storage is REAL (dB / Hz / bipolar). Converting real -> unit needs that parameter's
ValueMapping, and mappings live ONLY in the TS adapters (see feedback_param_mappings_from_adapter). Publishing
0 dB would be read as unit 0 — the same bug with a different number.

Fix (both sides, minimal):
- Engine publishes `f32::NAN` when the curve yields no value — the codebase's existing "no value yet" sentinel
  (cf. `ParamHandle::last`). The slot is still REGISTERED, so a curve that starts later still animates the knob.
- `AutomatableParameterFieldAdapter` reads NaN as "no controlled value": it clears `#controlledValue`, and the
  existing `getControlledUnitValue(): #controlledValue ?? getUnitValue()` then shows the STORAGE value, mapped
  by the side that owns the mapping.
- Holding the last automated value PAST a region end is unaffected: that path never writes the slot at all, so
  no NaN is published there.
Test: `attaching_automation_with_no_events_does_not_move_the_control` (engine); fails on the old seed.

## Best practice: silencing notes WITHOUT stranding held voices

The question "an empty MidiComposite must release the currently-sounding notes, but it cannot know which are
alive" has an established answer in this codebase, and the composite never needs to know:

`PullLink::SlotRoute`'s gate (the Playfield pad's mute / solo) drops note STARTS and lets RELEASES + CHOKES
through — "so held voices stop like TS". Never swallow a note-OFF and nothing can hang.

Applied to the midi composite in two places (both were bugs):
1. An EMPTY midi composite is now an IDENTITY (`build_link` returns the tee when it has no entries), mirroring
   the empty AUDIO composite's documented bypass. Merging zero branches swallowed EVERY event including the
   note-OFFs of sounding voices — the reported stuck notes. Passing through means there is nothing to release.
2. A SILENT branch (muted / not soloed) now drops only `EVENT_NOTE_ON`; its releases still reach the merge. It
   previously discarded the branch's whole output, so muting an entry stranded every voice it had started.
Tests: `a_silent_branch_still_passes_its_note_releases` (fails if the whole output is discarded).

## GOTCHA: tests that pull must take the crate-wide `pull_lock`

`PULL` is a plain `Shared` cell because the production engine is single-threaded, but the test harness runs on
parallel threads — unguarded access SEGFAULTS (it did). `crate::pull_lock()` is now the ONE crate-wide mutex;
`audio_unit::tests::pull_lock` delegates to it. Per-module mutexes would not serialise against each other.

## Flagged / open points

- Final UI labels for the three devices (working: "FX Composite", "Note Composite", "Stereo Split").
- Extra entries on StereoCompositeBox beyond two read branch 0 (robustness rule, revisit if generic N-branch splits arrive).
- Manual pages: `DeviceManualUrls` now points at manuals/devices/audio/effect-composite, .../audio/stereo-composite and .../midi/note-composite. Those pages do not exist yet.

## Progress

- Phase 1 DONE (schemas, pointers, codegen, all-boxes fixture; studio-boxes cargo tests green).
- Phase 2 DONE (5 adapters, DeviceHost relaxation + every call site, BoxAdapters registration, preset subtree fix, clipboard one-sided handling). Tests: `packages/studio/core/src/project/CompositeAdapters.test.ts` (4) and `packages/studio/adapters/src/preset/PresetEncoder.composite.test.ts` (1). core 193/193 green; adapters 144/146 with the only 2 failures pre-existing and unrelated (EnginePreferences metronome gain, fails on a clean tree too).
- Phase 3 IN PROGRESS. Done so far:
  - The registration seam, end to end and live: `EffectCompositeSpec` + `Distributor` in crates/engine/src/lib.rs, the `effect_composite_register` abi export, and the mirrored `EFFECT_COMPOSITES` table in core-wasm/src/engine-modules.ts threaded through device-linker / boot / protocol / WasmEngine / processor / engine-processor / offline-render / the wasm test helper. engine.wasm rebuilt and verified to export it; app/wasm 165/165 green.
  - The two DSP nodes the composite needs beyond what exists: `crates/engine-env/src/composite_mix.rs` (`DistributorProcessor` with broadcast / stereo modes + the owned input tap, and `DryWetMixProcessor` with the empty-composite bypass and update-clock automation). Everything else is REUSED (entry strip = `ChannelStripProcessor`, wet sum = `AudioBusProcessor`). Tests: `crates/engine-env/tests/composite_mix.rs`, 10 cases, all green (engine-env 83/83).
  - GOTCHA for engine-env tests: a synthetic `Block` must be physically coherent. One 128-sample quantum at 120 bpm spans 5.12 pulses (960 PPQN), and the update grid is every 10 pulses — copy the aux-send test's geometry (`p0: 8.0, p1: 13.12, s1: RENDER_QUANTUM`). An incoherent block silently clamps every grid point to the block end and the automation never resolves mid-quantum.
  - Also note: a de-click `LinearRamp` is 5 ms = 240 samples, LONGER than a 128-sample quantum, so an automated gain cannot reach its target within one block. Assert that the ramp STARTED and is rising, never that it arrived.
  - The BINDING is in and wired: `crates/engine/src/effect_composite.rs` (entry `IndexedCollection`, per-entry pooled reconcile, gain/mute/solo binding, cross-entry solo -> `forced_silent`, dry/wet binding + automation, input-tap registration, teardown, nesting via the shared `build_chain_members`). `Member` gained `input_node` + `params: Option<DeviceParams>`; `ProcHandle` gained `EffectComposite`. Every audio chain builds composites through the ONE `take_or_build_audio_member`, and all FOUR chain-wiring loops honour `input_node`. `terminate_member` hands a composite to its own teardown. Sidechain resolution recurses into composites (`visit_member_sidechains`) and now resolves a FULL target address first, so the composite input tap resolves while every existing bare-uuid target is unchanged. engine 111/111 green (6 new composite tests in audio_unit/tests.rs); engine.wasm rebuilt, app/wasm 165/165.
  - Design notes worth keeping: (1) a change INSIDE a composite must fire `rewire` (the unit's `wiring_dirty`), not `signal` — a plain enqueue never re-runs the unit's chain reconcile, so the edit would never reach the composite; (2) entry gain/mute/solo need their OWN targeted `This` monitors (they change no collection and raise no `wiring_dirty`), mirroring `subscribe_child_enabled`; (3) do NOT gate the survivor's reconcile behind a `subtree_dirty()` check — it CONSUMES the per-entry flags the reconcile itself needs, so the entry silently skips its re-wire. All three were found by tests, not by reading.
- Phase 3 DONE. Closing tests added: a composite NESTS inside another composite's entry (proving "stacks nested indefinitely" needs no special case), an outer teardown takes the nested cascade with it (nodes + subscriptions + both input taps), and the input TAP is registered at the composite's `input` vertex distinctly from its mixed output at the box address. engine 114/114. Each was mutation-checked (dropping `teardown_effect_composite` fails both teardown tests; ignoring `input_node` fails the wiring test).
- Phase 5 (stereo split) DONE: `EffectFactories.AudioEffectComposite` / `StereoComposite` / `MidiComposite`, with `STEREO_ENTRY_LABELS = ["L", "R"]` created by the stereo factory in one edit (index 0 = left, 1 = right — the order the engine's distributor maps BY INDEX). `EffectBox` union extended. Test in CompositeAdapters.test.ts, mutation-checked by swapping the label order. core 194/194.
- GOTCHA (two live-update bugs, both found by the user clicking, not by 119 green tests): a value the DSP reads each block must be synced into its shared `Cell` with `graph.catchup_and_subscribe`, NOT read once at bind time. The channel strip states the rule outright: "reactive but no rewire needed — the strip reads these Cells each block". Reading `dry`/`wet` once at build made the knobs dead until a reload (which rebuilt the composite and re-read them) — exactly the reported symptom. The entry GAIN is a DRAG, so it syncs live too; MUTE/SOLO stay on the re-wire monitor (toggles, and solo re-resolves every sibling). Routing a drag through a re-wire reconciles the whole chain per tick, which is the perf trap params.rs warns about.
- GOTCHA: a device's PEAK METER needs an explicit `broadcasts.register(uuid, &[], PACKAGE_FLOAT_ARRAY, &meter_slot)` — every plugin does it in `take_or_build_audio`. The composite had none, so its meter had no package to subscribe to and never moved. `DryWetMixProcessor` now owns a `Meter` fed on all three paths (bypass included) and registers under the composite's box uuid. The broadcast table is Weak-swept, so teardown needs no explicit unregister.
- GOTCHA (cost me a boot crash): a studio `.sass` consumed by `Html.adoptStyleSheet` MUST use the literal `component` token as its root selector, never a hand-written class — `adoptStyleSheet` asserts `includes("component")` and then `replaceAll("component", ".C<id>")` to generate the class. Indentation is 2 spaces. This is a RUNTIME assert at module load, so typecheck, unit tests AND `vite build` all pass while the app dies on boot. Only running the app catches it.
- GOTCHA: in studio/core use `npm run build` as the authoritative typecheck — it caught a `toStrictEqual(value, message)` arity error in a test that both `npx tsc --noEmit` and vitest (which transpiles without checking) let through.
- Phase 4 (midi composite) DONE: `crates/engine/src/midi_composite.rs` — `NoteTee` (pulls the upstream ONCE per window and replays it to every branch) + `NoteMerge` (pulls every branch, merges by position, stable by entry index; a SILENT branch is still pulled and only discarded). `PullLink` gained `Tee` / `Merge`; `ProcHandle` gained `MidiComposite`; `MidiCompositeBinding` (in effect_composite.rs) reconciles entries per member and `build_link` folds the composite into any pull chain — including nested inside another midi composite. All FOUR midi chain builders + both pull-chain folds go through `take_or_build_midi_member`. 5 tests in midi_composite.rs, mutation-checked (defeating the tee cache advances a stateful upstream 3x instead of 1x). engine 119/119.
- Phase 6 (UI) MOSTLY DONE: `AudioEffectCompositeDeviceEditor` (dry/wet + entry list; serves the stereo split too, via `entriesFixed`), `MidiCompositeDeviceEditor`, the shared `CompositeEntryList` (per-entry gain knob / mute / solo / enter / add), and `CompositeCellEditor` — the way BACK out of an entered entry, rendered in the instrument slot because a composite entry hosts no instrument (keyed off `DeviceHost.hostsInstrument`). `DevicePanel.getContext` resolves both cell box types; `DeviceEditorFactory` dispatches all three composites.
- Phase 3 / 6 REMAINING (the honest gaps):
  1. Sidechain picker scoping (UI). The ENGINE seam is done and tested (the tap is registered at the composite's `input` vertex and `resolve_one_sidechain` resolves a full address first), but `SidechainButton` does not yet OFFER "<composite> input". It needs the device's `deviceHost` threaded in (it currently takes only `sideChain` + `rootBoxAdapter` + `editing`) and an ancestor walk collecting each enclosing entry's `compositeDevice().inputField.address` — `AudioEffectCompositeCellBoxAdapter.compositeDevice()` exists for exactly this. Until then a nested sidechain can be pointed at the tap only programmatically.
  2. End-to-end wasm tests (phase 7): the dry/wet math, and the sidechain input tap surviving an upstream plugin swap. Native engine tests CANNOT cover a real sidechain — `call_device_init` is a no-op there, so no device ever declares a sidechain path. Needs app/wasm with a real compressor inside a composite.
  3. Drag-and-drop of an effect directly ONTO a composite editor (dropping into an entry's chain works today by entering the entry first).
  4. Manual pages for the three new devices (DeviceManualUrls points at paths that do not exist yet).