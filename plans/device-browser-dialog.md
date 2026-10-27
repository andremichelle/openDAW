# Device Browser Dialog

One dialog to browse, audition and create everything that goes into a device chain: stock devices, user and stock
presets, community scripts and WebCLAP plugins. It replaces the sidebar device browser and the "Add Effect" dropdown.
Like in Bitwig, a "+" button sits at every insert position of the device panel and opens the dialog for exactly that
position. The same dialog replaces an existing device. Every pick is applied immediately, so the user hears it before
deciding.

## Status

Branch `browser-refresh`, main merged in (26e0355f4).

- `ui/browse/DeviceBrowser.tsx` already flattens stock devices, presets and community scripts of one category into a
  single sorted list (commit "init"). A single click opens an animated details row below the item, a double click
  creates.
- WebCLAP plugins are not part of that list. They only live in `ui/browse/WclapBrowser.tsx` (dashboard resources,
  local or cloud). This is why Xenon is missing.
- `ui/devices/AddEffectButton.tsx` is a dropdown of stock audio effects, used by `NoEffectPlaceholder` and
  `AudioEffectCompositeDeviceEditor`.
- The timeline "Add instrument" button (`AudioUnitsTimeline.tsx`) is a dropdown of stock instruments.
- `SpotlightCreate` already creates devices, presets, scripts and WebCLAP plugins. The dialog reuses its create logic
  and extends it with an insert index.
- Device context menus (`ui/devices/menu-items.ts`) save instrument, effect and chain presets.
- `BoxEditing` (`lib/box/src/editing.ts`): `modify(fn, false)` collects changes as pending without an undo step,
  `revertPending()` rolls them back, `mark()` seals them as one step.
- Replacing exists: `api.replaceMIDIInstrument`, `api.insertEffect`, `PresetDecoder.replaceAudioUnit`, used by the
  drop handlers in `DevicePanelDragAndDrop.ts`.

## Dialog

A modal dialog (`showModal`, house dialog style), not a FloatingWindow. It sits above the device panel at a fixed size
and never covers it, so the auditioned device stays visible.

Layout:

- Top: filter bar with the stock, user, scripts and WebCLAP toggles, the local or cloud filter for WebCLAP, and the
  search field, focused on open.
- Left: the flat list of every entry that fits the insert position, sorted by name.
- Right: the info card of the selected entry: name, kind (stock device, user preset, stock preset, community script,
  WebCLAP plugin), host device, author or vendor, license, size, description, tags.

## Tags

Every entry carries tags: stock devices, user and stock presets, community scripts (already tagged) and WebCLAP plugins
(their CLAP features). The search matches names and tags, and the info card lists the tags of the selected entry. A
click on a tag puts it into the search. Presets get a tags field in their meta, user presets are tagged in the preset
edit dialog, stock presets carry tags from opendaw-commons.

## Opening

- Create: a "+" at an insert position, or the timeline "Add instrument" button. Nothing changes until the first pick.
- Replace: a click on the device icon in a device header, or "Replace…" in the device context menu. The current device
  is preselected in the list.

## Auditioning

1. A single click selects the entry, updates the info card and applies it right away: it creates the device at the
   insert position, or replaces the device the dialog was opened for. No expanding rows, the height animation goes.
2. Every further pick reverts the previous candidate first, then applies the new one. Arrow keys pick the same way.
3. Enter approves: the result becomes ONE undo step ("Add Xenon", "Replace Delay with Xenon") and the dialog closes.
   Enter without a pick just closes.
4. Escape or Cancel cancels: everything reverts to the state before opening and the dialog closes.
5. Candidates are applied with `modify(fn, false)` and reverted with `revertPending()`, approve calls `mark()`. Leftover
   pending UI state from before opening is sealed or kept apart so a revert never touches it.
6. Undo and redo are blocked while the dialog is open, `undo()` would seal the half applied candidate.
7. Space and the transport shortcuts keep working in the dialog, also with the search field focused, so the user can
   listen while picking. MIDI input keeps playing the instrument.

## Loading

- WebCLAP downloads, cloud presets and script compiles are asynchronous. Only the latest pick wins (generation
  counter), a loading row shows a spinner, Enter waits for the pending load.
- `SpotlightCreate`, `PresetApplication` and the script compile mark their own undo steps today. They get an unmarked
  path for auditioning.
- Prompts like "Replace Timeline?" never pop up per pick. Auditioning keeps the timeline, the question is asked once on
  Enter.

## Replace rules

- Effects swap for effects of the same chain kind at the same index.
- A MIDI instrument swaps only for another MIDI instrument, Tape never swaps with a MIDI instrument. The list only
  shows what can replace the device.
- Tracks, regions and the effect chains of the audio unit stay.
- Automation and modulation of the replaced device are lost, but only while auditioning. Escape restores them.
- Live room: collaborators see every candidate. A concurrent edit can make the revert fail, then a notice is shown.

## Info card

- User preset actions (Edit, Duplicate, Upload, Delete, Save to Disk) are buttons in the info card.

## Insert positions

Every possible insert position gets a "+" button:

- MIDI chain: before the first effect, between two effects, after the last effect.
- After the instrument, which inserts at audio index 0.
- Audio chain: between two effects and after the last effect.
- An empty chain shows its "+" too (replaces the "Add Effect" placeholder button).
- Composite cells use the same panel, so their chains get the same buttons.

The dialog only lists what fits the position: MIDI effects with their presets and Spielwerk scripts, or audio effects
with their presets, Werkstatt scripts and WebCLAP effects.

The timeline "Add instrument" button opens the dialog with instruments, their presets, Apparat scripts and WebCLAP
instruments. The first pick creates a new track, further picks replace its instrument, Escape removes the track again.

A companion button "Add Audio Track" sits next to it and creates a Tape device right away, without the dialog.

## Dragging

Dropped. The "+" buttons cover every insert position, replace covers dropping onto a device, the timeline buttons cover
creating tracks. Dropping a device onto a browser row to save a preset is gone too, the device context menus remain the
way to save. Moving devices inside the device panel stays as it is.

## Phases

Each phase ends with a browser check by André.

1. The dialog with auditioning: list, info card, filters, WebCLAP entries, create and replace with revert and approve.
   Opened from the empty chain placeholder and the device icon.
2. The "+" buttons at every insert position, "Replace…" in the device context menu, the timeline "Add instrument"
   button opening the dialog, and the "Add Audio Track" button.
3. Remove the Instruments, AudioFx and MidiFx tabs from the sidebar browser, update the tour steps (`presets`,
   `clips`) and `BrowseScope`.
4. Tags: an optional `tags` field in the preset meta (additive, SDK safe), tags for every stock device, the CLAP features
   of WebCLAP plugins, tag search and clickable tags in the info card, tag editing in the preset edit dialog. Stock
   preset tags need the preset API (api.opendaw.studio) to deliver them.

## Out of scope

- Racks and chains (audio unit, audio effect chain, MIDI effect chain presets) are not listed yet. Remind André
  before deploying.

## Implementation (2026-10-27, all phases, browser-unverified)

- `BoxEditing.checkpoint()` (lib-box, additive): everything edited after it, marked, appended to the previous step
  or pending, rolls back or commits as ONE undo step. Needed because device editors write their own marked steps
  while auditioning (WebCLAP parameter sync, script compile appends). Other `Editing` implementations fall back to
  `revertPending` and `mark`.
- `ui/browse/DeviceSlot.ts` (where), `DeviceCatalog.ts` (what), `DeviceAudition.ts` (pick, approve, cancel),
  `DeviceDialog.tsx` (the dialog), `DeviceTags.ts` (stock tags).
- "+" buttons: `ui/devices/panel/InsertButton.tsx`, wired in `DevicePanel.tsx`. They carry no `data-drag`, so drop
  insert indices stay as they were.
- Replace opens from "Replace…" in the device context menus. The device icon still minimizes, see open question 1.
- Tape is not listed in the instrument dialog, "Add audio track" creates it.
- No preview pictures in the info card: the picked device itself is the preview. The "Add Effect" placeholder in an
  empty chain is gone, the "+" buttons cover it.
- The dialog is bottom-aligned with the top of the device panel and keeps 16px to the app header.
- The sidebar keeps Samples and Soundfonts, `DeviceBrowser`, `DeviceItem`, `PresetItem` and `ScriptItem` are deleted.
- Undo steps carry no names, `BoxEditing` has no step labels.

## Open questions

1. The device icon click minimizes the device today, it is the only way to minimize. Replace via icon click needs a
   new home for minimize.
2. The drop handlers for presets, scripts and instruments in `DevicePanelDragAndDrop` and the timeline have no drag
   source left. Remove them, or keep them for drags from elsewhere?
