# Sample Browser Folders

> **Status:** Steps 1 and 2 are done and live. Soundfonts got the same treatment. The editor (step 3) is not started.

## TL;DR

Cloud samples get a nested folder tree delivered as a single static file, `assets.opendaw.studio/samples/index.json`, that carries the folder structure **and** the sample metadata inline. The studio fetches that one file, flattens it for everything that wants a linear list, and renders the tree in the sample browser. Soundfonts work identically through `assets.opendaw.studio/soundfonts/index.json`.

All curation moves into a separate app in a private repo. That app is the full sample administration tool: upload, edit metadata, remove, move between folders, and one button that updates the index the studio reads. The studio itself gets no folder editing.

Scope of v1: openDAW cloud assets only. Local samples keep their flat list.

Decided: order inside a folder is the authored array order, a sample has exactly one parent folder, the editor owns metadata as well as structure, new uploads always land in `Unsorted` and are filed by hand afterwards, and the published index is the only source of structure, so the studio never derives a folder.

**What is live now.** Both index files are published and both browsers read only them. Samples show `openDAW > Loops / One Shots`, with One Shots split into 13 drum machines and Loops into packs. Soundfonts show a single `openDAW` folder with 7 entries. `list.php` and `list.json` have no caller left in the studio, they remain on the server for the editor.

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

`Unsorted` is a root level folder the editor writes explicitly, and it is where every sample starts. New uploads go there first, and so does anything that turns up in the database without a place in the tree. Filing is a separate, deliberate move afterwards. The studio treats it as an ordinary folder, so no special casing on the read side. It is written only when it holds something, so an empty one never shows up in the browser.

`version` is a hard gate. A `version` the studio does not know fails validation, which surfaces as the browser's error-with-retry rather than as a guess.

`updatedAt` is informational, useful for the editor to warn about concurrent edits and for a support answer to "did my publish go through".

### Initial tree (done)

The first index was generated, not curated, by a one-time script. One root folder `openDAW` with `Loops` for `bpm > 0` and `One Shots` for `bpm === 0`, the established "tempo unknown" that keeps material unwarped.

Inside those two, the script clusters by shared name prefix, which is what produced the drum machines and the loop packs without any hardcoded list:

Sort the names, then grow a cluster while the common prefix survives two tests, at least 3 characters and ending on a word boundary in both names. The boundary test is what keeps `Drum Loop` apart from `Drumulator` and `Linn 9000` apart from `LinnDrum`, since `Drum` and `Linn` split a word.

A cluster becomes a folder at 3 or more members, and a folder only splits into subfolders when at least two subgroups qualify. One subgroup is not a split, it is a lone descriptor sitting next to its own siblings, which is what produced a meaningless `Bass > Loop` in the first run.

Loops recurse one level deep (`Polarity > Fatso`, `BVKER > Chillwave`), one-shots stop at the machine.

Result: 630 samples, `One Shots` fully covered by 909, DDD-1, DMX, DrumTraks, Drumulator, Linn 9000, LinnDrum, R-8, RX5, SDSV, TR-626, TR-707 and TR-808, `Loops` in about twenty packs with 11 names left loose because they share no prefix with three others.

Soundfonts got a second script with no clustering at all: one `openDAW` folder holding all 7, sorted by name. Their names carry no shared structure worth inventing.

Both scripts live in the session scratchpad and belong in `admin.opendaw.studio` when that repo starts. Nothing in the studio implements these rules, they exist only where the file is produced.

### Source of truth and staleness

The MySQL `samples` table stays the authority for **which samples exist and what their metadata is**. `index.json` is a published artifact generated from it, never hand written.

The editor writes both. A metadata edit goes to the database immediately through the update endpoint, and the folder tree it holds in memory is refreshed from that same write. Update Index then serialises the whole current state to `index.json`. So the two can only disagree between an edit and the next index update, and the editor shows that as an unpublished-changes state.

On boot the editor still reconciles against `list.php`, even though it becomes the only upload path, because the tree it published last is not proof of what the table holds now. New uuids land in `Unsorted` like every other upload, uuids the database no longer knows are dropped, retained records take their metadata from the database. The summary line before publishing reads "N added, N changed, N removed".

### Schema in code (done)

`packages/app/studio/src/opendaw-api/SampleIndex.ts` and `SoundfontIndex.ts`.

A recursive zod schema each. The folder type needs `z.lazy` plus an explicit type for the recursion, since zod cannot infer a self referential one. Each exports `schema`, `flatten` (depth first, `origin` injected) and `asSample` / `asSoundfont`. The leaf key is domain specific, `samples` and `soundfonts`, so the file reads as what it is.

They live in the studio app, not in `studio-adapters`. This is the file format of one deployment's asset host, not an SDK feature, and nothing outside the app has a reason to know it. The editor will validate against its own copy rather than pulling a package in.

Neither file knows a single folder name. No `fromFlat`, no seeding rule, no labels: structure exists only in the published file.

---

## Part 2: Studio changes (done)

### `OpenSampleAPI` and `OpenSoundfontAPI`

`IndexFile` points at `${FileRoot}/index.json` on the assets host, fetched once per session through `Promises.memoizeAsync` with `cache: "no-cache"` so a publish reaches users on their next load instead of sitting in the HTTP cache.

There is no fallback. The published index is the catalogue, and a failure rejects. `ResourceBrowser` already renders a failure branch with retry on click, and `memoizeAsync` drops a rejected promise, so the retry actually refetches. That is a better failure than a silently empty or half-invented list, and it removed `Option<SampleIndex>`, the intermediate catalogue types and both `#list()` methods.

`all()` is `flatten(await index)`, so the signature never changed and `boot.ts` (`FactoryCatalog.install`), `SampleSelection` (the online check in the delete guard) and the scripting API were untouched.

`get(uuid)` resolves from the memoized index and only falls back to `get.php` on a miss, which saves one request per sample load. That fallback stays for samples uploaded since the last publish.

`tree()` returns the index for the browser. `load()`, `upload()` and `SamplePlayback` are untouched.

**Gotcha worth remembering.** Both fetches originally used `network.defaultFetch`, which retries a throwing fetch 30 times at one second intervals. The assets host answers a CORS-less 404 for a missing index, so the fetch throws rather than returning a clean 404 and the browser hung on its spinner for half a minute. An index that may legitimately be absent must use a plain `fetch` with an explicit `response.ok` check.

### `ResourceBrowser` (`packages/app/studio/src/ui/browse/ResourceBrowser.tsx`)

The browser always renders a root `ResourceFolder<T>` (`{name, folders, items}`, new file `ResourceFolder.ts` with `flatten` and `countItems`), whose own name is never shown.

`ResourceBrowserConfig<T>.fetchOnline` returns that root, since every online catalogue is now an index. `fetchLocal` still returns a flat array, which the browser wraps in a root with no folders, so both locations share one rendering path. Folders started as an optional `fetchOnlineTree?` alongside a flat `fetchOnline`, which became dead weight the moment both catalogues had an index, so the two collapsed into one. No `renderFolder` hook was needed either: the folder row is generic and both browsers share it.

`expandedKeys?` is held module level by each browser, so expansion survives a reload of the entry list.

An empty filter renders the tree recursively, a non-empty one flattens the whole root and keeps the previous filter plus `StringComparator` sort, so search behaves exactly as before.

`HTMLSelection` did need a change, contrary to the plan's guess. It recognised entries by being a direct child of the container, so every row inside a folder would have been unselectable, taking delete and "Create Audio Track(s)" with it. It now matches `[data-selection]` and builds its shift-range from those in document order, skipping anything inside a collapsed (`.hidden`) folder. `SoundfontView` carries the same attribute, so both browsers benefit.

### `ResourceFolderItem.tsx` (generic, not sample specific)

Modelled on `CompoundItem`, minus all preset drag and drop. `ArrowRight` / `ArrowDown` icons swapped by CSS on the `expanded` class, folder icon, name, child count in brackets, `hidden` class on the body, key written into `expandedKeys`.

Nesting shows as indent only, no tree guide lines. Depth is a `--depth` custom property on the row: the header pads itself from it, and the body publishes `--indent` for its entries. The entries stay a subgrid, so only the name moves while Bpm and Sec stay aligned with the header.

Two layout consequences found in the browser, not on paper:

The folder header must not inherit the item subgrid, otherwise its four children map onto Name / Bpm / Sec and the folder name lands in the Bpm column. It is a flex row spanning all columns instead.

`SampleBrowser.sass` had `auto` tracks for Bpm and Sec. An `auto` track measures the rows currently in the grid, and collapsing a folder removes its rows, so the columns jumped on every toggle. They are fixed now, `1fr 3.5em 3em minmax(4px, auto)`.

### Browsers

`SampleBrowser` and `SoundfontBrowser` each map their index folders to `ResourceFolder` and keep a module level `expandedKeys` next to the existing `location` value.

`SampleView` shows a dash instead of `0.0` when a sample has no tempo, matching the meaning of bpm 0.

### Not affected

`packages/app/wasm/src/sample-fetch.ts` fetches by uuid and never lists. `SampleStorage` and the local path stay flat.

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

`github.com/andremichelle/admin.opendaw.studio`, private, cloned at `/Users/am/Repositories/andre.michelle/admin.opendaw.studio` and currently empty. It is a curation tool, not part of the product, so it stays out of the public repo and out of the studio bundle.

Deployment mirrors `deploy.yml` in this repo: a `workflow_dispatch` action that builds and pushes over SFTP with `SFTP_HOST`, `SFTP_PORT`, `SFTP_USERNAME`, `SFTP_PASSWORD` from GitHub secrets, targeting `admin.opendaw.studio`. Those secrets are for the deploy only, the app itself ships no credentials.

### Authentication

A login form in the editor, a bearer token on every write, an admin list the server owns. No cookies, no session state to configure, no key in the bundle. The browser's password manager remembers the login itself.

`admin/login.php` takes name and password, verifies with `password_verify` against hashed entries, and answers with a token, 32 random bytes hex encoded. Failed attempts answer 401 after a short sleep, so guessing is slow.

The token is stored server side as a hash next to the admin it belongs to, with an expiry. The editor keeps the plain token in `localStorage` and sends it as `Authorization: Bearer <token>` on every write request. `connect.php` already lists `Authorization` in its allowed headers, so no CORS change is needed and nothing has to be sent with credentials.

The admin list holds password hashes only, never plaintext. Either a small `admins` table next to `samples`, or a PHP file outside the webroot. A table is easier to extend and gives the tokens somewhere to live, a file is easier to deploy, either is fine for a handful of people.

`admin/require-admin.php` is included first by every write endpoint, resolves the bearer token and answers 401 unless it is valid and unexpired. This is the part that actually protects anything. An endpoint that forgets the include is unprotected no matter what the login screen does.

`admin/logout.php` deletes the token, which is the only way to revoke one, so it is worth having from the start rather than waiting for a laptop to go missing.

An expired or revoked token means every write answers 401, and the editor drops back to the login view. That is also the boot check, no separate session endpoint needed.

Keep that origin allowlist as a complement, not as the control. Restricting by `Origin` or `Referer` alone protects nothing, CORS only stops other sites' JavaScript from reading a response, it does not stop the request, and both headers are set by the caller. A one line `curl` with a forged `Origin` would otherwise reach `delete.php`.

Note on the existing state, which this must not copy: `connect.php` has the database credentials in the public repo, and `upload.php` compares against a hardcoded 8 character key sitting in the same public repo. Moving it behind the session check retires that key.

### Stack

Vite plus TypeScript, depending on the published `@opendaw/lib-std`, `@opendaw/lib-jsx`, `@opendaw/lib-dom` and `@opendaw/studio-sdk` packages so the zod schema, the uuid hashing and the coding conventions are shared rather than reinvented. Verify `@opendaw/lib-jsx` is actually published before committing to that, it has no `publishConfig` block unlike `lib-std` and `studio-sdk`.

Bpm comes from the same detector the studio uses. `@opendaw/studio-sdk` exports `WasmBpmDetector` and `Workers` for exactly this, the SDK's own module comment documents the seam. Install `Workers` first, construct the detector with the stretch wasm url, and a sample with no measurable pulse answers `None`, which is stored as bpm 0 and leaves the material unwarped. Analysis runs in the worker, so a long file does not block the editor. It also means the editor can show `AudioMaterialAnalyzer` results later if picking a stretch algorithm per sample ever becomes interesting.

### What it does

Loads `list.php` and the current `index.json` in parallel on boot and reconciles them as described above.

Two pane layout, folder tree on the left, folder contents on the right. Multi select plus drag to move, since filing hundreds of samples one at a time is the actual bottleneck.

Create, rename, delete and reorder folders, and drag to reorder samples within a folder, because the index preserves authored order.

Upload. Drop wav files anywhere in the editor and they land in `Unsorted`, with a metadata dialog for name and bpm before the request goes out. Filing them is a separate move, so an upload is never silently committed to a folder you did not think about. The file must be encoded with `WavFile.encodeFloats` first, exactly like `SampleUploadPage` does, because `OpenSampleAPI.load` decodes with `WavFile.decodeFloats` and a raw int16 wav from disk will not survive that round trip. Duration and sample rate come from decoding the file, bpm from `WasmBpmDetector` as described under Stack, editable in the dialog before the upload goes out.

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

Four server side pieces in `packages/server/api.opendaw.studio/samples/admin/`, all POST only, each including `require-admin.php` first as described under Authentication. The public `list.php` and `get.php` stay where they are and stay open.

`publish-index.php`, new. Validates the body, at minimum that it parses and that every uuid exists in the table. Writes a temp file and renames it onto `../../assets.opendaw.studio/samples/index.json`, so a reader never sees a half written file. Keeps the previous version as `index.<timestamp>.json` for one step rollback.

`update.php`, new. Updates name, bpm, sample_rate and duration for one uuid.

`delete.php`, new. Deletes the row and unlinks `../../assets.opendaw.studio/samples/<uuid>`, in that order, so a failed unlink leaves an orphaned file rather than a row pointing at nothing.

`upload.php`, existing, moves into the same directory and changes in two ways. It takes the uuid from the client instead of minting one, and it echoes back what it stored so the editor can place the sample without a reload. Its hardcoded key disappears with the move, since the session check replaces it.

---

## Rollout

**1. Generate `index.json` and put it on the server. Done, for samples and soundfonts.**
Two scripts, one per catalogue, described under Initial tree. They read `list.php` and `list.json`, validate every record, refuse on a duplicate uuid, and write the file for manual upload. No application code, nothing to deploy, revertible by deleting the file. Both are uploaded and serving.

The scripts belong in `admin.opendaw.studio` as the seed of that repo, since the reduction they perform is what the editor will do on every publish. They currently sit in the session scratchpad.

**2. Studio reads the file. Done.**
See Part 2. The browser went from a flat list to `openDAW > Loops / One Shots` for samples and a single `openDAW` folder for soundfonts.

The `list.php` fallback described in earlier drafts was built, used during the rollout, and then removed on purpose once both indices were live: two sources of truth for the same list is exactly what this plan set out to avoid, and the retry-on-error path covers a bad publish better than a silent degrade. The endpoints stay on the server for the editor.

**3. Build the editor. Next.**
Login and the four endpoints, then the tree UI, upload, metadata editing, delete, and the Update Index button. From here on the file is published from the tool instead of by hand, and real curation starts.

It has to cover soundfonts too, since they now have the same kind of index and no way to publish one. Their entry schema and leaf key differ, the tree editing is identical.

**4. Remove `SampleUploadPage` and the `/upload` route** from the studio, once the editor's upload path has been used for real material.

---

## Risks and decisions needed

**Single parent versus multi assignment.**
The plan assumes one folder per sample. Multi assignment would allow `Kicks` and `808` to both list the same sample, but it breaks flattening (duplicates in the linear list), makes counts ambiguous, and turns editor moves into set operations. Recommendation is single parent, revisit only if curation actually feels blocked by it.

**Metadata duplication.**
Metadata now lives in two places, the database and the published file. Accepted deliberately, with the editor's refresh on load as the reconciliation step. The alternative, uuid only in the index plus a join against `list.php`, keeps one source of truth but costs a second request and a merge, and leaves the browser dependent on PHP being up.

**Index size.**
A few thousand records at roughly 120 bytes each is a few hundred KB raw and well under 100 KB gzipped. Fine. If the catalogue ever reaches five figures, revisit, most likely by splitting per top level folder.

**Caching.**
A stale CDN copy after publish is the most likely support complaint. `cache: "no-cache"` is set on both fetches. Republishing during this work reached the browser immediately, but that was a dev session with devtools habits, so it still deserves a check from a cold browser after a real publish.

**No fallback means a bad publish is visible.**
An unreachable or malformed index shows the browser's error with retry, not an empty list and not a stale one. That is deliberate, but it does mean `publish-index.php` validating before it writes is now load bearing rather than a nicety.

**Credentials.**
Settled under Authentication: login form, bearer token, hashed admin list, no cookies and no secret in the bundle. Two traps to avoid. An `Origin` check is not access control, and an endpoint that forgets `require-admin.php` is open regardless of the login screen, so that include belongs in a review checklist.

The token sits in `localStorage`, which any script running on the admin page could read. Acceptable here because the page is ours and loads no third party code, but it is the reason the tool should never grow an embed, an analytics snippet or a CDN script.

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

None blocking. The remaining judgement calls are editor layout details that are cheaper to decide while building than on paper.
