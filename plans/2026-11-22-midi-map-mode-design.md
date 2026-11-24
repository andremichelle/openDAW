# Design: MIDI Map Mode & MIDI Mapping view (`MIDI-CORE-02`, MIDI only)

Branch: `feat/midi-map-mode`. Source: [plans/midi-feature-roadmap.md](https://github.com/BLyndon/openDAW/blob/midi-roadmap/plans/midi-feature-roadmap.md), `MIDI-CORE-02`.

## Intent

Mapping a hardware controller to openDAW parameters today means right-clicking every control, choosing
"Learn Midi Control...", and confirming a modal. There is no overview of what is mapped, no way to limit
the range, and no protection against value jumps. This feature turns mapping into a mode: switch it on,
see every assignable control, click one, move a knob, done. It also adds one place to review and tune all
mappings.

## Goals

- **MIDI Map Mode** toggle. While on, every assignable control is clearly highlighted; mapped controls look
  different from unmapped ones; the selected target is marked.
- **One-click binding:** click a control in map mode, move a hardware CC, the binding is created. Moving a
  CC with a target that is already mapped replaces its binding.
- **MIDI Mapping view:** a new workspace screen with its own header button. Layout like the Modulation
  screen: Browser left, mapping list on top, Devices panel below, so the mapped controls are visible
  while mapping.
- **List columns:** Port/Channel, CC, Track/Device, Parameter, Min, Max, Takeover, Encoding. Search, sort
  by column, click a row to locate (select the audio unit's device chain), multi-select + delete.
- **Min/Max per binding** in the parameter's unit range; `Min > Max` inverts the control.
- **Takeover modes** for absolute CCs: Jump, Pickup, Value Scaling. **Relative encoders** in three common
  encodings.
- **Persistence** in the project file (`project.od`, thereby also in the exported `.odb` bundle).
- **JSON export/import** of mappings as a local file, no network.

## Non-goals

- Key Map Mode (computer keyboard mapping does not exist yet; separate feature).
- Note messages as mapping sources (only CC; notes would collide with playing instruments).
- A global header toggle for map mode; the toggle lives in the MIDI Mapping screen.
- Deciding the final panel placement: the list is a standalone panel so the maintainer can put it
  elsewhere later.
- 14-bit CC (MSB/LSB pairs), NRPN.

## Anti-goals

- Changing the existing right-click "Learn Midi Control..." flow in a way users notice. It stays and uses
  the same binding code.
- Breaking existing projects: projects saved before this change must load with identical behaviour
  (Jump, absolute, full range).
- Allocations or UI work on the audio thread; all of this runs on the main thread like today.

## Current state (verified)

- `MIDIControllerBox` (`packages/studio/forge-boxes/src/schema/std/MIDIControllerBox.ts`) holds
  `controllers`, `parameter`, `device-id`, `device-channel`, `control-id`. It is `ephemeral: true`, which
  only excludes it from copy/paste and transfers. It **is** written to `project.od`: a save/load round
  trip keeps the box and the live connection (checked with a temporary test).
- `MIDILearning` (`packages/studio/core/src/midi/MIDILearning.ts`) owns the bindings per
  `UserInterfaceBox`, listens to CC messages and sets `adapter.setUnitValue(value)` directly (= Jump,
  absolute, 0..1).
- Mapped controls get the CSS class `midi` via `catchupAndSubscribeControlSources` and a 1 px orange
  `box-shadow` (`AutomatableControl.sass`).
- Every parameter control passes through one of `attachParameterContextMenu`,
  `attachModulatorParameterContextMenu`, `attachAssignmentDepthContextMenu` in
  `packages/app/studio/src/ui/menu/automation.ts`, each with the element, the parameter and `MIDILearning`.
- `TargetList` (`ui/modulation/TargetList.tsx`) already renders "owner + parameter, click to locate,
  delete" rows for modulation targets and is the template for the mapping rows.

## Approaches

The UI placement was decided in conversation:

1. **Modal dialog**: fastest, but openDAW dialogs use `showModal()`, so the list hides the controls being
   mapped and click-to-locate has to close it first. Rejected.
2. **Panel in an existing screen**: right fit long-term, but where is the maintainer's call (open
   question 1 in the roadmap).
3. **Own workspace screen (chosen)**: mapping list + Devices panel side by side, like the Modulation
   screen. The list is a standalone `PanelType`, so moving it into another screen later is a layout
   change in `Default.ts` only.

For the highlighting hook, two ways were considered: touching every control call site, or registering the
element inside the three `attach*ContextMenu` functions that every control already calls. Chosen: the
latter (one place, no call-site changes).

## Design

### Schema (`MIDIControllerBox`, new fields, defaults keep old behaviour)

| key | name       | type    | default | meaning                                                                                |
| --- | ---------- | ------- | ------- | -------------------------------------------------------------------------------------- |
| 6   | `min`      | float32 | 0.0     | unit value at controller minimum                                                       |
| 7   | `max`      | float32 | 1.0     | unit value at controller maximum; `min > max` inverts                                  |
| 8   | `takeover` | int32   | 0       | 0 Jump, 1 Pickup, 2 Value Scaling (absolute only)                                      |
| 9   | `encoding` | int32   | 0       | 0 absolute, 1 relative two's complement, 2 relative binary offset, 3 relative sign bit |

The builder verifies that a project saved before the change decodes the missing
fields with these defaults; if not, a migration sets them on load.

### Value transform (pure, unit-tested, `studio-core`)

A small module next to `MIDILearning`, e.g. `MIDIMappingTransform`, no DOM, no box access:

- Absolute: `controller = cc / 127`, `target = min + controller * (max - min)`.
- **Jump:** apply `target`.
- **Pickup:** ignore until the controller crosses the parameter's current value mapped into controller
  space (`(current - min) / (max - min)`), i.e. the last and the new controller value lie on different
  sides of it, or the new value is within one step of it. Then follow like Jump.
- **Value Scaling:** move the parameter toward the controller's end in proportion to the controller's
  movement so both meet at the end of travel: moving up,
  `next = current + (max - current) * (c - last) / (1 - last)`; moving down symmetrically toward `min`.
  Without a known last controller value the first message only records it.
- Relative: decode a signed tick delta per encoding (two's complement: 1..63 up, 127..65 down;
  binary offset: 65.. up, 63.. down; sign bit: 1..63 up, 65..127 down), `next = clamp(current + delta *
step * (max - min))`, clamped between `min` and `max`, step = 1/128. Takeover does not apply.
- "current" is the parameter's unit value via `adapter.getUnitValue()`. Per-binding state (`last`
  controller value, picked-up flag) lives in the connection, not in the box.

### Map mode (`MIDILearning`)

- `mapMode: DefaultObservableValue<boolean>` and `mapTarget: MutableObservableOption<Address>`.
- `registerMapTarget(element, field): Terminable`, called from the three `attach*ContextMenu` functions
  (returned together with the context menu subscription). It toggles CSS classes on the element:
  `midi-map-assignable` while map mode is on, `midi-map-target` when it is the selected target. While
  map mode is on, a capture-phase `pointerdown` selects the target and stops the event so knobs don't
  start dragging.
- While map mode is on and a target is selected, one MIDI subscription waits for the next CC and creates
  the binding through the same code path as `learnMIDIControls` (extracted), replacing an existing
  binding on that parameter. The target stays selected so the user can re-learn; leaving map mode clears
  it.
- Fixes along the way: the learn path keeps the channel it read; the handler checks channel and CC.

### Highlighting (CSS)

- Assignable, unmapped: clear colored outline (2 px) + tinted background in one color.
- Mapped (`midi` class) during map mode: filled tint + outline in a second, distinct color (orange family,
  matching today's hint, but strong).
- Selected target: thicker outline / pulse. Outside map mode the existing subtle orange hint stays as is.
- Concrete colors: builder's call from the existing tokens, checked in dark theme.

### MIDI Mapping panel + screen

- `PanelType.MIDIMapping`, `PanelFactory` case, `PanelContent` entry; component
  `ui/midi-mapping/MIDIMappingPanel.tsx` takes only `{lifecycle, service}`.
- Screen `"midi-mapping"` in `DefaultWorkspace` (Browser | MIDI Mapping over Devices), icon from
  `IconSymbol` (builder picks an existing fitting one).
- Panel header: Map Mode toggle, search field, Export, Import, Delete selected.
- Rows: subscribe to `controllers.pointerHub` of the followed user (like `TargetList` renders from a
  pointer hub). Track/Device name resolved via the parameter address (same approach as
  `ModulationBoxAdapter.catchupAndSubscribeTargetOwner`). Min/Max shown with the parameter's
  `stringMapping` and editable by drag; Takeover and Encoding as dropdowns. Clicking the owner name calls
  `userEditingManager.audioUnit.edit(...)`.
- Sorting and search are view state only, not stored.

### JSON export / import

- Export writes `{version, mappings: [...]}` via the existing file save helper; each mapping has channel,
  CC, device id, encoding, min, max, takeover and its target.
- Target identity (decided): each mapping stores the parameter address (box UUID + field keys) **and**
  descriptive names (track/audio unit label, device label, parameter name). Import first resolves the
  address in the current project; if it is not found, it matches by the three names. A name match that
  is ambiguous (more than one candidate) or missing is skipped. After import a notification reports
  imported, replaced and skipped counts. Imported mappings replace existing bindings on the same
  parameter.
- The format carries a `version` so later changes can migrate.

### Slicing (commits; may become two PRs as the roadmap suggests)

1. Schema fields + transform module + tests (no UI change).
2. `MIDILearning`: apply transform; extract the binding code; map mode state + `registerMapTarget`;
   CSS. (Roadmap PR 2.1)
3. MIDI Mapping panel + screen. 4. JSON export/import. (Roadmap PR 2.2)

## Verification

- Vitest in `studio-core`: transform (all takeover modes, inversion, each relative encoding, clamping),
  save/load round trip with new fields, old project without fields loads with defaults.
- Type check with `--noEmit`; existing test suites green.
- Browser check in the dev server: map mode highlighting, click-to-bind (MIDI input simulated if no
  hardware), list edits, locate, export/import.

## Open questions

- For the maintainer later: final panel placement; whether map mode belongs in the global header.

## Left to the builder

Exact colors, icon, step size fine-tuning for relative encoders, Pickup tolerance, file names of new
modules, row layout details.

## Revision 2026-11-24 (maintainer)

The open questions are decided. These changes were made on top of PR 571 and PR 572.

### One MIDI button

- The MAP button, the Esc handler and the Shift+9 shortcut are gone. The MIDI button in the header does it all.
- MIDI off: pressing the button turns MIDI on. `MidiAccessOnLoad` still turns it on automatically when the
  browser granted permission before.
- MIDI on: the button shows a small triangle below the icon and opens or closes the MIDI Mapping screen.
  Closing returns to the previous screen.
- The screen opens in the same area as the code editor and the layers overview (`editorScreen`, hidden from
  the screen menu, opened through `StudioService.openCodeEditor` with a `MIDIMappingScreenState`).
- Map mode is on exactly while the MIDI Mapping panel exists. There is no separate toggle.

### Highlighting

- The frame goes onto the control source indicator ring that `AutomationControl` and the modulation
  controls already draw, and onto the `AutomatableControl` element itself. No `getComputedStyle` walk and no
  waiting for the element to be attached.
- `MapTarget.select` (target selection on pointer down) and `MapTarget.frame` (classes) are separate.

### Devices per mapping

- New field `filter-device` (key 10, default off) on `MIDIControllerBox`. Off means all devices, so existing
  projects behave as before.
- The MIDI Device column is a menu like a track's note input: "All devices" or one device, each with
  "All channels" or "Channel 1" to "Channel 16".
- A device is identified by the browser's id, like the track note input. A mapping set to one device shows
  "Unavailable device" when that device is not connected.

### Mapping again

- Mapping a parameter that already has a mapping updates its CC, channel and device in place. Min, Max,
  Takeover, Encoding and the device filter stay.
- A mapping on "All channels" is not changed to the channel the CC came from.

### Values

- Relative encoders move parameters with few steps: the transform keeps the unrounded value between ticks
  as long as nothing else changed the parameter.
- Reset Value stays as it is, it resets the parameter, not the mapping range.

### List and presets

- The list updates when a track or device is renamed and when a mapping's CC, channel or device changes.
- Takeover is disabled while the encoding is relative.
- Import is one undo step. Export and import report errors, only a cancelled file dialog is silent.
- The preset entry gains `filterDevice`. Channel and CC must be whole numbers, takeover and encoding must be
  known enum values.
- `MIDITakeover`, `MIDIEncoding`, `MIDIMappingState` and `MIDIMappingTransform` each have their own file.
