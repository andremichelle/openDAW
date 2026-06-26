# Engine updates: surgical, TS-faithful reactive updates

## Goal & hard requirements

The TS engine (`packages/studio/core-processors`, `packages/lib/box`) is highly optimised for runtime
edits: a single box-graph field change fires **exactly one** targeted handler that touches **only** the
affected adapter/processor. The Rust engine must match or beat this. Hard requirements, from the user, to
the letter:

1. **No `subscribe_all` scenarios.** Every reaction is targeted at the specific field/pointer/box that
   can change. (One justified exception mirrors TS exactly — see §5.6.)
2. **No reconcile of large parts of the engine on tiny or unrelated updates.** A chain edit on unit A must
   not rebuild unit A's other processors, must not reset their DSP state, and must not touch unit B.
3. **Equal or better effectiveness than TS.** A different, Rust-shaped solution is allowed only if proven
   at least as cheap. In particular, replacing one `subscribe_all` with N per-member monitors is a
   regression unless dispatch is sub-linear (§4).
4. **Minimal, clean, human-readable code.**

When any point feels unsafe while planning or implementing: record the concern in §8, re-collect data,
revise the strategy here, and continue. Do not stop until done and verified (Rust tests + parity suite).

## TS surgical model (verified, with citations)

- **Targeted subscriptions only.** `PrimitiveField.subscribe` / `PointerField.subscribe` use
  `subscribeVertexUpdates(Propagation.This, this.address, …)` — one exact address
  (`packages/lib/box/src/primitive.ts:95`, `pointer.ts:90`). A field's incoming pointers (automation,
  sidechain, members) are watched via its `pointerHub.catchupAndSubscribe(…, ...types)` — filtered by
  pointer type (`pointer-hub.ts:37`). No all-updates listeners exist in the audio chain. The single
  `subscribeToAllUpdates` is for `NewUpdate`/`DeleteUpdate` of a box CLASS (`EngineProcessor.ts:325`,
  for `AudioFileBox`) — there is no address to target a not-yet-created box, so this one is justified.
- **Per-member dynamic subscriptions.** `IndexedBoxAdapterCollection` watches membership via the
  pointer-hub and, inside `onAdded`, subscribes to that member's `indexField`; the sub is stored and
  terminated in `onRemoved` (`IndexedBoxAdapterCollection.ts:47`). `AudioDeviceChain` subscribes each
  effect's `enabledField` on add (`AudioDeviceChain.ts:49`).
- **Per-member processor lifecycle.** A device processor is created when its box joins the chain and
  terminated when it leaves; reorder/enable/output only re-connect EDGES via a `#disconnector`
  (`AudioDeviceChain.ts:90` `invalidateWiring` → `#wire` at `:124`). Surviving processors and their
  output buffers are **stable** for their lifetime — which is exactly why the sidechain registry needs no
  notify and a consumer never re-resolves merely because a source re-wired (`AudioOutputBufferRegistry.ts`
  is a plain map; `GateDeviceProcessor.ts:86` re-resolves only when its own `sideChain` pointer changes).
- **Address-indexed dispatch.** Monitors are kept sorted by address; `Propagation.This` matches by
  binary search, `Parent`/`Children` by prefix strategies (`packages/lib/box/src/dispatchers.ts`,
  `Dispatcher.stations()` sorts, `filter` uses `Addressable.equals/startsWith/endsWith`). Dispatch is
  sub-linear, not a scan.

## Rust primitives & the one constraint

`crates/boxgraph/src/graph.rs` already exposes the targeted primitives:
- `subscribe_vertex(Propagation, Address, observer)` — fires only when the update's address matches
  (`This` = exact, `Parent` = at/under, `Children` = at/over).
- `subscribe_pointer_hub(Address, observer)` — incoming-pointer add/remove at an address (catch-up + live).
- `catchup_and_subscribe(Address, observer)` — primitive value at an exact address (= `subscribe_vertex`
  `This` + value decode).

These are already used correctly for samples (`observe_samples` → `subscribe_vertex(This)`), plain fields
and params (`catchup_and_subscribe`), strip params, and all membership hubs.

**Constraint:** an observer receives `&BoxGraph` (shared), so it **cannot subscribe from inside a
callback** (`subscription.rs:8-11`). TS subscribes from inside `onAdded`; Rust cannot. Adaptation:
observers only RECORD (into cells/queues); per-member subscriptions are added/removed in the **apply
phase** (`reconcile`, which holds `&mut graph`). This is a faithful, equal-or-better equivalent: the same
targeting, with sub management batched once per transaction instead of mid-dispatch.

**Dispatch cost today:** `subscription.rs:dispatch` linearly scans every vertex monitor per update. With
targeted monitors that is O(M) cheap address-compares per update — acceptable for a few hundred, but a
regression for thousands of note/value events. So an address-indexed dispatcher is a prerequisite (§4),
not optional, to satisfy requirement 3.

## §4 Foundation: address-indexed dispatcher (boxgraph core)

Make `Subscriptions` keep vertex monitors sorted by address and resolve matches sub-linearly, mirroring
TS `Dispatcher`:
- Keep monitors in three buckets by propagation (This / Parent / Children), each sorted by `Address`
  (needs `Address: Ord` — add a total order: by uuid bytes then field-key slice).
- `This`: binary-search the equal-address range.
- `Parent` (monitor at/under target — monitor address `starts_with`... wait: Parent fires when update is
  at/under the monitor, i.e. `update.starts_with(monitor)`): for a given update address, its matching
  Parent monitors are the prefixes of the update address → probe each prefix length via binary search
  (O(len · log M)).
- `Children` (monitor at/over update, `monitor.starts_with(update)`): the contiguous sorted range whose
  addresses have `update` as a prefix → two binary searches for the range bounds.
- `all` listeners and hub diffing unchanged. Preserve fire order (vertex monitors before all-listeners).
- Insertion keeps sorted (insert at binary-search position); removal by id within the bucket.

Verify with focused unit tests in boxgraph (exact/parent/children hit the right monitors; non-matches
fire nothing). This change is invisible to every caller (same API), so existing tests must stay green.

## §5 Eliminate the six `subscribe_all` sites

### 5.1 `bindings/note_collection.rs:78` and `value_collection.rs:99` (per-event edit)
Events are SEPARATE boxes joined via the `events` pointer-hub. Replace the edit `subscribe_all` with a
**per-event `subscribe_vertex(Propagation::Parent, Address::box_of(event_uuid))`** added when the event
joins and dropped when it leaves. Because the hub observer cannot subscribe, give each collection an
`apply(&mut graph)` that drains pending joins/leaves (recorded by the hub observer) and manages the
per-event subs + upsert/remove. The owner calls `apply` in its reconcile. With §4, each event edit
dispatches to exactly that event's monitor.

### 5.2 `bindings/indexed_collection.rs:116` (per-member index/reorder)
Members are separate device boxes. Replace with a **per-member `subscribe_vertex(This, Address::of(member,
[index_key]))`** managed in an `apply(&mut graph)` (hub observer records joins/leaves; apply adds/removes
the index sub and re-reads order). The index-sub observer re-reads the member's index, re-sorts, marks the
chain dirty + signals (no subscribe needed — read + record only).

### 5.3 `audio_unit.rs:1067` (region span edit)
Per-region: replace with `subscribe_vertex(Propagation::Parent, Address::box_of(region_uuid))` created in
`build_region` (already apply phase, has `&mut graph`) and unsubscribed in `teardown_track`/region remove.
Fires only on that region's own field edits → re-read span, re-sort the track's region set.

### 5.4 `audio_unit.rs:614` automation attach/detach (part of the unit observer)
Replace the unit-level `subscribe_all` + `touches_unit_automation` with **per-parameter targeted subs**,
mirroring TS `AutomatableParameterFieldAdapter`:
- Static value edit: already handled by the per-param `catchup_and_subscribe` in `observe_params`
  (`:873`). Make that callback PUSH the value to the device when the param is un-automated (today a
  separate broad rebind does it), so the static-edit case needs no global listener.
- Automation attach/detach: per-param `subscribe_pointer_hub(Address::of(device, param_path))` to catch a
  TrackBox `target` pointing at / leaving the param field → (re)build that one param's track binding and
  re-arm the node. Only that parameter rebinds, not the unit.
- Value-region joining the automation track: handled by the param's `ValueCollection` (§5.1 fix) which
  observes the track's value-region membership + edits surgically; no unit-level listener.

### 5.5 `audio_unit.rs:614` sidechain re-point (the other half of the unit observer)
Replace `touches_sidechain` with a **per-effect `subscribe_vertex(This, Address::of(device,
sidechain_path))`** created when the effect joins (apply phase), exactly like `observe_samples`. On change
it re-resolves ONLY that port: follow the pointer → registry → swap that one edge + rebuild that effect's
sidechain set. No scan of units or other sidechains. Source-rebuild no longer forces re-resolution once
§6 makes source buffers stable (a persistent source keeps its buffer; a removed source unregisters and the
consumer re-resolves on the next reconcile that touches it, or via a registry-unregister hook if needed —
see §8 concern C1).

### 5.6 `lib.rs:948` (AudioFileBox new/delete) — JUSTIFIED, keep but narrow
This mirrors TS `subscribeToAllUpdates` for a box class; a not-yet-created box has no address to target.
Keep the semantics but narrow the firing: add a boxgraph `subscribe_box_lifecycle(observer)` that the
dispatcher invokes ONLY for `New`/`Delete` updates (rare), not every primitive edit. Document as the lone
all-class listener, matching TS.

## §6 Per-member processor lifecycle (no broad reconcile)

Today `rewire_unit` tears down and rebuilds the WHOLE unit cluster (every instrument/effect processor +
buffer + DSP state) on any chain dirty. Rework to TS's model:
- The unit holds persistent slots: `instrument: Option<DeviceSlot>`, `midi: Vec<DeviceSlot>`,
  `audio: Vec<DeviceSlot>` (a slot = uuid + processor `Rc` + node_id + `DeviceParams` + per-member subs),
  plus a persistent channel strip (move strip creation from `rewire_unit` to `build_unit`).
- On a chain change for the unit, do a **diff**: create a processor only for a newly-joined device,
  terminate only a left device; survivors keep their processor, buffer, params, and DSP state.
- Re-wire only EDGES: drop the unit's current audio edges and reconnect instrument → audio-fx (sorted) →
  strip → master; rebuild the midi-fx PULL chain from the persistent midi processors and re-set it on the
  instrument. (Edge churn is cheap; processors persist.)
- Output buffers become stable across reorder/enable, so sidechain consumers (§5.5) need no re-resolution
  when a source merely re-wires.
- Composite children get the same per-child lifecycle (mirror in `composite.rs`).

Net: adding a delay to a playing synth keeps the synth's voices; reorder only swaps edges; unrelated units
are never visited (they are not enqueued — the per-unit dirty dispatch from the prior work stays).

## §7 Implementation phases (each lands green: `cargo test` + wasm build + parity)

- **P0 — Indexed dispatcher (§4).** Add `Address: Ord`, bucket+sort monitors, sub-linear match, unit
  tests. Invisible to callers; all existing tests stay green. *Foundation for everything else.*
- **P1 — Collection edit subs (§5.1, §5.2, §5.3).** Give note/value/indexed collections an `apply` phase
  for per-member subs; convert region span edit. Owners call `apply` in reconcile.
- **P2 — Box-lifecycle listener (§5.6).** `subscribe_box_lifecycle`; convert `observe_audio_files`.
- **P3 — Per-member processor lifecycle (§6).** Rework `rewire_unit` into a diffing reconcile;
  persistent strip + slots; edge-only re-wire; mirror in composite.
- **P4 — Surgical automation (§5.4) and sidechain (§5.5).** Per-param pointer-hub + per-effect pointer
  subs; delete the unit-level `subscribe_all` and `touches_unit_automation`/`touches_sidechain`; delete
  the all-units sidechain scan and the `did_work` global pass.
- **P5 — Verify.** Full Rust workspace, wasm build (no warnings), parity/sync suite; manual reasoning over
  each "thing that can update" in §9.

After P4 there must be ZERO `subscribe_all` calls in `engine/` and `bindings/` except the box-lifecycle
primitive's single internal use, and ZERO whole-unit rebuilds on a chain edit.

## §9 Inventory: every thing that can update → target mechanism

- Audio-unit membership (root) → pointer-hub (already targeted). ✓
- Device chain add/remove (input/midi/audio host) → pointer-hub (targeted) → create/terminate one slot.
- Device reorder (member `index`) → per-member `This` sub → re-wire edges only.
- Device enabled/bypass → NOT IMPLEMENTED today; out of scope, note in §8 (C2).
- Instrument swap → input-host membership → terminate old slot, create new.
- Param static value edit → per-param `catchup_and_subscribe` → push to device.
- Param automation attach/detach → per-param pointer-hub → rebind that param.
- Automation curve data (value events / regions) → `ValueCollection` per-event subs (§5.1).
- Sample set/repoint/clear → per-sample `This` sub (already targeted). ✓
- Plain device field → per-field `catchup_and_subscribe` (already targeted). ✓
- Sidechain re-point/detach → per-effect `This` sub → re-resolve one port.
- Strip volume/pan/mute → `catchup_and_subscribe` (already targeted). ✓
- Track membership → pointer-hub (targeted). ✓
- Region membership → pointer-hub (targeted). ✓
- Region span edit → per-region `Parent` sub (§5.3).
- Note events (region content) → `NoteCollection` per-event subs (§5.1).
- AudioFileBox new/delete → box-lifecycle listener (§5.6, justified).
- bpm / loop / signature / tempo automation controls → `catchup_and_subscribe` (verify each is targeted).

## §8 Concerns / open risks (update as encountered)

- **C1 — sidechain source removal.** With stable buffers, a consumer only re-resolves when its own pointer
  changes. If a SOURCE unit is removed, the consumer holds a dangling buffer/edge. TS relies on the source
  processor's termination dropping the edge and the registry entry; confirm the Rust registry/edge
  teardown does likewise, else add a registry-unregister → consumer-invalidate hook. Decide during P3/P4.
- **C2 — enabled/bypass not implemented.** TS subscribes `enabledField`; the Rust engine has no bypass
  yet. Not in scope here; do not add a `subscribe_all` for it. Note for a later plan.
- **C3 — `apply` ordering.** Collections needing an `apply` phase must be driven from the owner's
  reconcile in dependency order (member subs added before first read). Verify no read-before-apply gap.
- **C4 — Address ordering correctness.** RESOLVED: `Address` already derives `Ord` (uuid, then field-keys
  lexicographically), the exact total order prefix queries need. Covered by existing + new dispatch tests.
- **C5 — value-event curve boxes.** A `ValueEventCurveBox` (custom slope) is a SEPARATE box pointing at an
  event's interpolation field. The per-event `Parent` sub on the event box (§5.1) catches every DIRECT
  event edit (position / value / index / interpolation mode) surgically, and the slope is re-read whenever
  the event is upserted, so PLAYBACK of existing curves is always correct. What is NOT instant: editing a
  curve's slope, or attaching / detaching a curve, with no accompanying edit to the owning event — that is
  reflected on the next edit of that event. Closing this fully needs deferred POINTER-HUB subscriptions
  (the current `Deferred` does vertex subs only); deferred until it is shown to matter. This is the one
  accepted, documented divergence; it is not a `subscribe_all`.

## §10 Status log

- P0 (indexed dispatcher) — DONE. Sorted buckets per propagation, sub-linear match, tests added; all green.
- Deferred VERTEX subscriptions — DONE (boxgraph `Deferred` handle + apply after dispatch / via
  `graph.apply_deferred`); test added.
- §5.3 region span edit — DONE (per-region `Parent` sub).
- §5.1 note collection — DONE (per-note `Parent` subs via deferred).
- Deferred POINTER-HUB subscriptions — DONE (graph-level apply with catch-up); C5 thereby CLOSED.
- §5.1 value collection — DONE with FULL curve reactivity (per-event `Parent` + interp pointer-hub +
  per-curve `Parent`); the curve attach/slope test passes. C5 no longer applies.
- §5.2 indexed collection — DONE (per-member `This` index subs via deferred; `index_key` 0 skips).
- §5.6 box lifecycle — DONE (`subscribe_box_lifecycle`, fires only on New/Delete; AudioFileBox converted).
- Binders self-flush their catch-up deferrals via `graph.apply_deferred()` at the end of `observe`.
- §5.5 sidechain — DONE. Each declared port has a TARGETED `This` monitor on its pointer field
  (`build_cluster`), enqueuing the unit; the diff-based resolve pass re-resolves only that unit. The old
  `touches_sidechain` + `sidechain_addrs` removed.
- §5.4 automation — DONE. Per declared parameter (`observe_params`): a field-value sub that pushes a
  static edit straight to the device, an automation pointer-hub on the param field (attach / detach), and a
  region pointer-hub on its track (value-region join / leave) — all firing `automation_invalidate`, which
  sets `automation_dirty` + enqueues the unit so `reconcile_one` re-binds (the proven path, unchanged). The
  unit-level `subscribe_all` observer, `touches_unit_automation`, and `device_uuids` are GONE.
- ZERO `subscribe_all` calls remain in `engine/` and `bindings/` (verified by grep). The only broad
  primitive is `subscribe_box_lifecycle`, which fires solely on box New/Delete (mirrors TS).
- ALL verified green: boxgraph + bindings + engine + transport tests, no warnings, wasm builds clean, and
  the parity/sync suite (263 transactions). The "no subscribe_all" hard requirement is fully met, and every
  per-edit update (param value, automation attach/detach, curve points + slopes, note edits, sidechain
  re-point, region span, chain reorder dispatch) is now targeted and per-unit.

## §11 Remaining: P3 — per-member processor lifecycle

The one part of requirement 2 not yet addressed: `rewire_unit` still tears down and rebuilds a unit's WHOLE
cluster (every device processor + buffer + DSP state) whenever that unit's device-chain membership/order
changes. It is correctly SCOPED to the one affected unit (the per-unit dispatch ensures unrelated units are
untouched) and only fires on a structural CHAIN edit (not on param / note / automation / sidechain edits,
which are all surgical now). The defect is DSP-STATE LOSS: adding a delay to a playing synth resets the
synth's voices, because the surviving processors are recreated rather than kept.

Strategy (mirrors TS `AudioDeviceChain` per-member lifecycle, see §6): the unit keeps persistent device
slots (`uuid -> processor + bindings`) and a persistent channel strip (moved out of `rewire_unit` into
`build_unit`). On a chain change, diff the new sorted member list against the live slots: create a processor
only for a newly-joined device, terminate only a left one, keep survivors (and their DSP state). Then
re-connect EDGES only (instrument -> audio-fx -> strip -> master, and the midi-fx pull chain rebuilt from the
persistent midi processors). Mirror the same per-child lifecycle in `composite.rs`. This is a focused rewrite
of `rewire_unit` + `build_cluster`; it is higher-risk (core wiring) and warrants audio-level test coverage,
which the checksum-only parity suite does not provide — so it should be a dedicated next pass with a
rendering test that proves an effect add/remove keeps the instrument's voices alive.
