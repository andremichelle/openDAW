# Audio unit into a Composite

Status 2026-09-21: both features implemented, tested in core (10 tests), core-wasm (wrap while playing) and by
hand in the studio. The dialog for both-have-notes exists (decision 3). Uncommitted.

Two ways to get an existing chain into an Instrument Composite. Follows `plans/instrument-composite.md`.
Rule 0 applies: nothing existing changes behaviour, both features are new entry points only.

## 1. Drop a new Composite onto an existing instrument: wrap the chain

Today `DevicePanelDragAndDrop` drops a browser instrument onto the unit's instrument slot and calls
`ProjectApi.replaceMIDIInstrument`, which deletes the old instrument. When the dragged instrument is the
Composite, the unit's whole chain becomes layer 1 of the new Composite instead:

- create `InstrumentCompositeBox` in the unit's input, create one `InstrumentCompositeCellBox`
- re-host by pointer only, no copy: the instrument's `host` -> `cell.instrument`, every midi effect's `host` ->
  `cell.midiEffects`, every audio effect's `host` -> `cell.audioEffects`, indices kept
- automation lanes keep their targets (the boxes do not move), regions, clips, sends and the strip stay on the
  unit, the layer strip starts at 0 dB / centre / unmuted
- a Composite dropped onto a Composite nests it (layer 1 hosts the old Composite), same as any instrument
- Tape and MIDI Output cannot be wrapped (`isLayerInstrument` false): the drop is refused, nothing changes
- API: `ProjectApi.wrapInstrumentIntoComposite(instrumentBox): Attempt<CompositeLayerProduct, string>`

Same wrap from the Add Layer / browser drop paths is NOT part of this: only the instrument-slot drop of a NEW
Composite. Dropping a Composite preset (rack) is unchanged.

Engine: re-hosting live is the "swap the instrument" and `moveEffects` path the wasm engine already reconciles,
covered by `instrument-composite-e2e` and the moveEffects tests. Add one core-wasm test: wrap a playing unit,
peaks unchanged before and after.

## 2. Copy AudioUnit / Paste AudioUnit as a layer

`AudioUnitsClipboard` already serialises a unit (`"audio-units"` entry) on Cmd+C in the timeline. Missing is a
menu entry to do the same from elsewhere, and a paste that turns the entry into a LAYER.

Copy AudioUnit (menu item, label `Copy Audio Unit`)
- track header menu (`AudioUnitTrackHeader`)
- every device menu: `forAudioUnitInput`, `forEffectDevice`, `forCompositeCell` (inside a layer the whole unit)
- `ClipboardManager.write(entry)` exported: sets the fallback entry, writes the text, shows the toast, exactly
  what Cmd+C does

Paste AudioUnit (menu item on the Composite device, label `Paste Audio Unit as Layer`)
- selectable when the session's fallback entry is an `"audio-units"` entry. The system clipboard is async and
  cannot be read while the menu builds, so an entry copied in ANOTHER tab does not enable the item. On trigger
  the system clipboard is read first, then the fallback.
- `PresetDecoder`-style decode into a new layer: the entry's instrument plus both chains are cloned into a new
  last layer (`TransferUtils.deviceDependencies` / `mapUuids` / `cloneBoxes`, pointer map: `InstrumentHost` ->
  `cell.instrument`, effect hosts -> the cell's chains, modulators via `mapModulatorCollection`)
- the unit's strip is carried: volume -> gain, panning -> pan, mute -> mute, solo -> solo
- it must sound the same (decision 1): the unit's tracks travel too, appended as new lanes of the Composite's
  unit with their regions, clips and events. Automation lanes re-target the cloned devices through the uuid map,
  lanes on the unit's own volume / panning / mute / solo re-target the layer's gain / pan / mute / solo
- dropped: sends, capture, the unit box itself
- Tape and MIDI Output units are refused with a notice
- API: `ProjectApi.pasteAudioUnitAsLayer(composite, data): Attempt<CompositeLayerProduct, string>`, the
  decode lives next to `PresetDecoder.replaceLayerInstrument`

## Tests (test-first, per feature)

- core: wrap keeps every box uuid, indices and automation targets, refuses Tape / MIDI Output, nests a Composite
- core: paste as layer clones instrument + chains, carries the strip, appends the tracks with regions, clips and
  re-targeted automation, drops sends, refuses Tape
- core-wasm: wrap while playing renders the same peaks
- app: none automated (menus), browser check by hand

## Decisions

1. A pasted unit must sound the same: its tracks are appended to the Composite's unit, nothing is dropped but
   sends and capture.
2. Paste Audio Unit as Layer lives in the Composite's device menu only.
3. When the clipboard's unit and the Composite's unit both hold notes, a dialog asks: drop the copied notes,
   replace the existing notes, or append. Empty copied note lanes are never appended.
