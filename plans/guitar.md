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
6. The pattern restarts every bar of the signature track (or every two bars for a two bar pattern).

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

## Open

1. Browser check of the editor, a manual screenshot.
2. Name: Guitar, or a name in the style of the other devices?
3. Tunings: are the four enough?
