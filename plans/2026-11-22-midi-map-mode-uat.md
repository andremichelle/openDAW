# UAT: MIDI Map Mode & MIDI Mapping view (`MIDI-CORE-02`, MIDI only)

Manual acceptance test with a real MIDI controller. Covers the whole feature on `feat/midi-map-mode`
(all commits), not a single commit.

## Setup

- Dev server of this branch running (`studio-midi-mapping`, http://localhost:8091), WASM engine rebuilt
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

| ID   | Steps                                                                  | Expected                                                                                                                | Result |
| ---- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------ |
| A-01 | Click the knob icon in the header (between "Midi Access" and Capture). | Button turns purple. Every assignable control (track header knobs, M/S, fader in Devices) gets a purple frame.          | Ok     |
| A-02 | Switch views with Shift+1, Shift+2 (mixer), Shift+9 (MIDI Mapping).    | Map mode stays on in every view; mixer pan knobs and faders are framed too.                                             | Ok     |
| A-03 | Click the header button again.                                         | All frames disappear, button is no longer purple.                                                                       | Ok     |
| A-04 | Map mode on, click the volume fader of "Audio Track".                  | Fader frame turns yellow and pulses. The fader value does **not** change. The MIDI Mapping view shows "Target: Volume". | Ok     |

### B. Binding

| ID   | Steps                                                                                                 | Expected                                                                                                                                              | Result                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| B-01 | Target = volume of "Audio Track" (A-04). Turn K1.                                                     | Binding is created immediately; frame turns orange; the fader follows K1. Row in MIDI Mapping: your port name, channel, K1's CC, Audio Track, Volume. | learning works, but it doesn't turn orange - stays pulsating, see findings from section A |
| B-02 | Keep the same target, turn K1 again several times.                                                    | Still exactly one row for Volume (no duplicates).                                                                                                     | Ok                                                                                        |
| B-03 | Keep the same target, turn K2.                                                                        | The Volume row now shows K2's CC; K1 no longer moves the fader.                                                                                       | Only after leaving, the old control doenst move the fader anymore.                        |
| B-04 | Click the pan knob of "Audio Track", turn K1. Turn K1 to its middle detent (or as close as possible). | Pan follows K1; at the hardware centre the pan reads centre (0 / C). Note the value if it is off by one step.                                         | Ok                                                                                        |
| B-05 | Click Mute of "Audio Track 2", press B1.                                                              | Mute follows the button (on at 127, off at 0). Note whether B1 sends toggle or momentary.                                                             | Ok                                                                                        |
| B-06 | Map mode off. Right-click a control, "Learn Midi Control...", move F1.                                | Classic learn still works and the binding appears in the list. "Forget Midi" removes it.                                                              | Ok                                                                                        |

### C. Range and inversion

| ID   | Steps                                                             | Expected                                     | Result |
| ---- | ----------------------------------------------------------------- | -------------------------------------------- | ------ |
| C-01 | In the Volume row set Max to `-12` (dB), Enter. Turn K2 fully up. | Max shows -12.00; the fader stops at -12 dB. |        |
| C-02 | Set Min to `0` (dB), i.e. Min > Max. Turn K2 from down to up.     | Inverted: K2 down → 0 dB, K2 up → -12 dB.    |        |
| C-03 | Reset Min to `-inf` (type a very low value) and Max to `6`.       | Full range again.                            |        |

### D. Takeover

| ID   | Steps                                                                                                                   | Expected                                                                                                                    | Result |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------ |
| D-01 | Takeover = Jump. Put K2 at its minimum. Drag the fader with the mouse to about -6 dB. Turn K2 slightly.                 | Fader jumps to K2's position.                                                                                               |        |
| D-02 | Takeover = Pickup. K2 at minimum, fader dragged to about -6 dB with the mouse. Turn K2 up slowly.                       | Fader does not move until K2 passes the fader's position, then it follows.                                                  |        |
| D-03 | Pickup again: after pickup, drag the fader with the mouse to another value, then turn K2.                               | Fader waits again until K2 crosses the new value.                                                                           |        |
| D-04 | Takeover = Scaling. K2 at about 25 %, fader at about 75 % (mouse). Turn K2 up to its maximum, then down to its minimum. | No jump. The fader moves proportionally and reaches its maximum exactly when K2 does, and its minimum exactly when K2 does. |        |

### E. Endless encoder (only with E1)

| ID   | Steps                                                                                                                | Expected                                                                                                                     | Result |
| ---- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------ |
| E-01 | Map E1 to a pan knob. Try Encoding "Relative (2's compl.)", then "Relative (offset 64)", then "Relative (sign bit)". | Exactly one encoding makes the knob step smoothly in both directions. Note which one fits E1.                                |        |
| E-02 | With the fitting encoding, turn E1 a full revolution.                                                                | Note how much of the range one revolution covers (step is 1/128 of the range per tick). Judge if it is too slow or too fast. |        |
| E-03 | Set Min/Max of that row to a narrow range, turn E1 far in both directions.                                           | Value stays clamped inside Min/Max.                                                                                          |        |

### F. Mapping list

| ID   | Steps                                                                                      | Expected                                                                                                              | Result |
| ---- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------ |
| F-01 | Create at least three bindings. Click the column headers CC, Track, Parameter, twice each. | Sorts ascending, then descending; the arrow shows the direction.                                                      |        |
| F-02 | Type a parameter name (e.g. `mute`) into "Search mappings".                                | Only matching rows remain; clearing the field shows all again.                                                        |        |
| F-03 | Open "Audio Track 2" in Devices, then click "Audio Track" in a row.                        | Devices switches to "Audio Track".                                                                                    |        |
| F-04 | Tick two rows, click "Delete selected".                                                    | Both rows disappear without an error dialog; the controls lose their orange frame; the hardware no longer moves them. |        |
| F-05 | Delete a single row with its trash icon.                                                   | Row disappears.                                                                                                       |        |

### G. Persistence and presets

| ID   | Steps                                                                                        | Expected                                                                                                              | Result |
| ---- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------ |
| G-01 | Set one binding to Max -12 dB / Pickup. Save the project, reload the page, open the project. | Binding with all settings is back and works with the hardware.                                                        |        |
| G-02 | Export the project as bundle (.odb), open the bundle again.                                  | Bindings and settings are included.                                                                                   |        |
| G-03 | MIDI Mapping → Export, save the JSON file. Open it in a text editor.                         | Readable JSON with `version: 1`, one entry per binding, names of track/device/parameter. No network request happened. |        |
| G-04 | Delete all bindings, MIDI Mapping → Import the file.                                         | Message "Imported N, replaced 0, skipped 0"; all bindings are back.                                                   |        |
| G-05 | New project with one audio track named "Audio Track". Import the same file.                  | Bindings whose track/parameter names exist are imported (by name); the others are counted as skipped.                 |        |
| G-06 | Import a file that is not a preset (e.g. any other JSON).                                    | Message that the file is not a valid MIDI mapping preset; nothing changes.                                            |        |

## Known limitations (not failures)

- Key Map Mode and note/key sources are out of scope.
- The port is shown but not used as a filter: the same CC from any input triggers the binding.
- Script device views and WCLAP plugin parameters are not highlighted in map mode; right-click learn
  works there.
- Locate selects the track/device, it does not scroll to or flash the single control.

## Result summary

| Section | Pass | Fail | Not tested | Notes |
| ------- | ---- | ---- | ---------- | ----- |
| A       |      |      |            |       |
| B       |      |      |            |       |
| C       |      |      |            |       |
| D       |      |      |            |       |
| E       |      |      |            |       |
| F       |      |      |            |       |
| G       |      |      |            |       |

## Findings

Everything noticed during the test that is not a plain pass/fail of a case: bugs outside the cases,
things that feel wrong, ideas. A failed case gets a short note in its Result column plus a reference
to the finding here (e.g. "Fail, see F-1"), so the details live in one place.

- **Type:** Bug / UX / Idea
- **Severity:** high (blocks use) / medium (annoying, workaround exists) / low (cosmetic)
- **Decision:** open / fix on this branch / later / ask maintainer / rejected

| ID  | Case | Observation                                       | Type | Severity | Decision |
| --- | ---- | ------------------------------------------------- | ---- | -------- | -------- |
| F-1 |      | Midi button nicht sofort erkennbar als map        |      |          | open     |
| F-2 |      | Map Mode im MIDI-Modus entfernen                  |      |          | open     |
| F-3 |      | Nach lernen blinkt das zugewiesene Control weiter |      |          | open     |
