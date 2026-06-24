# Playfield and the composite-device mechanism

The plan for Playfield in the Rust/WASM engine, designed as a general **composite device** mechanism
with Playfield as its first user. The aim is a version that is cleaner and more potent than the TS one,
not a line port. This is the engine design we settled on in discussion, written down before any code.

## Principle

A composite device is a **flattening host, not a nested engine**. It owns no private sub-graph.
Every node it creates (each child's voice plugin, each child's audio-fx chain, the sum node) is
registered in the one global processor graph, keyed by box UUID, exactly like an audio-unit's nodes.

Why flattening, not a sub-graph:

- References cross the boundary freely. A child's compressor can be keyed from another unit, and a
  child can be a sidechain source for the outside, with zero special-casing. A sub-graph would make
  those cross-references painful, flattening makes "inside" and "outside" one namespace.
- It matches how the engine already works. The audio-unit cascade does not own a graph, it contributes
  nodes and edges into the single `context` graph. The composite does the same.

The composite is **generic**. Playfield is one registry entry that pins a voice plugin and a field-key
map. The same machinery hosts any future composite, including the case of several full instruments on
one note-track, each with its own midi- and audio-fx chain.

## The model

A composite hosts a collection of **child clusters**. Each child cluster is the normal engine shape:

```
note source --> [filter] --> [midi-fx pull chain] --> voice plugin --> [audio-fx chain] --> sum --> composite output
```

- The voice plugin is one generic instrument plugin, instantiated once per child as an ordinary
  flattened instrument node.
- Each child is bound by its own box's FieldKeys, the child box is treated like any device box.
- All children sum into the composite output, which then continues into the unit's own audio-fx chain
  and channel strip like any instrument.

For Playfield the child is a sample-player slot, the voice plugin is `device-playfield-slot.wasm`, and the
filter narrows to the slot's note.

## Box mapping

The engine keys off box type. Neither box describes the other.

- `PlayfieldSampleBox` is a device-tagged box (`device-type: instrument`). It maps to the voice plugin
  in the box-type registry, just like any device box maps to its plugin. It carries the per-slot config:
  `file` (11, the sample), `index` (15, its note), the parameter set (40 to 49), its own `audio-effects`
  (13) and `midi-effects` (12) host collections, and a `SideChain` pointer.
- `PlayfieldDeviceBox` only signals "I am a composite host of a `samples` collection" (field 10). It
  holds no information about how to handle a slot.

So the only Playfield-specific engine knowledge is two facts in the registry:

1. `PlayfieldDeviceBox` is a composite host whose children live in field 10.
2. The composite routes notes to children and pins `device-playfield-slot` as the child plugin.

Everything else is the generic composite cascade plus the standard "device box to plugin, bind FieldKeys,
build its fx chain" treatment, rooted at the child box instead of the unit.

## Note routing: broadcast plus a filter link

The composite broadcasts the full note stream to every child. Each child has a **filter pull-link** in
front of its plugin that keeps only the notes it wants. This is the relaxed strategy:

- no filter: a full instrument gets everything (the several-instruments-on-one-track case),
- index filter: a Playfield pad (one note),
- range filter: a key zone.

The filter is a pull-chain link, not baked into the voice plugin, so the instrument stays generic. It is
also the natural place for a midi-fx to narrow ranges. Note that with index routing each note maps to one
child, two children cannot both fire on the same note. The use case is one note-track, many pads, each on
its own note, each with its own fx chain.

## Per-slot parameters and control-field roles

Per-child parameters bind by FieldKeys, uniform with every other device, the child box is the bind root.
The voice plugin declares its DSP parameters at init through the existing bind path.

Field-keys are not fixed across composite types. `mute`, `solo`, and the filter index may sit at
different keys in a different complex plugin. So the **child plugin declares its control-field roles** to
the host at init, role-tagged, the same way it binds parameters and samples. The composite reads those
declarations to know what to observe and act on. Roles:

- `mute`, `solo`: consumed by the composite for the per-child output gain (below).
- `exclude`: consumed by the composite to build each child's choke-trigger set (below).
- `filter-index` (or a range): consumed to build the filter link.

Nothing is hardcoded. The engine composite stays fully generic, the plugin owns its field map, and a
different complex plugin can place these fields anywhere or omit them.

## Per-slot audio-fx and midi-fx

Each child's `audio-effects` (field 13) builds a normal flattened `PluginAudioEffect` chain, rooted at
the child node, reusing the audio-unit chain machinery. Each child's chain is independent and its nodes
are global, so they are sidechain-addressable.

`midi-effects` (field 12) exists on the box but is dormant in the TS engine. In our model midi-fx are
pull-chain links, so lighting it up is just inserting the child's midi-fx links between the filter and the
voice plugin. We can include it from the start since it is nearly free given the pull model, or defer it.
Either way it needs no schema change.

## Mute and Solo

Mute and Solo are a **per-child gain applied at the sum**, a mini channel strip per child, ramped to
declick. The composite watches every child's declared `mute`/`solo` fields and computes audibility per
child: `silent = mute || (anySolo && !thisSolo)`. They are automatable booleans, evaluated continuously,
not only on box edit. A child that is fully silent with no active voices can skip rendering.

This is a **deliberate deviation** from the TS Playfield, accepted as backwards-incompatible. TS gates at
note-on: a muted slot creates no voice and a sounding voice keeps ringing when you mute. We instead mute at
the output, so muting fades a sounding voice. That mirrors Bitwig (a Drum Machine pad's mute/solo behave
like channel mutes) and our own channel strip, and it keeps mute/solo uniform with the rest of the engine
instead of being a special note-onset rule.

## Choke (exclude)

Choke is voice arbitration, it must actually stop sibling voices, so it cannot be a mix gain. It is
**event-tagging in the router, not inter-slot firing**, which keeps it generic and free of ordering
hazards. Choke timing is a function of the note stream, which is fully known before any child renders, so
no child has to run before another and nothing is produced during render.

- The composite fetches the block's note events and checks each note-on against the choke (exclude) table.
- A note-on that matches a sibling in a child's choke group is passed to that child tagged as `CHOKE`
  instead of `PLAY`. The triggering child itself gets a normal `PLAY` (its own retrigger is the separate
  `polyphone` rule).
- Dispatch is by **sub-block split**, the same fragmentation the SDK already does for note-on/off. The
  block is split at the choke offset and the voice plugin's `forceRelease` is called at the boundary, so
  the plugin never tracks event offsets, it only renders contiguous ranges. `forceRelease` applies the
  fast 5 ms release (`FAST_RELEASE`), click-free, and the ramp plays out across the remaining samples and
  usually into the next block.

`forceRelease` is one method with three callers: choke, monophonic retrigger (`polyphone=false`), and
panic / discontinuity. The voice plugin stays generic, it only knows `PLAY` versus `CHOKE`. The only
composite-side state is each child's choke-trigger set, derived from the `exclude` flags and indices,
refreshed off the hot path and re-evaluated per block if `exclude` is automated. Any composite can define
choke groups this way by tagging.

Because choke is solved generically here, Playfield stays a **pure composite of independent child nodes**.
The single multi-output voice device (which would make choke trivial internal state but is Playfield-specific)
was considered and rejected, it is not needed once choke is event-tagging plus `forceRelease`.

## The voice plugin DSP (device-playfield-slot)

A new device crate under `stock-devices`, a sample voice richer than Nano:

- read head with linear interpolation, playback-rate ratio from sample-rate and pitch in cents,
- gate modes Off, On, Loop, and reverse playback when start is past end,
- `sample-start` / `sample-end` window, `attack` / `release` envelope, velocity to gain,
- `polyphone` toggle (monophonic retrigger releases the prior voice),
- per-voice fade on force-stop and on discontinuity.

It resolves its sample through Route F (`host_resolve_sample` / `host_bind_sample`) from field 11, exactly
like Nano. The reusable sample-playback primitives go in the shared `dsp` crate so Nano, Tape, Playfield,
and Soundfont share them.

Parameters are snapshotted at note-on (`gate`, `gain = velocityToGain(velocity)`, `attack`, `release`,
`sampleStart`, `sampleEnd`), so automation of them affects only the next note. Only `pitch` is read live,
once per sub-block. `velocityToGain` is ported exactly from lib-dsp.

### Parity checklist

The DSP is a straight port, the care is in a few places where Rust would silently diverge from the TS
`Number` semantics:

- **Precision: f32 for the ordinary math** (envelope, gain, interpolation, rate ratio), but the **read-head
  position stays f64**. The position accumulates fractional steps across the whole sample, and in f32 the
  sub-sample fraction degrades as it grows, drifting the pitch on long samples. This matches the engine
  rule, control in f32, absolute positions in f64. Envelope counters are fine in f32, bounded by the ~10 s
  max envelope, inside f32's exact-integer range.
- **`sign` must match `Math.sign`**, returning 0 at 0, not `f64::signum` (which returns +1 at 0). The
  zero-distance case (`sampleStart==sampleEnd`) relies on `sign==0` freezing the read head.
- **Envelope behaves identically, implemented plainly.** A simple AR with sustain at 1. No reliance on an
  `Infinity` sentinel, a `released` flag plus computing the release term only once released gives the same
  result in a couple of branches.
- **Write the final sample.** TS ends the voice before writing the sample that crosses the end, we write it
  then end. A deliberate one-sample-better deviation.
- **Transcendentals are epsilon, not bit-exact, vs TS.** `2^(pitch/1200)` goes through libm, which can
  differ from V8's `Math.pow` by a few ULP, a sub-sample pitch drift over time, inaudible. Our libm path
  guarantees wasm matches the Rust host exactly, unpitched playback stays bit-exact, pitched playback is
  epsilon-equal to TS.

## Voice pool and polyphony

No allocation on the audio thread, so voices live in a fixed pre-allocated pool in the plugin's zeroed
state, like Nano's `[NanoVoice; MAX_VOICES]`. Each slot is its own voice-plugin instance, so the pool is
per-slot and needs no cross-slot arbitration. **`MAX_VOICES = 16` per slot**, decided. When the pool is
full a note-on steals the oldest voice through `forceRelease` (the 5 ms ramp, click-free). The fixed cap
is the one accepted **deviation** from the TS engine, whose per-slot polyphony is unbounded, it is never
reached in normal drum use and the steal keeps it graceful.

Memory is per actual slot, not per MIDI note. Only the slots wired into the composite (the
`PlayfieldSampleBox` children) get an instance. A voice's state is the playback and envelope scalars only
(the sample frames stay in shared memory, read by offset), about 64 bytes, so a slot's pool is about 1 KB
plus a small header, roughly 1.25 KB per slot. A 16-pad kit is about 20 KB, the theoretical full 128 slots
about 160 KB, negligible next to the sample buffers.

## Edge cases (decided)

- **Gate.Loop with zero-length window** (`sampleStart==sampleEnd`, so `distance==0`): the TS `while position
  >= end` would spin forever. Guard it by **ending the voice**. Off and On modes self-terminate at a
  zero-length window already, only Loop needs the guard.
- **Two slots sharing the same `index`**: the **first slot in collection order wins**, deterministically.
- **Sample not resident at note-on**: **drop the note**, no voice, matching TS's empty-data early return.
  Fine with async Route F loading, the pad simply does not sound until its sample is resident.
- **Per-slot `enabled` (22) and `midi-effects` (12)**: stay **dormant** for now (the TS processor reads
  neither), kept in mind as later additions, no schema change needed to light them up.

## Sidechain and addressability

Flattening gives this for free. Every child node and every per-child fx node is a global, UUID-addressable
node with a registered output buffer. So a child's effect can be keyed from outside, and the child output
can feed an external sidechain. Per Q1, Playfield is used as a sidechain **source**, which is just its
addressable output, nothing extra to build.

## ABI and engine additions (summary)

- Composite host recognition: a registry entry marking a box type as a composite, with its children field,
  pinned child plugin, and routing strategy.
- Instantiate a device node rooted at a **collection-member box** (the child box), generalizing today's
  "device from the unit's device-host field" to "device from any device-tagged box."
- A **filter pull-link** (index or range) inserted ahead of a child's voice plugin.
- **Control-field role declaration**: a host import for the plugin to register role-tagged FieldKeys
  (`mute`, `solo`, `exclude`, `filter-index`) at init, alongside `host_bind_parameter` / `host_bind_sample`.
- A **`forceRelease`** entry on the voice plugin (fast 5 ms kill), one method behind choke, monophonic
  retrigger, and panic / discontinuity.
- A **`CHOKE` event kind** tagged by the router, dispatched by the same sub-block split as note-on / off.
- A **sum node** for the composite output, with per-child ramped gain for mute/solo.
- A multi-level cascade: watch the children collection (add / remove / reorder), and per child watch its
  fx collections, control fields, and parameters.

## What we reuse

The flattened global graph, the `PluginInstrument` / `PluginAudioEffect` nodes, the audio-fx chain wiring
(lifted out of `rewire_unit` into a reusable cluster builder), the event pull chain, Route F sample
delivery, FieldKey parameter binding, and the DSP primitives.

The real refactor is lifting the chain-cluster build out of `rewire_unit` into a routine parameterized by
`{ note source + optional filter, voice/source device, midi-fx collection, audio-fx collection, output
target }`. The audio-unit becomes one consumer of it, a composite child becomes another.

## Build order

1. Lift the chain-cluster builder out of `rewire_unit`, audio-unit still green through it.
2. The `device-playfield-slot` device: sample voice DSP per the parity checklist (f64 position, f32 ordinary
   math, snapshot-at-note-on, `Math.sign`-matching sign, plain AR envelope, write the final sample, gate
   modes with the Loop zero-distance guard, reverse), a fixed 16-voice pool with steal-oldest, and the
   `forceRelease` entry (choke / mono / panic), resolved through Route F. Native-tested. Prove it as a
   single normal instrument first.
3. Composite host and cascade: recognize `PlayfieldDeviceBox`, instantiate one voice child per slot rooted
   at the slot box, bind FieldKeys, sum into the composite output. Start with broadcast and no filter.
4. Filter pull-link, route each slot by its `index` (first slot wins on a duplicate index).
5. Per-slot audio-fx chains from field 13.
6. Mute / Solo as a ramped per-child gain at the sum.
7. Choke: tag note-ons as `PLAY` / `CHOKE` from the exclude table in the router, dispatched by sub-block
   split into `forceRelease`.
8. Control-field role declaration so mute / solo / exclude / filter-index are plugin-declared, not hardcoded.
9. A Playfield page proving several pads on one note-track, each with its own fx chain, with mute, solo,
   and choke live.
10. Optional: light up per-slot midi-fx (field 12) as pull-chain links.

## Open questions and deferrals

- Whether to ship per-slot midi-fx (field 12) in the first cut or defer it (currently the optional last
  step). The pull model makes it cheap.
- Whether a general composite box (several arbitrary instruments on one note-track) is worth wiring now,
  or left as an enabled capability until a box type for it exists. Playfield is the only composite box
  today.
- The exact declick ramp length for the mute/solo gain, to reuse the channel-strip ramp.

## Out of scope (this milestone)

- The Tape device and the timeline audio-region query (deferred, to be done better later).
- Soundfont, which builds on the same sample resource.
- Time-stretch and audio-region fades.
