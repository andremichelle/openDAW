# UAT: MIDI Map Mode & MIDI Mapping view (`MIDI-CORE-02`, MIDI only)

Manual acceptance test with a real MIDI controller. Covers the whole feature on `feat/midi-map-mode`
(all commits), not a single commit.

## Setup

- Dev server of this branch running (`studio-midi-mapping`, http://localhost:8085; the asset server only allows
  ports 8080–8089, see F-12), WASM engine rebuilt
  after the schema change (`npm run build-wasm`).
- Controller connected **before** the page is loaded. Ideally it has: one absolute knob (K1), a second
  absolute knob (K2), one fader (F1), one button sending CC (B1), optionally one endless encoder (E1).
- Header button "Midi Access" is orange (access granted). If not, click it and allow MIDI.
- New project, add two audio tracks ("Audio Track", "Audio Track 2").
- Record for each case: Pass / Fail / Not tested, plus a note. Note the controller model and browser.

| Controller | Browser + version | OS    | Build / commit |
| ---------- | ----------------- | ----- | -------------- |
| UC-33      | Chrome 157        | macOS | ecb386629      |

## Test cases

### A. Map mode and highlighting

Sections A and B test the MAP button of the original PR. After the revision of 2026-11-24 the MIDI button
replaces it, see section H.

| ID   | Steps                                                               | Expected                                                                                                                | Result |
| ---- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------ |
| A-01 | Click MAP in the header (right of the MIDI icon).                   | Button turns purple. Every assignable control (track header knobs, M/S, fader in Devices) gets a purple frame.          | Ok     |
| A-02 | Switch views with Shift+1, Shift+2 (mixer), Shift+9 (MIDI Mapping). | Map mode stays on in every view; mixer pan knobs and faders are framed too.                                             | Ok     |
| A-03 | Click the header button again.                                      | All frames disappear, button is no longer purple.                                                                       | Ok     |
| A-04 | Map mode on, click the volume fader of "Audio Track".               | Fader frame turns yellow and pulses. The fader value does **not** change. The MIDI Mapping view shows "Target: Volume". | Ok     |

### B. Binding

| ID   | Steps                                                                                                 | Expected                                                                                                                                                                          | Result                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| B-01 | Target = volume of "Audio Track" (A-04). Turn K1.                                                     | Binding is created immediately; the target is released, the frame turns orange; the fader follows K1. Row in MIDI Mapping: your port name, channel, K1's CC, Audio Track, Volume. | learning works, but it doesn't turn orange - stays pulsating, see findings from section A. Fixed in F-3, retest |
| B-02 | After B-01, turn K1 again several times.                                                              | Still exactly one row for Volume (no duplicates).                                                                                                                                 | Ok                                                                                                              |
| B-03 | Turn K2 first (nothing may change), then click the fader again and turn K2.                           | Turning K2 alone leaves the binding on K1. After re-selecting the fader, the Volume row shows K2's CC; K1 no longer moves the fader.                                              | Only after leaving, the old control doenst move the fader anymore. Fixed in F-4, retest                         |
| B-04 | Click the pan knob of "Audio Track", turn K1. Turn K1 to its middle detent (or as close as possible). | Pan follows K1; at the hardware centre the pan reads centre (0 / C). Note the value if it is off by one step.                                                                     | Ok                                                                                                              |
| B-05 | Click Mute of "Audio Track 2", press B1.                                                              | Mute follows the button (on at 127, off at 0). Note whether B1 sends toggle or momentary.                                                                                         | Ok                                                                                                              |
| B-06 | Map mode off. Right-click a control, "Learn Midi Control...", move F1.                                | Classic learn still works and the binding appears in the list. "Forget Midi" removes it.                                                                                          | Ok                                                                                                              |

### C. Range and inversion

| ID   | Steps                                                                                                                                                                                                                                           | Expected                                     | Result                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| C-01 | In the Volume row set Max to `-12` (dB), Enter. Turn K2 fully up.                                                                                                                                                                               | Max shows -12.00; the fader stops at -12 dB. | Value seems to be unsigned? - not possible to put a minus there. Fixed in F-7, retest |
| C-02 | Set Min to `0` (dB), i.e. Min > Max. Turn K2 from down to up.                                                                                                                                                                                   | Inverted: K2 down → 0 dB, K2 up → -12 dB.    | No negative values possible, inversion worked with min 6 max 0. Fixed in F-7, retest  |
| C-03 | In the Volume row type Min back to `-inf` (a very low value, e.g. `-100`) and Max back to `6`. There is no reset command for Min/Max; "Reset Value" in the control's context menu resets the parameter (fader position), not the mapping range. | Full range again.                            | Ok, but see F-6                                                                       |

### D. Takeover

| ID   | Steps                                                                                                                   | Expected                                                                                                                    | Result |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------ |
| D-01 | Takeover = Jump. Put K2 at its minimum. Drag the fader with the mouse to about -6 dB. Turn K2 slightly.                 | Fader jumps to K2's position.                                                                                               | Ok     |
| D-02 | Takeover = Pickup. K2 at minimum, fader dragged to about -6 dB with the mouse. Turn K2 up slowly.                       | Fader does not move until K2 passes the fader's position, then it follows.                                                  | Ok     |
| D-03 | Pickup again: after pickup, drag the fader with the mouse to another value, then turn K2.                               | Fader waits again until K2 crosses the new value.                                                                           | Ok     |
| D-04 | Takeover = Scaling. K2 at about 25 %, fader at about 75 % (mouse). Turn K2 up to its maximum, then down to its minimum. | No jump. The fader moves proportionally and reaches its maximum exactly when K2 does, and its minimum exactly when K2 does. | Ok     |

### E. Endless encoder (only with E1)

Not testable with the UC-33: its knobs are potentiometers with end stops and send absolute values
(0–127), not relative steps. Decoding of all three encodings and clamping to Min/Max are covered by unit
tests (`MIDIMappingTransform.test.ts`, "relative"). Open for hardware: whether a step of 1/128 of the
range per tick feels right.

| ID   | Steps                                                                                                                | Expected                                                                                                                     | Result                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| E-01 | Map E1 to a pan knob. Try Encoding "Relative (2's compl.)", then "Relative (offset 64)", then "Relative (sign bit)". | Exactly one encoding makes the knob step smoothly in both directions. Note which one fits E1.                                | Not tested: no endless encoder (UC-33 has absolute pots) |
| E-02 | With the fitting encoding, turn E1 a full revolution.                                                                | Note how much of the range one revolution covers (step is 1/128 of the range per tick). Judge if it is too slow or too fast. | Not tested: no endless encoder (UC-33 has absolute pots) |
| E-03 | Set Min/Max of that row to a narrow range, turn E1 far in both directions.                                           | Value stays clamped inside Min/Max.                                                                                          | Not tested: no endless encoder (UC-33 has absolute pots) |

### F. Mapping list

| ID   | Steps                                                                                      | Expected                                                                                                              | Result |
| ---- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------ |
| F-01 | Create at least three bindings. Click the column headers CC, Track, Parameter, twice each. | Sorts ascending, then descending; the arrow shows the direction.                                                      | Ok     |
| F-02 | Type a parameter name (e.g. `mute`) into "Search mappings".                                | Only matching rows remain; clearing the field shows all again.                                                        | Ok     |
| F-03 | Open "Audio Track 2" in Devices, then click "Audio Track" in a row.                        | Devices switches to "Audio Track".                                                                                    | Ok     |
| F-04 | Tick two rows, click "Delete selected".                                                    | Both rows disappear without an error dialog; the controls lose their orange frame; the hardware no longer moves them. | Ok     |
| F-05 | Delete a single row with its trash icon.                                                   | Row disappears.                                                                                                       | Ok     |

### G. Persistence and presets

| ID   | Steps                                                                                        | Expected                                                                                                              | Result                                                                                                             |
| ---- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| G-01 | Set one binding to Max -12 dB / Pickup. Save the project, reload the page, open the project. | Binding with all settings is back and works with the hardware.                                                        | Loading the project doen't finish - stuck for around 1 min. Cause: dev server port 8091 (see F-12), retest on 8085 |
| G-02 | Export the project as bundle (.odb), open the bundle again.                                  | Bindings and settings are included.                                                                                   | Ok                                                                                                                 |
| G-03 | MIDI Mapping → Export, save the JSON file. Open it in a text editor.                         | Readable JSON with `version: 1`, one entry per binding, names of track/device/parameter. No network request happened. | Ok                                                                                                                 |
| G-04 | Delete all bindings, MIDI Mapping → Import the file.                                         | Message "Imported N, replaced 0, skipped 0"; all bindings are back.                                                   | Ok                                                                                                                 |
| G-05 | New project with one audio track named "Audio Track". Import the same file.                  | Bindings whose track/parameter names exist are imported (by name); the others are counted as skipped.                 | Ok                                                                                                                 |
| G-06 | Import a file that is not a preset (e.g. any other JSON).                                    | Message that the file is not a valid MIDI mapping preset; nothing changes.                                            | Ok                                                                                                                 |

### H. Revision 2026-11-24

| ID   | Steps                                                                                                | Expected                                                                                                                  | Result |
| ---- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------ |
| H-01 | Fresh page without MIDI permission. Press the MIDI button in the header.                            | The browser asks for MIDI access. After allowing, the button is orange and shows a small triangle. The header does not shift. |        |
| H-02 | Press the MIDI button again.                                                                         | The MIDI Mapping screen opens: Browser on the left, the mapping list above Devices. Every mappable parameter is framed.     |        |
| H-03 | Press the MIDI button again, then open the screen and use the red close button in the list header.  | Both return to the screen that was open before. All frames disappear.                                                     |        |
| H-04 | Open the screen, click the volume fader in Devices, turn K1.                                         | The mapping is created, the frame turns orange, the fader follows K1.                                                    |        |
| H-05 | Set Min, Max, Takeover and Encoding of that row. Click the fader again, turn K2.                    | The row shows K2's CC. Min, Max, Takeover and Encoding are unchanged.                                                     |        |
| H-06 | In the MIDI Device column choose your device, "Channel 1". Send the CC from another device or channel. | Only the chosen device on channel 1 moves the fader. "All devices", "All channels" accepts every device and channel again. |        |
| H-07 | Rename the track and change the CC of a mapping (map it again).                                      | The row shows the new track name and CC without reopening the screen.                                                    |        |
| H-08 | Set Encoding to a relative mode.                                                                     | Takeover is greyed out and cannot be opened. Back to Absolute enables it again.                                          |        |
| H-09 | Import a preset with several mappings, then undo once.                                               | All imported mappings disappear with one undo.                                                                            |        |
| H-10 | Map an endless encoder to a parameter with few steps (a waveform or mode selector), relative encoding. | The selector steps through its values in both directions.                                                               |        |

## Known limitations (not failures)

- Key Map Mode and note/key sources are out of scope.
- A mapping set to one device identifies it by the browser's id. After switching browsers the device can
  show as "Unavailable device" and has to be chosen again.
- Script device views and WCLAP plugin parameters are not highlighted in map mode; right-click learn
  works there.
- Locate selects the track/device, it does not scroll to or flash the single control.
- Relative encoders (section E) are verified by unit tests only; no hardware with endless encoders was
  available.

## Result summary

| Section | Pass | Fail | Not tested | Notes                                                                      |
| ------- | ---- | ---- | ---------- | -------------------------------------------------------------------------- |
| A       |      |      |            |                                                                            |
| B       |      |      |            |                                                                            |
| C       |      |      |            |                                                                            |
| D       |      |      |            |                                                                            |
| E       | 0    | 0    | 3          | No endless encoder available; relative encoders covered by unit tests only |
| F       |      |      |            |                                                                            |
| G       |      |      |            |                                                                            |
| H       |      |      |            |                                                                            |

## Findings

Everything noticed during the test that is not a plain pass/fail of a case: bugs outside the cases,
things that feel wrong, ideas. A failed case gets a short note in its Result column plus a reference
to the finding here (e.g. "Fail, see F-1"), so the details live in one place.

- **Type:** Bug / UX / Idea
- **Severity:** high (blocks use) / medium (annoying, workaround exists) / low (cosmetic)
- **Decision:** open / fix on this branch / fixed / later / ask maintainer / rejected

| ID   | Case       | Observation                                                                                                                                                                                                                                                                                                     | Type             | Severity | Decision                                                                                                                                        |
| ---- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1  | A-01       | Midi button nicht sofort erkennbar als map                                                                                                                                                                                                                                                                      | UX               | medium   | fixed: header button shows the label "MAP" next to the knob icon                                                                                |
| F-2  | A-02       | Map Mode im MIDI-Modus entfernen                                                                                                                                                                                                                                                                                | UX               | low      | fixed: toggle removed from the MIDI Mapping panel, the panel shows a hint to use the header button                                              |
| F-3  | A-04, B-01 | Nach lernen blinkt das zugewiesene Control weiter                                                                                                                                                                                                                                                               | Bug              | medium   | fixed: the target is released after binding, the control turns orange                                                                           |
| F-4  | B-03       | While the target stayed selected, every moved controller re-bound it, so the old control kept moving the fader until map mode was left                                                                                                                                                                          | Bug              | high     | fixed: same change as F-3; re-binding needs the control to be selected again                                                                    |
| F-5  | B-03       | Remove knob icon from the header. MAP right next to the MIDI icon is sufficient for indicating map mode                                                                                                                                                                                                         | UX               | low      | fixed: knob icon removed, the header shows only "MAP" next to the MIDI icon                                                                     |
| F-6  | C-03       | Right-click "Reset Value" resets only the parameter (e.g. fader to 0 dB); the MIDI mapping range keeps its Min/Max. Open question: rename it to "Reset Values" and, for a mapped control, also reset the mapping range to its defaults (Min = parameter minimum, e.g. -inf; Max = parameter maximum, e.g. 6 dB) | Idea             | low      | open, ask maintainer: "Reset Value" is shared by every parameter (automation, modulation, MIDI); changing its name or scope affects all of them |
| F-7  | C-01, C-02 | A minus could not be typed into Min/Max. NumberInput filtered keys by physical position (`event.code`); on a German layout the minus key reports `Slash`. Affects every number field in openDAW on non-US layouts                                                                                               | Bug              | high     | fixed: NumberInput accepts the minus by its character (`event.key`); Min/Max also accept decimals                                               |
| F-8  | —          | Found while checking "Reset Value": in map mode a right-click also selected the control as target, so the next controller movement could bind it unintentionally                                                                                                                                                | Bug              | medium   | fixed: map mode only reacts to the left mouse button; the context menu works as before                                                          |
| F-9  | —          | I want to exit mapping mode with escape                                                                                                                                                                                                                                                                         | UX               | medium   | fixed: Escape leaves map mode (also clears the target); ignored while typing in a text field or with a dialog open; tooltip mentions Esc        |
| F-10 | —          | Select all missing                                                                                                                                                                                                                                                                                              | UX               | medium   | fixed: header checkbox selects/deselects all visible (filtered) rows, shows a partial state when only some are selected                         |
| F-11 | -          | Export midi-mapping: propose <current_project_name>.json                                                                                                                                                                                                                                                        | UX               | low      | fixed: export suggests `<project name>.json`; characters not allowed in file names become `-`; falls back to `midi-mappings.json`               |
| F-12 | G-01       | Project loading hung on the test server: the asset server (`assets.opendaw.studio`) only allows CORS from `localhost:8080`–`8089`, the UAT ran on 8091, and project loading retries the asset index indefinitely                                                                                                | Bug (test setup) | high     | fixed: dev server moved to port 8085; no code change. Projects saved on 8091 are not visible on 8085 (browser storage is per origin)            |
