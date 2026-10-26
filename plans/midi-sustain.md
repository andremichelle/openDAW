# MIDI Sustain (issue #498)

A sustain pedal on a MIDI keyboard should hold notes after the keys are released, like on a piano, while
playing live, while recording and on playback.

## How MIDI input works today

1. `CaptureMidi` listens to the armed track's MIDI device and channel and forwards note-on and note-off only. Every
   other message, CC64 (sustain) included, is dropped there.
2. Live notes reach the engine as raw notes (`engine.noteSignal`). The Rust note sequencer starts them with an
   infinite duration and ends them with a `NoteComplete` when the key's gate drops (`note_sequencer.rs`, RAW notes).
3. MIDI effects (Velocity, Pitch, Arpeggio, Zeitgeist, Spielwerk) sit between the sequencer and the instrument and
   see NOTE_ON and NOTE_OFF records. Instruments end a voice on NOTE_OFF.
4. `RecordMidi` turns note-on and note-off pairs into notes with a duration. No CC is recorded, note regions have no
   controller lanes.
5. MIDI learn maps any CC onto any automatable parameter. It runs on the main thread as a box edit, coalesced per
   animation frame, and `RecordAutomation` records such parameter moves while recording.
6. No instrument has a sustain parameter, so MIDI learn has nothing to map CC64 to.

## What sustain has to do

1. While the pedal is down, a released key keeps sounding. Pedal up releases every held note at that moment.
2. Pressing a held key again restrikes it: the held voice ends, a new one starts (no stacking of the same pitch).
3. Transport stop, panic and a changed capture device release everything held.
4. A recording plays back the way it sounded.

## Solutions

### A. Hold in the capture, bake it into the recording (TypeScript only)

`CaptureMidi` reads CC64 (value >= 64 is down) on its device and channel and holds note-offs while the pedal is down,
before they reach the engine and the recorder. Pedal up sends the held note-offs. Because the recorder gets the late
note-offs too, recorded notes come out as long as they sounded.

1. Pro: small, no engine, schema or ABI change. Works for every instrument, MIDI effects included.
2. Pro: playback matches the performance, the sustain lives in the note lengths.
3. Con: the pedal is gone after recording. You cannot change the sustain afterwards, only the note lengths, and the
   piano roll shows long overlapping notes instead of what the hands played.
4. Con: only live input. Notes drawn in the piano roll cannot be sustained.

### B. A Sustain MIDI effect device

A new stock MIDI effect with one parameter, Hold (on or off, automatable). While Hold is on it keeps NOTE_OFF records
back and lets them through when Hold goes off. You put it on the track and MIDI-learn the pedal onto Hold.

1. Pro: everything else exists already. MIDI learn takes the pedal, `RecordAutomation` records it as an automation
   lane, playback sustains through the automation, and the pedal can be edited like any automation.
2. Pro: works for drawn notes and for every instrument, and it is visible where it acts in the chain (before or
   after an arpeggiator makes a difference).
3. Con: setup per track, add the device and learn CC64, nothing happens on its own.
4. Con: the pedal travels on another path than the notes. MIDI learn is a main-thread box edit coalesced per frame,
   notes are engine signals. A quick pedal down and key up can arrive in the wrong order and the note is released.
5. Con: a full device: schema, box, adapter, Rust crate, editor, factory entry, manual.

### C. Built-in sustain per instrument track

Every instrument track gets a sustain state, without a device.

1. Live: `CaptureMidi` forwards CC64 as a sustain signal next to the note signals, on the same path, so the order
   stays intact. The note sequencer holds the `NoteComplete` of released raw notes while sustain is down.
2. Timeline: an automatable Sustain parameter on the track (a new field on the audio unit). The sequencer holds
   sequenced notes too while it is on.
3. Recording: the capture writes the pedal into the Sustain automation of the recorded track, notes keep the
   lengths the hands played.
4. Pro: plug in the pedal and it works, live, recorded and on playback, nothing to set up. The pedal is an editable
   automation lane under the notes, the way DAWs show CC64.
5. Pro: one ordered path for live input, no race.
6. Con: the biggest change: engine (sequencer, a new signal), schema field with a default (old projects unchanged),
   adapter and automation lane, capture and recording.
7. Con: sustain acts before the MIDI effects. Holding after an arpeggiator would need B.
8. Can ship in two steps: live plus baked recording first, the automation lane second.

### D. Hand CC64 to instruments that understand it

WebCLAP plugins and soundfonts have sustain of their own (half pedal, sostenuto, damper behaviour). The pedal could
reach them as a MIDI controller (CLAP MIDI dialect) instead of holding note-offs on the host side.

1. Pro: the most faithful sound for plugins that model a real damper.
2. Con: only some instruments, the stock devices would still need A, B or C.
3. Fits as an addition later: a track whose instrument handles sustain itself skips the host-side hold.

### E. A community Spielwerk script

Not possible today. When a source note ends, the Spielwerk bridge ends every note the script produced from it
(`sourceToOutput` in `script-spielwerk.ts`), so a script cannot hold a note past its key. It would need an API change
that lets a script detach an output from its source.

## Edge cases for any solution

1. Restrike of a held pitch, see above.
2. Several capture devices on one track, and channel filters: the pedal of device X only holds notes of device X.
3. Transport stop, loop wrap and locate release held notes, as the sequencer already does for retained notes.
4. Composite layers and Playfield: a Composite passes the sustain to all layers, Playfield pads ignore it (one-shots).
5. Live rooms: the sustain signal has to travel like the note signals.
6. Offline render and freeze must match live playback (only for B and C, A bakes it).
7. Half pedal: CC64 is continuous, all host-side solutions treat >= 64 as down.
8. Inverted pedal: a normally closed pedal on a keyboard that expects normally open sends 127 at rest and 0 when
   pressed (AKAI MPK mini with a switchable pedal: inverted in both switch positions and after a power cycle, the same
   in Logic). Many keyboards detect polarity at power up, some not or wrongly, see the links below.

## Invert sustain per input device

A per-device setting "Invert sustain" next to the MIDI input device preferences. When on, the capture reads CC64 as
`127 - value` before any solution sees it, so live hold, recording and the automation lane all get the corrected
pedal. Off by default, existing setups unchanged.

1. Applies to A, B (MIDI learn sees the corrected value) and C alike, and to D (the forwarded CC64 is inverted too).
2. Stored per device id in the preferences, not in the project, a project opened on another setup must not inherit it.
3. The test page `opendaw.studio/midi-test.html` has the same toggle, users can confirm it fixes their pedal before
   reporting.
4. Few hosts have it: Logic needs a Transformer in the Environment, Pianoteq reverses the CC64 range, Native
   Instruments Kontrol Mk3 users report re-setting normal/invert each session.

References:

1. [Arturia: sustain pedal acts reversely](https://support.arturia.com/hc/en-us/articles/4405741267602-My-sustain-pedal-acts-reversely-How-to-invert-it)
2. [Akai MPC Key 61: pedal working in reverse](https://support.akaipro.com/en/support/solutions/articles/69000859246-akai-pro-mpc-key-61-my-pedal-is-working-in-reverse)
3. [NI k61 mk3: always reverse polarity with 3 pedals](https://community.native-instruments.com/discussion/40104/k61-mk3-sustain-pedal-always-reverse-polarity-3-different-pedals)
4. [Yamaha checks pedal polarity at boot (PSR Tutorial forum)](https://www.psrtutorial.com/forum/index.php/topic,66436.msg502841.html)
5. [Cantabile: polarity flips from a half seated plug](https://community.cantabilesoftware.com/t/sustain-pedal-changing-polarity-and-back-mystery/8773)
6. [Pianoteq: reverse the CC64 range](https://forum.modartt.com/viewtopic.php?id=5065)

## Test page

`packages/app/studio/public/midi-test.html`, deployed with the studio as `/midi-test.html`. Web MIDI only, no studio
code: piano roll with notes held by the pedal, lanes for sustain, pitch bend, mod wheel and aftertouch, all CCs, a raw
message log and "Copy report" for bug reports. Separates "the studio does it wrong" from "the device sends it so".

## Recommendation for the discussion

C gives the result users expect from a DAW with no setup, and its first step (live sustain in the sequencer plus
baked recording) already solves the issue as reported. A is the smallest change, but its
recordings cannot be edited later and C would replace it. B is worth it only if holding after other MIDI effects
matters. D can follow for WebCLAP instruments. Invert sustain ships with whichever solution comes first.

Open questions:

1. Should recorded sustain be editable (an automation lane, C step two) or are baked note lengths enough?
2. Where does the pedal belong in the chain, before the MIDI effects (C) or as a device (B)?
3. Do we expect sustain on notes drawn in the piano roll?
