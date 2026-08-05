# Compact Soundfont Format

## Status

Plan only. Drafted 2026-05-07. Paused mid-design; resume from the
"Implementation list" section. The architecture is settled (SAB lives
inside `SoundfontProgramSampleBox.data` as a SAB-backed `Int8Array`
view; cross-thread sync rides structured-clone; editor-driven cascade
with `SoundfontProgramExtractor.extract(...)` as the single entry
point; no auto-observers; no SAB registry; no `fetchSampleData` RPC).
The next concrete action is **Step 1 — Verify SAB transport
assumption**, the SAB-through-`ByteArrayField` integration test. Until
that test passes, no other work in this plan should land.

Open design points that still need a decision before implementation:

- **Selection contract enforcement** (a/b/c) in the
  `SoundfontProgramExtractor` section.
- **Project-open hook** scope: inside or outside the editing stack.
- **SDK-induced main-thread `SoundFont2` retention**: noted as out of
  scope but worth a separate plan if memory pressure reports come in.
- The smaller items in the Open Questions section.

## Goal

Replace the parsed `SoundFont2` everywhere in the runtime with a small,
self-contained format of our own. A `.sf2` file commonly contains 128 melodic
banks plus a percussion bank, hundreds of megabytes of sample data, and
thousands of zones. The user only ever auditions **one preset at a time**
through `SoundfontDeviceBox.presetIndex`, yet today both the main thread
(`DefaultSoundfontLoader`) and the audio worklet (`SoundfontManagerWorklet`)
hold the full parsed structure, with the worklet copy created by a
structured-clone of the entire `SoundFont2` over
`engineToClient.fetchSoundfont`.

The fix is a new internal format that holds only the zones, samples, and
parameters needed to render the currently selected preset. It is the
canonical **runtime** form on both threads: zone and sample boxes synced
through the box graph, plus a single `SharedArrayBuffer` per active
extraction. The device adapter operates on the boxes alone; it never
holds or reads a parsed `SoundFont2`. It can request the device's SAB on
demand, and that is the only piece of state outside the box graph.

The compaction is invisible from outside the studio. SDK consumers
continue to use the existing `SoundfontLoaderManager` /
`SoundfontLoader` API and continue to receive `Option<SoundFont2>` exactly
as they do today. The new extraction step layers on top: a separate
extraction routine (driven on preset change, scope discussed below)
takes the parsed file from the loader, populates the playback boxes, and
writes the SAB into the sample-data store. After that, the device
adapter runs from the boxes + SAB without re-touching the parsed form.

The runtime program data, the per-zone parameters and per-sample headers
**plus the audio bytes**, lives in **first-class boxes** that point at the
owning `SoundfontDeviceBox`. This piggybacks on openDAW's existing
cross-thread box-graph sync: when the main-thread extractor populates the
zone and sample boxes, the worklet sees the same boxes appear in its
mirror automatically.

The audio sample data rides inside the existing `bytes` schema type as an
`Int8Array` view backed by a `SharedArrayBuffer`. Box-graph cross-thread
sync uses structured-clone, which preserves SAB-ness on TypedArray views,
so the SAB is shared across the worklet boundary by reference. All sample
boxes from one extraction share the same underlying SAB because the
extractor allocates exactly one and emits per-sample views into it; when
the box updates ship as one structured-clone batch at end-of-transaction,
the receivers also share the same underlying SAB. There is no
`fetchProgram` or `fetchSampleData` RPC, no separate SAB registry, no
lifetime bookkeeping outside the box graph.

The volume envelope is a user-facing parameter set on the device, not
something the format inherits from the SoundFont. The `SoundfontDeviceBox`
schema gains a single nested `adsr` object at field 20 (schema class
`SoundfontAdsr`) with four inner `Float32Field`s (`attack`, `decay`,
`sustain`, `release`) storing the absolute envelope values: attack /
decay / release in seconds, sustain as a 0..1 level. They apply uniformly
to every voice from this device regardless of zone. Defaults match today's
"no SF2 generator present" fallback (5 ms attack, 5 ms decay, full
sustain, 5 ms release). The four inner fields are individually wired
through `ParameterAdapterSet` for slider rendering; the wrapping object
gives them a single observable lifecycle and matches the nested-object
precedent already used elsewhere (e.g., `Fading` on `AudioRegionBox`,
`key-range` / `vel-range` on the zone box). The SoundFont's per-zone
envelope variance is intentionally discarded; the user dials in ADSR
directly. Other parameter classes (filter, LFO, modulation envelope,
per-zone overrides) are not in this plan.

For the studio's playback path, the original SoundFont is treated as a
transient parser input. The **device editor** is the trigger: when the
user picks a file or preset, the editor opens an editing transaction,
asks the loader for the parsed file, runs the extractor inside the same
transaction (so all the box mutations + SAB allocation happen atomically
with the `presetIndex` update), then drops its own reference to the
parsed `SoundFont2`. A small one-shot hook at project-open does the same
for the persisted state of any `SoundfontDeviceBox` that has a file but
no extracted program subtree.

The cascade is **explicit**, not field-observer-driven, because an
auto-observer fires after the user's transaction commits: it would have
to open a second transaction for the cascade, fragmenting undo/redo. With
editor-driven cascade everything is in one transaction; undo restores
presetIndex and the box subtree atomically, which is the standard
openDAW pattern.

SDK consumers that change `presetIndex` programmatically call the same
exposed `SoundfontProgramExtractor.extract(...)` helper from inside their
own editing transaction. One-line addition; no auto-magic.

Whether the parsed `SoundFont2` survives in main-thread memory between
preset changes depends on whether the SDK or any other consumer is still
holding a strong reference through the public `loader.soundfont` getter.
The studio path itself does not. The worklet path is unconditional: it
never holds a `SoundFont2`, regardless of SDK activity.

## Proposed name

**`SoundfontProgram`**.

Reasoning:

- The format stands on its own. It is what openDAW plays; the parsed
  `SoundFont2` exists only long enough to populate it, then is gone. The name
  should not borrow synth-vocabulary like "Patch" or "Snapshot", which carry
  semantics the format does not have.
- "Program" is the General MIDI term for "the currently selected sound", and
  MIDI Program Change is precisely the message that selects an SF2 preset.
  Picking the same word the protocol uses keeps the mental model honest.
- It does not collide with `soundfont2.Preset` or `soundfont2.Instrument`
  (the third-party source types) or with `SoundfontVoice` (the per-note
  runtime instance). The triangle reads cleanly: parsed `SoundFont2`
  (transient) -> `SoundfontProgram` (canonical) -> `SoundfontVoice` (runtime).
- "CompactPreset" or "CompactSoundfont" describe what it is today but age
  badly: once the non-compact form is gone, the adjective becomes meaningless.

Supporting boxes and types:

- `SoundfontProgramZoneBox` — one playable zone as a box. Holds the merged
  per-zone fields (key range, velocity range, root key, sample modes, pan,
  initial attenuation, tuning), plus an outgoing pointer to its
  `SoundfontProgramSampleBox` and an outgoing pointer back to its owning
  `SoundfontDeviceBox`. **No ADSR fields**: the volume envelope is a
  device-level parameter set, not a per-zone one. Marked `ephemeral: true`
  in the schema so it is rebuilt at extract time and never written to a
  saved project.
- `SoundfontProgramSampleBox` — one sample as a box. Holds a
  `data: bytes` field (an `Int8Array` view backed by a `SharedArrayBuffer`)
  plus header metadata (sample rate, original pitch, loop start, loop end).
  Multiple sample boxes from the same extraction carry views into the
  **same** SAB; the extractor allocates one SAB and slices it. Box itself
  is `ephemeral: true` and never serialised, which matters because the
  binary persistence path would lose the SAB-ness of the view.
- `SoundfontDirectory` — a tiny in-memory structure: `{name, presets:
  [{name, presetIndex, bankIndex}]}`. Built once during the same parse pass
  that produces the boxes, kept by the loader, used by the preset picker.
  Not a box; it carries no inter-thread observability requirement and would
  be wasted overhead as one. The picker is main-thread-only.

## Data flow today

```
file (.sf2 in OPFS)
  -> DefaultSoundfontLoader (main thread)        [SoundFont2, full]
     -> SoundfontDeviceBoxAdapter.#soundfont     [SoundFont2 ref]
     -> engineToClient.fetchSoundfont (clone)
        -> SoundfontManagerWorklet (worklet)     [SoundFont2, full clone]
           -> SoundfontDeviceProcessor#loader    [SoundFont2 ref]
              -> SoundfontVoice (per note)       [presetZone, instZone, sf2]
```

Both copies are wasteful: the worklet clone is the largest single hit, and the
main-thread copy keeps the entire bank tree alive long after the user has
committed to one preset.

## Data flow after this plan

```
user picks new preset in the device editor (main thread)
  -> editor opens editing.modify(...)
     -> ask loader for parsed SoundFont2
     -> SoundfontProgramExtractor.extract runs inside the transaction:
        ├── set SoundfontDeviceBox.presetIndex to the new value
        ├── tear down any existing SoundfontProgramZoneBoxes
        │   and SoundfontProgramSampleBoxes pointing at this device
        ├── allocate one fresh SharedArrayBuffer sized to the selected
        │   preset's total sample bytes
        ├── for each unique sample: create a SoundfontProgramSampleBox
        │   whose data field holds new Int8Array(sab, byteOffset, length);
        │   header fields (sample-rate, original-pitch, loop-start, loop-end)
        │   set from the SF2 sample header
        └── for each zone: create a SoundfontProgramZoneBox pointing at
            its sample box and back at the device box
     -> editor releases its reference to the parsed SoundFont2
  -> editing transaction commits

cross-thread sync (existing box-graph machinery)
  -> all box updates from this transaction are flushed in one
     sendUpdates(...) batch (sync-source.ts:42), one structured-clone
  -> worklet receives the batch; structured-clone preserves SAB-ness,
     so all the per-sample Int8Array views arrive backed by the same SAB
  -> SoundfontDeviceProcessor observes its child boxes change, replaces
     its zone/sample lookup tables; voices currently in flight keep
     playing because they hold their own typed-array view
  -> note-on: walk adapter.zones, match key/velocity, take the matching
     zone's sample.data Int8Array directly (already a SAB-backed view),
     hand it to the new SoundfontVoice (re-cast as Int16Array if needed)
```

After extraction, the parsed `SoundFont2` has no surviving references on
the main thread (modulo SDK consumers holding it through `loader.soundfont`)
and is eligible for GC. The worklet has never held one. The SAB lives
inside the box graph on each thread, hanging off `SoundfontProgramSampleBox.data`.
There is no separate registry, no `fetchSampleData` RPC, no "old SAB
lifetime" bookkeeping: voices in flight hold their typed-array views
directly, which keeps the previous SAB alive transitively until they
finish.

## The format

### New pointer types

Location: `packages/studio/enums/src/Pointers.ts` (or wherever the
`Pointers` enum lives).

Add three pointer types:

- `Pointers.SoundfontProgramZone` — incoming on `SoundfontDeviceBox`,
  outgoing on `SoundfontProgramZoneBox`. Lets the device enumerate its
  current zones and lets a zone find its owning device.
- `Pointers.SoundfontProgramSample` — incoming on `SoundfontDeviceBox`,
  outgoing on `SoundfontProgramSampleBox`. Same pattern for samples.
- `Pointers.SoundfontSampleRef` — incoming on `SoundfontProgramSampleBox`,
  outgoing on `SoundfontProgramZoneBox`. The zone-to-sample reference. A
  sample box can have many zones referencing it (typical SoundFont reuse).

### `SoundfontProgramZoneBox` schema

Location: `packages/studio/forge-boxes/src/schema/devices/instruments/SoundfontProgramZoneBox.ts`
(new), generates `packages/studio/boxes/src/SoundfontProgramZoneBox.ts`.

A small shared class describes a `[lo, hi]` byte pair, reused for the key
range and velocity range so both surfaces have the same shape:

```ts
// in a shared module, e.g. forge-boxes/src/schema/std/Ranges.ts
export const ByteRange = {
    name: "ByteRange",
    fields: {
        1: {type: "int32", name: "lo", value: 0,   constraints: {min: 0, max: 127}, unit: ""},
        2: {type: "int32", name: "hi", value: 127, constraints: {min: 0, max: 127}, unit: ""}
    }
} as const
```

The zone box itself:

```ts
export const SoundfontProgramZoneBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "SoundfontProgramZoneBox",
        fields: {
            1:  {type: "pointer", name: "device",    pointerType: Pointers.SoundfontProgramZone, mandatory: true},
            2:  {type: "pointer", name: "sample",    pointerType: Pointers.SoundfontSampleRef,   mandatory: true},
            10: {type: "object",  name: "key-range", class: ByteRange},
            11: {type: "object",  name: "vel-range", class: ByteRange},
            12: {type: "int32",   name: "root-key",            constraints: {min: 0, max: 127}, unit: ""},
            13: {type: "int32",   name: "sample-modes",        constraints: {min: 0, max: 3},   unit: ""},
            14: {type: "float32", name: "pan",                 value: 0.0, constraints: "bipolar",  unit: "ratio"},
            15: {type: "float32", name: "initial-attenuation", value: 0.0, constraints: "positive", unit: "db"},
            16: {type: "int32",   name: "coarse-tune",  constraints: "any",      unit: "semitones"},
            17: {type: "int32",   name: "fine-tune",    constraints: "any",      unit: "cents"},
            18: {type: "int32",   name: "scale-tuning", value: 100, constraints: "positive", unit: "cents-per-key"}
        }
    },
    pointerRules: {accepts: [], mandatory: false},
    ephemeral: true
}
```

`key-range` and `vel-range` are nested object fields. Their inner `lo` and
`hi` are addressable as e.g. `zoneBox.keyRange.lo` and `zoneBox.keyRange.hi`
in the generated accessor surface, which keeps the matching code in
`SoundfontDeviceProcessor.handleEvent` readable. Reusing the shared
`ByteRange` class shape avoids declaring `KeyRange` and `VelocityRange`
twice for identical content.

The zone box carries no ADSR fields. The volume envelope is a single set of
four absolute parameters on the parent `SoundfontDeviceBox` (fields 20 to 23)
and is applied uniformly to every voice regardless of which zone it
originated in. The SoundFont's per-zone envelope variance is intentionally
not preserved in this format; the user dials in ADSR directly.

`ephemeral: true` means the box is in-memory only. It is created at extract
time, lives until the next preset change (or device removal), and is never
serialized into a saved project. This matches how the program data is
intrinsically derived from `(file, presetIndex)` and never independently
edited.

### `SoundfontProgramSampleBox` schema

Location: `packages/studio/forge-boxes/src/schema/devices/instruments/SoundfontProgramSampleBox.ts`
(new), generates `packages/studio/boxes/src/SoundfontProgramSampleBox.ts`.

```ts
export const SoundfontProgramSampleBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "SoundfontProgramSampleBox",
        fields: {
            1:  {type: "pointer", name: "device",         pointerType: Pointers.SoundfontProgramSample, mandatory: true},
            10: {type: "bytes",   name: "data"},
            11: {type: "int32",   name: "sample-rate",    constraints: "positive", unit: "hz"},
            12: {type: "int32",   name: "original-pitch", constraints: {min: 0, max: 127}, unit: ""},
            13: {type: "int32",   name: "loop-start",     constraints: "positive", unit: "frames"},
            14: {type: "int32",   name: "loop-end",       constraints: "positive", unit: "frames"}
        }
    },
    pointerRules: {accepts: [Pointers.SoundfontSampleRef], mandatory: false},
    ephemeral: true
}
```

`data` is a `bytes` field, generated as a `ByteArrayField` on the runtime
box. The extractor populates it with `new Int8Array(sab, byteOffset,
byteLength)`, where `sab` is the single `SharedArrayBuffer` allocated for
this extraction. The view's intrinsic `byteOffset` and `byteLength`
locate the slice; no separate offset/count fields are needed. The audio
bytes therefore live **inside** the box graph (at field-value level), not
in any separate registry, and ride along with the box update batch as a
SAB-backed Int8Array preserved by structured-clone.

`loop-start` and `loop-end` are sample-frame indices local to this view,
copied from the SF2 sample header. They are persisted as int32 simply
because the SF2 spec guarantees they fit; if a sample ever exceeded
`Int32.MAX_VALUE` frames the schema would need int64, but no real-world
SoundFont sample comes anywhere near that size.

### `SoundfontDeviceBox` schema (modify)

Location: `packages/studio/forge-boxes/src/schema/devices/instruments/SoundfontDeviceBox.ts`
(modify the existing file).

```ts
export const SoundfontDeviceBox: BoxSchema<Pointers> = DeviceFactory.createInstrument(
    "SoundfontDeviceBox", "notes", {
        10: {type: "pointer", name: "file",         pointerType: Pointers.SoundfontFile, mandatory: false},
        11: {type: "int32",   name: "preset-index", constraints: {min: 0, max: 65535}, unit: ""},
        20: {
            type: "object", name: "adsr", class: {
                name: "SoundfontAdsr",
                fields: {
                    1: {type: "float32", name: "attack",  value: 0.005, constraints: "positive", unit: "seconds"},
                    2: {type: "float32", name: "decay",   value: 0.005, constraints: "positive", unit: "seconds"},
                    3: {type: "float32", name: "sustain", value: 1.0,   constraints: "unipolar", unit: "ratio"},
                    4: {type: "float32", name: "release", value: 0.005, constraints: "positive", unit: "seconds"}
                }
            }
        }
    })
```

Two changes:

1. **`adsr` nested object at field 20** with four inner `Float32Field`s.
   They are the absolute volume-envelope values applied to every voice
   from this device, regardless of zone. Defaults match today's "no SF2
   generator present" behaviour: 5 ms attack, 5 ms decay, full sustain,
   5 ms release. The four inner fields live inside the schema-generated
   `SoundfontAdsr` object class, mirroring the way `key-range` and
   `vel-range` group their `lo` / `hi` pairs on the zone box; this groups
   the four parameters under a single observable lifecycle and matches the
   existing nested-object precedent (e.g., `Fading` on `AudioRegionBox`).
   Each inner field is still individually exposed via `ParameterAdapterSet`
   for slider wiring.
2. **Accept incoming pointers**: `DeviceFactory.createInstrument` already
   accepts the standard incoming pointer types. Extend its accept list (or
   the box's `pointerRules`) to include `Pointers.SoundfontProgramZone` and
   `Pointers.SoundfontProgramSample` so zone and sample boxes can point at
   the device. This may require a small change to `DeviceFactory` or a
   per-box override in the schema.

The gap between 11 and 20 is intentional: indices 12 to 19 are reserved
for future preset-related fields (e.g., `bankIndex`, MIDI channel,
transpose). Field IDs 21 onward are open for future device-level parameter
groups (e.g., a `filter` object with cutoff and resonance).

### `SoundfontDirectory`

Location: `packages/studio/adapters/src/soundfont/SoundfontDirectory.ts`.

```ts
export interface SoundfontDirectoryEntry {
    readonly presetIndex: int
    readonly bankIndex: int
    readonly name: string
}

export interface SoundfontDirectory {
    readonly soundfontUuid: UUID.Bytes
    readonly name: string
    readonly entries: ReadonlyArray<SoundfontDirectoryEntry>
}
```

The directory replaces the parsed `SoundFont2` for the preset picker UI. It
is a few KB at most for any soundfont, holds no sample data, and is built
during the same parse pass that produces the boxes. The picker iterates
`directory.entries`; selecting an entry updates
`SoundfontDeviceBox.presetIndex`, which triggers a full re-extract.

### `SoundfontProgramExtractor`

Location: `packages/studio/adapters/src/soundfont/SoundfontProgramExtractor.ts`.

`extract(...)` is **the single sanctioned entry point** for changing a
device's selection. It owns the writes to `box.file` and
`box.presetIndex` together with the zone/sample subtree mutations and
the SAB allocation, all inside one editing transaction. No other code
in the codebase writes those two fields directly. See "Selection
contract" below for the rationale.

```ts
export namespace SoundfontProgramExtractor {
    export const extractDirectory(soundfont: SoundFont2,
                                  soundfontUuid: UUID.Bytes,
                                  name: string): SoundfontDirectory

    // Atomically updates the device's file pointer + presetIndex AND
    // rebuilds its zone/sample subtree inside one editing.modify(...).
    // Awaits the loader's parsed SoundFont2 internally so callers do
    // not have to deal with the load lifecycle.
    export const extract(deviceBox: SoundfontDeviceBox,
                         fileBox: SoundfontFileBox,
                         presetIndex: int,
                         loaderManager: SoundfontLoaderManager,
                         editing: Editing): Promise<void>
}
```

### Selection contract

`SoundfontDeviceBox.file` and `SoundfontDeviceBox.presetIndex` are the
persistent record of "which preset, from which file, this device plays".
They live on the device box for project-save/load (no separate
selection-state box is added). But they are **not** freely settable:
because the runtime zone/sample subtree is derived from them, anyone
who writes those fields without re-running the extractor leaves the box
graph silently inconsistent.

Convention: only `SoundfontProgramExtractor.extract(...)` writes
`box.file` or `box.presetIndex`. All other code paths (device editor,
SDK consumers, project-open hook) call `extract(...)`; the function
performs the field writes and the subtree mutations atomically inside
one `editing.modify(...)`.

Three options for hardening the convention; pick one when implementing:

- **(a) Convention only.** Documented in the schema source and in
  `SoundfontProgramExtractor.ts`. Rely on code review. Cheapest, most
  fragile.
- **(b) `@internal` jsdoc + a lint rule** (or equivalent) that flags
  direct writes to `box.file.targetVertex` / `box.presetIndex.setValue`
  outside the extractor. Mid-cost; survives drive-by edits.
- **(c) Adapter facade.** `SoundfontDeviceBoxAdapter` does not expose
  a way to set those fields; the only mutation method is
  `apply(extractor)`-style. Direct box-field access is theoretically
  possible but no UI code reaches the box without going through the
  adapter. Highest enforcement, biggest refactor.

Default recommendation: (a) for v1 plus a TODO to move to (b) once
there is a precedent for lint rules in the repo.

`extractProgram` runs in three passes:

1. **Discover phase**: walk `soundfont.presets[presetIndex].zones`, for each
   zone walk the inner `presetZone.instrument.zones`, merge the two
   generator chains for the non-ADSR fields (key range, velocity range,
   root key, sample modes, pan, initial attenuation, tuning) with
   instrument overriding preset and SF2 defaults filling the rest, resolve
   `sampleId -> sample`, and collect the unique samples needed together
   with the merged per-zone generator values. AttackVolEnv, DecayVolEnv,
   SustainVolEnv, ReleaseVolEnv generators are read but **not stored**;
   the device-level ADSR fields take precedence and the SoundFont's own
   envelope is discarded.
2. **Allocate + copy phase**: sum the unique samples' `data.length`,
   allocate one `SharedArrayBuffer` of `totalSamples * 2` bytes, copy each
   unique sample's `Int16Array` into it at a known byte offset.
3. **Box graph mutation phase**: open an editing modification, delete
   any existing `SoundfontProgramZoneBox` and `SoundfontProgramSampleBox`
   currently pointing at this device, create one new
   `SoundfontProgramSampleBox` per unique sample whose `data` field is
   `new Int8Array(sab, byteOffset, byteLength)` (the view's intrinsic
   `byteOffset` and `byteLength` locate the slice; no separate fields),
   then one `SoundfontProgramZoneBox` per zone (each pointing at its
   sample box and back at the device box).

The extract is synchronous from the user's point of view (one editing
transaction) so the box graph is never observed in a half-built state.

### How the SAB rides through the box graph

The SAB **is** a field-level value, sitting inside `data` on each
`SoundfontProgramSampleBox` as a SAB-backed `Int8Array`. There is no
separate registry. The mechanism that makes this work:

1. `ByteArrayField` (`packages/lib/box/src/primitive.ts:277`) stores any
   `Readonly<Int8Array>`. It does not constrain whether the underlying
   buffer is a regular `ArrayBuffer` or a `SharedArrayBuffer`.
2. The cross-thread sync path (`SyncSource.sendUpdates` →
   `Communicator.dispatchAndForget` → `Messenger.send` → `postMessage`)
   uses structured-clone semantics. Structured-clone preserves SAB-ness
   on TypedArray views: an Int8Array backed by a SAB arrives backed by
   the same SAB on the receiver side, by reference, without copy.
3. All updates within one editing transaction are batched and shipped
   together (sync-source.ts:42, `sendUpdates(updates)` at end-of-transaction).
   The structured-clone protocol within one call preserves
   shared-buffer identity across multiple TypedArray views in that batch.
   So if the extractor allocates one SAB and emits N per-sample views in
   one transaction, the worklet receives N views still sharing the same
   SAB.

The lookup at note-on is now trivial:

```ts
const view = sampleBox.data.getValue() // Readonly<Int8Array>, SAB-backed
// reinterpret as Int16Array if the playback path wants 16-bit samples:
const samples = new Int16Array(view.buffer, view.byteOffset, view.byteLength / 2)
```

No registry, no UUID lookup, no RPC. The zone's outgoing `sample` pointer
resolves to the right sample box; the box's `data` field is the view.

**Persistence caveat**: the binary persistence path
(primitive.ts:296-300, `output.writeBytes(...)` / `input.readBytes(...)`)
loses SAB-ness because it materialises a plain ArrayBuffer-backed
Int8Array on read. This does not matter here because the program boxes
are `ephemeral: true` and never go through persistence.

**Initial bootstrap caveat**: when a new SyncTarget (e.g., the worklet at
engine start) attaches, sync-source.ts:25-31 sends existing boxes via
`box.toArrayBuffer()`, the binary path. This also loses SAB-ness. Again
irrelevant because the program boxes are ephemeral and only get created
*after* the editor opens the project (i.e., always after sync is
established), via the regular `update` path which uses structured-clone.

**Lifetime**: the SAB lives as long as any sample box references it via
`data`. When the user changes preset, the editor's transaction deletes
the old sample boxes and creates fresh ones with views into a new SAB;
the old SAB is GC-eligible once no in-flight `SoundfontVoice` still
holds a typed-array view into it. Voices in flight at the moment of
preset change keep their original SAB alive transitively through their
own view, which is exactly the lifetime guarantee we need.

### Cross-origin isolation prerequisite

`SharedArrayBuffer` requires a cross-origin-isolated context (COOP +
COEP headers, or equivalent). openDAW already serves the studio under
`assets.opendaw.studio` with the headers needed for `AudioWorklet` and
`SharedArrayBuffer`; this plan assumes that posture continues. Verification:
`crossOriginIsolated === true` in the studio's main-thread global scope.
If a deployment ever relaxes those headers, this plan's SAB transport
breaks, and a fallback (transferring an `ArrayBuffer` clone) would be
required. We do not design that fallback here.

## Touchpoints

### Studio enums (`packages/studio/enums/src`)

- **`Pointers.ts`** (modify): add `SoundfontProgramZone`,
  `SoundfontProgramSample`, `SoundfontSampleRef` enum entries. Append-only
  so existing pointer-type IDs are stable.

### Forge-boxes + Boxes packages

- **`packages/studio/forge-boxes/src/schema/devices/instruments/SoundfontDeviceBox.ts`**
  (modify): add the nested `adsr` object at field 20 (schema class
  `SoundfontAdsr`) with four inner Float32Fields, defaults
  `0.005 / 0.005 / 1.0 / 0.005`. Extend the device's accepted incoming
  pointer types to include `Pointers.SoundfontProgramZone` and
  `Pointers.SoundfontProgramSample`.
- **`packages/studio/forge-boxes/src/schema/devices/instruments/SoundfontProgramZoneBox.ts`**
  (new): schema as defined above. `ephemeral: true`.
- **`packages/studio/forge-boxes/src/schema/devices/instruments/SoundfontProgramSampleBox.ts`**
  (new): schema as defined above. `ephemeral: true`.
- **`packages/studio/boxes/src/SoundfontDeviceBox.ts`,
  `SoundfontProgramZoneBox.ts`, `SoundfontProgramSampleBox.ts`** (regenerated
  by `forge`): no hand edits.

### Adapters package (`packages/studio/adapters/src`)

- **`soundfont/SoundfontDirectory.ts`** (new): the picker-facing directory
  type plus its entry interface.
- **`soundfont/SoundfontProgramExtractor.ts`** (new): the **single
  sanctioned entry point** for changing a device's selection. See "The
  format" → `SoundfontProgramExtractor` and "Selection contract"
  sections above for the full signature and rationale.

  ```ts
  export namespace SoundfontProgramExtractor {
      export const extract(deviceBox: SoundfontDeviceBox,
                           fileBox: SoundfontFileBox,
                           presetIndex: int,
                           loaderManager: SoundfontLoaderManager,
                           editing: Editing): Promise<void>
  }
  ```

  Inside, it: resolves the loader, awaits the parsed `SoundFont2`, opens
  `editing.modify(...)`, sets `box.file` to point at `fileBox`, sets
  `box.presetIndex.setValue(presetIndex)`, tears down the existing
  zone/sample subtree, allocates one fresh `SharedArrayBuffer` sized to
  the selected preset's total sample bytes, creates per-sample
  `SoundfontProgramSampleBox`es with `data` set to a SAB-backed
  Int8Array view, creates per-zone `SoundfontProgramZoneBox`es, and
  drops its local reference to the parsed `SoundFont2`. Everything
  atomic in one editing transaction; undo restores all of it.
- **`soundfont/SoundfontLoader.ts`** (no public-API change): the existing
  surface (`soundfont: Option<SoundFont2>`, `uuid`, `state`, `subscribe`,
  `invalidate`) is preserved for SDK consumers. The loader continues to
  parse the `.sf2` from OPFS on demand and expose the parsed form. The
  extraction step does not live on the loader; it is a separate function
  invoked by the device editor (see below).
- **`soundfont/SoundfontLoaderManager.ts`** (no change): stays as-is.
  `getOrCreate(uuid)` / `remove(uuid)` / `invalidate(uuid)` keep their
  current semantics. SDK consumers continue to work without modification.
- **`devices/instruments/SoundfontProgramZoneBoxAdapter.ts`** (new): wraps
  `SoundfontProgramZoneBox`, exposes typed accessors (key range, vel range,
  pan, tuning, etc.) and a resolved reference to its sample adapter.
- **`devices/instruments/SoundfontProgramSampleBoxAdapter.ts`** (new): wraps
  `SoundfontProgramSampleBox`, exposes the sample-header values and the
  SAB-backed `Int8Array` directly via `data` for the voice constructor.
- **`devices/instruments/SoundfontDeviceBoxAdapter.ts`** (modify): drop
  `#soundfont` and `#preset`. Add:
  - `directory: ObservableOption<SoundfontDirectory>` — for the picker.
  - `zones: ReadonlyArray<SoundfontProgramZoneBoxAdapter>` — derived from
    the device's incoming `SoundfontProgramZone` pointers.
  - `samples: ReadonlyArray<SoundfontProgramSampleBoxAdapter>` — derived
    from incoming `SoundfontProgramSample` pointers.

  The adapter does **not** trigger extraction itself; it only reflects the
  current box-graph state. Triggering is the editor's responsibility (see
  Studio editor below).

  Wire the four inner ADSR fields (`box.adsr.attack`, `box.adsr.decay`,
  `box.adsr.sustain`, `box.adsr.release`) into `ParameterAdapterSet` so
  the device editor renders four sliders alongside the preset picker.
- **`protocols.ts`** (modify): remove `fetchSoundfont(uuid):
  Promise<SoundFont2>`. **No RPC replaces it**; everything the worklet
  needs (zone/sample boxes plus the SAB inside `data`) arrives via the
  existing box-graph sync channel.
- **`BoxAdaptersContext.ts`** (no SAB-store change): the existing
  `soundfontManager` field stays. Its public surface shrinks only in that
  the studio's playback path no longer asks the loader for a parsed
  `SoundFont2`; SDK consumers still do.

### Studio app (`packages/app/studio/src`)

- **Device editor for `SoundfontDeviceBox`** (modify): when the user
  picks a different file or preset (or imports a soundfont), call
  `SoundfontProgramExtractor.extract(deviceBox, fileBox, presetIndex,
  loaderManager, editing)`. The extractor handles the editing
  transaction internally; the editor passes its own `editing` instance
  in. The editor must **not** write `box.file` or `box.presetIndex`
  directly — that is the extractor's job, per the selection contract.
- **Project-open hook** (new, location TBD — typically wherever the
  project applies post-load fixups): walk every `SoundfontDeviceBox`
  in the graph that has a `file` pointer set but no incoming
  `SoundfontProgramZone` pointers. For each, call
  `SoundfontProgramExtractor.extract(...)`. Open question: should this
  bootstrap pass run inside the project's editing stack (so it appears
  on the undo timeline) or outside (treated as initialisation)?
  Recommendation: outside, because the user did not initiate the
  action. Implementation detail TBD.

### Core package (`packages/studio/core/src`)

- **`soundfont/DefaultSoundfontLoader.ts`** (no public-API change): the
  loader continues to expose `soundfont: Option<SoundFont2>` to SDK
  consumers. Parsing `.sf2` from OPFS happens in the same lifecycle as
  today. No structural change.
- **`EngineWorklet.ts`** (modify): the `fetchSoundfont` handler at lines
  197-210 is **deleted**. There is no replacement RPC. The worklet
  receives everything it needs (zone/sample boxes including SAB-backed
  `data`) through the existing box-graph sync channel.
- **`OfflineEngineRenderer.ts`** (modify): same removal on the offline
  path.
- **`project/Project.ts`, `project/ProjectEnv.ts`, `project/ProjectBundle.ts`**:
  audit. The `soundfontManager` field stays.

### Core processors package (`packages/studio/core-processors/src`)

- **`SoundfontManagerWorklet.ts`** (delete): not needed. The worklet
  consumes program data exclusively through the box-graph mirror. There
  is no per-device cache or SAB store; the `data` field on each
  `SoundfontProgramSampleBox` already carries the SAB-backed view.
- **`devices/instruments/SoundfontDeviceProcessor.ts`** (modify): drop
  `#loader: Option<SoundfontLoader>`. Subscribe to the device adapter's
  `zones` and `samples` arrays (via box-graph mirror). The `handleEvent`
  zone-walk iterates `adapter.zones`, matches key/velocity range, and
  pushes a new `SoundfontVoice` per matching zone. The sample view is
  read directly from the matching zone's resolved sample box:
  `zone.sample.targetVertex.box.data.getValue()`.
- **`devices/instruments/Soundfont/SoundfontVoice.ts`** (modify): constructor
  takes `(event, zoneAdapter, sampleView, adsr)` where:
  - `sampleView: Int8Array` (or reinterpreted as `Int16Array`) is the
    SAB-backed view from the sample box's `data` field. The voice does
    not allocate; it just keeps the reference.
  - `adsr: {attack, decay, sustain, release}` is read fresh from the
    device box at note-on time.

  The envelope is seeded directly from the device's ADSR fields:

  ```ts
  this.envelope.set(adsr.attack, adsr.decay, adsr.sustain, adsr.release)
  ```

  The zone box has no ADSR fields. The envelope is identical for every
  voice on this device. Slider changes affect the next note, not voices
  already in flight; envelope shape is fixed at gate-on. Voices in flight
  hold their typed-array view directly, which keeps the underlying SAB
  alive through GC even after a preset change replaces the sample boxes
  with fresh views into a new SAB.

### P2P package (`packages/studio/p2p/src`)

- **`PeerAssetProvider.ts`** (modify): the `fetchSoundfont(uuid, progress)`
  method is for cross-peer asset sharing of the **file**, not for engine
  consumption. It keeps transferring the raw `.sf2` bytes (the receiving
  peer parses locally). No semantic change; only verify no caller assumed
  it returned a parsed structure.

## Migration

This plan touches the on-disk format only on `SoundfontDeviceBox`. The new
`SoundfontProgramZoneBox` and `SoundfontProgramSampleBox` are
`ephemeral: true` and never serialize, so they never appear in saved
projects.

1. **`SoundfontDeviceBox` schema**: one append-only addition at index 20,
   the nested `adsr` object holding `attack`, `decay`, `sustain`,
   `release` Float32Fields. Defaults are `0.005 s / 0.005 s / 1.0 / 0.005 s`,
   matching today's "no SF2 generator present" envelope. Field IDs in the
   12 to 19 range are reserved for future preset-related fields (e.g.,
   `bankIndex`).

   `boxgraph` deserialization tolerates trailing missing fields by
   populating defaults from the schema, so a project saved before this
   change loads with the four ADSR fields at their default values. Playback
   uses these defaults directly; the SoundFont's own per-zone envelope is
   not consulted. Existing projects whose audible character depended on a
   preset's natural envelope will sound different until the user dials in
   the matching ADSR; this is a deliberate trade for the simpler
   single-source ADSR model.

   The schema must also extend its `pointerRules.accepts` to include
   `Pointers.SoundfontProgramZone` and `Pointers.SoundfontProgramSample`.
   Adding accepted pointer types is a non-breaking change: existing pointer
   targets are not renumbered, and old projects (which never had any
   incoming program-box pointers) still load.

2. **`Pointers` enum**: three new values appended. Pointer-type IDs are
   used inside box-graph payloads but are stable across schema changes
   because openDAW writes them by name, not by enum index. Verify this
   when implementing; if not, the appends still slot in safely as long as
   they go at the end of the enum.

3. **`SoundfontFileBox` resource format**: unchanged, still the raw `.sf2`.

4. **Project file format**: only the four trailing fields on
   `SoundfontDeviceBox` are new. No version bump required.

The code-level migration replaces every reference to `adapter.preset`
(`Option<Preset>`) and `adapter.soundfont` (`Option<SoundFont2>`) with
`adapter.zones` / `adapter.samples` (the new arrays of zone and sample
adapters) and, where the picker UI is concerned, `adapter.directory`
(`Option<SoundfontDirectory>`).

When an existing project first loads under the new code, the device adapter
sees `presetIndex` at its persisted value but no zone/sample boxes exist
yet. The adapter's normal "presetIndex changed" reaction fires the
extractor once on first observe, which builds the program boxes and
allocates the SAB. From that point forward the steady state matches a
project created post-migration.

## Memory accounting (rough)

Take a typical 100 MB GeneralUser GS soundfont with one chosen preset
("Acoustic Grand Piano"). The preset occupies maybe ~6 MB of sample data
across ~10 zones; everything else (other 256 presets) is dead weight in the
runtime today.

Estimated steady-state memory, before/after, for this case. The
"main-thread (studio only)" row assumes no SDK consumer is independently
holding a reference to the parsed `SoundFont2`; the "main-thread (with
SDK)" row assumes a consumer is keeping it alive through
`loader.soundfont`.

| Location | Today | After (studio only) | After (with SDK consumer) |
|---|---|---|---|
| Main thread | ~100 MB parsed `SoundFont2` | 6 MB SAB (in sample boxes' `data`) + ~10 KB zones + ~10 KB directory | ~100 MB parsed + 6 MB SAB + ~10 KB zones |
| Worklet | ~100 MB cloned `SoundFont2` | shares the same 6 MB SAB by reference (same Int8Array views, same SAB) | shares the same 6 MB SAB by reference |
| Total in-process bytes | ~200 MB | ~6 MB | ~106 MB |

The wins have two compounding sources:

1. **Discard the unused presets** (~94 MB) on the playback path. Only the
   active preset's samples are extracted into the SAB. (Note: SDK
   consumers asking for `loader.soundfont` still receive the full parsed
   form, by design.)
2. **Share the audio bytes across threads** via `SharedArrayBuffer`. The
   worklet copy goes from "structured-clone of the entire byte payload"
   to "SAB handle, zero copy". This holds unconditionally, regardless of
   SDK activity: the worklet never sees a parsed `SoundFont2` anymore.

The directory carries enough information for the picker UI to function
without holding a parsed `SoundFont2` (whether the SDK is using it or
not).

## Implementation list

Working list, ordered. Tick items as they land.

- [ ] **Step 1 — Verify SAB transport assumption.** Before any schema or
      adapter work, write a small integration test that proves a
      `ByteArrayField` populated with a SAB-backed `Int8Array` survives
      cross-thread sync without copying. The test must:
  1. Spawn a Worker (or use the existing test harness if it has one).
  2. Stand up a `BoxGraph` with `SyncSource` on the main thread and
     `SyncTarget` on the worker, wired through a `Messenger`.
  3. Define a tiny test box with one `bytes` field.
  4. On the main side, allocate a `SharedArrayBuffer`, build an
     `Int8Array` view over it, set the field to that view inside an
     editing transaction.
  5. On the worker side, read the field's value, assert
     `value.buffer instanceof SharedArrayBuffer`.
  6. Mutate one byte through the worker's view and assert the main
     thread's view sees the change (proves shared memory, not copy).
  7. Repeat with two `bytes` fields backed by the same SAB in the same
     transaction; assert that on the worker side both views' `.buffer`
     are reference-equal (proves the same-batch shared-buffer
     preservation we rely on for one-SAB-per-extraction).

  This test is a hard prerequisite for everything else in the plan. If
  any of these assertions fails, the design needs to be reconsidered
  before any schema work begins. Location candidate:
  `packages/lib/box/src/sab-transport.test.ts`.

- [ ] **Step 2 — Schemas.** Add the three new pointer types and the two
      new ephemeral box schemas. Modify `SoundfontDeviceBox` to accept
      the new incoming pointers. Regenerate the boxes package.

- [ ] **Step 3 — Extractor.** Implement
      `SoundfontProgramExtractor.extract(...)` and
      `extractDirectory(...)`. Unit-test extraction shape against a
      small fixture `.sf2` file: zone count matches preset, unique
      sample count matches, SAB byte length equals the sum of unique
      samples' byte lengths.

- [ ] **Step 4 — Adapters.** Add zone and sample box adapters. Update
      `SoundfontDeviceBoxAdapter` to expose `zones`, `samples`,
      `directory`. Adapter does not trigger extraction.

- [ ] **Step 5 — Editor cascade.** Wire the device editor's preset
      picker / file picker to call
      `SoundfontProgramExtractor.extract(deviceBox, fileBox,
      presetIndex, loaderManager, editing)`. The extractor opens its
      own editing transaction internally, sets `box.file` +
      `box.presetIndex`, and rebuilds the zone/sample subtree. Editor
      code must **not** write `box.file` / `box.presetIndex` directly
      (selection contract). Add the project-open hook that calls the
      same `extract(...)` for any `SoundfontDeviceBox` whose file is
      set but whose program subtree is missing.

- [ ] **Step 6 — Engine wiring.** Remove `fetchSoundfont` from the
      engine-to-client protocol. Delete `SoundfontManagerWorklet`.
      Modify `SoundfontDeviceProcessor` and `SoundfontVoice` to consume
      box adapters with SAB-backed `data`.

- [ ] **Step 7 — Migrate studio callers.** Sweep the studio package for
      any code that read `adapter.preset` / `adapter.soundfont`; route
      to `adapter.zones` / `adapter.directory`.

- [ ] **Step 8 — A/B audio render comparison.** Render an existing
      project before and after; tolerance is float-rounding noise from
      precomputed ADSR. Confirm no regressions.

- [ ] **Step 9 — ADSR field (PR 2).** Append the `adsr` nested object to
      `SoundfontDeviceBox` schema, wire its four parameter adapters,
      seed `envelope.set(...)` from them inside `SoundfontVoice`.

- [ ] **Step 10 — Cleanup (PR 3).** Audit dead code and remove leftover
      `soundfont2` imports from `core-processors`.

The earlier "PR 1 / PR 2 / PR 3" framing maps onto the steps above:
Steps 1-8 are PR 1; Step 9 is PR 2; Step 10 is PR 3.

## Implementation order

### PR 1 — Schema, pointers, extractor, editor cascade (single landing)

This is one PR because the steps are tightly coupled: the parsed
`SoundFont2` stops crossing the worklet boundary the moment the box-graph
zone/sample sync (with SAB inside `data`) is in place. Until that ships,
the engine has no way to receive sample data.

1. Add `Pointers.SoundfontProgramZone`, `Pointers.SoundfontProgramSample`,
   `Pointers.SoundfontSampleRef` to the enum.
2. Add `SoundfontProgramZoneBox` and `SoundfontProgramSampleBox` schemas
   to forge-boxes (the sample box uses the existing `bytes` field type
   for `data`). Regenerate the boxes package.
3. Modify `SoundfontDeviceBox` schema to extend `pointerRules.accepts`.
   (No ADSR override fields yet; ADSR comes in PR 2.) Regenerate.
4. Add `SoundfontDirectory.ts` and `SoundfontProgramExtractor.ts` to
   adapters. The extractor is a pure helper called from inside an
   `editing.modify(...)` transaction; it tears down prior zone/sample
   boxes, allocates one SAB, builds per-sample Int8Array views, and
   creates the new boxes.
5. Leave `SoundfontLoader`, `SoundfontLoaderManager`, and
   `DefaultSoundfontLoader` public APIs untouched. SDK consumers
   continue to call `manager.getOrCreate(uuid)` and read
   `loader.soundfont` exactly as today.
6. Add `SoundfontProgramZoneBoxAdapter` and
   `SoundfontProgramSampleBoxAdapter`.
7. Modify `SoundfontDeviceBoxAdapter` to expose `directory`, `zones`,
   `samples` derived from the box graph. The adapter does **not**
   trigger extraction; it only reflects state.
8. Wire the device editor: when the user picks a different file or
   preset, open `editing.modify(...)`, resolve the loader, await
   `loader.soundfont`, call `SoundfontProgramExtractor.extract(...)`,
   drop the local reference. Add a project-open hook that walks
   `SoundfontDeviceBox`es with no incoming program-zone pointers and
   runs the same extraction once.
9. Remove the `fetchSoundfont` handler from `EngineWorklet` and
   `OfflineEngineRenderer`. No replacement RPC.
10. Delete `SoundfontManagerWorklet.ts`.
11. Modify `SoundfontDeviceProcessor` and `SoundfontVoice` to consume
    the box adapters; the sample view is read directly from the sample
    box's `data` field.
12. Update **studio** main-thread callers (preset picker UI, anything in
    the studio that previously read `adapter.preset` or `adapter.soundfont`)
    to read from `adapter.zones` / `adapter.directory`. SDK code outside
    the studio that talks to `SoundfontLoader` directly is unaffected
    and is not touched in this PR.
13. Verify: A/B audio render comparison of an existing project. Acceptable
    differences only from float-rounding noise from precomputed ADSR.

### PR 2 — ADSR fields and sliders

1. Append the nested `adsr` object (field 20, class `SoundfontAdsr`) to
   the `forge-boxes` `SoundfontDeviceBox` schema. Regenerate.
2. Wire the four inner parameter adapters
   (`box.adsr.attack`/`decay`/`sustain`/`release`) into
   `SoundfontDeviceBoxAdapter` so the device editor renders four sliders.
3. Read the four ADSR field values inside the worklet's `SoundfontVoice`
   constructor at note-on; pass them straight to `envelope.set(...)`.
4. Verify: device editor shows four sliders (attack, decay, sustain,
   release). Defaults (5 ms / 5 ms / 1.0 / 5 ms) play with a near-instant
   envelope. Adjusting any slider audibly changes the envelope on the next
   note; voices already in flight retain their original envelope shape.

### PR 3 — Optional cleanups

1. Audit `packages/studio/core-processors/` and remove any remaining
   `soundfont2` package import.
2. Audit dead code: `SoundfontLoaderWorklet`'s old `Option<SoundFont2>`
   surface, any utility that walked SF2 zones at runtime.
3. Consider extracting and persisting `SoundfontDirectory` alongside the
   `.sf2` in OPFS (`soundfont/{uuid}/directory.json`) so that opening the
   picker on a previously-imported soundfont does not require re-parsing
   the file at all. Out of scope for v1 unless the cost is observable.

PR 1 delivers the headline memory win: full `SoundFont2` instances no
longer exist on either thread between preset changes. PR 2 layers
user-visible ADSR controls on top. PR 3 is housekeeping.

## Open questions

- **Re-parse latency on rapid preset scrolling**: each preset change
  re-reads OPFS and re-parses the `.sf2`. For a 100 MB file this is on the
  order of tens of milliseconds. If picker scroll feels sluggish, two
  follow-ups exist: (a) debounce presetIndex updates so a fast scroll
  only fires extracts on settle; (b) persist the directory in OPFS so
  the picker can browse without parsing at all (extract still needed on
  selection). Both are out of scope for PR 1.
- **Project-open hook integration**: should the bootstrap extraction at
  project-open run inside an editing transaction (so it's part of the
  undo stack) or outside (treated as bootstrap, not an undoable user
  action)? Outside is more honest because the user did not initiate the
  action; design preference TBD.
- **Bank selection**: SF2 banks (drum kit lives in bank 128) are not
  currently exposed in `SoundfontDeviceBox`. Adding a `bankIndex` field
  is a separate plan; the directory format already carries `bankIndex`
  per entry in anticipation. Out of scope for this plan. Reserve box
  field 12 for it.
- **Persisting the directory**: caching `SoundfontDirectory` alongside
  the `.sf2` in OPFS would eliminate parsing on every project open.
  Mentioned under PR 3 as a potential follow-up.
- **Discarding per-zone ADSR variance**: this plan replaces the
  SoundFont's per-zone envelope with a single device-level ADSR. For
  most preset banks this is fine (zones in a melodic preset usually
  share an envelope), but some layered presets (drum kits,
  multi-articulation orchestral patches) rely on per-zone envelope
  differences for character. A future plan could reintroduce per-zone
  overrides on `SoundfontProgramZoneBox` without changing the
  device-level fields, restoring the variance for users who want it.

(Resolved by the SAB-in-`data` design and editor-driven cascade,
removed from this list: old-SAB lifetime, note-on vs SAB-arrival race,
worklet store class name, frame-count unit ambiguity.)

## Verification

After PR 1 lands (memory win):

1. `grep -rn 'fetchSoundfont\|fetchSampleData' packages/` returns no
   source matches (only historical text in this plan).
2. `grep -rn 'SoundFont2' packages/studio/core-processors/` returns no
   matches: the worklet has no dependency on the `soundfont2` library at
   all.
3. `grep -rn 'SoundFont2' packages/studio/adapters/` returns matches only
   inside `SoundfontProgramExtractor.ts`.
4. Heap snapshot, with one Soundfont device active and a 100 MB `.sf2`
   file selected: the dominant allocation is the active preset's SAB,
   attributed to a single `SharedArrayBuffer`. The parsed `SoundFont2`
   is not on the heap (it was discarded after the most recent extract).
   The worklet shows no second copy of the sample bytes.
5. On the worklet, for any sample box: `sampleBox.data.getValue().buffer
   instanceof SharedArrayBuffer` holds, and two sample boxes from the
   same extraction satisfy
   `sampleBoxA.data.getValue().buffer === sampleBoxB.data.getValue().buffer`
   (same SAB).
6. The device's incoming `Pointers.SoundfontProgramZone` and
   `Pointers.SoundfontProgramSample` pointer counts match the active
   preset's zone count and unique-sample count.
7. Project files saved before this change load and play identically
   (within float-rounding tolerance). On first load, the project-open
   hook triggers an initial extract per device that populates the
   zone/sample boxes (with SAB-backed `data`).
8. Switching presets in the device editor: one editing transaction
   covers the presetIndex change, the teardown of old zone/sample boxes,
   and the creation of new ones with their SAB-backed `data`. The
   worklet sees the whole batch in one sync tick. Undoing the preset
   change atomically restores the prior state.

After PR 2 lands (ADSR fields):

9. The device editor renders four ADSR sliders, sourced from
   `box.adsr.attack` / `decay` / `sustain` / `release`. Defaults
   (0.005 / 0.005 / 1.0 / 0.005) produce the existing "no SF2 generator
   present" envelope, audibly equivalent to playing a SoundFont preset
   whose volume-envelope generators are absent.
10. Setting `release = 2.0` produces a 2-second release tail on every note
    regardless of zone; setting `sustain = 0.0` collapses sustain to
    silence; etc. The envelope is identical across all voices from one
    device.
11. Loading a project saved before PR 2 sees `box.adsr` populated from
    schema defaults; playback uses those values, not the SoundFont's own
    per-zone envelope.

## What this plan does NOT solve

- The cloud-preset and P2P file transport keeps shipping raw `.sf2` bytes
  between peers. That is correct: peers each maintain their own runtime
  state.
- The `SoundfontLoaderManager` / `SoundfontLoader` public API is preserved
  for SDK consumers, which means SDK code paths that hold a strong
  reference to `loader.soundfont` continue to keep a parsed `SoundFont2`
  alive on the main thread. The plan does not change that. The worklet's
  full-`SoundFont2` copy is what this plan unconditionally eliminates.
  Reducing the SDK-induced main-thread footprint (e.g. by lazy-parsing
  inside the loader, or by streaming a per-preset view through the SDK
  surface) is a separate concern and would need its own design.
- Sliders for filter cutoff, LFO depth, modulation envelope, etc., are not
  in this plan. Only the volume envelope (`adsr`) is exposed. A follow-up
  plan can add more nested parameter objects on `SoundfontDeviceBox` using
  the same pattern as `adsr`.
- Modulation envelopes, vibrato/mod LFO, filter envelopes are extracted
  into the program zone for completeness but the existing voice
  implementation ignores most of them. Wiring them through is a separate
  change.
