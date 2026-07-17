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
- Audio AND note composites ship in this pass.
- Audio entries carry gain, mute, solo (all automatable). Note entries carry mute and solo only.
- The audio composite has stack-level dry and wet gains. The note composite has neither (output = merge of audible entries).
- Dry defaults to silent, wet to 0dB. The composite REPLACES the signal by default, raise dry for parallel-fx use.
- An EMPTY composite (zero entries) bypasses: identity pass-through regardless of dry/wet.
- Entries have NO separate `enabled`, mute is the gate. The composite device itself keeps the standard device `enabled` (field 4).
- Two entry box types (audio / note), each with exactly the fields its kind needs, both with an `index` field.
- Sidechain input tap: devices INSIDE a composite can pick that composite's input as sidechain source. Registered as an address seam, resolvable generically.
- One split container ships now: stereo split (fixed L/R entries), proving the input-distributor seam. Frequency / mid-side / tonal splits come later as further box types on the same seam.
- UI: Playfield-style enter. The composite editor lists entries, clicking one swaps the devices row to that entry's chain (the entry is a DeviceHost).
- Naming: Composite family, matching CompositeDeviceBox / CompositeCellBox.
- Presets capture the whole subtree (entries, chains, nested composites) via the existing PresetEncoder path.

## Naming

Boxes:
- `EffectCompositeBox` (audio-effect device via `DeviceFactory.createAudioEffect`)
- `NoteCompositeBox` (midi-effect device via `DeviceFactory.createMidiEffect`)
- `StereoCompositeBox` (audio-effect device, the stereo split, same entry type as EffectCompositeBox)
- `EffectCompositeCellBox` (one audio entry: an audio-effects chain + gain/mute/solo)
- `NoteCompositeCellBox` (one note entry: a midi-effects chain + mute/solo)

Pointers (appended to `Pointers.ts`, never renumbered):
- `Pointers.EffectCompositeCell`
- `Pointers.NoteCompositeCell`

UI labels are an implementation-time call (working proposal: "FX Composite", "Note Composite", "Stereo Split").

## Part 1: shared requirements for notes and audio composites

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

Note-only:
- Pull-based tee and merge (midi effects are pull-chain stages, not buffer processors).

## Part 2: box schemas

All keys below become WASM CONTRACT once shipped (mirrored in `engine-modules.ts` and the Rust spec, frozen).

`EffectCompositeBox` = `DeviceFactory.createAudioEffect("EffectCompositeBox", {...})`:
- 10 field `entries`, accepts `[Pointers.EffectCompositeCell]`
- 11 field `input`, accepts `[Pointers.SideChain]` (the input-tap target vertex, no children)
- 12 float32 `dry`, ParameterPointerRules, constraints "decibel", default = the decibel floor (silent)
- 13 float32 `wet`, ParameterPointerRules, constraints "decibel", default 0dB

`StereoCompositeBox` = same shape (fields 10-13), own box type so the engine spec selects the stereo distributor. Its factory creates exactly two `EffectCompositeCellBox` entries labeled "L" / "R". The UI hides add / remove for it.

`NoteCompositeBox` = `DeviceFactory.createMidiEffect("NoteCompositeBox", {...})`:
- 10 field `entries`, accepts `[Pointers.NoteCompositeCell]`

`EffectCompositeCellBox`:
- 1 pointer `composite`, `Pointers.EffectCompositeCell`, mandatory
- 2 field `audio-effects`, accepts `[Pointers.AudioEffectHost]`
- 3 int32 `index`, constraints "index"
- 4 string `label`
- 5 boolean `minimized`
- 40 float32 `gain`, ParameterPointerRules, constraints "decibel", default 0dB
- 41 boolean `mute`, ParameterPointerRules
- 42 boolean `solo`, ParameterPointerRules
- box pointerRules accepts `[Pointers.Editing, Pointers.Selection]`

`NoteCompositeCellBox`:
- 1 pointer `composite`, `Pointers.NoteCompositeCell`, mandatory
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

### Note composite as a pull stage

Integration point: the midi-fx fold in `build_cluster` (wiring.rs:1030) and the equivalent fold in `wire_cluster`. When a chain member is a `NoteCompositeBox` (note kind spec):
- `NoteTee` (new): wraps the upstream `PullLink`, pulls it ONCE per (from, to) window and caches the events, serving all branches (same idea as the clip-sequencer replay cache for multi-sequencer pulls).
- Per entry: the entry's own midi-effects chain folds `PluginMidiEffect` stages over the tee, exactly like the normal fold, so nested note composites recurse for free.
- `NoteMerge` (new): pulls every branch each window. Muted / not-soloed branches are still pulled (stateful effects keep time) but their events are discarded. Output = merged events sorted by time, stable by entry index. The merge is the `PullLink::Source` the rest of the chain folds on.
- Entries, mute / solo subscriptions, and per-entry reconcile reuse the same binding pattern as the audio side (shared helper where practical).
- A disabled NoteCompositeBox is skipped in the fold like any disabled midi effect.

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
- `EffectCompositeBoxAdapter`, `StereoCompositeBoxAdapter` (AudioEffectDeviceAdapter) and `NoteCompositeBoxAdapter` (MidiEffectDeviceAdapter), each exposing an `IndexedBoxAdapterCollection` of its entries and the dry/wet parameters (created with the decibel ValueMapping).
- `EffectCompositeCellBoxAdapter` / `NoteCompositeCellBoxAdapter` implement `DeviceHost` following `PlayfieldSampleBoxAdapter` (delegate `inputField` / `tracksField` to the audio unit, own `minimizedField`). Entry params (gain/mute/solo) created here.
- One-sided hosts: an audio cell hosts no midi chain, a note cell hosts no audio chain and no instrument. The `DeviceHost` seam gets relaxed for this (chain accessors become capability-aware, e.g. Option-returning or paired with `hostsMidiEffects` / `hostsAudioEffects` flags), and `DevicePanel`, `DeviceMount`, and `DevicePanelDragAndDrop` render / accept only the declared sections. This touch is the main UI-infrastructure cost and lands before the editors.
- Register in `BoxAdapters`, extend `Devices` type guards if needed.

Studio UI (`packages/app/studio/src/ui/devices`):
- `EffectFactories`: three new factories (audio list: EffectComposite, StereoComposite, midi list: NoteComposite). The StereoComposite factory creates the two fixed L/R cells in the same edit.
- `EffectCompositeDeviceEditor.tsx` (audio-effects dir) and `NoteCompositeDeviceEditor.tsx` (midi-effects dir): header with dry / wet knobs (audio only), then the entry list. Each row: reorder drag handle (writes `index`), editable label, gain knob (audio), mute / solo toggles, and an enter button calling `userEditingManager.audioUnit.edit(cellBox)`. Add-entry button appends an empty cell. StereoComposite hides add / remove / reorder.
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

## Flagged / open points

- Final UI labels for the three devices.
- Exact default encoding for `dry` at the decibel floor (verify the "decibel" constraint's minimum during phase 1).
- The DeviceHost relaxation shape (Option-returning accessors vs capability flags) is decided when touching DevicePanel, whichever needs the smaller diff.
- Extra entries on StereoCompositeBox beyond two read branch 0 (robustness rule, revisit if generic N-branch splits arrive).