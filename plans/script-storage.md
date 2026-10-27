# Script Storage: a local library per script

Status: DRAFT 2026-10-21, nothing implemented. Issue [#487](https://github.com/andremichelle/openDAW/issues/487).

Goal: a scriptable device (Werkstatt, Apparat, Spielwerk) stores data outside the project, such as patterns,
drawn waveforms or snapshots, and loads it again in any project that runs the same script. The data lives in
OPFS, belongs to the script alone and can be saved to and loaded from a file.

Builds on [script-views.md](script-views.md): the API lives in the view, the processor only ever sees data that
arrived through `@collection` or `@buffer`.

## 1. Decisions (2026-10-21)

1. Loading an entry into the device is undoable.
2. No quota per script. The only limit is the browser's OPFS quota.
3. The whole library of a script can be saved to a file and loaded from a file.
4. The storage is bound to the script. No other script and no studio browser can see it. This needs a secure id
   and garbage collection (sections 3 and 6).

## 2. Opt-in

```
// @storage
```

1. Only a script that declares `@storage` gets `host.storage`. Every existing script stays bit-identical.
2. `@storage` without a `class View` is a compile error (`@storage needs a View, the processor cannot read it`).
3. The line takes no arguments. The namespace is never named by the script (section 3).

## 3. Identity: who owns a library

The script never sees or chooses its namespace. The host assigns it and keeps it with the device.

### 3.1 Fields

All three device boxes get two new fields (new keys, never reused):

| Field | Type | Meaning |
|---|---|---|
| `storage-id` | string | random UUID of the library, `""` = none yet |
| `storage-seal` | string | HMAC proving this machine granted the id to this code |

`ScriptMeta` (the script library in `scripts/v1`) gets an optional `storage?: UUID.String`.

### 3.2 Assigning the id

1. First compile with `@storage` and an empty `storage-id`: the host creates a random UUID.
2. A device created from a library script takes the id from `ScriptMeta.storage`. If the library entry has none
   yet, the host creates one and writes it into the meta, so every device made from that entry shares one library.
3. Saving a device's script to the library copies its id into the meta. "Save as new script" creates a fresh id.
4. Copy and paste of a device, within or across projects, keeps the id (it is the same script).
5. Stock scripts never ship an id. A shipped, well known id would be shared by every user of the app and by every
   project anyone sends around.

### 3.3 The seal

The id travels inside project files, presets, templates and Live rooms. Anyone the user shares a project with
learns it. Without a seal, a crafted project could carry the same id with different code and read, overwrite or
delete the library.

1. On first use, a random 256-bit local secret is created and stored in OPFS (`script-data/v1/secret`). It never
   leaves the machine and is never part of a project or export.
2. `seal = HMAC-SHA256(secret, storage-id + "\n" + SHA-256(code))`, hex. Both go through `crypto.subtle`.
3. Every local compile writes `code`, `storage-id` and `storage-seal` in the same transaction. The seal is computed
   before the transaction opens, because `crypto.subtle` is async. Undo restores old code with its old seal,
   which is still valid.
4. When the view starts, the host verifies the seal. A missing or wrong seal means the device is locked: every
   `host.storage` call rejects with `StorageLocked`, and nothing is read or written.
5. Locked happens for a project made on another machine or browser, a Live room peer's compile, or a tampered
   file. The device menu then offers "Allow Library Access", which reseals with the local secret (one transaction,
   undoable). The user decides, the project never does.
6. Editing the code of one's own device is a local compile and reseals. Pasting foreign code into one's own
   device is the user's own act.

## 4. View API

```ts
interface ViewHost {
    // ... existing members
    readonly storage: ViewStorage                            // only with // @storage
}
interface ViewStorage {
    list(): Promise<ReadonlyArray<string>>                   // keys, sorted
    readText(key: string): Promise<string>                   // strict UTF-8, rejects if missing
    writeText(key: string, text: string): Promise<void>
    readBytes(key: string): Promise<Uint8Array>              // rejects if missing
    writeBytes(key: string, bytes: ArrayBuffer | ArrayBufferView): Promise<void>
    delete(key: string): Promise<void>
    subscribe(observer: () => void): Terminable              // after any change, from any device sharing the library
}
```

1. Request and response over the existing view `MessagePort`, each request carries an id. Bytes travel as
   transferables, no copy on the way out of the view.
2. Keys: 1 to 128 characters of `[A-Za-z0-9 _.-]`, not `.` or `..`, not `__proto__`, no leading or trailing
   space. Validated in the runtime (early error) and again in the host (the runtime is untrusted).
3. Text and bytes share one key space. A text entry is UTF-8 bytes on disk, `readBytes` on it works.
4. Rejections are `Error`s with a short name: `StorageLocked`, `StorageMissing`, `StorageKey`, `StorageFailed`.
5. Undo (decision 1): reading is not a project change, writing the loaded data into a collection or buffer is.
   The view does `host.edit(() => ...)` after the read resolves, one undo step. The examples show exactly this.
   Library writes and deletes are NOT undoable, they are file operations like saving a preset.
6. Two devices on the same library see each other's writes through `subscribe` (a host side broadcast per id).
7. Offline render, export and the engine are untouched: the processor only reads `this.data`.

## 5. OPFS layout and host side

```
script-data/v1/secret
script-data/v1/<storage-id>/meta.json        {name, created, modified}   name = last script name seen
script-data/v1/<storage-id>/entries/<key>
```

1. `ScriptDataStorage` in `studio-core/src/scripts/`, next to `ScriptStorage`, over `Workers.Opfs`. Same
   `Pick<OpfsProtocol, ...>` injection, so it is testable with `FakeFiles`.
2. `ScriptViewFrame` resolves the device's id, verifies the seal once per view start and answers storage requests.
   It holds no state beyond the verified id.
3. The library folder is created on the first write, not on the first compile. A script that never writes leaves
   no trace.

## 6. Garbage collection

Automatic deletion is unsafe: a library may be used by projects that only exist outside OPFS (exported files,
`.odb` bundles, the cloud, another browser). The storage page disclaimer already says so. So collection means
the user sees what is unused and removes it.

1. `StorageScan.referencesOf` also collects every `storage-id` from device boxes in local projects, templates
   and presets. Library metas with `storage` count as users too.
2. The storage page gets a "Script data" section: one row per library with the script name, size, entry count,
   its users or an "unused" badge, and delete. Deleting goes through `StorageDeletion`.
3. Deleting a library script asks whether to delete its stored data too, listing the local projects that still
   use it (from the same scan). Default: keep.
4. A device whose library folder does not exist simply starts empty. Nothing breaks when data was collected.

## 7. Save and load as file

1. Device menu: "Save Library..." and "Load Library..." (only with `@storage`, only when not locked).
2. Format: a zip (`jszip` is already a studio dependency), extension `.odlib` (`.odb`, `.odp`, `.odsl` are taken):
   - `library.json`: `{version: 1, name, created, entries: [{key, size}]}`
   - `entries/<key>`: the raw bytes
3. The file carries no id and no seal. Loading writes the entries into the device's own library.
4. Loading into a library with existing keys asks: replace all, merge (file wins on equal keys) or cancel.
5. Keys and sizes in `library.json` are validated against the zip content before anything is written.
6. Views get `subscribe` notifications after a load, so an open pattern browser refreshes.

## 8. Phases

1. `ScriptDataStorage` + key validation + `FakeFiles` tests (list, read, write, delete, missing, bad keys,
   `__proto__`, path traversal).
2. Schema fields + `@storage` declaration + id assignment on compile, library meta, copy and paste. Tests: copy
   keeps id, save as new script gets a fresh id, stock scripts have none, existing scripts unchanged.
3. Secret + seal + verify, "Allow Library Access". Tests: foreign seal locks, tampered code locks, undo of a code
   change stays sealed, reseal is one undo step.
4. View runtime `host.storage` + port protocol + `subscribe` across devices. Monaco types. Example: a Spielwerk
   pattern sequencer with a pattern browser (save, load, delete).
5. Save and load as file.
6. Storage page section + library delete dialog.
7. Docs: manual page, AI starter prompts, scripting API docs.

## 9. Open questions

1. File extension `.odlib` for saved libraries (section 7, item 2).
