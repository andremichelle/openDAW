# Range edits of byte fields

A `ByteArrayField` is synced whole: every change sends the entire value to the engine and, in a Live Room, to every
peer. That is fine for small blobs and wrong for large ones that change in small places. The case that brings it up:
ProTracker keeps the whole module (up to ~1 MB) in its WebCLAP state, and a one byte edit of the position list sends the
full module to every peer (`plans/wclap-state-bytes.md`, `plans/protracker-wclap.md`).

Goal: a field can be changed in a range, and only that range travels, to the engine and through Yjs. Everything that
reads the field keeps seeing a whole value.

## Today

1. **lib-box.** `ByteArrayField` holds an immutable `Int8Array`, `equals` compares references. A change is a
   `PrimitiveUpdate` with the old and the new value, undo swaps them.
2. **Engine.** `SyncSource` turns updates into `UpdateTask`s (`update-primitive` carries the whole value),
   `serialize-update-tasks.ts` writes them, `crates/boxgraph/src/updates.rs` applies them, both sides compare checksums.
3. **Yjs.** `YMapper` stores the value as one `Uint8Array` under the field key of the box's `Y.Map`. Yjs treats it as
   one atomic value, a change replaces and sends all of it.
4. **Project files.** The field is written whole, nothing changes here.

## lib-box

1. `ByteArrayField.setBytes(offset: int, bytes: Int8Array)`: copies the current value, writes `bytes` at `offset`
   (growing the value if it reaches past the end) and sets the copy. `setByte(index, value)` is `setBytes` with one byte.
   `setLength(length)` truncates or zero extends.
2. The update stays a `PrimitiveUpdate` with the whole old and new value, so every subscriber, adapter and undo step
   works unchanged. It gains an optional `range: {offset, length, size}` (the changed bytes and the new total size).
   The inverse of a ranged update carries the same range. A whole `setValue` has no range.
3. Copy on write costs one memcpy of the value per edit, locally. Only the transport gets smaller. In-place mutation
   would break undo (the old value is kept by reference) and is not worth it.

## Engine

1. `SyncSource` turns a ranged `PrimitiveUpdate` into a new task
   `{type: "update-bytes-range", address, offset, bytes, size}` with only the changed bytes.
2. `serialize-update-tasks.ts` and `updates.rs` get the new task. The Rust box graph resizes the field's `Vec<u8>` to
   `size` and writes `bytes` at `offset`. Both sides end with the same bytes, so the checksum needs no change.
3. Devices observing a bytes field still receive the whole value (`FIELD_KIND_BYTES`). A ranged delivery to devices can
   come later if one needs it.
4. WASM contract: the new tag in the update stream is a lockstep change of TS and Rust, marked with
   `// WASM CONTRACT:`.

## Yjs

1. A byte field becomes a nested `Y.Map`: `size` and one entry per chunk, `"0"`, `"1"`, ..., each a `Uint8Array` of
   `CHUNK = 16 KB` (the last one shorter). A ranged update replaces only the chunks it touches and sets `size` when it
   changed. A whole `setValue` writes all chunks.
2. Yjs garbage collects the content of replaced map entries, so the document holds the current chunks and small
   tombstones, not every past value.
3. `YSync` already observes deep. An event in a chunk map maps to the field, the local field is changed with
   `setBytes` for the changed chunks, so the engine gets the small task too.
4. `Y.Array` of chunks is not an option: two peers replacing the same chunk would both insert, the array grows.
5. **Old rooms** hold the field as a plain `Uint8Array`. `fromY` reads both forms, the first write turns the field into
   the chunk map. All clients of a room must run the same version (an open tab from before the update cannot read the
   chunk form). Deploys reload clients, a tab left open across the deploy is the risk.

## Atomicity

Chunks are last writer wins each. Two peers writing different values at the same time can end with a mix: chunk 3
from A, chunk 5 from B. For data where any byte mix is valid (script buffers) that is fine. For opaque blobs (plugin
state) a mix is corrupt. Every peer runs its own engine, and a WebCLAP state is saved by the peer whose plugin changed,
so concurrent writes need two people editing the same plugin at once. Rare, but it must not corrupt.

Options:

1. **Generation tag (recommendation).** Every write stores a `generation` (writer client id + counter) in the field's
   map and with every chunk it writes. All peers converge to the same mix (Yjs resolves each key the same everywhere),
   so all of them see the same torn state: chunks whose generation differs from the field's `generation`. The peer
   that owns the winning `generation` still has its value and rewrites all chunks with it. Readers deliver a torn field
   to nobody (the engine keeps the last whole value) until it is whole again.
2. **Per field mode.** A schema flag `chunked: "merge" | "atomic"`. Atomic fields keep the plain `Uint8Array` form and
   send whole values. Simple, but the plugin state is exactly the field that needs chunks.
3. **Single writer.** Only the peer that made the edit writes the state, the others never save. Holds for page edits,
   not for state changes a plugin makes on its own (a sequencer advancing its pattern) on every peer at once.

## ProTracker

1. The plugin saves the module in the layout it uses in memory: header, room for all 64 (100) patterns, samples. An
   inserted pattern then moves no sample, and a position edit touches the header chunk, a new pattern one more chunk.
   The state grows by the empty pattern room (at most 64 KB uncompressed).
2. The WebCLAP bridge reports a state change as a whole blob. `WclapStates.store` compares it with the field and
   writes only the differing range with `setBytes` (one diff scan per save, cheap next to the transport it saves).
   No bridge or plugin API change: any WebCLAP with a mostly stable state benefits.

## Tests

1. **lib-box:** `setBytes` inside, at the end, growing; `setByte`; `setLength`; undo and redo restore byte exact; the
   update carries the right range; a whole `setValue` carries none.
2. **Engine:** a ranged task keeps the checksum (TS and Rust) for an edit inside, at the end, growing and shrinking; a
   1 MB field with a one byte edit sends a task of a few bytes; the bytes-mirror test from `wclap-state-bytes`
   extended with ranged edits.
3. **Yjs:** two peers, one byte edit of a 1 MB field produces an update of about one chunk; late joiner gets the whole
   value; an old room with the plain form is read and converted on the first write; the Y.Doc does not grow with ten
   edits beyond the current chunks plus tombstones.
4. **Atomicity:** two peers write different values at once, both end with the same whole value of one writer, never a
   mix delivered to the engine; three peers; a peer that drops out before rewriting (the torn field stays held until a
   new whole write).
5. **WebCLAP:** a ProTracker position edit in a Live Room sends one chunk; the plugin on the other peer loads it.
6. **Browser** (by you): ProTracker in a Live Room with two tabs, edits on both.

## Order

1. lib-box API and the range on `PrimitiveUpdate`, tests.
2. Engine task, TS and Rust, checksum tests.
3. Yjs chunk map, old room conversion, tests.
4. Atomicity (option 1), tests.
5. `WclapStates.store` writes ranges, ProTracker saves its stable layout.
6. Browser check.

## Open questions

1. Atomicity: generation tag (1), per field mode (2) or single writer (3)?
2. Chunk size: 16 KB keeps a one byte edit small and a 1 MB value at 64 map entries. Smaller chunks mean more entries,
   larger chunks more bytes per edit.
3. Should `ScriptBufferChunkBox` move onto chunked byte fields later? It solved the same problem with child boxes.

## Result (2026-10-23)

1. **Ranges come from a diff, not a hint.** `BytesSplice.of(old, new)` finds the common prefix and suffix of every
   bytes update, so `setValue`, `setBytes`, undo and redo all travel as ranges without carrying anything. A range is a
   splice (offset, bytes removed, bytes inserted), which also covers inserts and removals in the middle. One linear scan
   per bytes update. `ByteArrayField` gained `setBytes`, `setByte` and `setLength`.
2. **Engine.** `UpdateTasks.of` (lib-box) sends `update-bytes` when the splice is smaller than the value. Rust decodes
   it as `Update::BytesSplice` and resolves it inside `transaction` against the field as the updates before it left
   it, into an ordinary `Primitive`, so observers, devices and the checksum never see a splice. `Error::BadSplice` for
   a splice that does not fit.
3. **Yjs.** Values up to one chunk (16 KB) stay a plain `Uint8Array`, as before, larger ones become a chunk map with a
   meta entry. Writes only touch differing chunks. Atomicity is the generation tag (option 1): each chunk stores its
   writer's generation, the meta entry the generation every chunk must have. A torn field is delivered to nobody, the
   client owning the meta entry's write puts its chunks back. Old rooms with a large plain value are read and chunked
   on the first write.
4. **ProTracker** saves state version 2: the module with room for every pattern. A position or pattern edit changes
   1 to 27 bytes of the state, a step 3, a sample header 30. Version 1 still loads.
5. **Tests.** lib-box `bytes.test.ts` (26: splice cases, 5000 random edits, field methods, undo and redo, tasks, a
   mirror through 300 random transactions), Rust `bytes_splice.rs` (11), core-wasm `bytes-range-mirror.test.ts` (6,
   TS against the Rust engine), core `YBytes.test.ts` (21: stored form, one chunk per edit, late joiner, old rooms,
   chunk keys never read as fields, concurrent edits of different and same chunks, growth against edits, three peers,
   a torn field whose owner is away, 40 random rounds), `WclapParameters.collab.test.ts` (2 more), ProTracker native
   state tests (17).
6. **Open.** A diff costs a scan per bytes update on the main thread (about 1 ms per MB). An insert in the middle of a
   chunked value moves every chunk behind it, so it sends the tail.
