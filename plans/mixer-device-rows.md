# Mixer Device Rows

Two new rows in every mixer channel strip: MIDI FX before the Input row, Audio FX after it.

## Behaviour

1. Each cell shows the enabled toggle, the device label and, when the device has a big view, an open button.
2. Pointerup on the label (no drag happened) edits the audio unit and reveals the device in the device panel.
3. Cells are dragged to reorder within their chain (same strip, same type).
4. Row count per section is the maximum chain length over all visible strips, capped at 5. Every strip gets the same rows, empty slots stay blank.
5. A chain longer than 5 scrolls vertically. The scroller is always visible, has its own reserved width and never overlaps the cells.
6. Strips without a MIDI chain (groups, buses, aux, output) show blank MIDI FX rows.

## Phases

### 1. Mixer grid rows
- `Mixer.tsx`: two headers "MIDI FX" and "Audio FX" around "Input".
- `Mixer.sass`: rows become `--mixer-midi-rows` and `--mixer-audio-rows` driven tracks, row spans `2 / 11`, mastering panel span updated.
- `ChannelStrip.sass`: `grid-row: span 9`.
- Mixer owns a `MixerDeviceRows` observable (max midi count, max audio count over the visible strips), recomputed in `updateDom` and on chain add/remove, written as the two css variables on `.channel-strips`.

### 2. DeviceList component (`ui/mixer/DeviceList.tsx`)
- Props: lifecycle, service, `IndexedBoxAdapterCollection` option, type, shared row count.
- Height = rows x cell height, `overflow-y: auto`, non floating vertical `Scroller` beside the cells.
- Subscribes `catchupAndSubscribe` on the collection, rebuilds cells on add/remove/reorder.

### 3. DeviceCell
- Enabled toggle on `enabledField` via `EditWrapper`.
- Label from `labelField`, `TextScroller` for overflow.
- Open button only if the device declares a big view (see question 2).
- Pointerup on the label navigates (phase 5), suppressed after a drag.

### 4. Reorder
- `DeviceDragging.install` as the drag source (reuses `DragDevice`).
- List is a `DragAndDrop.installTarget` using `findInsertLocationVertical`, accepts only same-type devices of the same host, applies the index change in one `editing.modify`.

### 5. Navigate to device
- Edit the audio unit, select the device, and let `DevicePanel` scroll that device editor into view (new: DevicePanel reveals a requested device).

### 6. Browser check
- 0, 1, 3, 5, 7 devices across strips, rows stay aligned, scroller visible only area reserved, reorder, navigation, open button.
