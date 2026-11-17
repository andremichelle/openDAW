# Guitar: a strummed Karplus-Strong instrument

A stock instrument that plays a six string guitar. It strums the chords of the chord track with a rhythm pattern, or
plays incoming notes on the strings. The sound is a port of `~/WebstormProjects/Guitar`: six
Karplus-Strong strings, a noise burst per pluck shaped by a seeded character noise, and a body filter.

## What it does

1. Mode **Chords**: while the transport runs, the chord on the chord track is voiced as a guitar shape and strummed with
   the selected pattern. It strums on its own like Arpeggio with Chords. No chord, no strum. Played notes still sound.
2. Mode **Keys**: incoming notes are placed on strings and frets. Notes that start together are strummed in string
   order with the strum speed, so a held chord on a keyboard sounds strummed.
3. The editor shows the current chord as a fret diagram and the pattern as a step row with the playing step lit.

## Sound (the original string with the established extensions)

1. Pluck: the string's velocity as it leaves the pick, a triangle displaced at the Spot (default 0.13 of the
   string) whose corner is rounded by the contact width of the Pick (Finger, Thumb, Nail, Plectrum). The original's
   fixed noise table blended with fresh noise roughens it (Character, 0 plays identical picks), the plug filter
   smooths it (Pluck, with the original variation law). Upstrokes are brighter, a hard pluck starts up to 8 cents
   sharp and settles in 40 ms, the pick angle sets the polarization mix, a pick stops a ringing string before it
   plucks it. Character also varies spot, width, angle and twang per pick. A separate noise click was tried and
   dropped: the reference recording has less top end in the attack than the model had.
2. From the extended Karplus-Strong (Jaffe and Smith): a dynamic-level lowpass (soft picks are darker), the body
   joins through a spot comb.
3. From commuted synthesis (STK Guitar): the body's impulse response joins the pluck at a third of its energy, the
   pick stays on top. Off (the bare original), Dreadnought (default), Classical, Parlor, Jumbo, Archtop, each body
   with its strings' brightness. The bodies play within 2.1 dB of each other.
4. String, measured on a steel string acoustic (open low E and high e): the loop lowpass is designed per pluck for
   an overtone loss per second (about 50 dB/s at 3 kHz on the high e, wound strings faster, Damping scales it,
   its variation only opens it), so high strings keep their overtones (the original law lost them per period, the
   high e sounded like a sine after the attack). Four allpasses make the string stiff (B 2.3e-5 on the low E,
   5.5e-5 on the high e, nylon a third of that). The vertical polarization feeds the body and fades at up to
   40 dB/s on high notes, the horizontal one sustains (the measured double decay). Tension shortens the string.
5. Electric Neck and Electric Bridge: no acoustic body, a pickup that hears the string at its position (a comb at a
   quarter of the string or near the bridge) and rolls off the highs with a resonant peak (2.5 or 4.5 kHz), the
   direct signal an amp simulation expects. The eight bodies play within 2.2 dB of each other.
6. Every string is plucked about equally hard (the original's one period burst gave the low E 10 dB more than the
   high e, so a strum sounded like its bass note). Strum Speed runs from 3 ms to 123 ms per string on a curve, its
   variation moves every stroke up to 12 ms late and makes the strum uneven.
7. Fixes on top: an allpass fractional delay corrected by the loop filter's phase delay (every fret within 2 cents,
   the original rounded the period up), two slightly detuned polarizations, a restruck string adds to its vibration,
   a new fret under a ringing string glides in 2 ms, the real sample rate, seeded variation (exports repeat).

## Voicing (chord to tab)

1. Input: `abi::harmony_at` chord root and voicing mask (its lowest bit is the bass). Output: one fret per string or muted.
2. Search the frets around the Position, score: every chord tone present, lowest sounding note is the chord bass, muted
   strings only at the edges, span at most 4 frets, at most 4 fingers, a barre leaves no open string under it, prefer
   open strings in the open position and low frets near the Position.
3. A chord missing at the Position moves to the nearest position, then drops its fifth, then keeps root and bass.
4. Cached per (root, mask, position, tuning). Tests pin C x32010, G 320003, Am x02210, Em 022000, D xx0232, F 133211.
5. `Guitar.tab` in lib-dsp draws the fret diagram, a shared fixture of 3744 chords keeps Rust and TS equal.

## Strum patterns

1. A pattern has 1 to 64 steps on four pages of 16. Rate plays it at half, normal or double speed (eighths, sixteenths,
   thirty-seconds).
2. Strokes: Down, Up, Palm mute, Chuck, Bass, Alternate bass, Pick, Stop, Rest. Strums cross the strings of their
   Strings lane (treble strums are strums on the high strings), Pick plays its lane strings together. A brush palette
   picks the stroke, clicking steps paints it.
3. Per step lanes: Velocity, Strings (which strings a strum hits) and Speed (how fast this stroke crosses the strings).
4. 37 built in patterns in seven styles: Strumming, Rock, Funk and Soul, Reggae and Ska, Latin, Country, Fingerstyle.
   Changing a step turns the pattern into Custom, which keeps the edits.
5. Global strum controls: Speed, Velocity, Swing, Accent (bar downbeat, beats lighter). Shift and Clear as in Arpeggio.
6. ~~The pattern restarts every bar of the signature track~~ The pattern runs on from the song start like Cubed (2026-11-17).

## Schema

1. `GuitarDeviceBox`: mode, pattern, rate, length, step arrays (kind, string mask, velocity, speed), position, tuning,
   body, and the sound parameters.
2. Every sound parameter that varies per pluck has its own variation amount: speed (timing), velocity, damping, pluck,
   character. Tension, swing, accent, spread and gain have none.
3. Adapter with the parameters, factory entry, scripting `Instruments.Guitar`, parameter parity test.

## Engine

1. `device-guitar` crate: string, body, fretting, strum, device, unit tested (tuning within 2 cents on every fret, T60,
   release, palm mute, restrike, extremes at 44.1 to 192 kHz, every body, the pattern grid, swing, block splits).
2. Strokes are internal note events from `generate_events`, placed by the SDK, each queues its plucks at strum offsets.
3. Live broadcast: playing step, chord root, tab (6 ints) and the struck strings, for the editor.
4. Full engine tests in core-wasm: the chord track strums, every body, tuning and pattern sounds, Keys mode.

## Editor

1. Display (Vaporisateur frame): chord name and step, fret diagram with x and o markers and the base fret, sounding
   strings lit, footer with the next chord or the tuning and position.
2. Pattern: the Arpeggio sequencer. Two toolbar rows of fields (pattern menu, length, shift and clear; the brush
   palette, page), then the StepGrid with index, play row, stroke row and one lane at a time (Velocity, Strings, Speed).
3. Sound: two Arpeggio label columns with Delay sections and rotated titles. Left: Strum (Speed, ± Speed, Velocity,
   ± Velocity, Swing, Accent), Play (Mode, Rate), Neck (Position, Tuning). Right: String (Damping, ± Damping, Pluck,
   ± Pluck, Character, ± Character, Tension, Body), Out (Spread, Gain). Each variation sits next to its parameter.
4. The step lane fills the panel down to the bottom.
5. Preview: `plans/guitar-preview.html`, with the Karplus-Strong model and the voicing search running in the page.

## Phases

1. ~~DSP port: string, body, tests against the TS model.~~
2. ~~Voicing in Rust and TS with the shape tables.~~
3. ~~Device: schema, adapter, factory, Keys mode.~~
4. ~~Chords mode with the built in patterns.~~
5. ~~Editor with the fret diagram and step row, live broadcast.~~
6. ~~Custom pattern, scripting, manual page.~~
7. ~~Custom shapes and a chord source (below), replaces the plan to store frets on global chords.~~
8. ~~Sixteen pattern slots (below).~~
9. ~~Bends per string (below).~~
10. ~~Finger squeak (below), dropped.~~
11. ~~Tonal chuck (below).~~
12. Free running patterns (done) and own tunings with a bass (below).

## Custom shapes

1. 16 custom shapes per Guitar (`shapes`, field 44): one int32 each, 5 bits per string from the low E, 31 mutes a
   string, all muted is empty. Entered by clicking the neck in the fret display.
2. The `chord` parameter (field 43, automatable): 0 strums the chord track, 1 to 16 strums that shape and ignores
   the chord track. An empty shape strums the chord track. Nothing reaches the global chord track, other devices
   are not affected. A progression is the automation of `chord` on the Guitar's track, safe on seek and loop.
3. The name shows orange while a shape plays, Chord Track in the selector removes the override.
4. Dropped for now: frets stored on global chords with chord detection (it changes what every device hears),
   notes on the Guitar's track selecting shapes (held notes are not resent after a seek or loop wrap), a Chord lane
   per pattern step, a Guitar chord lane on the timeline (new track type).
5. Later: a per step shape lane for riffs inside one pattern, a capo shift, shape names, copy and paste of shapes,
   a shape library, a timeline lane with chord diagrams.
6. Later: "Add to Chord Track" in the chord source menu. An explicit action that detects the selected shape's chord
   (root, shape bits, inversion from the lowest note, degree and shift against the key) and writes it to the chord
   track at the playhead, so other devices follow it only when the user asks. A shape that is no known chord
   writes its pitch classes as a shaped chord (shown with `*`).

## Sixteen pattern slots

1. The Guitar holds 16 pattern slots (array of objects like Surgeon's patterns): kinds, strings, velocities, speeds
   (64 steps each), length, and the library pattern it was loaded from.
2. A `slot` parameter (int32, 0 to 15, automatable) picks the slot that plays. A change takes over immediately.
3. Slots never move or reorder, so automation keeps pointing at the same slot. The library menu and its `<` `>`
   load a pattern into the current slot, overwriting it.
4. A new Guitar seeds the 16 slots with 16 library patterns, so automating to a stored pattern works at once.
5. Unreleased: fields 30 to 35 are replaced, no migration.
6. Later, not now: notes select slots, and a pattern lane on the timeline.

## Bends per string

1. Every step stores a bend per string (`step-bends`, 3 bits per string from the low E): none, ¼, ½, 1 or 2
   semitones. A real bend is one finger on one string, the other strings keep their pitch.
2. The Strings lane cycles a string off, plucked, bent ¼, ½, 1, 2, off. Right-click sets the bend directly or plays
   all or no strings. A newly painted pick clears all strings and bends.
3. A bent string is plucked at pitch, rises fast to the bend and falls back slower, within the step. The string's
   loop length follows the curve. Pre-bend (start bent, release to pitch) is left out unless asked for.

## Finger squeak (dropped)

Built and dropped 2026-11-16: a synthesized squeak (a filtered pulse train at the rate the finger passes the
windings, led half a step before the stroke) sounded like a cat. A convincing squeak would need a physical model
(the finger's friction exciting the gliding string itself) and many listening rounds, sample libraries record it.
It also never fired for automated custom shapes, the shape switches only at the stroke. The original idea:

1. When the chord or custom shape changes between two strokes, the wound strings (low E, A, D) that change their
   fret squeak along the frets just before the next stroke: a short tonal noise, longer and higher the further
   the finger travels. Open strings and strings that keep their fret stay silent.
2. A new Squeak knob, off by default so existing sounds stay identical. It sits in a new column at the end of the
   editor for now, its final place comes later.

## Tonal chuck

1. The chuck (×) excites the muted strings with the pick shape at the chord's pitches instead of pure noise,
   darker and damped within a few tens of milliseconds, a little pick noise on top. A percussive thunk that still
   carries the chord.
2. This changes the sound of the chuck: render before and after for listening.

## Own tunings and bass

1. Tuning menu: Standard, Drop D, Open G, DADGAD, Bass (E1 A1 D2 G2, the two high strings off), Custom. Tuning
   stays automatable over these entries.
2. Custom plays six notes of the device (box field 45), a note per string or off. Editing a note on the neck while
   a preset is chosen copies the preset into Custom and switches to it.
3. A string that is off never sounds: strums, picks, played notes, voicing search and custom shapes skip it.
4. Neck: the note names at the nut change by drag or wheel, right-click toggles the string off, off strings are dim.
5. Two bass bodies: Acoustic Bass (low wooden modes) and Electric Bass (pickup, darker, stiffer strings).
6. Notes from C1 to E6, the string delay line holds C1 up to 96 kHz.

## Open

1. Browser check of the editor, a manual screenshot.
2. Name: Guitar, or a name in the style of the other devices?
3. Tunings: are the four enough?
