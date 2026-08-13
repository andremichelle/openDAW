# Sample Browser Folders

> **Status:** Plan. Not started.

## TL;DR

Cloud samples get a nested folder tree delivered as a single static file, `assets.opendaw.studio/samples/index.json`, that carries the folder structure **and** the sample metadata inline. The studio fetches that one file instead of `list.php`, flattens it for everything that wants a linear list, and renders the tree in the sample browser.

All curation moves into a separate app in a private repo. That app is the full sample administration tool: upload, edit metadata, remove, move between folders, and one button that updates the index the studio reads. The studio itself gets no folder editing.

Scope of v1: openDAW cloud samples only. Local samples keep their flat list.

Rough cost: index format plus studio read path is small, roughly 300 to 400 LOC across 6 files. The editor plus its three new endpoints is the bulk of the work, roughly 4 to 5 days.

Decided so far: order inside a folder is the authored array order, a sample has exactly one parent folder, the editor owns metadata as well as structure.

## Goal

Concrete user stories:

The sample browser shows `Drums > Snares > 808` as collapsible rows, the way `CompoundItem` already renders preset groups in `PresetBrowser`.

Typing in the search field collapses the tree back to a flat, alphabetically sorted result list across all folders, exactly like today.

Everything that consumes the sample catalogue programmatically (`FactoryCatalog`, `SampleSelection`, scripting) still sees one linear array of `Sample`.

A curator opens a private editor app, drags samples into folders, hits Publish, and every studio user sees the new structure on next load.

---

## Part 1: The index file

### Location

`https://assets.opendaw.studio/samples/index.json`

Same host as the wav files (`OpenSampleAPI.FileRoot`), so it is a plain static file, no PHP, no database round trip, cacheable by the CDN.

### Format

Nested nodes. Each node carries `name` plus optional `folders` and optional `samples`, so a folder can hold both subfolders and samples, and nesting is unlimited.

```json
{
  "version": 1,
  "updatedAt": "2026-08-12T10:14:00Z",
  "folders": [
    {
      "name": "Drums",
      "folders": [
        {
          "name": "Kicks",
          "samples": [
            {"uuid": "6b1f0f3a-2c44-4c8e-9a1b-0f0e6d1a5c31", "name": "Kick Deep 01", "bpm": 0, "duration": 0.84, "sample_rate": 44100},
            {"uuid": "d2c4a6e8-1b33-4f57-8c02-77ab9e4d1f10", "name": "Kick Punch 02", "bpm": 0, "duration": 0.51, "sample_rate": 44100}
          ]
        },
        {
          "name": "Snares",
          "folders": [
            {
              "name": "808",
              "samples": [
                {"uuid": "41e0b9c7-6d2a-4f19-9d55-a3c8b2170e6f", "name": "808 Snare Tight", "bpm": 0, "duration": 0.33, "sample_rate": 44100}
              ]
            }
          ],
          "samples": [
            {"uuid": "c5d81f04-3a76-4e2b-91cc-6b0d8e2f4a19", "name": "Snare Room", "bpm": 0, "duration": 0.62, "sample_rate": 44100}
          ]
        }
      ]
    },
    {
      "name": "Loops",
      "folders": [
        {
          "name": "Breaks",
          "samples": [
            {"uuid": "b81c4d6f-27a9-4e30-9f6b-5d0c3e18a72d", "name": "Amen Slow", "bpm": 136, "duration": 7.06, "sample_rate": 44100}
          ]
        }
      ]
    }
  ]
}
```

### Rules

The sample record is the existing `Sample` schema (`packages/studio/adapters/src/sample/Sample.ts`) minus `origin`. Every record in this file is a cloud sample, so `origin: "openDAW"` is injected client side on parse. That keeps `z.array(Sample)` valid for each folder's list after injection and means no consumer downstream sees a new type.

Folder identity is its path (`Drums/Snares/808`). No ids, nothing to keep in sync, renaming a folder is a pure text edit in one place.

Order inside `folders` and `samples` is the array order and is authored in the editor. The studio renders it as given. Alphabetical sorting only happens for flattened search results.

A sample appears exactly once in the tree. Single parent, so the tree flattens without dedupe surprises and folder counts mean what they say.

Samples that exist in the database but have not been filed land in a folder named `Unsorted` that the editor writes explicitly. The studio treats it as an ordinary folder, so no special casing on the read side.

`version` is a hard gate. If the studio reads a `version` it does not know, it falls back to `list.php` rather than guessing.

`updatedAt` is informational, useful for the editor to warn about concurrent edits and for a support answer to "did my publish go through".

### Source of truth and staleness

The MySQL `samples` table stays the authority for **which samples exist and what their metadata is**. `index.json` is a published artifact generated from it, never hand written.

The editor writes both. A metadata edit goes to the database immediately through the update endpoint, and the folder tree it holds in memory is refreshed from that same write. Update Index then serialises the whole current state to `index.json`. So the two can only disagree between an edit and the next index update, and the editor shows that as an unpublished-changes state.

On boot the editor still reconciles against `list.php`, even though it becomes the only upload path, because the tree it published last is not proof of what the table holds now. New uuids land in `Unsorted`, uuids the database no longer knows are dropped, retained records take their metadata from the database. The summary line before publishing reads "N added, N changed, N removed".

### Schema in code

New file `packages/studio/adapters/src/sample/SampleIndex.ts`:

A recursive zod schema. `SampleFolder` needs `z.lazy` plus an explicit interface for the recursion, since zod cannot infer a self referential type. Exports:

`SampleIndex` and `SampleFolder` types and schemas.

`SampleIndex.flatten(index): ReadonlyArray<Sample>`, depth first, `origin` injected, used by `all()`.

`SampleIndex.fromFlat(samples): SampleIndex`, single `Unsorted` folder, used as the fallback so the browser has exactly one rendering path even when only `list.php` answered.

Lives in `studio-adapters` next to `Sample`, so the editor can depend on the published package and validate against the same schema the studio uses.

---

## Part 2: Studio changes

### `OpenSampleAPI` (`packages/app/studio/src/opendaw-api/OpenSampleAPI.ts`)

Add `static readonly IndexFile = `${OpenSampleAPI.FileRoot}/index.json``.

Add a memoized `#index(): Promise<SampleIndex>` using `Promises.memoizeAsync`, mirroring what `OpenSoundfontAPI` already does with its static `list.json`. Fetch with `cache: "no-cache"` so the browser revalidates against the ETag instead of serving a stale copy for an hour, and memoize per session so the tree is fetched once.

Fallback chain, each step logged:

1. `index.json` parses and `version` is known, use it.
2. Anything fails, fetch `list.php` and wrap it via `SampleIndex.fromFlat`.
3. That fails too, empty index, which is today's behaviour on error.

`all()` becomes `SampleIndex.flatten(await this.#index())`. Signature unchanged, so `boot.ts:112` (`FactoryCatalog.install`), `SampleSelection.ts:73` (the online check in the delete guard) and the scripting API need no change.

`get(uuid)` resolves from the memoized index first and only falls back to `get.php` on a miss. That removes one request per sample load and matches `OpenSoundfontAPI.get`. The `get.php` fallback stays for samples uploaded after the last publish.

New `tree(): Promise<SampleIndex>` for the browser.

`load()`, `upload()` and `SamplePlayback` (which builds `FileRoot/<uuid>` directly) are untouched.

### `ResourceBrowser` (`packages/app/studio/src/ui/browse/ResourceBrowser.tsx`)

The browser is generic and shared with soundfonts, so folders go in as an optional capability, not a rewrite.

`ResourceBrowserConfig<T>` gains three optional fields:

`fetchOnlineTree?: () => Promise<SampleIndex>`, used instead of `fetchOnline` when the location is `AssetLocation.OpenDAW` and it is defined.

`renderFolder?`, receiving label, depth, expanded state and the rendered children, so the row markup lives in the browser specific component rather than in the generic browser.

`expandedKeys?: Set<string>`, held outside the component like `PresetBrowser` does, so expansion survives a reload of the entry list.

The existing `update()` closure gets two branches. Empty filter renders the tree recursively, non empty filter flattens and keeps today's exact filter plus `StringComparator` sort, so search behaviour does not change at all. Local location always uses the flat path.

`installScrollbars`, `HTMLSelection` and the delete key handler keep working unchanged, since selection is driven by the `data-selection` attribute on each `SampleView` and does not care about DOM depth. Worth a click through check that range selection across collapsed folders behaves, since `HTMLSelection` walks children.

### New `SampleFolderItem.tsx`

Modelled on `CompoundItem.tsx`, minus all preset drag and drop. Triangle, folder icon, name, child count, click to toggle, `hidden` class on the body, key written into `expandedKeys`. Indent per depth via a CSS custom property set on the row, so nesting does not need a class per level.

### `SampleBrowser.tsx`

Wire `fetchOnlineTree: () => OpenSampleAPI.get().tree()`, pass `renderFolder` and a module level `expandedKeys` set next to the existing module level `location` value.

### Not affected

`packages/app/wasm/src/sample-fetch.ts` fetches by uuid and never lists.

`SampleStorage` and the local sample path stay flat.

### Removed from the studio

`SampleUploadPage` goes away once the editor uploads, so there is one upload path and no catalogue state living outside the index.

Delete `packages/app/studio/src/ui/pages/SampleUploadPage.tsx` and its sass, and drop the `/upload` route in `App.tsx:61`.

`OpenSampleAPI.upload` then has no caller in the studio. `allowsUpload()` already returns `false` and the `SampleAPI` interface (`packages/studio/core/src/samples/SampleAPI.ts`) still declares both, so either keep `upload` as an unused interface implementation or take it off the interface, which is the cleaner end state but touches `studio-core`. Decide when the deletion happens, not before.

---

## Part 3: The editor

### Where it lives

A new private repo, for example `opendaw-sample-index`. It is a curation tool, not part of the product, and it holds publish credentials, so it stays out of the public repo and out of the studio bundle.

Note on the current state: the sample backend and its database credentials are already committed in the public repo (`packages/server/api.opendaw.studio/samples/connect.php`, and `upload.php` carries a hardcoded 8 character key). Any new write endpoint added for this feature must not follow that pattern. See risks below.

### Stack

Vite plus TypeScript, depending on the published `@opendaw/lib-std`, `@opendaw/lib-jsx`, `@opendaw/lib-dom` and `@opendaw/studio-sdk` packages so the zod schema, the uuid hashing and the coding conventions are shared rather than reinvented. Verify `@opendaw/lib-jsx` is actually published before committing to that, it has no `publishConfig` block unlike `lib-std` and `studio-sdk`.

Bpm comes from the same detector the studio uses. `@opendaw/studio-sdk` exports `WasmBpmDetector` and `Workers` for exactly this, the SDK's own module comment documents the seam. Install `Workers` first, construct the detector with the stretch wasm url, and a sample with no measurable pulse answers `None`, which is stored as bpm 0 and leaves the material unwarped. Analysis runs in the worker, so a long file does not block the editor. It also means the editor can show `AudioMaterialAnalyzer` results later if picking a stretch algorithm per sample ever becomes interesting.

### What it does

Loads `list.php` and the current `index.json` in parallel on boot and reconciles them as described above.

Two pane layout, folder tree on the left, folder contents on the right. Multi select plus drag to move, since filing hundreds of samples one at a time is the actual bottleneck.

Create, rename, delete and reorder folders, and drag to reorder samples within a folder, because the index preserves authored order.

Upload. Drop wav files onto a folder and they are uploaded and filed there in one gesture, with a metadata dialog for name and bpm before the request goes out. The file must be encoded with `WavFile.encodeFloats` first, exactly like `SampleUploadPage` does, because `OpenSampleAPI.load` decodes with `WavFile.decodeFloats` and a raw int16 wav from disk will not survive that round trip. Duration and sample rate come from decoding the file, bpm from `WasmBpmDetector` as described under Stack, editable in the dialog before the upload goes out.

### Sample identity

The uuid is derived from the audio, `UUID.sha256` over the `encodeFloats` output, not generated by the server. This is what `SampleService.importFile` already does for local imports (`packages/studio/core/src/samples/SampleService.ts:43`), so a cloud sample and the same file imported locally finally share one id instead of being two entries in the OPFS cache.

Duplicate uploads are therefore detectable before anything is written. The editor hashes first, checks the uuid against the catalogue, and on a hit tells the user which existing sample it matches and aborts the import. No overwrite, no silent second copy.

Two consequences for the backend:

`upload.php` takes the uuid from the client instead of calling `generateUuidV4`, and the insert becomes the second line of defence, a primary key collision means duplicate and is reported as such rather than as a failure.

`list.php` currently rewrites any 32 character uuid by injecting `4` and `8` nibbles at fixed positions to fake a v4 shape. That would corrupt a hash derived id. Uuids must be stored in dashed form so the branch never fires, and the rewrite should be removed once the column is known to be clean.

This also settles audio replacement. Different audio is a different uuid by construction, so an existing uuid never changes its content and the OPFS cache can stay content addressed.

**Existing uuids are immutable.** The rows already in the table were minted as random v4 and they stay exactly as they are. Projects, demo projects and every user's OPFS cache reference them, so rewriting them is not on the table, not even behind an alias. Hash ids apply to new uploads only, and the catalogue permanently holds two generations of id. Nothing in the studio cares, a uuid is opaque to it.

Duplicate detection therefore covers hash-era uploads. An old sample re-uploaded from its own source file does not collide with its existing entry, which is accepted.

Edit metadata. Name, bpm, and anything else the `samples` table carries, written straight to the database.

Remove. Hard delete of the row and the wav file, behind a confirmation that names the sample and states that projects referencing it will break. See risks.

Preview playback straight from `FileRoot/<uuid>` with a plain `Audio` element, the way `SamplePlayback` already does it.

Search across the flat catalogue, with results draggable into folders. This is how bulk sorting actually gets done.

Unpublished-changes indicator plus one Update Index button. Never autosave, because every publish is visible to every user immediately.

### Validation before the index is written

Refuse, listing the offending entries:

A uuid appears in more than one folder, or is not in the `samples` table.

A sample in the table is missing from the tree, which would silently hide it in the studio.

Two sibling folders share a name, or a name is empty or contains `/`.

The result does not parse against the `SampleIndex` zod schema.

### Endpoints

Four server side pieces in `packages/server/api.opendaw.studio/samples/`, all POST only, all authenticated against a secret held on the server and in the private repo's local config, never in the public repo.

`publish-index.php`, new. Validates the body, at minimum that it parses and that every uuid exists in the table. Writes a temp file and renames it onto `../../assets.opendaw.studio/samples/index.json`, so a reader never sees a half written file. Keeps the previous version as `index.<timestamp>.json` for one step rollback.

`update.php`, new. Updates name, bpm, sample_rate and duration for one uuid.

`delete.php`, new. Deletes the row and unlinks `../../assets.opendaw.studio/samples/<uuid>`, in that order, so a failed unlink leaves an orphaned file rather than a row pointing at nothing.

`upload.php`, existing, needs two changes. It must return the generated uuid in the response, otherwise the editor cannot file a freshly uploaded sample without a full reload. And its hardcoded 8 character key moves to the same server side secret as the rest.

---

## Rollout

1. Land the `SampleIndex` schema and the studio read path with the `list.php` fallback. Publish nothing yet. The studio still shows the flat list, now via the fallback, which verifies the fallback path in production before it is ever needed.
2. Publish a first `index.json` generated from the database with everything under `Unsorted`. The browser now renders one folder containing every sample, which proves the tree path and the caching without any curation.
3. Build the editor, curate, publish. This is where the visible change happens.
4. Remove `SampleUploadPage` and the `/upload` route from the studio, once the editor's upload path has actually been used for real material.

---

## Risks and decisions needed

**Single parent versus multi assignment.**
The plan assumes one folder per sample. Multi assignment would allow `Kicks` and `808` to both list the same sample, but it breaks flattening (duplicates in the linear list), makes counts ambiguous, and turns editor moves into set operations. Recommendation is single parent, revisit only if curation actually feels blocked by it.

**Metadata duplication.**
Metadata now lives in two places, the database and the published file. Accepted deliberately, with the editor's refresh on load as the reconciliation step. The alternative, uuid only in the index plus a join against `list.php`, keeps one source of truth but costs a second request and a merge, and leaves the browser dependent on PHP being up.

**Index size.**
A few thousand records at roughly 120 bytes each is a few hundred KB raw and well under 100 KB gzipped. Fine. If the catalogue ever reaches five figures, revisit, most likely by splitting per top level folder.

**Caching.**
A stale CDN copy after publish is the most likely support complaint. `cache: "no-cache"` on the fetch plus a short `max-age` on the file should cover it, but this needs an actual check against the real host headers after step 2.

**Credentials.**
The write endpoint must not repeat the pattern of the committed database credentials and the hardcoded upload key. Secret outside the webroot, read from the environment or a file that is not in any repo. This is worth fixing for `upload.php` at the same time, tracked separately.

**Removal is destructive by decision.**
Remove is a hard delete, the database row and the wav file both go. Consequences to be aware of while using it:

A cloud uuid is referenced directly by `AudioFileBox` in every saved project that uses it, so a delete breaks those projects permanently, including the demo projects on the server.

`SampleSelection.deleteSamples` lets a user delete their local copy without any warning as soon as the sample is present online, because `OpenSampleAPI` documents standard samples as non-removable. Those users have no copy left either.

Mitigations that are cheap and worth building into the editor: a confirmation dialog that names the sample and states that projects using it will break, and the previous `index.<timestamp>.json` files, which at least record what existed when.

Optional and more thorough: the editor can fetch the published demo projects and scan their box graphs for `AudioFileBox` references before deleting, which catches the one class of breakage that is actually visible to everyone. That needs `studio-core` in the editor to decode `.od` files. Not v1 unless wanted.

**Soundfonts and presets.**
Soundfonts already ship a static `list.json` with full metadata, so the same nesting could be applied later with the same components. Not part of v1, but do not build anything in `ResourceBrowser` that is sample specific.

---

## Open questions

1. Does `Unsorted` sit at the top or the bottom, and does it disappear from the studio once empty? Defaulting to bottom and hidden when empty unless you say otherwise.
2. Where does the secret for the write endpoints live, given `connect.php` and `upload.php` currently carry credentials in the public repo? This blocks the first publish, not the plan.
