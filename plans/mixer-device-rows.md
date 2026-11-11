# Mixer Device Rows

Two new rows in every mixer channel strip: MIDI FX before the Input row, Audio FX after it.

## Behaviour

1. Each cell shows the enabled toggle (LED) and the device label. Composites are one cell.
2. Below every chain sits a pinned add button opening the device dialog for that chain.
3. Pointerup on the label (no drag happened) edits the audio unit, opens the device panel if needed and reveals the device.
4. The cell context menu is the device editor menu (`MenuItems.forEffectDevice`).
5. Cells reflect the device selection: click selects, shift extends. A drag only takes the selected devices of its own strip (existing `DeviceDragging` behaviour).
5b. A cell's context menu shows only the device menu, the strip adds nothing.
6. Cells are dragged to reorder within their chain and to the same chain type of other strips (alt copies).
7. Each section is at most 5 rows including the add row (4 device rows). The limits are two constants, one for MIDI FX and one for Audio FX, both 5. The subgrid row takes the tallest strip, the add button is always pinned to the bottom of the row.
7b. Frozen units show their cells read-only (no toggle, drag, add).
8. A longer chain scrolls vertically. The scroller is always visible, has its own reserved width and never overlaps the cells.
9. Strips without a MIDI chain (groups, buses, aux, output) show the MIDI FX rows with a dark striped background and no add button.
10. The header column shows a collapse arrow per section. A collapsed section keeps one row showing the device count per strip. Collapse state is a per-user view state saved with the project.
11. Compact strips have no device rows.
12. Later: sidechain visualisation (lines to the sources).

## Phases

### 1. Mixer grid rows
- `Mixer.tsx`: two headers "MIDI FX" and "Audio FX" around "Input".
- `Mixer.sass`: rows become `--mixer-midi-rows` and `--mixer-audio-rows` driven tracks, row spans `2 / 11`, mastering panel span updated.
- `ChannelStrip.sass`: `grid-row: span 9`.
- No row count bookkeeping: the strips are subgrids, so an `auto` row already takes the tallest list.
- Spans to update: `ChannelStrip.sass` span 7, `Mixer.sass` `2 / 9` (twice), mastering panel `"2 / 9"` in `Mixer.tsx`.

### 2. DeviceList component (`ui/mixer/DeviceList.tsx`)
- Props: lifecycle, service, `IndexedBoxAdapterCollection` option, type, shared row count.
- Height = rows x cell height, `overflow-y: auto`, non floating vertical `Scroller` beside the cells.
- Subscribes `catchupAndSubscribe` on the collection, rebuilds cells on add/remove/reorder.

### 3. DeviceCell + add button
- Enabled toggle on `enabledField` via `EditWrapper`.
- Label from `labelField`, `TextScroller` for overflow.
- Selection from `deviceSelection` (click, shift extends).
- Pointerup on the label navigates (phase 5), suppressed after a drag.
- Context menu via `MenuItems.forEffectDevice`, then `collector.stopPropagation()`.
- studio-core `ContextMenu.Collector` gets `stopPropagation()` (additive SDK change): sets a flag on `CollectorImpl`, every later chain entry (the ancestors, which collect after the innermost target) is skipped.
- Pinned add button below the scroll area, `DeviceDialog.open` with the slot for that host and chain type.
- Striped empty variant for hosts without the chain, decided by `DeviceHost.takesEffect` (buses, aux, output report a midi chain but take none).
- Cell presses are excluded from the strip's track selection (`TrackGrouping.installTrackSelection`), so shift extends the device selection, not the track range.

### 4. Drag and drop
- `DeviceDragging.install` as the drag source (reuses `DragDevice`).
- The effect drop logic in `DevicePanelDragAndDrop` is bound to the edited audio unit. Extract the effect part into a function taking the target host, chain type and index, used by both the device panel and the mixer list.
- List is a `DragAndDrop.installTarget` using `findInsertLocationVertical`, accepts same-type devices from any strip, alt copies.
- Vertical auto-scroll inside a list while dragging, and verify the mixer's horizontal auto-scroll works during a drag.

### 4b. Section collapse
- Collapse arrows in the header column for MIDI FX and Audio FX.
- Collapsed: one row per strip showing the device count.
- New per-user view state for both flags: `ViewStates` only holds per-unit/track state, so two new fields on `UserInterfaceBox` (forge-boxes, Rust registry, `all-boxes.od`) plus accessors in `ViewStates`.

### 5. Navigate to device
- Edit the audio unit, select the device, `service.panelLayout.showIfAvailable(PanelType.DevicePanel)`.
- New: `DevicePanel` reveals a requested device, applied after the chain is rebuilt for the new edited unit.

### 6. Browser check
- 0, 1, 3, 5, 7 devices across strips, rows stay aligned, scroller visible only area reserved, reorder, navigation, open button.
