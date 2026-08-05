# Midi Composite (second attempt)

A parallel midi-fx stack (`MidiCompositeBox`): several midi-effect chains process the incoming note stream in
parallel, outputs merged, sent on. The note-side mirror of the FX Composite. The first attempt is documented in
`plans/obsolete/midi-composite.md` (why tee/replay cannot work); this plan builds on those constraints. The
box-schema / UI / registration design from `plans/effect-stack.md` Part 2/4 still applies and is resurrected,
not redesigned.

## Decisions (2026-08-01)

1. The composite is placeable ANYWHERE in the midi chain, not only at its head.
2. Chance rolls are DETERMINISTIC PER NOTE (hash, not a sequential random stream): the same note resolves the
   same way in every branch and on every re-read.
3. An EMPTY composite (zero branches) passes notes through unchanged (identity, like the empty FX Composite).
4. The merge re-ids like the Arpeggio: each branch note-on gets a fresh id from the merge's own counter,
   remembered as (branch, branch-local id) -> fresh id; the branch's note-off emits with the mapped id and
   drops the entry. Works at any nesting depth. Voices associate by note id, so on/off must match exactly.

## Foundation: the stateless note source

`NoteSequencer` today is destructively stateful (`retainer.drain_linear_completed` removes held notes as it
reads) — it can be pulled exactly once per block. Branches pull individually and Zeitgeist warps a branch's
window, so the source must become re-readable. Split it:

- `NoteTimeline` — a PURE window query, no mutation on read: content regions, clip sections (through the
  ClipSequencer replay cache), live/raw notes as an interval log (a key press appends an open interval, the
  release closes it; GC behind the transport), audition notes as fixed intervals. Any consumer reads any
  window any number of times and sees the same events.
- Deterministic note IDENTITIES, derived from the source (region uuid, event index, loop-cycle index, ratchet
  step; live notes from their log entry) — internal to the timeline only. Wire ids stay per-consumer
  ascending u32 (see dry-run finding 2).
- Deterministic chance: the roll is a hash of the note identity (+ cycle index), replacing the sequencer's
  `Mulberry32` stream. A note dropped by chance is dropped for every consumer.
- `NoteFeed` — the small PER-CONSUMER state that remains: which notes this consumer has started (today's
  retainer, moved to the sink side), emitting offs at span end and releasing everything it started on a
  transport stop / discontinuity.

Migration: the unit's existing single pull path becomes NoteTimeline + one NoteFeed; behaviour must be
unchanged (all existing engine-env / cargo / wasm note tests stay green before the composite lands on top).

## The composite in the engine

- Branch = its own complete pull chain: NoteFeed over the shared NoteTimeline, then (mid-chain placement) its
  own REPLICAS of every upstream midi effect, then the branch's own fx chain. "One state for every midi
  effect per branch": a stateful upstream effect (Arp, Zeitgeist) cannot be shared across branches, so each
  branch owns an instance (own wasm state block, own subscriptions). The stateless timeline guarantees all
  replicas read identical input; replica ids never leave the branch (the merge re-ids).
- Merge: pulls every branch per window. Ordering mirrors `compare_lifecycle` (at an equal position, note-off /
  choke BEFORE note-on — the retrigger lesson). Muted / not-soloed branches are still pulled (state keeps
  time), their events discarded. Id mapping per decision 4.
- Empty composite: identity pass-through (decision 3). A branch with an empty fx chain is an identity branch.
- `note_bits` discipline: internal branch pulls clear, only the outer merge arm marks (first-attempt fix).
- Parameter automation must reach replicas: an automated upstream param binds per instance; a rebind
  terminates every replica's ValueCollections.
- Registration reuses the kept `EFFECT_COMPOSITES` / `EffectCompositeSpec` seam (midi kind = a registration,
  not an engine change).
- Tests need `crate::pull_lock()` around the global `PULL` context (kept from the first attempt).

## Forward-compatibility: the instrument composite

The future instrument composite (one note stream feeding N branches of midi-fx -> instrument -> audio-fx ->
strip -> audio sum) rides on the same groundwork, verified:
- Note side: identical problem, solved by NoteTimeline + one NoteFeed per branch. This SUBSUMES today's
  per-slot sequencers sharing the ClipSequencer replay cache (Playfield / composite cells) — the cache exists
  precisely because several sequencers pull the same track.
- Upstream replication (phase 4) is the same requirement there (a unit-level arp feeding all branches).
- Deterministic chance keeps a chance-note consistent across branches.
- The audio side (per-branch instrument, fx chain, strip, sum) already exists (Playfield / CompositeSpec +
  FX-composite entries).
- The merge id-map is MC-ONLY: instrument-composite branches never merge notes back (notes die in their
  branch's instrument, branches merge as audio).

Constraint this adds: NoteTimeline / NoteFeed are GENERIC engine-env primitives any binding instantiates,
never welded into MidiCompositeBinding.

## No resurrection possible

The first attempt was added AND removed inside the squashed commit `3ca49ce09` — no commit in history
contains the midi-composite schemas, adapters, editor or engine binding. Everything is a fresh build, with
the AUDIO composite code as the template and effect-stack.md Part 2/4 as the spec (codegen gotchas listed
there: build enums before the forge, rebuild boxes, regenerate all-boxes.od). `Pointers` is auto-numbered and
never stored, so appending `MidiCompositeCell` is safe.

## Dry-run findings (2026-08-01, read against the real code)

1. The ClipSequencer is a SECOND destructive source. `NoteSequencer.process_notes` calls `clips.iterate`,
   which ADVANCES the launch state machine, guarded only by a replay cache keyed to the EXACT `(from, to)` —
   a warped feed's shifted window misses the cache and corrupts the machine. The NoteTimeline must advance
   the clip machine exactly ONCE per engine block (engine-driven) and retain a SECTION LOG that any window
   query reads non-destructively, with bounded history for unwarp lookback (formalize the bound; a groove
   cell today, cap and document it).
2. Deterministic ids DO NOT go on the wire. `EventRecord.id` is u32 (`id as u32` truncation) and
   `compare_lifecycle` totals on "ids ascend in emission order" — hashed identities would collide and break
   both. Resolution: deterministic identities (region, event index, loop-cycle, ratchet index) live INSIDE
   the timeline only; each NoteFeed maps identity -> its own ASCENDING u32 id. Cross-feed id equality is not
   needed (the merge re-ids; chance consistency comes from the roll, not ids).
3. Chance: the roll order is an explicit parity contract in `process_collection` ("advances the stream for
   EVERY iterated note"). The hash roll replaces it: hash(note identity + loop-cycle index), so a pass
   re-rolls (today's musical character) but every feed and every re-read of the SAME pass agrees. Update the
   contract comment + tests; existing chance projects will resolve differently (accepted).
4. Ratchets: identity must include the ratchet step index, and the timeline query must reproduce the
   back-extension by `max_duration` (a ratchet started before the window emits sub-notes inside it).
5. Raw/live notes + auditions: today pushed into EVERY slot sequencer (`note_signal_to_unit` fanout). They
   become ONE canonical interval log on the unit's timeline (position assigned at push from the engine
   clock, which advances while paused); feeds read it. `push_raw_note_off`'s "gate the FIRST started note of
   that pitch" matching must be replicated at the log.
6. NoteFeed must tolerate NON-MONOTONIC windows: automating a groove amount can make a warped branch's next
   window overlap or regress vs its previous pull. Define regression handling (treat as discontinuity:
   release feed-started notes, reseat).
7. Upstream replicas: `PluginMidiEffect::new` already allocates per-instance state, so N replicas of one box
   are mechanically fine, BUT device-level registrations collide: broadcast/live-data registration skips
   duplicate alive addresses, so only ONE replica's note-bits / editor indicators are live — decide the
   primary (first branch) explicitly. Automation rebinds must reach every replica; every replica's
   ValueCollections terminate on teardown (leak tests).
8. PullContext is a global with a strict borrow-scope discipline during descent (re-enters on
   `process_events`); the merge/branch arms must scope exactly like the MidiFx arm, and every test through
   the global `PULL` takes `crate::pull_lock()`.
9. Update-clock composition: branch-internal fx fragment their own `process_events` at their update grids;
   verify in phase 3 that the outer consumer's `host_next_update_position` does not need the union of branch
   grids.
10. Other consumers of the one-shot pull chain (MidiOut node, freeze/export renders, SlotRoute/choke) must
    stay green through phase 1; porting slots/cells to NoteFeed is a follow-up unification, not required.

## Execution detail

### Phase 1a — timeline extraction (behaviour-preserving)

Files: `crates/engine-env/src/note_timeline.rs` (new), `note_feed.rs` (new), `note_sequencer.rs` (becomes a
thin composition), `clip_sequencer.rs` (advance/read split).

- `NoteIdentity` (engine-env): `{source: enum {Content {region: Uuid, event_index: u32, cycle: i64,
  ratchet: u16}, Clip {clip: Uuid, event_index: u32, cycle: i64, ratchet: u16}, Raw {log_index: u64},
  Audition {log_index: u64}}}`. Hash/Eq derive; never crosses the ABI.
- `NoteTimeline`: owns the content access (today's `Box<dyn NoteContentSource>`), the raw-note log, the
  audition log, and the truncate pref cell. One method:
  `query(&self, from, to, &mut FnMut(NoteIdentity, NoteStartData))` — a PURE re-readable window read that
  reproduces `process_collection` exactly (incl. the `max_duration` back-extension and ratchet expansion,
  which yield identity + start data; the CALLER decides on/off emission). Chance: a note is skipped when
  `hash(CHANCE_SEED, identity_without_ratchet, cycle) as roll > note.chance` — one roll per note per pass,
  identical for every consumer (use math::random::Mulberry32 seeded from the hash for the roll, so the
  distribution code stays).
- `ClipSequencer` split: `advance(track, p0, p1, info)` — the ONLY mutating call, driven once per engine
  block; `sections(track, from, to) -> impl Iterator<Section>` — reads a per-track SECTION LOG (ring buffer,
  retention `SECTION_LOG_BARS = 2` bars behind the last advanced position, documented cap for warp lookback).
  Replace `cached_range`/`cached_sections` with the log. Drive site: the engine currently advances implicitly
  via the FIRST `iterate` per block; make it explicit where the unit bindings are walked in `render()`
  (crates/engine/src/lib.rs:2130 path) BEFORE any node processes — each note/audio track binding already
  carries the `ClipInfo` access it passes to `iterate` today. `schedule_play`/`schedule_stop`/`reset`/
  `forget` unchanged (they invalidate the log tail instead of the cache).
- `NoteFeed`: `{started: hashmap NoteIdentity -> (id: u32, complete: f64), next_id: u32, last_to: f64}`.
  `process(from, to, flags, sink)`: on discontinuity flag OR `from < last_to - EPS` (window regression),
  release everything started; else release started notes whose `complete <= to` (clamped positions, the
  retainer semantics); then `timeline.query(from, to)` emits `NoteStart` with a FRESH ascending id per new
  identity. Raw notes: open log intervals emit on at their log position, off when the log entry closes.
  No-std: use the crate's existing map type (`SortedSet`-style vec map is fine at these sizes).
- `NoteSequencer` keeps its public shape (`NoteEventSource` + `push_raw_note_on/off` + `audition_note` +
  truncate binding) but is internally `{timeline: Rc<NoteTimeline>, feed: NoteFeed}` — all four construction
  sites (wiring.rs:443/744/1002, composite.rs:777) stay untouched. Raw pushes append to the timeline's log
  (position = the engine's current block start, which advances while paused; keep the "gate the FIRST
  started note of that pitch" close rule). `note_signal_to_unit` (params.rs:228) then pushes ONE log per
  unit — slot sequencers sharing the unit timeline see it automatically.
- Gate: every existing test green with NO test edits except the chance-parity ones (the roll-order contract
  in `process_collection`'s comment is retired; update `crates/engine-env` note tests that assert exact
  chance sequences). Explicitly re-run: engine-env note tests, cargo engine, app/wasm (MidiOut, freeze,
  exports, SlotRoute, zeitgeist-groove, arp-rate, clip playback).

### Phase 1b — multi-consumer proof

New engine-env tests: two feeds over one timeline pulling (a) identical windows -> identical events modulo
ids; (b) one feed warped (shifted windows) -> same notes at shifted read times, clip sections served from the
log; (c) window regression -> feed releases and reseats; (d) chance-heavy content -> identical keep/drop sets
across feeds; (e) raw notes visible to both feeds, offs matched per feed.

### Phase 2 — schemas, adapters, UI (fresh build)

Per effect-stack.md Part 2 field tables: `MidiCompositeBox` (createMidiEffect, field 10 `entries`),
`MidiCompositeCellBox` (composite pointer 1, `midi-effects` 2, index 3, label 4, minimized 5, mute 41,
solo 42), `Pointers.MidiCompositeCell` APPENDED. Build order: enums build -> forge -> boxes build ->
`generate-all-boxes`. Adapters mirror `AudioEffectCompositeBoxAdapter` / `AudioEffectCompositeCellBoxAdapter`
(cell = one-sided DeviceHost: `midiEffects` Some, `audioEffects` None, `hostsInstrument` false). Effect
factory in `EffectFactories.MidiNamed`; editor `MidiCompositeDeviceEditor.tsx` next to the audio one (entry
list, mute/solo, enter; no dry/wet, no gain). PresetEncoder/Decoder subtree tests mirror the composite preset
tests. Rebuild `packages/studio/adapters` dist afterwards (the app resolves adapters from dist).

### Phase 3 — engine, head-of-chain

- Register via the kept seam: `EFFECT_COMPOSITES` entry in `packages/studio/adapters/src/engine-modules.ts`
  (kind "note", gain/dry/wet keys 0) + the worklet registration loop passes it (already generic).
- `PullLink` gains `Merge {branches: Vec<Rc<PullLink>>, gates: Vec<Rc<Cell<bool>>>, map: Rc<RefCell<...>>,
  next_id: Rc<Cell<u32>>}`. The fold in `build_cluster` (wiring.rs midi fold) and `wire_cluster`: on a
  midi-composite member, each cell's chain folds over its OWN `PullLink::Source` (a fresh
  `NoteSequencer`-shaped feed over the unit timeline), then the composite contributes the Merge link;
  zero entries -> contribute NOTHING (identity: the fold continues on the upstream link).
- Merge pull: for each branch (in cell-index order) scope-swap `PULL.current` to the branch link, pull into
  scratch, re-id via the map ((branch, id) -> fresh id; off consumes the entry), drop events of gated
  branches (mute / not-soloed — pull FIRST, drop after, state keeps time), clear note_bits during branch
  pulls, sort merged output with `compare_lifecycle`, outer consumer marks bits once.
- Cell mute/solo: observed boolean cells resolved across siblings (SlotRoute `gate` pattern; silent =
  mute || (any sibling solo && !solo)).
- Cargo tests in `crates/engine/src/` test modules with `pull_lock()`: merge determinism (off-before-on at
  equal positions), zeitgeist-in-one-branch (other branch unshifted), muted-branch continuity (arp keeps
  phase while muted), nesting (composite in a cell), empty composite identity, entry add/remove/reorder
  edge-only.

### Phase 4 — mid-chain placement (upstream replicas)

- The fold currently threads ONE link chain. For a composite at member index k with upstream members
  0..k: each branch builds its own replicas of members 0..k (fresh `PluginMidiEffect` per member per branch
  — own state, own `init`, own param bindings) over its own feed. Pool key becomes (box uuid, branch index)
  so reconciles keep replica identity; the plain chain (no composite) keeps today's uuid-only pooling.
- Primary-replica rule: branch 0's replica registers the device-address broadcasts (note_bits, live data);
  later replicas skip (the registry already skips duplicate alive addresses — make the order deterministic
  by building branch 0 first).
- Automation: `for_each_params`-style traversal must visit every replica (each has its own ParamHandles);
  rebind terminates every replica's ValueCollections (extend the existing leak tests).
- Upstream chain edits (add/remove/reorder/enable) mark the unit; reconcile rebuilds replicas edge-only
  (joiner replicated into every branch, leaver's replicas torn down everywhere).
- Verify finding 9 here: outer `host_next_update_position` vs branch-internal fragmentation.

### Phase 5 — wasm end-to-end

`packages/app/wasm/test/midi-composite.test.ts`: audible parity (one branch == no composite), two branches
== union, mute/solo, zeitgeist branch, arp-before-composite (replica correctness), note indicator lights
with a composite in the chain (the first attempt's unreproducible-in-native bug — MUST be a wasm test).
Build: `npm run build-wasm`, then copy `packages/studio/core-wasm/dist/wasm/engine.wasm` to
`packages/app/wasm/public/wasm/` for the tests (the test harness loads the app/wasm copy); hard-reload the
studio to drop the cached engine.

## Phases (each gated on green tests)

1. Foundation, in two gates: 1a behaviour-preserving extraction (NoteTimeline + section log + raw-note log +
   NoteFeed behind the unchanged NoteSequencer shape; all existing tests green), then 1b multi-consumer
   proof (two feeds, warped windows, regression, chance consistency, raw notes).
2. Schemas + adapters + UI, built fresh on the audio-composite template (no engine wiring yet).
3. Engine, head-of-chain: branches = feed + own fx chain, merge with id map, mute/solo, empty = identity.
   Cargo tests: merge determinism, Zeitgeist-in-branch, muted-branch phase continuity, nesting.
4. Mid-chain placement: per-branch upstream replication, automation into replicas, reconcile (upstream chain
   edit rebuilds replicas edge-only). Tests: arp-before-composite parity, replica automation, leak checks.
5. Wasm end-to-end (the note-indicator regression from the first attempt needs the real engine) + manual pass.
