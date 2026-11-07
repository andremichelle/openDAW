# Guitar: a strummed Karplus-Strong instrument

A stock instrument that plays a six string guitar. It strums the chords of the chord track with a rhythm pattern, or
plays incoming notes on the strings. The sound is a port of `~/WebstormProjects/Guitar`: six
Karplus-Strong strings, a noise burst per pluck shaped by a seeded character noise, and a body filter.

## What it does

1. Mode **Chords**: while the transport runs, the chord on the chord track is voiced as a guitar shape and strummed with
   the selected pattern. Held keys gate the strumming (optional) and set nothing else. No chord, no strum.
2. Mode **Keys**: incoming notes are placed on strings and frets. Notes that start together are strummed in string
   order with the strum speed, so a held chord on a keyboard sounds strummed.
3. The editor shows the current chord as a fret diagram and the pattern as a step row with the playing step lit.

## Sound (port of the existing TS model)

1. String: delay line of one period, filled with a noise burst on pluck (character noise mixed with fresh noise by
   Variation), one pole damping per sample, fractional read offset (Tension).
2. Damping rises with pitch (`damp + sqrt(tone) * (1 - damp) / 2`), each pluck varies damping and pluck brightness.
3. Body: Simple (default) or Band Pass, as in `src/bodies`. Spread pans the strings.
4. Fixes while porting: real sample rate instead of 44100, delay sized for the lowest tuning at 192 kHz, no
   `Math.random` (seeded per note, so exports repeat), events at sample offsets from the engine, not timers.

## Voicing (chord to tab)

1. Input: `abi::harmony_at` chord root, voicing mask and bass. Output: one fret per string or muted.
2. Search frets 0 to 12 per string, score: every chord tone present, lowest sounding note is the chord bass, span at most
   4 frets (open strings free), prefer open strings and low positions, near the previous shape for smooth changes.
3. Position parameter (Open, 3rd, 5th, 7th, 9th fret) moves the preferred window. Tuning: Standard, Drop D, Open G,
   DADGAD.
4. Results are cached per (root, mask, bass, position, tuning). Tests pin the common shapes: C x32010, G 320003,
   Am x02210, Em 022000, D xx0232, F 133211, plus inversions and 7ths.
5. The same function in TS (lib-dsp) draws the fret diagram, a parity test keeps both equal.

## Strum patterns

1. A pattern has 1 to 64 steps on four pages of 16. Rate plays it at half, normal or double speed (eighths, sixteenths,
   thirty-seconds).
2. Strokes: Down, Up, Palm mute, Chuck, Bass, Alternate bass, Pick, Let ring, Rest. Strums cross the strings of their
   Strings lane (treble strums are strums on the high strings), Pick plays its lane strings together. A brush palette
   picks the stroke, clicking steps paints it.
3. Per step lanes: Velocity, Strings (which strings a strum hits) and Speed (how fast this stroke crosses the strings).
4. About 35 built in patterns in eight styles: Strumming, Rock, Funk and Soul, Reggae and Ska, Latin, Country,
   Fingerstyle, Other. Changing a step turns the pattern into Custom, which keeps the edits.
5. Global strum controls: Speed, Velocity, Swing, Accent (bar downbeat). Shift and Clear tools as in Arpeggio.
6. The pattern follows the bar of the signature track.

## Schema

1. `GuitarDeviceBox`: mode, pattern, rate, length, step arrays (kind, string mask, velocity, speed), position, tuning,
   body, and the sound parameters.
2. Every sound parameter that varies per pluck has its own variation amount: speed (timing), velocity, damping, pluck,
   character. Tension, swing, accent, spread and gain have none.
3. Adapter with the parameters, factory entry, scripting `Instruments.Guitar`, parameter parity test.

## Engine

1. `crates/dsp/src/guitar/` string, body, voicing, patterns, unit tested (pitch of a plucked string within a few cents,
   decay, shapes table).
2. `device-guitar` instrument crate: Keys mode from note events, Chords mode from `harmony_at` + `bar_at` per block.
3. Live broadcast: current tab (6 ints) and playing step, for the editor.

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

1. DSP port: string, body, tests against the TS model.
2. Voicing in Rust and TS with the shape tables.
3. Device: schema, adapter, factory, Keys mode.
4. Chords mode with the built in patterns.
5. Editor with the fret diagram and step row, live broadcast.
6. Custom pattern, scripting, manual page.

## Open questions

1. Name: Guitar, or a name in the style of the other devices?
2. Chords mode: should held keys gate the strumming, or does it strum on its own like Arpeggio with Chords?
3. Tunings: are the four enough?
