# Preset Device Browser

## Motivation

The current DevicesBrowser lists devices as flat lists in three categories (Instruments, Audio Effects, MIDI Effects). There is no built-in preset library. Presets exist only as `.odp` files the user manually saves/loads via the file picker. This plan introduces a preset system integrated into the device browser, two new categories (Audio Units, Effect Chains), collapsible sections, and a cloud/local preset storage backed by OPFS.

---

## Current State

### DevicesBrowser (`packages/app/studio/src/ui/browse/DevicesBrowser.tsx`)
- Three sections: Instruments (green), Audio Effects (blue), MIDI Effects (orange)
- Each device is a `<li>` with icon, name, brief description
- Instruments: click to create, drag to replace
- Effects: click to append to selected audio unit, drag to insert at index
- DragAndDrop via `DragAndDrop.installSource()` with `DragDevice` data

### Preset System (`packages/studio/adapters/src/preset/`)
- `PresetEncoder.encode(audioUnitBox)` serializes an AudioUnit (instrument + effects) to binary `.odp`
- `PresetDecoder.decode(bytes, target)` imports a preset into a project
- `PresetDecoder.replaceAudioUnit(arrayBuffer, targetAudioUnitBox, options)` replaces a device in-place
- Header: magic `0x4F505245` + version 1
- Currently only accessible via right-click context menu on devices

### OPFS Storage (`packages/lib/fusion/src/opfs/`, `packages/studio/core/src/Storage.ts`)
- Worker-based access via `Workers.Opfs` (read/write/delete/list/exists)
- Folder pattern: `{type}/{version}/{uuid}/` with `meta.json` + binary data
- Used for: `projects/v1/`, `samples/v2/`, `soundfont/`
- Abstract `Storage<>` base class with list, delete, trash management

### Cloud API Pattern (`packages/studio/core/src/samples/OpenSampleAPI.ts`)
- API at `https://api.opendaw.studio/{type}/`
- Assets at `https://assets.opendaw.studio/{type}/`
- List endpoint returns metadata array, download by UUID with progress streaming

---

## Plan

### 1. Preset Storage in OPFS

**User presets** use a flat layout with a single authoritative index file:

```
presets/user/
    index.json          (ReadonlyArray<PresetMeta> — all user presets)
    {uuid}.odp          (binary preset data, one file per preset)
```

**Why one index file instead of per-preset folders.** A per-preset `meta.json` layout would force a directory walk on boot — roughly one OPFS `list` + one `open` + one `read` per preset, each crossing the worker boundary. For 100 presets that's ~300 round trips. A single `index.json` is one OPFS read for the same information. Listing user presets should be as cheap as listing stock presets — both are a single fetch of a JSON blob.

**Stock presets** are not mirrored to OPFS. Their metadata ships as a single JSON index (section 2); the binary `.odp` files are served from the CDN and fetched on demand when a user actually applies a preset. Relying on the browser HTTP cache for binary re-use keeps the OPFS tree small and avoids a "download everything" gate.

**PresetMeta schema:**
```typescript
type PresetMeta = {
    uuid: UUID.String
    name: string
    device: string           // device key (e.g. "Vaporisateur", "Delay") — for racks the contained instrument; for single-device presets the device itself
    category: "instrument" | "audio-effect" | "midi-effect" | "audio-unit" | "audio-effect-chain" | "midi-effect-chain"
    author: string
    description: string
    created: number          // epoch ms
}
```

Whether a preset is **stock** or **user** is not a field on `PresetMeta` — it's derived from where it came from (stock index vs. OPFS user folder). The `PresetService` tags each in-memory entry with a `source: "stock" | "user"` when it merges the two lists.

**New class:** `PresetStorage` (user presets only, OPFS-backed):
- `readIndex(): Promise<ReadonlyArray<PresetMeta>>` — reads `presets/user/index.json` (single OPFS read). Returns `[]` if the file is missing (fresh install).
- `save(preset: { uuid, name, instrument, category, data: ArrayBuffer }): Promise<void>` — writes `{uuid}.odp`, then rewrites `index.json` with the new/updated entry appended.
- `load(uuid: UUID.Bytes): Promise<ArrayBuffer>` — reads `{uuid}.odp`.
- `rename(uuid: UUID.Bytes, name: string): Promise<void>` — rewrites `index.json` with the patched name. Binary is untouched.
- `delete(uuid: UUID.Bytes): Promise<void>` — removes `{uuid}.odp`, then rewrites `index.json` without the entry.

**Write ordering.** Always write the binary before rewriting the index. If a crash interrupts the sequence the index is still consistent (the binary exists with no pointer — recoverable later); the opposite ordering would leave the index pointing at a missing file.

**Atomicity.** Use OPFS's write-to-temp-and-rename pattern for `index.json` so the file is never observed in a half-written state: write `index.json.tmp`, then atomically rename over `index.json`. OPFS serializes access through the same worker, so we don't need extra locking beyond an in-memory `await`-chain.

**Recovery.** A `rebuildIndex()` method scans `presets/user/*.odp`, reads each file to recover its UUID and whatever metadata is embedded (AudioUnit preset `name`, chain `kind`, etc.), and writes a fresh `index.json`. This runs **automatically on boot** if `index.json` is missing or unparseable — so a fresh install, a user who manually dropped files into OPFS, or a corrupted index all self-heal without intervention. A happy-path boot never pays the scan cost: `index.json` is present and valid, so `readIndex()` is a single file read. The scan only kicks in when there's something to recover. `rebuildIndex()` is also exposed in a dev/debug menu for explicit re-sync if the user suspects the index has drifted.

There is no per-device list API — the in-memory index (section 3) answers all "what presets does this device have?" queries from a single filtered walk of the in-memory array.

### 2. Server API for Stock Presets

Two endpoints — a single fat index JSON, and a CDN path per binary:

```
GET  https://api.opendaw.studio/presets/index.json
     -> ReadonlyArray<PresetMeta>
     (target ≤ 20kb for ~100 entries; served with long Cache-Control + ETag)

GET  https://assets.opendaw.studio/presets/{uuid}.odp
     -> binary .odp file
     (immutable — UUID is content-addressed; Cache-Control: max-age=31536000, immutable)
```

The index is fetched once per boot; binaries are only hit when the user actually applies a preset, and rely on the browser's HTTP cache for re-use.

**New class:** `OpenPresetAPI` (in `packages/studio/core/src/presets/`):
- `index(): Promise<ReadonlyArray<PresetMeta>>` — fetches `index.json`
- `load(uuid: UUID.Bytes): Promise<ArrayBuffer>` — fetches one binary. No progress callback; at ≤ 20kb typical size, the download is effectively instantaneous.

**Pack format.** The server builds `index.json` from a directory of `{uuid}.odp` + `{uuid}.meta.json` files, or from a single `presets.zip` in the repo. Build tooling lives outside this plan — the studio only consumes the public endpoints.

### 3. Boot-Time Index, Lazy Binary Fetch

The browser loads **all preset metadata up front** — stock and user — in a single pair of parallel calls during boot. Binary `.odp` files are only fetched when the user actually applies a preset. Net result: browsing, searching, expanding, and filtering touch the in-memory index only — zero network or OPFS I/O per interaction.

**Boot phase** (runs from `PresetService.boot()`):

```typescript
const [stockRaw, userList] = await Promise.all([
    OpenPresetAPI.index().catch(() => readStockCache()),   // network, ~20kb
    PresetStorage.user.readIndex()                         // one OPFS file read
])
```

- **Stock index**: `fetch(https://api.opendaw.studio/presets/index.json)`. On success, write the JSON to `localStorage['opendaw:presets:stock-index']` as an offline fallback. On network failure, fall back to the localStorage cache so openDAW still browses previously-known stock presets offline.
- **User index**: one OPFS read of `presets/user/index.json`. If the file is missing or unparseable, `PresetStorage.user.rebuildIndex()` is invoked automatically — it scans `presets/user/*.odp`, extracts UUID + whatever metadata each binary carries, writes a fresh `index.json`, and returns the reconstructed list. On a happy-path boot (index present and valid) the cost is a single cross-thread call regardless of preset count; the scan only runs on first boot or after corruption.

Both lists are merged into a single in-memory table keyed by `uuid`, with each entry tagged `source: "stock" | "user"`. The table is held on `PresetService` and exposed as an observable so the browser UI re-renders when it changes.

**Live updates.** User-preset mutations (save, rename, delete, color) update the in-memory table synchronously, in addition to the OPFS write. The UI observes the table directly — no re-walk after each write.

**Apply phase** (happens on click or drop, not on browse):

```typescript
const bytes = source === "user"
    ? await PresetStorage.user.load(uuid)
    : await OpenPresetAPI.load(uuid)      // browser HTTP cache hits after first fetch
```

**Size budget.** Assuming ~100 presets × ~200 bytes per `PresetMeta` JSON row (name, instrument, category, author, description, 36-char UUID, epoch) the index comes in well under 20kb. If it ever exceeds 20kb, we can compact field names (`n`/`d`/`c`/…) or switch to `index.json.gz` — the endpoint already supports gzip via standard HTTP.

**Why no OPFS mirror of stock binaries.** A preset binary is typically ≤ 20kb. At 100 presets that's 2MB — not burdensome, but the user almost never touches every preset. Fetching on demand with `Cache-Control: immutable` means first-time use hits the CDN once, subsequent uses come from the browser cache, and we never pre-pay a 2MB download cost.

### 4. Effect Chain Preset Format (No AudioUnit Wrapper)

Effect chain presets store **only the effect boxes** (MIDI or audio) plus their dependencies. No AudioUnit, no instrument, no placeholder boxes — the file is a self-contained chain ready to be inserted into any existing AudioUnit.

**Two chain kinds share a single file format, distinguished by a kind marker in the header:**
- `audio-effect-chain` — one or more audio-effect boxes
- `midi-effect-chain` — one or more MIDI-effect boxes

**File layout:**
```
magic (int32)        0x4F504543  "OPEC"   (distinct from 0x4F505245 "OPRE" used for AudioUnit presets)
version (int32)      1
kind (int32)         0 = midi, 1 = audio
payload              BoxGraph.toArrayBuffer()  (effect boxes + non-mandatory dependencies)
```

Using a distinct magic number lets the decoder dispatch without any ambiguity, and lets `.odp` files declare themselves as either an AudioUnit preset or an effect-chain preset. (Alternative: share the magic and add a `PresetKind` byte — rejected because it complicates backward compatibility with the existing v1 AudioUnit format.)

**Encoder — `encodeEffectChain(effects, kind)`:**

Input: an ordered array of effect boxes (`ReadonlyArray<AudioEffectDeviceBox>` or `ReadonlyArray<MidiEffectDeviceBox>`) and a `kind` discriminator.

1. Write the `OPEC` header with the kind marker.
2. Create an empty skeleton `BoxGraph`.
3. Collect non-mandatory dependencies of each effect box (modulation, side-chain targets inside the chain, etc.) using `graph.dependenciesOf(effects, { alwaysFollowMandatory: false, stopAtResources: true, excludeBox })`.
4. Generate a UUID map for effects + dependencies (keep file-box UUIDs stable like `replaceAudioUnit` does).
5. Copy the effect boxes and dependencies into the skeleton graph with their pointers remapped through the UUID map.
6. For each copied effect box in the skeleton:
   - **Clear the `host` pointer** — it has no target in a standalone chain preset.
   - **Renumber `index` to `0, 1, 2, …`** in the supplied order, so the preset is self-normalizing regardless of the indices of the source effects.
7. Serialize the skeleton graph and concatenate with the header.

**Decoder — `insertEffectChain(arrayBuffer, targetAudioUnitBox, insertIndex)`:**

1. Parse the header; reject if magic ≠ `OPEC` or version mismatch. Read `kind`.
2. Load the source graph from the remaining bytes.
3. Enumerate the source effect boxes of the matching kind, sorted by `index` (so the in-file ordering is preserved).
4. On the target, **shift existing effects of that kind** whose `index >= insertIndex` up by `N` (chain length), in a single transaction.
5. Generate a UUID map: every source box gets a fresh UUID, except file-box dependencies (`AudioFileBox`, `SoundfontFileBox`) which keep theirs and are skipped if already present in the target graph (same logic as `replaceAudioUnit`).
6. Copy all source boxes into the target graph through `PointerField.decodeWith` so pointers are rewritten to the new UUIDs.
7. For each newly inserted effect, in the order declared by the source graph:
   - Set its `host` pointer to the target AudioUnit's `midiEffects` or `audioEffects` field (driven by `kind`).
   - Set `index = insertIndex + i`.

**Benefits over the PassthroughDevice approach:**
- No new box type, no new processor, no new adapter — zero schema surface area.
- MIDI effect chains come for free (the Passthrough-as-audio-instrument idea did not accommodate MIDI chains).
- Nothing transient ever lives in the user's project; the inserted effects are the only boxes that get created.
- The file is strictly smaller — no AudioUnitBox, TrackBox, or instrument box in the payload.

### 5. Device Browser Structure

Keep the three existing top-level categories (**Instruments**, **Audio Effects**, **MIDI Effects**) and give each one two children: (a) the list of stock devices, each of which expands to its own preset list, and (b) a trailing section for the category's compound presets (**Racks** under Instruments, **Effect Chains** under Audio Effects and MIDI Effects).

```
▼ Instruments                                     (green)
  ▼ Vaporisateur          Subtractive Synth
      Fat Bass Lead
      Warm Pad
  ▶ Tape                  Sample Player
  ▶ Nano                  FM Synth
  …
  ▼ Racks                                         (audio-unit presets, OPRE)
      My FM Bass Rack
      Clean Piano + Reverb

▼ Audio Effects                                   (blue)
  ▼ Compressor
      Mastering
      Drum Bus
  ▶ Delay
  …
  ▼ Effect Chains                                 (OPEC, kind = audio)
      Vocal Polish
      Dub Delay

▼ MIDI Effects                                    (orange)
  ▼ Arpeggio
      Up-Down 1/16
  …
  ▼ Effect Chains                                 (OPEC, kind = midi)
      Humanize + Chord
```

Device presets and rack/chain presets live under the same category heading, but in visually separated groups so the user can tell a single-device preset from a multi-device rack or chain at a glance.

**Three nesting levels** (all with disclosure triangles):

1. **Category** (`Instruments` / `Audio Effects` / `MIDI Effects`) — collapsible as today.
2. **Stock device row** or the fixed **Racks / Effect Chains** node — collapsible; when closed, shows only the row.
3. **Preset row** — leaf, draggable.

**Content mapping:**
- Racks (under Instruments) hold `OPRE` files — full audio-unit presets (instrument + its MIDI and audio effect chain). Dropped onto an audio unit → `PresetDecoder.replaceAudioUnit`. Dropped on empty space → creates a new audio unit.
- Effect Chains (under Audio Effects) hold `OPEC` files with `kind = audio`. Dropped into `audioEffectsContainer` → `PresetDecoder.insertEffectChain`.
- Effect Chains (under MIDI Effects) hold `OPEC` files with `kind = midi`. Dropped into `midiEffectsContainer` → `PresetDecoder.insertEffectChain`.

The `Racks` / `Effect Chains` nodes are always present even when empty, so the user always knows where to drag a user-saved rack/chain to see it appear.

### 6. Collapsible Sections and Disclosure Triangles

Category headers (`Instruments`, `Audio Effects`, `MIDI Effects`) are **not** collapsible — the full list of stock devices is always visible in each category. The only things that expand/collapse are:

1. **Per-device preset lists.** Each stock-device row has a disclosure triangle; clicking it expands the device's presets inline below the row.
2. **Racks / Effect Chains sections.** Each category's trailing rack/chain node has a disclosure triangle; clicking it expands the list of `OPRE` racks (under Instruments) or `OPEC` chains (under Audio / MIDI Effects).

Both expansion states persist in `localStorage` (`device-browser-open:device:{device-key}` and `device-browser-open:racks:{category}`). Default: all collapsed; stock device rows always shown.

**ASCII wireframe** (brackets show a selection, `▶` = collapsed, `▼` = expanded):

```
┌───────────────────────────────────────────────────────────────┐
│  DEVICES                                                      │
│  [🔍 search…                          ]   [All ▾]             │
├───────────────────────────────────────────────────────────────┤
│  Instruments                                                  │
│    ▶ [♪] Tape                Sample Player                    │
│    ▼ [♪] Vaporisateur        Subtractive Synth                │
│          Fat Bass Lead                                 ☁      │
│          Warm Pad                                      ☁      │
│          Pluck Arp                                     ☁      │
│         ──────────────────────────────────────────────        │
│          My Custom Lead                                ◉      │
│          Warm User Pad                                 ◉      │
│    ▶ [♪] Nano                FM Synth                         │
│    ▶ [♪] Playfield           Sampler                          │
│    ▼ ▸  Racks                                                 │
│          Clean Piano + Reverb                          ☁      │
│          Punch Drum Rack                               ☁      │
│          My FM Bass Rack                               ◉      │
│                                                               │
│  Audio Effects                                                │
│    ▶ [≈] Compressor                                           │
│    ▼ [≈] Delay                                                │
│          Ping-Pong Quarter                             ☁      │
│          Dub Slap                                      ☁      │
│    ▶ [≈] Reverb                                               │
│    ▶ [≈] Stereo Tool                                          │
│    ▼ ▸  Effect Chains                                         │
│          Vocal Polish                                  ☁      │
│          Guitar Bus Glue                               ☁      │
│          My Mastering Chain                            ◉      │
│                                                               │
│  MIDI Effects                                                 │
│    ▶ [♫] Arpeggio                                             │
│    ▶ [♫] Chord                                                │
│    ▶  Effect Chains                                           │
└───────────────────────────────────────────────────────────────┘

Legend:  ▶ collapsed   ▼ expanded   ☁ stock preset   ◉ user preset
         [♪] instrument icon    [≈] audio fx icon    [♫] midi fx icon

Filter bar (top):
  🔍 text search — case-insensitive substring match against preset name
  [All ▾]       — source dropdown: All / Stock / User.
```

**Interaction rules:**

- Each preset row is draggable (`DragPreset` for single-device presets, `DragEffectChain` for `OPEC` chains, `DragPreset` with `category: "audio-unit"` for racks).
- Click a preset to apply it to the selected audio unit (`PresetDecoder.replaceAudioUnit` for `OPRE`; `insertEffectChain` for `OPEC`).
- User presets listed first, then stock presets (no divider).
- Device rows, `Racks`, and `Effect Chains` nodes also act as **drop targets** for saving presets — see section 9 for the drag-to-save behavior.
- Stock device rows are always visible even when their triangle is collapsed — this is the "device picker" function carried over from the current browser.
- Animation: CSS transition on `max-height`, or toggle `.hidden` for simplicity.

### 7. Stock vs User Distinction and Filtering

Every preset has a **source**: `stock` (shipped by openDAW, metadata from the server index) or `user` (metadata from `presets/user/index.json`). This is the only preset-level attribute the browser exposes — no per-preset colors, no tags. Anything fancier is the user's appearance/theme choice, not a property of the preset.

**Visual distinction.** Stock presets render plain; user presets get a subtle theme-driven accent (e.g. a slightly different foreground color or a thin accent underline on the row) so a user can spot their own presets when scrolling. Exact styling lives in `DevicesBrowser.sass` and follows the active theme. The `☁` / `◉` indicator on the right stays as the explicit marker.

**Filter bar.** Row above the category list:

| Control | Behaviour |
|---|---|
| Text search | Case-insensitive substring match against preset name (and optionally device name). Live filter as the user types. Empty = no filter. |
| Source dropdown | `All` (default) / `Stock` / `User`. `Stock` hides user presets; `User` hides stock presets. |

**Filter application rules.**

- The filter only narrows **preset rows**. Stock-device rows stay fully visible regardless — the device picker must always be usable for dropping new empty devices.
- A stock-device row **auto-expands** while a filter is active and it has ≥ 1 matching preset. When the filter is cleared, expansion reverts to the user's stored preference.
- `Racks` / `Effect Chains` sections auto-expand the same way, and hide entirely (node + header) if the filter leaves them empty.
- Filter state is **not** persisted across sessions. On reload the browser starts with no filters, so users don't wonder where their presets went.

### 8. New Drag Data Types

**Individual presets** (from disclosure triangle lists):
```typescript
type DragPreset = {
    type: "preset"
    category: "instrument" | "audio-effect" | "midi-effect" | "audio-unit"
    uuid: UUID.String
    instrument: string
}
```

**Effect chain presets** get their own drag type because they behave like dragging a single effect (insert marker, index-based positioning) but create multiple effects at the drop index:
```typescript
type DragEffectChain = {
    type: "effect-chain"
    kind: "audio" | "midi"
    uuid: UUID.String
}
```

The `kind` field mirrors the `kind` byte stored in the `OPEC` header and tells the drop target which container (`audioEffects` or `midiEffects`) to accept the drag. The browser reads `kind` from the preset's `PresetMeta` when constructing the drag payload; the decoder re-validates it against the file header at drop time.

**Drop handling in `DevicePanelDragAndDrop`:**

- `DragPreset` with `category: "instrument"` or `"audio-unit"`: replace the current instrument via `PresetDecoder.replaceAudioUnit`
- `DragPreset` with `category: "audio-effect"`: insert a single effect at drop index (load preset, decode, insert)
- `DragPreset` with `category: "midi-effect"`: insert a single MIDI effect at drop index
- `DragEffectChain`: uses the **same drag UX as a single effect of the matching kind** — shows an insert marker in `audioEffectsContainer` or `midiEffectsContainer`, computes the drop index via `DragAndDrop.findInsertLocation`. On drop:
  1. Load the `.odp` (`OPEC`) file from OPFS
  2. Call `PresetDecoder.insertEffectChain(bytes, targetAudioUnit, dropIndex)` — the decoder handles the shift-and-insert atomically

The drag feedback (insert marker between existing effects) is identical to dragging a single effect, but the drop creates the full chain in one editing transaction. MIDI chains are only droppable into `midiEffectsContainer`; audio chains only into `audioEffectsContainer`.

### 8. Panel Width

- Expand the minimum width of the browser panel to accommodate the wider preset list
- The `grid-template-columns: auto auto 1fr` in `DevicesBrowser.sass` already allows flexible width
- Add a triangle column: `grid-template-columns: auto auto auto 1fr`
- Consider increasing the panel's base width from the current flexible layout to ~280px minimum

### 9. User Preset Management

**Primary save flow: drag from device panel into a LibraryBrowser folder.** The drop target's category implicitly declares what kind of preset is being saved, so no "choose category" dialog is ever shown.

**Drag sources in the device panel (extension required).** Today the panel only installs a `DragAndDrop` source on single audio-effect devices. We extend this to cover every kind of drag source needed for saving:

| Source | Drag payload `kind` | Produces preset of category |
|---|---|---|
| Instrument box | `instrument` | `instrument` (single-device preset) |
| MIDI effect box | `midi-effect` | `midi-effect` |
| Audio effect box (already present) | `audio-effect` | `audio-effect` |
| Audio-unit header drag handle | `audio-unit` | `audio-unit` (full rack: instrument + midi + audio effects) |

The payload carries the UUID of the source box so the drop handler can resolve it in the project's `BoxGraph` and serialize it via `PresetEncoder.encode` (for `audio-unit`) or a new single-device encoder.

**Drop targets in the LibraryBrowser.**

| Target row | Accepts payload `kind` | Behaviour |
|---|---|---|
| Stock device row (e.g. `Vaporisateur`, `Compressor`) | Matching single-device `kind` only, AND matching `deviceKey` | Saves under that device row. Drag visual confirms compatibility; incompatible drags get no drop affordance. |
| `Racks` node (under Instruments) | `audio-unit` | Saves to the rack list. |
| Audio `Effect Chains` node | `audio-effect` | Saves as a 1-entry effect chain. Multi-effect selection → N-entry chain (deferred, see below). |
| MIDI `Effect Chains` node | `midi-effect` | Same, MIDI side. |

Dropping a single audio-effect on `Effect Chains` (producing a 1-entry chain) is intentional — user can rename the chain later and append more effects once multi-effect selection-drag lands. Folder names can be renamed later so the "Effect Chains" label is not load-bearing.

**On drop:**

1. Resolve the source box(es) from the payload UUID(s).
2. Serialize via `PresetEncoder.encode` (audio-unit) or a new `encodeSingleDevice(box)` helper (single device preset) or `encodeEffectChain` (chain).
3. `PresetStorage.user.save({uuid, name, device, category, data})`. Name defaults to the device's `label` field, or the device's `defaultName` if label is blank.
4. Immediately open a `Surface.requestFloatingTextInput` positioned over the newly-inserted preset row, pre-filled with the default name. `Enter` commits (calls `PresetStorage.rename`); `Escape` keeps the default.
5. The new row is visually highlighted until the rename flyout closes so the user can see which row they just created.

**Secondary / later actions** (right-click context menu on user preset):
- **Rename**: re-opens the floating text input (writes via `PresetStorage.rename`)
- **Delete**: removes the preset (stock presets cannot be deleted)
- **Export**: "Export as .odp" (file picker save)
- **Import** (on any device row or `Racks` / `Effect Chains` node): "Import Preset..." file picker → same save flow as drop.

**Phasing.** Ship in three commits:

1. **PresetStorage** (OPFS layer) + swap the mock user-index for a live `readIndex()`. No drag plumbing yet.
2. **Drag-to-save** — install the missing drag sources (instrument, midi, audio-unit-header), install drop targets on LibraryBrowser rows, wire the `FloatingTextInput` rename on drop. Single effect onto `Effect Chains` → 1-entry chain.
3. **Multi-select drag → N-entry chain** — select multiple effects in the device panel, drag as a group, produce a proper chain preset. Deferred until the device panel gets a multi-select UI.

---

## File Changes

### New Files
- `packages/studio/core/src/presets/PresetStorage.ts` - OPFS storage for presets
- `packages/studio/core/src/presets/PresetMeta.ts` - metadata type + zod schema
- `packages/studio/core/src/presets/OpenPresetAPI.ts` - cloud preset API
- `packages/studio/core/src/presets/PresetService.ts` - combines cloud + user storage, manages download state

### Modified Files
- `packages/studio/adapters/src/preset/PresetHeader.ts` - add `MAGIC_HEADER_EFFECT_CHAIN` (`0x4F504543` "OPEC") and a `ChainKind` enum (`Midi = 0`, `Audio = 1`)
- `packages/studio/adapters/src/preset/PresetEncoder.ts` - add `encodeEffectChain(effects, kind)`: collects dependencies, clears each effect's `host` pointer, renumbers `index` starting at 0, emits `OPEC` payload
- `packages/studio/adapters/src/preset/PresetDecoder.ts` - add `insertEffectChain(arrayBuffer, targetAudioUnit, insertIndex)`: validates `OPEC` header, shifts target effects ≥ insertIndex, copies source effects with UUID remap, re-wires `host` pointers and assigns sequential indices
- `packages/app/studio/src/ui/browse/DevicesBrowser.tsx` - collapsible sections, triangles, preset lists, new categories, download banner
- `packages/app/studio/src/ui/browse/DevicesBrowser.sass` - triangle column, collapse animation, preset rows, banner styling
- `packages/app/studio/src/ui/AnyDragData.ts` - add `DragPreset` and `DragEffectChain` (with `kind`) types
- `packages/app/studio/src/ui/devices/DevicePanelDragAndDrop.ts` - handle `DragPreset` and `DragEffectChain` drops; route audio chains to `audioEffectsContainer` and MIDI chains to `midiEffectsContainer`
- `packages/app/studio/src/ui/devices/DevicePanelDragSources.ts` (or equivalent) - install `DragAndDrop.installSource` on the instrument box, MIDI-effect box, and audio-unit header. Today only audio-effect boxes have a source installed — this is the extension this plan relies on.
- `packages/app/studio/src/ui/devices/menu-items.ts` - user preset rename/delete/export/import (save is drop-driven, not menu-driven in v1)
- `packages/app/studio/src/boot.ts` - create `PresetService` and pass to `StudioService`
- `packages/app/studio/src/service/StudioService.ts` - accept and expose `PresetService`

---

## Implementation Order

1. **PresetHeader extension** - add `OPEC` magic + `ChainKind` enum
2. **PresetEncoder.encodeEffectChain / PresetDecoder.insertEffectChain** - box-only chain serialization, host-pointer rewiring on import
3. **PresetMeta + PresetStorage** - data layer (OPFS read/write/list for presets)
4. **OpenPresetAPI** - server list + download
5. **PresetService** - combines cloud + user, manages download state
6. **Boot integration** - wire PresetService into StudioService
7. **DevicesBrowser UI** - collapsible sections, disclosure triangles, preset lists, download banner
8. **New categories** - Audio Units and Effect Chains (audio + MIDI) sections
9. **DragPreset + DragEffectChain + drop handling** - effect chain drag uses same insert-marker UX as single effect, routes by `kind` to audio or MIDI container
10. **User preset management** - save/rename/delete/export/import via context menus

---

## Open Questions

- Server-side: Does `api.opendaw.studio` need a new `/presets/` endpoint, or can we reuse an existing deployment pattern?
- Should the "Audio Units" category show presets grouped by instrument type, or flat?
- How to handle preset compatibility when device schemas evolve (version mismatch)?
- Should cloud preset metadata include a preview/thumbnail or tags for filtering?

---

## Current Implementation Status

### Shipped

- **`LibraryBrowser`** (`packages/app/studio/src/ui/browse/LibraryBrowser.tsx`) replaces the old flat `DevicesBrowser`.
  - Three category sections (Instruments green / Audio Effects blue / MIDI Effects orange), each containing one entry per stock device plus a compound row (`Racks` for audio-unit, `Stash` for effect-chain).
  - Collapsible rows with rotating triangle hit area; state persists in `expandedKeys` across renders.
  - Filter bar: text search (name + device-key), source toggles (Cloud/User) — exactly one of the two is allowed off at a time. Text search auto-expands matching nodes; source toggles preserve the user's manual expansion state.
  - Components split: `DeviceItem.tsx` / `CompoundItem.tsx` / `PresetItem.tsx`, each with its own adopted stylesheet. Shared layout fragments live in `packages/app/studio/src/mixins.sass` (`library-item-outer`, `library-item-header`, `library-item-states`, `library-preset-list`, `triangle-toggle`, `color-icon-tile`).

- **`PresetStorage`** (`packages/studio/core/src/presets/PresetStorage.ts`)
  - Flat OPFS layout: `presets/user/index.json` + `presets/user/{uuid}.odp`.
  - `save` stamps `modified = Date.now()` on every write; `updateMeta` bumps `modified` on rename/description edit; `rebuildIndex` logs a warning (should never happen in normal use).
  - `cache: DefaultObservableValue<PresetMeta[]>` drives reactive UI updates.

- **`PresetMeta`** (`packages/studio/core/src/presets/PresetMeta.ts`) discriminated union: `instrument` | `audio-effect` | `midi-effect` | `audio-unit` | `audio-effect-chain` | `midi-effect-chain`. Common fields: `uuid`, `name`, `description`, `created`, `modified`. No `author` (removed).

- **`PresetEncoder`** / **`PresetDecoder`**
  - Two binary formats: `OPRE` (full audio unit, via BoxGraph serialization) and `OPEC` (effect chain, raw box bytes + `ChainKind` enum).
  - `PresetEncoder.encode(audioUnitBox, {excludeEffect?})` supports subset encoding — used by rack save when only some effects are selected.
  - `PresetDecoder.decode` re-registers script device processors via `Project.loadScriptDevices()` (idempotent via `#loadedScriptUuids` SortedSet).

- **Drag-and-drop rules** (`AnyDragData.DragDevice`, `DeviceDragging.ts`, `DevicePanelDragAndDrop.ts`, `LibraryActions.ts`)
  - Payloads carry UUIDs snapshotted at dragstart (race-immune against mid-drag `userEditingManager.audioUnit` changes).
  - Selection-driven target routing:
    - 1 instrument → Instrument slot (save as instrument preset).
    - 1 effect → its Device slot (save as single effect preset).
    - N effects (same kind) → Stash compound (save as chain preset).
    - instrument + ≥1 effect → Rack compound (save as rack preset with subset via `excludeEffect`).
  - `handleRackDrop` and rack-replace share the same `showRackCompositionDialog` for the bare-instrument case (Entire Chain / Only Instrument / Cancel).
  - Rack preset replace ignores instrument-type (racks can legitimately swap instrument); the stored `meta.instrument` field is updated to the dragged instrument's key so `rebuildIndex` stays consistent.

- **Ghost count badge** (`GhostCount.tsx` + sass) — dragged-count indicator during multi-device drag.

- **Preset CRUD from UI** — user preset rows have a context menu (Edit… / Delete). Edit reuses the save dialog pre-filled with current name/description. Delete prompts for approval.

- **History consolidation** — `PresetApplication.createNewAudioUnitFromRack` wraps both the decode and the subsequent `userEditingManager.audioUnit.edit` in one `editing.modify(...)` call so activating a rack preset is a single undo step.

- **Old "Save as Rack…" menu item removed** — superseded by the drag-to-Rack flow.

### Not yet wired

- Cloud/stock preset loading (section below).
- Backup / portability (section below).
- `DevicesBrowser` (old component) still exists as a fallback; remove once the Library UI is confirmed stable.

---

## To Think About

### Backup system

Presets must hook into the existing `CloudBackup` flow (Dropbox sync) alongside projects, samples, and soundfonts. Pattern is already set in `packages/studio/core/src/cloud/`:

- `CloudBackup.backupWithHandler` runs `CloudBackupSamples` → `CloudBackupProjects` → `CloudBackupSoundfonts` under a single `lock.json`, with progress split across them.
- Each of those modules owns a remote path (`samples/`, `projects/`, `soundfonts/`), a `RemoteCatalogPath` (`index.json` on the cloud side), and an upload/trash/download cycle that diffs local OPFS vs cloud catalog by UUID.

**To add:** `CloudBackupPresets` in the same directory, mirroring `CloudBackupSamples`:

- `RemotePath = "presets"`, `RemoteCatalogPath = "presets/index.json"`, `pathFor(uuid) = "presets/{uuid}.odp"`.
- Local source is `PresetStorage.readIndex()` + `PresetStorage.load(uuid)`; remote catalog is `PresetMeta[]` just like `presets/user/index.json` on disk.
- Diff by `uuid`; upload missing, download missing, delete trashed. `PresetStorage` currently has no trash (unlike `SampleStorage.loadTrashedIds()`) — either add a trashed-ids list on delete, or accept that deletes are local-only until added.
- Wire into `CloudBackup.backupWithHandler` as a fourth step with its own progress slice (`Progress.split(..., 4)`).
- Conflict rule: use `modified: number` — the newer timestamp wins when the same UUID exists on both sides with different `modified` values.

Open: whether preset backup should be gated behind the same Dropbox auth dialog or piggyback silently on the combined sync action the user already triggers.

### Stock preset delivery (`OpenPresetAPI`?)

Stock presets need a delivery channel. Pattern to mirror from `OpenSampleAPI`:

```
https://api.opendaw.studio/presets/        → index.json (ReadonlyArray<PresetMeta & {source: "stock"}>)
https://assets.opendaw.studio/presets/{uuid}.odp
```

Open items before building this:

- **Authoring workflow.** How do stock presets get produced? Option A: in-app "Export as stock preset" for curated contributors, then manual PR to a preset repo. Option B: openDAW core contributors save presets from a dev project and commit the `.odp` + index entry.
- **Versioning.** Decoder-side rejection is shipped: `PresetDecoder.decode` and `insertEffectChain` both bail out on any `FORMAT_VERSION` mismatch, now with the actual version number surfaced in the error. Policy: bump `PresetHeader.FORMAT_VERSION` for any breaking box-schema change. No on-load migration; old presets are rejected, not silently mis-loaded.
- **Caching.** Stock presets are immutable per-UUID. A simple `Cache-Control: immutable` on assets + `stale-while-revalidate` on the index would avoid hammering the API. Could reuse the sample asset pattern directly.
- **Offline.** If index fetch fails, the browser should still render user presets (current implementation already handles this — `PresetStorage.readIndex` is independent).
- **`LibraryBrowser` integration.** `tagSource(list, "stock")` already exists; wiring is just "fetch index → merge into `allPresets` → render". Source toggle already filters by `entry.source`.
- **Source-gated load paths.** `LibraryActions.activatePreset` and `TimelineDragAndDrop` (`ui/timeline/tracks/audio-unit/TimelineDragAndDrop.ts:86`) both short-circuit on `data.source !== "user"` because `PresetApplication.loadBytes` → `PresetStorage.load` only reads `presets/user/` in OPFS. Once the stock channel exists, extend `loadBytes` to dispatch by source (user → OPFS, stock → cached network fetch) and drop both gates.
