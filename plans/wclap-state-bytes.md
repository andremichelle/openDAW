# WebCLAP plugin state as bytes

The CLAP state blob of a WebCLAP device lives in field 12 `state` of `WclapDeviceBox` and `WclapInstrumentBox`, a
string holding base64. That costs a third more than the blob, a decode on every apply in the bridge, and a full
string rewrite on every save. ProTracker will put whole modules (up to ~1 MB) into its state
(`plans/protracker-wclap.md`, phase 3), so the state moves into a `bytes` field.

## Today

1. **Write.** `WclapStates.store` (studio-core) compares the base64 string and writes it with
   `editing.modify(..., false)`, no undo mark.
2. **Engine.** `wclap-common` observes field 12 with `abi::observe_field`, gets `FieldValue::String`, passes the text
   to `abi::wclap_state`. The bridge (`wclap-bridge.ts#state`) decodes UTF-8 then base64, dedupes against
   `knownState`.
3. **Field kinds.** The engine delivers int, float, bool, string, int array (`FIELD_KIND_*` in `crates/abi`,
   `deliver_field_value` in `crates/engine/src/audio_unit/params.rs`). The Rust box graph already holds
   `FieldValue::Bytes`, but a bytes field is never delivered to a device.
4. **Live Rooms.** `YMapper` maps a `ByteArrayField` to a Yjs `Uint8Array` and back, deprecated fields are skipped.

## Schema

1. Both boxes get field 14 `{type: "bytes", name: "plugin-state"}`. Key 14 is free in both.
2. Field 12 stays a string with the same key and name and becomes `deprecated: true`. Never reuse key 12 with another
   type. The accessor `box.state` stays, so SDK code that reads it still compiles, it reads "" after migration.
3. New code writes only field 14.

## Migration

1. `MigrateWclapState` in `project/migration`, run by `ProjectMigration` for every `WclapDeviceBox` and
   `WclapInstrumentBox`: if field 12 is not empty and field 14 is empty, decode the base64 into field 14, then
   clear field 12. A string that is no valid base64 stays in field 12 and is logged, never dropped silently.
2. The same function runs where boxes enter a project without `ProjectMigration`: preset load (`PresetDecoder`),
   `.odb` bundle import, paste, Live Room join of a room created by an older client.
3. Fallback while reading: the bridge keeps the base64 path for one release, so a box that somehow still carries
   field 12 keeps its state.

## Engine and bridge

1. `abi`: `FIELD_KIND_BYTES = 5`, `FieldValue::Bytes(&[u8])`. Old device wasms never observe a bytes field, so they
   never see the new kind (their `from_wire` would panic on it).
2. `deliver_field_value`: `FieldValue::Bytes` → `FIELD_KIND_BYTES`, pointer and length, valid for the call like a
   string.
3. `wclap-common`: observe field 14, `FieldValue::Bytes` → `abi::wclap_state_bytes(bridge, bytes)`, a new
   `host_wclap_state_bytes(handle, ptr, len)` import. The string import stays for the fallback.
4. Bridge: `#stateBytes` copies the bytes, same `knownState` dedupe, no decoding.
5. `WclapStates.store`: compares bytes (`bytesEqual`), writes `Int8Array` into field 14.
6. Rebuild `device-wclap` and `device-wclap-instrument` dist wasm, `npm run build:bundles` for core-wasm.

## Tests

1. **Migration** (unit): base64 in field 12 lands byte exact in field 14, field 12 empty afterwards. Empty field 12
   is a no-op. Invalid base64 stays. Running twice changes nothing.
2. **Round trip** (core-wasm `wclap-bridge.test.ts`): Basics reverb state saved, written to field 14, reloaded
   through the new import, plugin answers with the same blob. The existing state test keeps passing on the string
   path.
3. **Engine** (Rust): `deliver_field_value` of a bytes field reaches a test device as `FieldValue::Bytes` with the
   exact bytes, an empty field as an empty slice.
4. **Project files**: an old project with field 12 opens with its state (Pro54 program, Basics room size), saves,
   reopens from the new format. `.odb` export and import, cloud backup restore, template, preset save and load.
5. **Live Rooms** (`WclapParameters.collab.test.ts` and `YSyncCollab.test.ts` style, two peers):
   1. A state save on peer A arrives byte exact on peer B and the plugin on B loads it.
   2. A room created from an old project (field 12) migrates once, not once per peer, and no peer writes field 12
      again.
   3. Both peers save different states at once: last writer wins, both end up equal (Reconcile).
   4. A 1 MB state: size of the Yjs update, no growth of the Y.Doc beyond the current value after several saves
      (Yjs garbage collection), and the time from save to apply on the other peer.
   5. Joining a room late receives the current state.
6. **Undo**: a state save still makes no undo step, undoing a parameter change around it leaves the state alone.
7. **Browser** (by you): Pro54 and Basics with a saved state in an old project, then in a Live Room with two tabs.

## Order

1. Schema, migration, migration tests.
2. Engine kind, abi, `wclap-common`, bridge, round trip and engine tests.
3. `WclapStates.store` on field 14, project file tests.
4. Live Room tests.
5. Browser check, then ProTracker phase 3 builds on it.

## Open questions

1. How long does the base64 fallback in the bridge stay? One release, then remove with field 12 still deprecated.
2. Should states above a threshold (say 256 KB) skip the save-after-every-GUI-message debounce and save only on window
   close and project save, to keep Live Room traffic down?

## Result (2026-10-23)

1. **Field 12 is not deprecated.** A deprecated field is skipped by `fromJSON` and by Yjs, so a Live Room created
   before the update would lose its state on join. Field 12 stays a plain string, the device reads it only while
   field 14 is empty, and every save writes field 14 and clears field 12 in one step. The base64 path in the bridge
   stays for good, so boxes that enter without `ProjectMigration` (preset, `.odb`, paste) keep their state anyway.
2. **Migration.** `MigrateWclapState` runs in `ProjectMigration` (project load and Live Room join). Invalid base64
   stays in field 12 with a warning.
3. **Engine.** `FIELD_KIND_BYTES = 5`, `abi::FieldValue::Bytes`, `host_wclap_state_bytes`. `wclap-common` observes
   field 14 before field 12.
4. **Undo.** A save still makes no step of its own. An undo right after it restores the previous bytes and the
   legacy string, as before.
5. **Tests.**
   1. `MigrateWclapState.test.ts`: byte exact, 1 MB, empty, invalid, existing bytes, twice, instrument.
   2. `WclapParameters.collab.test.ts`: byte exact on the other peer, concurrent saves converge, late joiner, no
      write for an unchanged state, an old room migrates once, a 1 MB state is one update (applied in 0.2 ms) and the
      room stays under 2 MB after five more saves.
   3. `WclapParameters.history.test.ts`: undo and redo of a save.
   4. `wclap-bridge.test.ts`: raw bytes before and after the plugin is up.
   5. `wclap-state-bytes-mirror.test.ts`: the Rust engine mirror stays in sync through a legacy string, small, 1 MB
      and empty states.
   6. Engine: a bytes field reaches the device as `FIELD_KIND_BYTES` with its length, an empty one with length 0.
6. **Open.** Browser check (Pro54 and Basics in an old project, then a Live Room with two tabs).
