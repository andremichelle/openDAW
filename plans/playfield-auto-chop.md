# Playfield Auto-Chop

Slice one audio file into N contiguous slots of a Playfield, each sharing the same `AudioFileBox`
but with its own `index` (key), `sample-start` and `sample-end`. The user configures the chop in a
large, app-like modal with a live, editable waveform preview, then bakes it into the device.

## User-facing behaviour (locked)

- **Two modes.**
  - **Transients** — one slice per detected onset. Uses the existing worker detector as-is (no
    sensitivity control); the user prunes/adjusts by editing boundaries in the preview.
  - **Grid** — even slices at an adjustable division (default `1/16`, semi-quaver). BPM is
    auto-detected on open: use the sample's stored metadata BPM if it has one, otherwise a
    power-of-2 fit (assume the sample is `2^n` beats and pick the `n` whose BPM lands in `90..180`).
    Grid assumes the sample starts on the grid (first slice at position `0`). BPM and division are
    both editable.
- **Start-Key** — adjustable, default `C3 (60)`. When triggered by **shift-dropping onto a slot**,
  the default is that slot's key instead.
- **Max-Keys** — adjustable, default `16`, `0` = infinite. Capped by the MIDI range: at most
  `128 - startKey` slices. If slices exceed the cap, the extra slices past the cap are **dropped**.
- **Override scope** — only the target key range (`startKey .. startKey + count - 1`) is replaced.
  Slots on keys outside that range are left untouched.
- **Overflow** — when there are more onsets/grid-cells than keys, only the first `cap` slices are
  kept; each kept slice ends at its next boundary (the last kept slice ends at the next transient,
  NOT the end of the file, so it does not swallow the ahead material). The tail past the cap is
  simply left unassigned. The final slice reaches the end of the file only when it is genuinely the
  last boundary.
- **Slice bounds** — contiguous: slice `i` spans boundary `i` to boundary `i+1`
  (`sample-start[i] == sample-end[i-1]`).
- **Slot playback** — one-shot with a choke group: `gate = Off`, `polyphone = false`,
  `exclude` set so re-triggering within the chop chokes the previous hit. Small `attack`/`release`
  to avoid clicks.

## Triggers (all three)

1. **Drop a sample onto the Playfield device body** (not a slot) — chops into the currently-open
   Playfield. Requires a new device-level drop target (none exists today).
2. **Browser sample context menu** — "Auto-chop into Playfield". If there is no current Playfield
   target, create a new instrument (`InstrumentFactories.Playfield`) and chop into it.
3. **Shift-drop a sample onto a slot** — opens the dialog with Start-Key = that slot's key.

All three converge on: resolve `Sample`/uuid → `AudioData` → open the dialog → on approve, call the
single adapter bake method.

## The dialog (large, app-like, two-phase)

A large modal (`Dialog.tsx`, explicit large `style` width/height, styled like its own mini-editor),
built around a **navigatable** waveform, not a static one.

### Navigatable waveform (reuse timeline components)

- Reuse `TimelineRange` (`studio-core/ui/timeline/TimelineRange.ts`) as the units↔pixel model, with
  units = sample frames (`maxUnits = numberOfFrames`). It already provides `unitToX` / `xToUnit`,
  `unitsPerPixel`, `unitMin/unitMax`, zoom and scroll.
- Render peaks through `AudioRenderer.render` (`studio-core/ui/renderer/audio.ts`), which draws
  `file.peaks` into a `TimelineRange` via `PeaksPainter` — the same path the timeline's audio
  regions use. Peaks from `AudioFileBoxAdapter.peaks` / `sampleManager.getOrCreate`.
- Reuse `TimelineRangeSlider` for the scroll/zoom bar and `WheelScroll` for wheel zoom+pan, so the
  waveform navigates exactly like the timeline.
- **Slices are vertical lines only** — one line per boundary drawn at `range.unitToX(boundary)`. No
  overlay, no fills, no alternating tint.

### Two phases

**Phase 1 — pre-slice (mode active).** The pre-slice controls (Mode, BPM, Division, Max-Keys) are
enabled and drive the boundary set:
- **Transients / Grid** plus their options (Grid: BPM + Division), and Max-Keys.
- Changing any of these (or Start-Key, which changes the MIDI-range cap) regenerates the boundaries
  live from scratch. **The cap is applied here, at generation** — the boundaries past the cap are
  dropped from the stored set, not just hidden.
- No manual boundary editing yet.

**Phase 2 — edit (auto-slicing stopped).** The moment the user manually edits a boundary, the
pre-slice controls (Mode, BPM, Division, Max-Keys) go **disabled** and the boundary set is frozen —
**any manual change stops auto-slicing entirely**. No auto process (mode regeneration OR the Max-Keys
cap) may add or backfill a slice afterwards; deleting a slice really reduces the count. Only the
MIDI-range validity cap (`128 − startKey`) still trims, since Start-Key stays live. Editing:
- **Click a slice** (between lines) to audition it once (plays `[start,end]` of the file via a
  one-shot `AudioBufferSourceNode` on `service.audioContext`; auditioning does NOT enter edit phase).
- **Drag** a boundary line to move it (stays contiguous; clamps between its neighbours).
- **Alt-click the waveform** between lines to split (add a slice).
- **Alt-click a line** to delete that boundary (its two slices merge).

Cursor feedback (reuses `installCursor` + `ElementCapturing` + the `Cursor` enum, extended with
`Speaker` + `Erase`): over a line → `ew-resize` (drag), or `Erase` when Alt is held (delete); between
lines → `Speaker` (audition), or `Scissors` when Alt is held (split). Re-evaluates on Alt keydown/up.

**Reset.** A `Reset` button returns to Phase 1: it re-enables the pre-slice controls and re-slices
from the current mode/options, discarding manual edits. This is the only way back to pre-slicing.

### Controls & buttons

- Max-Keys lives with the pre-slice controls (it only bounds generation; frozen in edit).
- Start-Key stays live in both phases (placement; re-clamps via the MIDI-range cap, never backfills).
- **Live key/slice count** readout so `0 = infinite` and the MIDI-range cap are visible.
- **Buttons** — `Reset` (back to Phase 1), `Cancel` (close, no change), `Chop` (primary: call the
  bake method, then close).

Internal boundary model: an array of normalized positions `[0 .. 1]` over the whole file, strictly
increasing, `boundaries[0] == 0`. The last boundary is `1.0` only when the slicing genuinely reaches
the file end; on overflow it is the last kept transient (tail dropped). Slices = adjacent pairs.
Transients map seconds→normalized via `position / duration`; grid maps beat times→normalized, tiling
from `0` with a trailing partial slice to the end. The cap truncates the stored boundary array at
generation time.

## Single bake method (per user constraint)

One method on `PlayfieldDeviceBoxAdapter` does the whole job from an options object:

```ts
type PlayfieldChopOptions = {
    file: AudioFileBox            // the shared source
    startKey: number             // MIDI key of the first slice
    slices: ReadonlyArray<{start: number, end: number}>  // normalized 0..1, contiguous, already capped
}

chop(options: PlayfieldChopOptions): void
```

Behaviour:
- Delete existing `PlayfieldSampleBox`es whose `index` is in `[startKey, startKey + slices.length - 1]`
  (target-range override only).
- For each slice `i`, create a `PlayfieldSampleBox` sharing `options.file`:
  `device.refer(box.samples)`, `index = startKey + i`, `sample-start = slice.start`,
  `sample-end = slice.end`, `gate = Off`, `polyphone = false`, `exclude` = the chop choke group,
  small `attack`/`release`.
- All in one box-graph transaction.

The dialog owns mode/grid/transient math and boundary editing and hands the adapter a
already-resolved, already-capped slice list. The adapter method is pure box mutation — no worker,
no detection, no UI. Overflow (last slice → end) is already encoded in the slice list the dialog
produces, so the adapter needs no special-casing.

## Slice generation (in the dialog / a small helper, not the adapter)

- **Transients**: `Workers.Transients.detect(audioData)` → seconds (already includes `0` and EOF).
  Normalize by duration. If the sample was slot-loaded it may have no cached markers; detect on
  demand (idempotent, results cached on the `AudioFileBox`).
- **Grid**: `beats = bpm * duration / 60`; slice length = `60 / (bpm * (1 / division))` seconds
  (division as a fraction of a whole note, e.g. `1/16`). Tile from `0`, trailing partial slice to
  EOF.
- **Cap**: keep at most `maxKeys` slices (or `128 - startKey` when infinite / when `maxKeys` would
  exceed the MIDI range); the last kept slice's `end` is forced to `1.0`.

## New / touched files

- `PlayfieldDeviceBoxAdapter.ts` — add `chop(options)`.
- New `PlayfieldDeviceEditor/ChopDialog.tsx` (+ sass) — the large editor dialog; owns a
  `TimelineRange`, `AudioRenderer.render`, `TimelineRangeSlider` + `WheelScroll`, and the two-phase
  state (pre-slice ↔ edit, Reset).
- New `PlayfieldDeviceEditor/ChopModel.ts` — boundary model + transient/grid generators + cap logic +
  edit ops (drag/split/merge).
- `PlayfieldDeviceEditor.tsx` / `SlotGrid` — device-body drop target that opens the dialog.
- `EmptySlot.tsx` / `BusySlot.tsx` (slot drop) — intercept shift-drop → open dialog with that key.
- `SampleView.tsx` (browser) — context-menu item "Auto-chop into Playfield".

## Engine

No engine change. The Rust `device-playfield-sample` already reads `sample-start`/`sample-end` as
`0..1` of the whole file (`last * fraction`) and filters note-on by `index`. Chopping is pure
box-graph authoring; existing slot playback covers it.

## Open follow-ups (non-blocking)

- Default mode on open (Transients vs Grid) — default to Transients; revisit after first use.
- Optional slice audition (click a slice to preview its audio) — nice-to-have, out of scope for v1.
