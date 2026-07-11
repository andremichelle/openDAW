# File evaluation and choosing for cloud backup (#249)

**Doability:** ⭐⭐☆☆☆ (2/5) — today's sync has no conflict concept at all (pure last-write-wins by timestamp); this asks for a new comparison UI plus project metadata that isn't currently tracked.
**Type:** ux
**Scope:** large

## What is asked
When a same-named project already exists in the cloud, let the user choose between: import the cloud file, create a renamed local copy, or keep the existing one — after a compare screen showing last-edited date, track length, etc. Goal: speed up cross-device editing.

## Current behaviour / relevant code
Cloud project sync is implemented in `packages/studio/core/src/cloud/CloudBackupProjects.ts`. It has no conflict-resolution UI whatsoever today; it is a fully automatic, UUID-keyed, timestamp-driven sync:

- **Matching is by UUID, not name.** `#upload`/`#download` both key off `Record<UUID.String, MetaFields>` (`local`/`cloud` maps built at `#start`, lines 34-49). A project with the same *name* but a different UUID (e.g. created independently on two devices, or duplicated/renamed from a template) is invisible to this matching — it would simply exist as two separate, unrelated entries rather than triggering any comparison. This is the actual gap behind "when a same-name project exists" — today there is no same-name detection at all, only same-UUID detection.
- **Same-UUID conflicts are resolved silently by timestamp**, `#upload` (lines 69-117):
  ```typescript
  const isUnsynced = (localProject: MetaFields, cloudProject: Maybe<MetaFields>) =>
      isAbsent(cloudProject) || new Date(cloudProject.modified).getTime() < new Date(localProject.modified).getTime()
  ```
  If local is newer, it uploads and overwrites the cloud copy — no prompt, no compare screen, no "keep both" option.
- **Downloads of cloud-only projects are unconditional**, `#download` (lines 147-200): every project missing locally (`Arrays.subtract(cloud, local, ...)`) is downloaded automatically. The only existing user-facing prompts in this file are narrow error-recovery dialogs via `RuntimeNotifier.approve` — "Delete Projects?" for locally-trashed-but-cloud-present projects (line 124-129), and "Download failed... corrupted, delete it?" for a project missing required files (line 169-174). Neither is a data-comparison/choice screen; both are binary yes/no error dialogs.
- **`ProjectMeta` lacks the fields the compare screen needs.** `packages/studio/core/src/project/ProjectMeta.ts:3-12`:
  ```typescript
  export type ProjectMeta = {
      name: string, artist: string, description: string, tags: Array<string>,
      created: Readonly<string>, modified: string, notepad?: string, radioToken?: string
  } & JSONValue
  ```
  `modified`/`created` are available for the "last edited" part of the compare screen, but there is no "track length" (or any project-content statistic) tracked in metadata — computing it would require decoding the actual `.od` project file (`project.od`, referenced in `#upload`/`#download`), which today only happens at full project load, not during the cloud sync pass.

## Plan
1. **Define what "same-name" conflict detection means.** Today two projects are only ever related by UUID. Decide whether same-name-different-UUID should be (a) surfaced as a *new* class of conflict (requires scanning `local`/`cloud` catalogs for name collisions across different UUIDs, which `#start` does not currently do at all), or (b) out of scope, and the real target is just adding a choice screen for the *existing* same-UUID timestamp-conflict case. The issue text ("same-name project exists in the cloud") suggests (a), which is materially larger than (b) since it requires a new detection pass, not just a new prompt on an existing one.
2. **Add a proper compare/choice dialog**, replacing (or gating) the silent branches in `#upload`'s `isUnsynced` and `#download`'s unconditional-download loop:
   - When a conflict is detected (by whichever definition from step 1), show a modal (following the existing `RuntimeNotifier.approve`-style dialog pattern already used in this file) presenting both projects' `modified`/`created` dates and any other cheaply-available metadata (`name`, `description`, `tags`).
   - Offer three actions matching the request: "Import cloud file" (download, overwrting local), "Create renamed copy" (download into a new local UUID/name, leaving the existing local project untouched), "Keep existing" (skip, do not upload/download this one).
3. **Track length / content stats** are not currently part of `ProjectMeta`. Either:
   - extend `ProjectMeta` with a small set of precomputed stats (e.g. project duration) written whenever a project is saved locally (`ProjectStorage`/wherever `meta.json` gets written), so the compare screen can read them cheaply from the catalog without downloading the full project, or
   - accept a heavier compare screen that downloads (or partially reads) both `project.od` files to compute stats on demand, only when the user actually opens the compare screen (not during the automatic background sync pass).
   The first option is much cheaper at sync time but requires finding every write path for `meta.json` and keeping the new stat in sync; the second is simpler to implement but slower and only works well if the compare screen is a deliberate, user-triggered action rather than something shown for every conflict during an automatic background sync.
4. Wire the new dialog into `#upload`/`#download` at the point where a conflict is currently resolved automatically, threading the user's choice back into the existing `tasks`/`uploaded`/`download` arrays so the rest of the transfer machinery (progress reporting, catalog upload, retry logic) is unaffected.

## Risks / open questions
- This is the largest of the reviewed issues in scope: it requires both a new conflict-*detection* pass (same-name-across-UUID) and a new conflict-*resolution* UI, plus a metadata extension, where today none of the three exist.
- Automatic background sync (this file runs as part of a broader "sync everything" pass, `CloudBackup.ts`) blocking on a modal per conflict could be disruptive if many conflicts exist at once — needs a batched or queued UI treatment (e.g. "3 projects need your attention" summary before drilling into per-project compare), not a naive one-dialog-per-conflict loop.
- "Create renamed copy" needs a clear rule for the new local UUID/name and needs to avoid re-triggering the same conflict on the next sync pass (the renamed copy must not collide with the same name-matching heuristic from step 1).
