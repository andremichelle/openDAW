# Device browser: non-modal

Goal: keep the device browser open while editing the auditioned device's parameters in the device panel.

## Current state

- `DeviceDialog.tsx` opens with `dialog.showModal()`.
- `DeviceAudition` applies every pick inside an `EditingCheckpoint` (`lib/box/src/editing.ts`). Cancel rolls back, Ok commits everything since the checkpoint as ONE undo step.
- Shortcuts are blocked only because `Dialog.tsx` stops keydown propagation and focus cannot leave a modal dialog.

## Side effects of going non-modal

1. Undo/redo (`StudioShortcutManager.ts`, `UndoRedoButtons.tsx`) can step below the checkpoint base. The next rollback or commit then works on the wrong history ("Could not revert, the project changed meanwhile").
2. Parameter edits land inside the checkpoint. Ok keeps them in the same undo step, Cancel and picking another entry discard them. Wanted.
3. Other project edits while open (delete the track or the auditioned device, move devices, edit other tracks) are folded into the checkpoint. Cancel reverts them too, or fails if the host is gone.
4. Selecting another audio unit swaps the device panel away from the auditioned device. For `new-instrument` the piano follows `userEditingManager.audioUnit`, so it binds to the wrong unit.
5. Arrows, Enter, Escape only reach the dialog while it has focus. With focus in the panel, Space, Delete, Shift+I/A etc. go to the app.
6. No backdrop. Menus and dialogs opened from the panel must layer above it (`Layers.install`).
7. Collaboration: remote edits during audition already interact with the checkpoint today, unchanged.

## Plan

1. `dialog.show()` instead of `showModal()`, keep `placeAbovePanel`.
2. While open, undo/redo are disabled (shortcuts and header buttons). Alternative: undo/redo first cancels the audition. Decide before implementing.
3. Close as Cancel when the slot's host box is deleted or the slot no longer resolves.
4. Pin the user editing selection to the slot's audio unit while open, or close as Cancel when it changes. Decide before implementing.
5. Escape closes the dialog from anywhere while it is open (global listener owned by the lifecycle).
6. Leave Space/Delete/add shortcuts to the app when focus is outside the dialog.
7. Check stacking of context menus and nested dialogs (preset rename/delete, timeline replace prompt) above the non-modal dialog.

## Tests

- `DeviceSlot.test.ts` / `editing.checkpoint.test.ts`: parameter edit after pick then commit gives one undo step, then rollback reverts pick and edit, then pick after an edit drops the edit.
- Browser: pick, turn a knob in the panel, Ok, one undo restores the previous state. Same with Cancel. Delete the host track while open closes the dialog without warnings.
