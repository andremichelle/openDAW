# Composite Overview (issue #568)

A temporary screen that shows every branch of one composite below each other, each branch with its full device
chain and displays. Meant to compare branches at one glance. Every composite gets it: FX Composite, Stereo Split,
Frequency Split, Instrument Composite, Mid/Side Split and every future one.

## Approach

1. Key everything on `CompositeCell` (`packages/studio/adapters/src/DeviceAdapter.ts`). Every composite branch is
   one (`AudioEffectCompositeCellBoxAdapter`, `InstrumentCompositeCellBoxAdapter`), and `siblings()` plus
   `subscribeSiblings()` already give the branch list. A new composite needs no extra work as long as its branches
   are composite cells.
2. Reuse the code editor path, no second mechanism. The script code editor already is "a device header button opens
   a hidden screen with a big panel above the devices panel, close returns to the previous screen". That path gets
   a second kind of content: the composite overview. One active editor at a time, opening one replaces the other.
3. Rows reuse `DeviceMount` (same editors, same displays, same minimize state as the device panel). No new editing
   features, a row is the regular chain.
4. Only the header button opens or switches the overview. Selecting another device or composite changes nothing.

## ~~Phase 1: Extend the code editor path~~

1. `CodeEditorState` becomes one variant of a tagged state, the other is the composite overview (composite device
   adapter, `previousScreen`). Lives next to it in `ui/code-editor/`.
2. `StudioService`: `activeCodeEditor`, `openCodeEditor`, `closeCodeEditor` take the tagged state. The previous
   screen handling and the deferred screen switch stay as they are, so both kinds share them. `closeCodeEditor`
   reopens the script state's `returnTo` overview when present (see Edge cases, Script devices 5).
3. Screen `"code"`, `PanelType.CodeEditor` and the `Header.tsx` mapping stay unchanged. `PanelFactory` (or a thin
   wrapper) picks `CodeEditorPanel` or `CompositeOverviewPanel` by the state's tag. The devices panel below stays.
4. `ScriptDeviceEditor` and `CodeEditorPanel` read the script variant only. Their behaviour stays bit identical:
   toggle, `CodeClose` icon swap, close on device termination, `codeEditorHandover`.
5. The overview closes only when its composite box is deleted or the project changes, never on editor unmount
   (see Edge cases, Lifetime 1).

## ~~Phase 2: Overview panel~~

1. `CompositeOverviewPanel.tsx`: header like `CodeEditorPanel` (red close button, composite name), then one row per branch from
   `siblings()`, rebuilt on `subscribeSiblings`.
2. A row: branch label (index plus `entryLabelAt` for fixed splits, layer name for instrument layers), the
   `CompositeCellStrip` (gain, pan, mute, solo, so branches can be soloed while comparing) and the chain:
    1. instrument layers: MIDI effects, instrument, audio effects
    2. audio entries: audio effects
3. Chains subscribe like `DevicePanel.subscribeChain` and mount through `DeviceMount`. Extract the subscribe and
   mount part into a small shared helper only if it stays bit identical for the device panel, otherwise keep a
   separate copy in the overview.
4. Rows scroll horizontally on their own, the panel scrolls vertically. Lists fade at the edges.
5. A nested composite inside a branch shows its regular editor, no recursion. Its own overview button opens the
   overview for that composite.

## ~~Phase 3: Header button and icon~~

1. Two new symbols in `packages/studio/enums/src/IconSymbol.ts` and `packages/studio/icons/src/IconLibrary.tsx`:
    1. `CompositeOverview`: a screen outline with one arrow going up that splits into three.
    2. `CompositeOverviewClose`: the inverted version, a filled screen with the arrows cut out.
   Both use `currentColor` only, the button never changes colour, it takes the header's colour.
2. `CompositeOverviewButton.tsx`, built like the script editor's toggle button, passed through `populateHeader` of
   every composite editor: `AudioEffectCompositeDeviceEditor` (FX Composite, Stereo Split, Mid/Side),
   `FrequencySplitDeviceEditor`, `InstrumentCompositeDeviceEditor`. A future composite adds the one line.
3. Toggle like the script editor: on its own composite it closes, on another composite it switches to that one.
   While its composite is open the button swaps to the inverted icon, the same way the script button swaps to
   `CodeClose`.

## Edge cases

### Script devices inside a branch

1. Opening the script editor from an overview row replaces the overview (one active editor). The row's
   `ScriptDeviceEditor` then terminates with the overview, sees its editor active and calls `closeCodeEditor`, so
   the editor closes the moment it opens. Fix (approved): opening from a row first enters that branch in the devices panel
   (`userEditingManager.audioUnit.edit(cell.box)`), so the devices panel mount owns the editor and the existing
   close rule applies unchanged. Overview mounts never close the code editor on termination.
2. A script device mounted twice (overview row plus devices panel) runs `compiler.load` / `compile` on each mount
   and on each `codeChanged`. Verify load is idempotent. An empty script device compiles its default code on mount
   and writes it into the box, two mounts must not both write it (one undo step, no double compile).
3. `codeEditorHandover.opening` (Load Example replaces the box) is consumed by the first new mount. With two
   mounts it must be the devices panel one, otherwise the same close problem as 1.
4. Script editor open, then the overview button: overview replaces the script editor, the previous screen stays the
   original one. An overview never returns to a script editor.
5. Closing a script editor that was opened while an overview was active returns to that overview. Bounded to one
   level, no stack:
    1. the script variant carries one `returnTo: Option<overview state>`, set when it replaces an overview
    2. switching to another script device inherits `returnTo`, like `previousScreen` is inherited today
    3. opening an overview drops any `returnTo`
    4. so the longest chain is overview, script (any number of switches), back to the overview, then the original
       screen
    5. if the overview's composite was deleted meanwhile, close falls through to the original screen

### Lifetime of the overview

1. The composite's device editor in the devices panel terminates whenever the devices panel navigates (entering a
   branch, selecting another track). The overview must not close on that. It closes only when the composite box is
   deleted (pointer hub / box graph deletion), its track is deleted, it is replaced (Device Slot replace) or the
   project changes. Undo of the deletion does not reopen it.
2. Deleting a device inside a row, or the branch itself, rebuilds the row or the list, the overview stays.
3. Collaboration (live room): remote branch adds, removes and reorders rebuild the list, a remote deletion of the
   composite closes it.
4. Composite moved to another track by drag: same box, overview stays and follows the label.
5. The user leaves the `"code"` screen through the header while the overview is open: the state stays (as the code
   editor does now). The button must then open the screen again instead of toggling the hidden overview off. Same
   check for the script button.

### Duplicate mounts

1. Every device can be visible twice (overview row and devices panel). Audit editors with mount side effects
   beyond scripts: engine message subscriptions, sample loading, canvases, focus, global singletons.
2. Shared state is fine and wanted: minimize, solo, selection, parameters all mirror between both mounts.
3. Header focus restore in `DevicePanel` uses `header.selected`, a selected device in the overview must not steal
   it.

### Nested and special composites

1. A composite inside a branch shows its regular editor with its own header button. Pressing it switches the
   overview to the nested composite, its parent's button returns.
2. A branch with no devices shows an empty chain line, not a collapsed row (no layout jumps).
3. Fixed splits (Stereo, Mid/Side, Frequency Split): label from `entryLabelAt`, band count changes rebuild the list.
4. Instrument Composite layers: MIDI effects, instrument and audio effects in one row. Large instrument editors
   keep their size, the row scrolls.
5. Many branches (Frequency Split at max bands, many layers): every row mounts real editors with meters. Measure
   the cost before deciding on lazy mounting.

### Frozen and disabled

1. A frozen track greys out its chain in the devices panel (`containers.frozen`). The overview needs the same
   class.
2. Disabled devices and a disabled composite show as in the devices panel.

### Interaction

1. Drag and drop into rows is out of scope (no editing features). Drops on the overview do nothing, no wrong
   insert markers.
2. Clicking a row's branch label enters that branch in the devices panel, the overview stays.

## ~~Phase 4: Check~~

1. tsc `--noEmit` for studio.
2. Browser check on each composite type: open, compare, solo a branch, add and remove a branch while open, delete
   the composite while open, undo, close returns to the previous screen.
3. Code editor regression: open, compile, switch between two script devices, delete the device while open, replace
   a script device, close. Then open a script editor while the overview is open and the other way round.
4. Every case of the edge case list above, script devices in a branch first.