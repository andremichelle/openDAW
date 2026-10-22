# Sidechain inputs for Werkstatt and Apparat (#211)

**Doability:** ⭐⭐⭐☆☆ (3/5). Sidechains become dynamic child boxes like `@sample`, so the engine's sidechain binding learns a box-driven port collection. Everything else (routing, graph ordering, `resolve_input`) already exists for effects and instruments.
**Type:** feature
**Scope:** medium
**Decided (2026-10-19):** Werkstatt + Apparat now, any number of named sidechains, NO limits, unconnected = silence, self-sidechain behaves like Compressor (accepted), the UI control is its own component (orange, own icon, the sample cell is only a template). Spielwerk later (separate issue).

> Third revision 2026-10-19. Revision 1 (one pointer, field 30) and revision 2 (fixed array of 8 slots) are both rejected. The original plan below the line referenced the removed TS `WerkstattDeviceProcessor`, superseded.

## Revised plan

### 1. Script surface
1. Directive `// @sidechain <name>`, name required, like `@sample`. One control cell per line, placed in the grid like `@sample`.
2. A script with at least one `@sidechain` gets `this.sidechains`, an object keyed by name, each value `[left, right]` (`Float32Array`, quantum coordinates like `io.src` / `output`). The bridge assigns it right before every `process` call, not available in the constructor. Mirrors Apparat's `this.samples[name]`.
3. Unconnected or unresolvable: zeros.
4. A script without `@sidechain` is never touched (an existing own `this.sidechains` field keeps working).

### 2. Box model
1. New box `WerkstattSidechainBox` (sibling of `WerkstattSampleBox`): `1 owner` (pointer `Pointers.ScriptSideChain`, mandatory), `2 label` (string), `3 index` (int32, order among the `@sidechain` lines), `4 source` (pointer `Pointers.SideChain`, not mandatory, targets the output exactly like Compressor's `side-chain`).
2. `WerkstattDeviceBox` and `ApparatDeviceBox`: `13: {type: "field", name: "side-chains", pointerRules: {accepts: [Pointers.ScriptSideChain], mandatory: false}}`, the hub the children point to.
3. `Pointers.ScriptSideChain` appended at the END of the enum (append-only ordinals).
4. Regenerate with `npm run build -w @opendaw/studio-forge-boxes` (rewrites `packages/studio/boxes/src` and the Rust `crates/studio-boxes/src/registry.rs`), then `npm run build-wasm`.
5. Adapters: `get sideChains(): Field<Pointers.ScriptSideChain>` on `WerkstattDeviceBoxAdapter` and `ApparatDeviceBoxAdapter`.
6. Old projects: no children, nothing changes. Device copy / preset / delete: children follow the device through their mandatory `owner` (like samples), the `source` pointer is not mandatory, so its target is never dragged into a copy (same rule as Compressor's `side-chain`).

### 3. Declarations and compiler (`packages/studio/adapters`)
1. `ScriptDeclaration.ts`: `SidechainDeclaration {label}`, a `{type: "sidechain"}` `DeclarationItem`, `DIRECTIVE_LINE` becomes `@(group|param|sample|sidechain) .+` (same shape, existing matching unchanged), `parseSidechains(code)` in line order. `DECLARATION_LINE` / `parseDeclarationOrder` untouched, sidechains keep their own index.
2. `ScriptCompiler.ts`:
   1. `wrapScript` adds `sidechains: [{label, index}]` to the registry entry (pure superset).
   2. `ScriptDeviceBox` gains optional `readonly sideChains?: Field<Pointers.ScriptSideChain>` (Spielwerk has none).
   3. New exported `ScriptCompiler.reconcileSidechains(deviceBox, declared)`, mirroring `reconcileSamples`: keyed by label, a surviving name keeps its box (and so its source), only its `index` is updated; a removed name deletes its box; a new name creates one. No-op without `sideChains`. Called in the `compile` modifier.
3. `packages/studio/scripting` `ScriptSupport.set code` calls the same `reconcileSidechains` (additive, no API change).

### 4. Engine (`crates/engine`)
1. `DeviceReg` gains `sidechain_collection_field: u16` (0 = none). New engine export `device_set_sidechain_collection_field(device_id, field)`, called by `device-linker.ts` after `device_register` when the device exports `observe_sidechain_collection_field`. `device_register` keeps its signature.
2. `SidechainPort.path: Vec<u16>` (device-relative) becomes `address: Address` (absolute), so a port can follow a pointer on a CHILD box. `build_sidechain` builds `Address::of(device, path)`, `resolve_one_sidechain` reads `port.address`. Behaviour for existing devices identical.
3. `SidechainPort` gains `child: Option<Uuid>` and `index_sub: Option<SubscriptionId>`. `SidechainBinding` gains `collection: Option<SidechainCollection {hub_field, bound_count, hub_sub}>`.
4. `build_sidechain` also creates a binding when only `sidechain_collection_field != 0`, subscribing the hub (`subscribe_pointer_hub`) to the unit's `signal`.
5. `resolve_one_sidechain`, before the port loop: sync collection ports with the hub children. Gone child: remove its edge, unsubscribe, drop the port. New child: subscribe its `source` pointer (key 4) and `index` (key 3) to `signal`, push a port. Port id = `2 + bound_count + index` (`bound_count` = the device's `bind_sidechain` count, 0 for script devices). Any change sets `changed`, so `set_sidechains` rebuilds.
6. Teardown (`terminate_member`): one helper unsubscribes every port's `pointer_sub` + `index_sub` and the `hub_sub`.
7. `WASM CONTRACT` markers on the child keys (3, 4) and the port id rule, mirrored in the bridge.

### 5. Rust devices
1. `device-werkstatt` and `device-apparat`: one new export `observe_sidechain_collection_field() -> 13`. Nothing else, no ABI change.

### 6. Script bridge (`script-bridge.ts`)
1. `ScriptEngine` gains `host_resolve_input(id, outPtr)` (already an engine export, `INPUTS` is swapped in for the device's `process`, and the bridge runs inside that call).
2. `RegistryEntry` gains `sidechains?: [{label, index}]`, `#ensureProc` copies it to the `Bridge` on every swap.
3. `#audio` (effect and instrument), when the list is non-empty: per sidechain resolve port `2 + index` into the scratch, build fresh views (memory may grow, same as `src` / `out`) or a per-bridge zero pair refilled `fill(0, s0, s1)`, store into a persistent `sidechainViews[label]`, assign `proc.sidechains = sidechainViews`, then `process`.
4. `#notes` (Spielwerk) untouched.

### 7. Editor (`packages/app/studio`)
1. New component `ui/devices/SidechainSelector.tsx` + `.sass`: props `lifecycle, editing, rootBoxAdapter, sideChain: PointerField<Pointers.SideChain>, deviceHost, label`. `Column ems={LKR}` with `h5`, a round orange zone that IS a `MenuButton` (icon `IconSymbol.Connected`, root reuses `populateSidechainMenu`), and the source name beneath. State from `sideChain.catchupAndSubscribe`.
2. `SidechainButton.tsx`: export `resolveSidechainLabel(sideChain, rootBoxAdapter, deviceHost)`, walking `labeledAudioOutputs()` recursively plus enclosing composite inputs. Existing `SidechainButton` / `ModulatorSourceMenu` untouched.
3. `ScriptDeviceEditor.tsx`: index `WerkstattSidechainBox` children by label (like `sampleBoxesByLabel`), render `SidechainSelector` for a `sidechain` item, `<div/>` when absent (Spielwerk, or before compile). Rebuild also on the `sideChains` hub (only when the adapter has one).

### 8. Docs and examples
1. `werkstatt-starter-prompt.txt`, `apparat-starter-prompt.txt`: `@sidechain` and `this.sidechains`.
2. `werkstatt-examples.ts`: a ducker on `this.sidechains.Key`. `apparat-examples.ts`: a voice gated by a sidechain.
3. Manual pages for Werkstatt and Apparat.

### 9. Tests
1. `ScriptDeclaration.test.ts`: `parseSidechains` order, missing name, extra tokens; `parseGroups` emits `sidechain` items; `parseDeclarationOrder` unchanged with interleaved `@sidechain` lines.
2. Reconcile (box graph): connect two named sidechains, then reorder, insert, remove, rename: surviving names keep their sources.
3. core-wasm vitest (templates `werkstatt-parity.test.ts`, `apparat-sample-parity.test.ts`): two sidechains on two sources map to the right names; a cleared source gives silence; adding and removing a sidechain box at runtime rewires; Apparat equivalent; a script without `@sidechain` owning `this.sidechains` stays untouched.
4. Rust: unit test for the collection port sync if the engine test harness allows it; existing Compressor / Gate / Vocoder / WCLAP sidechain and composite-sidechain-tap tests pass unedited.
5. All existing werkstatt / apparat / spielwerk tests pass unedited.

### 10. Sidechain mixer script and browser check
1. A Werkstatt example script "Sidechain Mixer": `// @sidechain A`, `// @sidechain B` (more lines work the same) plus one `@param` gain per sidechain, output = main input + the gain-weighted sum of every declared sidechain.
2. Tests for it (core-wasm vitest): two units with distinct deterministic signals routed into A and B, the output equals `src + gainA * A + gainB * B` sample by sample; clearing B removes only B; a gain of 0 mutes only its sidechain; renaming B keeps A on its source.
3. After the implementation and all tests: run the studio in Chrome, load the mixer script into a Werkstatt, connect two tracks through the new sidechain cells, check the cells (label, source name, orange state, dropdown, remove) and that the meter / audio follows the routing. Stop playback afterwards.

### 11. Dry-run findings
1. A child box pointer is not reachable by a device-relative path, hence the absolute `address` in `SidechainPort`. Existing ports build `Address::of(device, path)`, identical behaviour.
2. The bridge resolves ports itself through `host_resolve_input` during the device call, so no new import and no Rust device logic beyond one export.
3. Port ids `2 + bound_count + index` never collide with `bind_sidechain` ids (2 .. 2 + bound_count).
4. Reordering `@sidechain` lines changes `index` (a field edit, not a hub event), hence the per-port `index_sub`.
5. The Rust box registry is generated by the forge build, the regen is mandatory.
6. Existing scripts may own `this.sidechains`, the bridge only assigns it when declared.
7. Shared code (`ScriptDeclaration`, `ScriptCompiler`, `ScriptDeviceEditor`, scripting `ScriptSupport`): Spielwerk is gated by having no `side-chains` hub, the bridge never acts on MIDI effects.
8. `MenuButton` styles every child with `pointer-events: none` and sets its own `color`, so the zone is the button itself.
9. `ModulatorSourceMenu.resolveLabel` only checks top-level outputs, the new helper walks children.
10. Self-sidechain: no `would_cycle` in `resolve_one_sidechain`, the sort drops the back-edge, possibly one quantum late. Identical to Compressor, accepted.
11. Apparat calls `script_audio` several times per block, each call re-resolves from `INPUTS`, which covers the whole quantum.
12. Composite replicas build their own bindings over the same children, like Compressor.
13. Removing a `@sidechain` line deletes its box and so its source; undo restores both.
14. Freeze renders the sidechains as they are at freeze time.
15. `teardown` has a single drop site for sidechain bindings (`terminate_member`), so one helper covers all subscriptions.

### 12. Spielwerk (later, separate issue)
1. MIDI effects have no audio graph node (`take_or_build_midi` builds `sidechain: None`) and run inside the instrument's note pull. Audio input needs engine ordering work plus a script API for reading audio in a note generator.

---

## Original plan (superseded)

## What is asked
Give the Werkstatt scriptable device a sidechain/external audio input so user scripts (e.g. a hand-written vocoder) can read a second signal, not just the device's main input.

## Current behaviour / relevant code
- Werkstatt schema: `packages/studio/forge-boxes/src/schema/devices/audio-effects/WerkstattDeviceBox.ts:5-9` — fields `code` (string), `parameters` (pointer-hub, `Pointers.Parameter`), `samples` (pointer-hub, `Pointers.Sample`). **No sidechain field**, unlike Compressor.
- Werkstatt adapter: `packages/studio/adapters/src/devices/audio-effects/WerkstattDeviceBoxAdapter.ts:13-57` — no `sideChain` getter (contrast `CompressorDeviceBoxAdapter.ts:38`).
- Werkstatt TS processor: `packages/studio/core-processors/src/devices/audio-effects/WerkstattDeviceProcessor.ts` — `processAudio` (line 175) builds `#io = {src: [L,R], out: [L,R]}` from the single upstream source (line 167-170) and calls `proc.process(this.#io, block)` (line 190). `UserIO` interface (lines 34-37) only has `src`/`out` — no sidechain slot.
- Script bridge (JS↔WASM boundary): `packages/studio/core-wasm/src/script-bridge.ts` — `imports()` (lines 119-133) exposes `host_script_audio(handle, srcL, srcR, outL, outR, s0, s1, index, p0, p1, bpm, flags)`, a fixed 4-audio-pointer signature; `#audio()` (lines 188-229) builds `io.src`/`io.out` from exactly those two buffers before calling `proc.process(io, block)`.
- Rust Werkstatt mirror: `crates/stock-devices/device-werkstatt/src/lib.rs` — `process()` (lines 87-122) resolves only `MAIN_INPUT` via `abi::resolve_input(MAIN_INPUT)` (line 93); no `bind_sidechain` call anywhere in this crate. Calls `abi::script_audio(handle, src_l, src_r, out_l, out_r, &Block{...})` (lines 110-111, 119-120) — one buffer pair only.
- **Sidechain wiring to mirror** (Compressor): schema field `CompressorDeviceBox.ts:45-47` (`30: {type:"pointer", name:"side-chain", pointerType: Pointers.SideChain, mandatory:false}`); adapter `CompressorDeviceBoxAdapter.ts:38` (`get sideChain()`); UI `packages/app/studio/src/ui/devices/SidechainButton.tsx:19-56` (menu of `rootBoxAdapter.labeledAudioOutputs()`, sets `sideChain.targetAddress`); TS processor `CompressorDeviceProcessor.ts:136-152` (resolves `adapter.sideChain.targetVertex` → `context.audioOutputBufferRegistry.resolve(address)`, registers a graph edge via `context.registerEdge(...)`, falls back to the main signal if unresolved); Rust `device-compressor/src/lib.rs:42,131,187` (`SIDE_CHAIN_FIELD=[30]`, `abi::bind_sidechain` in `init`, `abi::resolve_input` in `process_audio`); engine plumbing `crates/abi/src/lib.rs:616-646`, `crates/engine/src/audio_unit/wiring.rs:116-125`, `crates/engine/src/audio_unit/routing.rs:62,262`.
- **Vocoder** (`VocoderDeviceBox.ts:47-49`, field `19 modulator-source` + field `30 side-chain`) confirms the pattern generalizes: the sidechain pointer field is the sole audio-path mechanism, and a separate string/mode field just decides how the resolved sidechain buffer is interpreted downstream.

## Plan
1. Schema: add a `30: {type:"pointer", name:"side-chain", pointerType: Pointers.SideChain, mandatory:false}` field to `WerkstattDeviceBox.ts`, identical to Compressor/Vocoder.
2. Adapter: add `get sideChain(): PointerField<Pointers.SideChain> {return this.#box.sideChain}` to `WerkstattDeviceBoxAdapter.ts`.
3. TS processor: in `WerkstattDeviceProcessor.ts`, add the same `ProcessPhase.Before` resolution hook Compressor uses (subscribe to `adapter.sideChain`, resolve via `context.audioOutputBufferRegistry`, `context.registerEdge(...)` for graph ordering, store the resolved `AudioBuffer` or a silent fallback). Extend `UserIO` (lines 34-37) with a new member, e.g. `sideChain: ReadonlyArray<Float32Array>`, populated each block in `processAudio` alongside `src`/`out`.
4. Script bridge: widen `host_script_audio`'s signature in `script-bridge.ts` (`imports()` lines 119-133, `#audio()` lines 188-229) to accept a second pair of buffer pointers (sidechain L/R), building `io.sideChain` from them before calling `proc.process(io, block)`.
5. Rust: add `SIDE_CHAIN_FIELD` + `abi::bind_sidechain`/`abi::resolve_input` to `device-werkstatt/src/lib.rs::init`/`process()` (mirroring `device-compressor`), and widen `abi::script_audio(...)`'s call signature and the corresponding WASM import to pass the resolved sidechain buffer pointers through to the JS `#audio()` bridge.
6. UI: add `SidechainButton` to `WerkstattDeviceEditor.tsx` exactly as `CompressorDeviceEditor.tsx`/Vocoder's editor do.
7. Documentation for script authors: update `werkstatt-examples.ts`, `werkstatt-default.js`, `werkstatt-starter-prompt.txt` (all in the Werkstatt editor folder) to document the new `io.sideChain` member and add an example script (a simple vocoder) demonstrating its use — this is the actual point of the feature per the issue.

## Risks / open questions
- The script bridge ABI change (widening `host_script_audio`) touches a frozen cross-engine contract — must be updated in lockstep per the project's "WASM frozen contracts" rule, and needs a version bump/compat check if any serialized user scripts assume the old signature (they shouldn't, since scripts call `process(io, block)`, not the host import directly, but verify no script currently destructures `io` in a way that would break with an added field).
- Same feature is worth checking against Apparat/Spielwerk (other scriptable devices sharing `crates/engine/src/script_device.rs`) — if they're expected to get sidechain too eventually, consider adding the `sideChain` plumbing at the shared `script_device.rs` level rather than duplicating per-device, to avoid drift.
- Decide whether the sidechain is mono or stereo into the script, and what the fallback buffer is when unresolved (silence, matches Compressor's behavior) — document this clearly since script authors will branch on it.
