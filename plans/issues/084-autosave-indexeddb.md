# Store project's editing progress in IndexedDB (#84)

**Doability:** ⭐⭐⭐⭐☆ (4/5) — most of the machinery already exists, this closes a specific gap in it.
**Type:** feature
**Scope:** small

## What is asked
If the user closes the tab/browser and dismisses the native "Leave site?" confirmation, openDAW should still keep a backup of the in-progress (unsaved) project, and on the next launch offer to restore it. Acceptance criteria implied: no silent data loss on forced/ignored close, and a restore prompt (not a silent swap) on next boot.

## Current behaviour / relevant code
A backup/restore mechanism already exists, but it is wired to the wrong trigger.

- `packages/studio/core/src/project/Recovery.ts` — `Recovery` class. `createBackupCommand()` writes `uuid`, `project.od`, `meta.json`, `saved` flag to OPFS at `.backup/` (not IndexedDB — the project already uses OPFS as its persistence layer, see `packages/studio/core/src/project/ProjectStorage.ts`). `restoreProfile()` reads it back and deletes it.
- `packages/app/studio/src/boot.ts:124` — the **only** place `createBackupCommand()` is invoked is `new ErrorHandler(buildInfo, () => service.recovery.createBackupCommand())`, i.e. backup only happens when the app hits a fatal JS error and shows the crash dialog (`packages/app/studio/src/errors/ErrorHandler.ts` `#showDialog` passes `backupCommand: this.#recover()` into `Dialogs.error(...)`). There is no backup on `beforeunload`.
- `packages/app/studio/src/service/StudioService.ts:665-671` (`#configBeforeUnload`) — today only calls `event.preventDefault()` to trigger the browser's native "Leave site?" dialog when there are unsaved changes; it does not persist anything. If the user ignores that dialog and leaves anyway, the in-progress edits are gone.
- `packages/app/studio/src/service/StudioService.ts:673-680` (`#checkRecovery`) — on every boot, silently calls `this.recovery.restoreProfile()` and if a backup exists, swaps it straight into `#projectProfileService` with no user prompt. This does not match "offer to restore" from the issue — today it is silent, not opt-in.

So the real gaps are: (1) no backup write on tab-close, (2) restore is silent instead of a user-facing offer.

## Plan
1. **Write a backup on unload, not just on crash.** In `#configBeforeUnload` (`StudioService.ts:665`), when there are unsaved changes, call `this.recovery.createBackupCommand()` in addition to (or instead of relying solely on) the native dialog. Note: `beforeunload` handlers cannot reliably await async work — the page may be torn down before an OPFS worker round-trip (`Workers.Opfs.write`, via `packages/lib/fusion/src/opfs/OpfsWorker.ts`, is `postMessage`-based, not synchronous) completes. Two options, in order of reliability:
   - Prefer hooking the backup off `visibilitychange`/`pagehide` (fired reliably, including on mobile, before `beforeunload` and not cancelable) as the primary write path, keeping it debounced during active editing rather than only at exit. This turns it into a lightweight autosave-to-backup rather than a last-ditch unload write.
   - Keep the `beforeunload` call as a best-effort fallback for the case where the user "ignores" the dialog and there is no earlier `visibilitychange` write already covering the same delta.
2. **Make restore an offer, not a silent swap.** In `#checkRecovery` (`StudioService.ts:673`), when `restoreProfile()` resolves to a project, show a dialog (reuse the existing `Dialogs.*` helpers under `packages/app/studio/src/ui/components/dialogs.tsx`, matching the style already used by `ErrorHandler`) — "Recovered unsaved changes from your last session. Restore / Discard." Only call `this.#projectProfileService.setValue(...)` on explicit confirm; on discard, drop the backup (already deleted by `restoreProfile()` today, so decline path should not re-read it).
3. **Keep OPFS, don't introduce IndexedDB.** The issue title says IndexedDB, but the project's persistence layer is already fully OPFS-based (`ProjectStorage.ts`, `ProjectPaths.ts`) and OPFS already survives browser close (it is disk-backed, not session storage). Introducing IndexedDB alongside would duplicate the storage layer for no benefit — recommend keeping `Recovery` on OPFS and treating "IndexedDB" in the title as the reporter's generic term for "persistent local storage," which OPFS already satisfies.
4. **Debounce during editing, not just at exit**, so a hard crash (power loss, browser kill) is also covered, not only clean-ish unload paths. `Recovery.createBackupCommand()` is already cheap enough (single OPFS write of the serialized project) to run on an idle/debounced timer keyed off `profile.hasUnsavedChanges()`.

## Risks / open questions
1. **`beforeunload` reliability**: browsers increasingly restrict what can run in the unload path; the `visibilitychange`/`pagehide`-driven periodic backup is the dependable mechanism, `beforeunload` itself is a bonus, not the primary guarantee. Should validate empirically (repro: start edit, kill tab via task manager, reopen, confirm restore offer appears) per the project's "repro or test first" convention.
2. **Multiple tabs / projects**: `Recovery` currently backs up a single `.backup` slot tied to one profile. If a user has multiple projects open in multiple tabs, the last writer wins and could clobber another tab's backup — worth deciding whether to key backups by project uuid instead of a single fixed path.
3. **Interaction with existing crash-recovery flow**: `ErrorHandler`'s crash dialog already offers manual backup; need to make sure the new automatic path and the manual crash-time path don't race or double-prompt on the next boot.
