# WebCLAP plugin versioning

A WebCLAP device names its bundle by `url = opfs:<sha256 of the archive>` (`WclapStorage.urlFor`). Every build is
its own id, so a project pins the exact build it was made with. This plan collects how builds move today, every edge
case found, and the rules that make versioning conclusive. Trigger: the WebCLAP storage and data exchange audit
(2026-10-25) wants to change state formats, which is only safe once these rules hold.

## Today

1. **Resolve.** `WclapStorage.load(url)` reads OPFS `wclap/<id>/bundle.tar.gz`. If absent, the installed remote
   (`boot.ts:129`) asks `WclapCatalog.find(id)` (cloud index + community index) and downloads, else a Live Room peer
   (`ChainedWclapProvider`). Every download is hash-checked and stored in OPFS.
2. **Project load.** `WclapMissing.resolve` restores missing local bundles from the catalogue by id, else asks the
   user to browse for the file (a different file rewrites `url`).
3. **New builds.** Admin "replace" and the commons deploy publish the new build with the old ids in `supersedes`. The
   old entry leaves the index (admin: to the trash, file kept; commons: one entry per slug, file kept on the server).
4. **Update button.** `WclapDeviceEditor.showUpdate` (cb028cc95, PROD) shows "Update" when a catalogue entry
   supersedes the device's id. It downloads the new build and changes only `url` + `clapId` in one marked step.
   `plugin-state` and the parameter boxes stay, the new build loads the old blob. Per device only.
5. **Live today.** All 13 cloud entries have an empty `supersedes`, no admin replace has happened. Only community
   ProTracker `1d87493a` supersedes `f7cd1180`, so a v1 ProTracker device is the only place the button can show.
6. **Old copies.** The old build stays in OPFS. Storage "Delete unused" counts saved projects, presets and the open
   project's live graph (`StoragePage.tsx:237`). Cloud backup syncs bundles and deletion tombstones across devices.

## Edge cases

1. **Update, project not saved.** Safe. The saved project still names the old id, the old build stays in OPFS
   (referenced by the saved project), the next load uses it. The downloaded new build stays too and is unused.
2. **Update, then undo.** Safe by order. The new build's first state store is an unmarked modify after the Update
   step. Undo seals pending into its own step first (`BoxEditing.undo`), so the first undo reverts the blob (the new
   build reloads the old blob, backward compatible) and the second reverts `url`. The first undo looks like nothing
   happened. To verify with a test.
3. **Old build gone locally, file still on the server.** BROKEN. `restoreFromCloud` and the remote both go through
   `WclapCatalog.find(id)`, which only knows current index entries. `f7cd1180.wclap` answers 200 but a v1 ProTracker
   project on a new machine, after "Delete unused", after OPFS eviction or after a tombstone purge gets "Missing
   Plugin". Admin replaces will produce the same for every cloud plugin.
4. **Admin deletes a trashed entry.** `delete-asset.php` unlinks the file. Every project pinned to that build is lost
   for users without a local copy or backup.
5. **New build cannot read an old blob.** The plugin rejects the state, the bridge reports "rejected its saved state"
   and stores nothing, so the blob survives. The user is left with a device in loading state and no way back except
   undo. Nothing tells the publisher before release.
6. **Old build reads a new blob (forward).** Happens only through redo/undo races, a Live Room peer undoing the
   other's Update, or a preset or copied device carrying a new blob into a box whose `url` names the old build. Old
   builds may refuse (ProTracker v1 refuses version 2) or misread. Never guaranteed, so it must never be needed.
7. **Parameter ids change between builds.** Update keeps `WclapParameterBox`es keyed by CLAP param id. Removed or
   renumbered ids silently orphan automation and modulation. Same for a changed `clapId` (Update then fails to find
   the plugin in the new bundle and the button stays hidden).
8. **Several devices, one plugin.** Update is per device, a project can end up mixing builds. Allowed, but the user
   has no project-wide "update all".
9. **Chains of builds.** `supersedes` holds every older id (admin prepends the replaced entry's list, commons appends),
   so v1 jumps straight to v3. Fine as long as v3 reads v1 blobs (rule 3 below).
10. **Live Room.** A peer's Update syncs `url`, other peers fetch the new build by hash from the catalogue. A peer
    joining a project pinned to a dropped build hits case 3, unless another peer holds it.
11. **Locally imported bundles.** Not in any catalogue, only OPFS, cloud backup, `.odb` project bundles and Live Room
    peers hold them. No supersede chain exists for them. Out of scope, the user owns them.
12. **Reproducible commons builds.** The commons uuid is the archive hash. A deploy that rebuilds an unchanged
    plugin with different bytes publishes a "new build" that supersedes an identical one (already watched).

## Rules

1. **A project pins its build.** Nothing switches a device's build except an explicit user action (Update, picking
   another plugin, browsing for a file). Keep.
2. **A published build stays resolvable forever.** The server never deletes a bundle file that was ever published.
   The studio resolves any id it does not find in the index by trying the file at the cloud and community roots
   directly, hash-checked like every download. The index lists only the latest build, the files of older ones stay.
3. **A newer build reads every older build's blob (backward).** This is the publisher's contract and the only one.
   A format change writes a new version tag and keeps every old reader. ProTracker already does this (v1 + v2).
4. **An older build never gets a newer build's blob.** Forward compatibility is not required. The host keeps track
   of which build wrote `plugin-state` and refuses to feed it to an older one (see below).
5. **Parameter ids and `clapId` are stable across builds.** A build that must drop a param keeps its id reserved.
   Checked at publish time, not at runtime.

## Implementation

1. **Resolve dropped builds (rule 2, fixes edge 3 and 10).** `WclapCatalog.load(uuid)` and the boot remote try
   `OpenWclapAPI.FileRoot/<id>.wclap`, then `CommunityAPI.FileRoot/wclaps/<id>.wclap` when the id is in no index.
   `WclapMissing.restoreFromCloud` uses it, the hash check already guards it. No index change.
2. **Never delete published files (rule 2, fixes edge 4).** Admin `delete-asset.php` for a wclap that was ever
   published only removes the row and keeps the file, or refuses while the entry is in some `supersedes` list.
   Commons deploy already uploads only, add a test that it never removes `wclaps/*.wclap`.
3. **State origin (rule 4, fixes edge 6).** New field 15 `state-url` (string) on both boxes, additive: the url of the
   build that wrote `plugin-state`. `WclapStates.store` writes it with the blob. The bridge loads the blob only when
   `state-url` is empty (legacy), equals `url`, or is superseded by `url` (known from the catalogue). Otherwise the
   device reports "state was saved by a newer build" with an "Update" action, and stores nothing. Undo and redo
   carry both fields in the same steps, so edge 2 stays correct without relying on order.
4. **Publish checks (rules 3 and 5, fixes edge 5 and 7).** The admin replace dialog and the commons build load the
   new build headless in node (core-wasm bridge harness) with the previous build's default state and every stored
   test state, and compare param ids and `clapId`. A rejected state or a missing param id blocks the publish.
5. **Update for the whole project (edge 8).** When a successor exists, the device's Update offers "this device" or
   "all devices using this build", one marked step.
6. **Tests.** Node tests for: Update then undo (edge 2), dropped build restore (edge 3), state-url refusal (edge 6),
   publish check rejects a renumbered param (edge 7).

## Order

1. Implementation 1 and 2 first, they close data loss today and are invisible.
2. Then 6 (tests for edge 2 and 3), then 3 (`state-url`), then 4 (publish checks).
3. Only after 1 to 3 hold may the storage format changes from the audit (JUCE length header, Odin wavetables, Surge
   `midichan_map`, Six Sines defaults) be published, each with its old reader kept and a test that loads an old blob.

## Open

1. Should a refused newer state (implementation 3) also offer "load anyway" for plugins known to be forward tolerant?
2. Does the desktop app keep its own bundle store beside OPFS (check before implementation 1)?
