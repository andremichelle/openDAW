# Surgeon

Status 2026-11-13: design settled in listening rounds with André, editor layout drawn and accepted as an
arrangement. Lab crate `crates/surgeon-lab` built. No engine crate, no box, no editor, no preview on `/testing`.

Branch: `surgeon`, in its own checkout `../openDAW-surgeon` (a git worktree, created 2026-11-13 from
`9fee779f6`). Committed, not pushed. The main checkout holds other work and must stay free of these files.
1. Files of this work: `plans/surgeon.md`, `plans/surgeon-architecture.svg`, `plans/surgeon-editor.svg`,
   `crates/surgeon-lab/`. Renders in `crates/target/surgeon-lab` (ignored).
2. The lab stands alone: it is not a member of the `crates` workspace (its `Cargo.toml` carries its own
   `[workspace]`), so no shared manifest changes on this branch.
3. `hit_envelope.rs` and `svf.rs` in the lab are copies of the openDrum blocks from the `opendrum` branch, which
   are not in `dsp` yet. The engine phase uses the `dsp` versions once they have landed.

Diagram: `plans/surgeon-architecture.svg`.

Name: Surgeon (decided 2026-11-13).

## Goal

1. One instrument that produces metallic, inharmonic FM themes for techno: a loop that plays its own voice.
2. The theme varies by itself. Nothing is drawn by hand, loops come from seeds and drift by mutation.
3. Good loops are kept as patterns and fired on the bar.
4. The washed out character comes from the existing Delay and Dattorro Reverb behind the device, as a preset
   chain. The device itself is dry.

## Design

### Overview

1. A note loop makes pitches, velocities, rests and ties.
2. Four lanes run next to it. Each is a loop of values from 0 to 1 with its own length.
3. The voice has 18 sound parameters. Each has a base value and one amount per lane. The lanes add up.
4. A pattern is a snapshot of the note loop, the lanes and the sound with its mapping. There are 8.
5. The device plays while the transport plays.

### Play mode

1. The loop plays while the transport plays. It takes no notes from the track.
2. 8 pattern buttons and an Off button in the editor. One is active.
3. A switch to another pattern or to Off takes effect at the start of the next bar.
4. After Off the last note rings out, no new notes start.
5. All loops run on the song position, not on the moment the pattern was fired. A pattern fired late joins
   exactly where it would be had it played all along ("in phase", decided 2026-11-13).

### Pitch loop

The loop has Steps steps and repeats. Every step is a note, a tied note or a rest.

| Value | Range | Meaning |
|---|---|---|
| Seed | whole number | which loop. Same seed, same loop. A button rolls a new one |
| Steps | 1 to 32 | loop length, odd lengths wanted |
| Rate | note values | step length. The lab uses sixteenths only |
| Mutate | 0 to 100 % | chance per step and pass that the step is replaced by a new random one |
| Range | octaves | how far pitches spread above and below Tune |
| Density | 0 to 100 % | share of steps that sound |
| Tie | 0 to 100 % | share of sounding steps that tie into the next and slide |
| Accent | 0 to 100 % | how far velocities spread below full |

Rules:
1. Pitches are free. They are never rounded to notes and there is no scale (a scale blend was tried and dropped,
   "does not sound like I expected").
2. A tied step lasts a little longer than its step, so it overlaps the next note and the voice slides.
3. An untied step lasts half a step, a held step (see Length) almost the whole step.
4. Lab values of the favourite: 7 steps, Range 13, Density 80 %, Tie 25 %, Accent 60 %, Mutate 12 %.

### Lanes

1. Four lanes: A, B, C, D (decided 2026-11-13).
2. A lane has three values: Steps (its own length), Seed, Mutate. It puts out one value from 0 to 1 per step.
3. Lanes are generic and interchangeable. A lane does not know what it moves.
4. Different lengths are the point: 5, 9, 4 and 11 steps against 7 note steps line up again only after a very
   long time, so the same notes keep sounding different.
5. Lanes are controlled by seed and mutate only. Steps are never drawn by hand (decided 2026-11-13).

### Mapping

1. Every sound parameter has a base value and four amounts, one per lane.
2. On every step: value = base + amount A x lane A + amount B x lane B + amount C x lane C + amount D x lane D,
   limited to the parameter's range. All in the parameter's 0 to 1 position, then mapped to its unit.
3. Amounts can be negative.
4. One lane may move several parameters, one parameter may take several lanes.
5. Switches (Wave, Fold Place, Sine Pitch) step through their settings when a lane moves them.
6. The value is set at the start of each step and held for the step.
7. Moving more parameters "adds life" (verdict on `listen/2`).

### Sound

Signal flow:
1. Modulator 1 at Ratio 1 times the note frequency, with Feedback on itself.
2. Modulator 2 at Ratio 2 times the note frequency. Depth 2 blends it in, zero is off. It "has more overtones".
3. Carrier at the note frequency, phase modulated by both, through zero. The depth is Depth plus the strike: every
   note starts with extra depth (Strike) that falls back over Strike Decay. Velocity scales the strike.
4. Fold, before or after the gate (Fold Place). Before: every note has the same folded brightness. After: loud
   starts fold hard and tails clean up.
5. Low pass gate: one decay drives level and brightness together, so a note gets darker as it fades. Length sets
   the decay.
6. Parallel sine at the loop's pitch or an octave below. It takes the gate's level only and skips the filter and
   the fold, so the body stays full while the top darkens.
7. Monophonic. A tied step slides to the next pitch over Glide and does not restart the envelopes.

| Value | Lab range | Meaning |
|---|---|---|
| Tune | Hz (lab: MIDI 24 to 72) | centre pitch of the loop, shown in Hz. Lab: 146.8 Hz |
| Ratio 1 | 0.25 to 8 | first modulator, free. Lab: 2.41 |
| Feedback | 0 to 1 | clean to noisy |
| Ratio 2 | 0.25 to 16 | second modulator, free. Lab: 5.19 |
| Depth 2 | 0 to 1.5 | blend of the second modulator. Lab: 0.6 |
| Wave | sine, half, rectified, burst | wave of carrier and modulators. All four stay |
| Depth | 0 to 4 | resting FM depth. Lab: 0.6 |
| Strike | 0 to 8 | extra depth at the note start |
| Strike Decay | 20 ms to 1 s | how fast the strike falls. Lab: 140 ms |
| Fold | 0 to 1 | fold amount |
| Fold Place | before, after | place of the fold against the gate |
| Length | 50 ms to 900 ms, then held | from a short punch to a long decay |
| Held share | 0 to 100 % | top share of Length that holds the whole step. Lab: 8 % |
| Sine Level | 0 to 1.5 | parallel sine. Lab: 0.6 |
| Sine Pitch | octave below, at pitch | pitch of the parallel sine |
| Glide | 0 to 300 ms | slide time of tied steps. Lab: 40 ms |
| Velocity | 0 to 1 | how much velocity scales the strike. Lab: 0.7 |
| Volume | 0 to 1 | output level |

Notes:
1. Ratio as a mapped parameter is meant for breaks: its lane amounts are zero by default and are turned up by
   hand for a short break.
2. Held steps: a quarter of the steps was too many, about one in twelve "adds something".
3. Ranges are the lab's. The engine phase confirms them.

### Patterns

1. 8 patterns (decided 2026-11-13, first 16).
2. A pattern stores the note loop, the four lanes and the sound with its mapping: everything except Tune and
   Volume.
3. Firing a pattern replaces the working values at the next bar.
4. Every value is automatable (decided 2026-11-13): the base values, the lane amounts, Tune and Volume, and the
   loop and lane values.
5. A value that has an automation simply keeps following it. A fired pattern does not touch it. Automation wins.

### Determinism

1. Every step of the note loop and of every lane is a function of its seed, the step and how often that step has
   been replaced so far. How often follows from the song position: each pass rolls once per step against Mutate.
2. So a locate, a loop of the transport and an export replay exactly the same notes and values.
3. The engine needs no state that survives a stop, apart from the sounding voice.

### Value list

110 values:
1. Note loop, 8: Seed, Steps, Rate, Mutate, Range, Density, Tie, Accent.
2. Lanes, 12: Steps, Seed, Mutate for each of the four.
3. Sound, 18: the table above.
4. Mapping, 72: 18 sound parameters times 4 lane amounts.

Fixed, no control: the gate's filter curve, the length of untied, tied and held steps, oversampling.

No value is dropped for count. They do not all need to be visible at all times, the editor finds the way to show
them (André 2026-11-13).

## Editor (layout proposal 2026-11-13, not decided)

Wireframe in true pixels: `plans/surgeon-editor.svg`. Body 172 px high like Tubular, 720 px wide. Built from
existing device conventions only: Tubular's round tab tiles, label control cells, tinted bands and rotated
titles, the Vaporisateur display frame.

The arrangement (patterns, display, tabs, 8 column section) is accepted (2026-11-13).

Left to right, always visible:
1. Patterns, 94 px: 8 tiles in two columns and four rows, the active one filled. A fired tile flashes while it waits
   for its bar (decided 2026-11-13), the editor switches to it at that bar. Below: Off, then Tune and Volume.
2. Display, 180 px: the pitch loop of the current pass on top (rests, ties, the playing step lit), below it the
   four lanes A to D with their current values. It shows all five loops at once on every tab, no switching.
   The white element in each loop is the step that plays right now.
3. Three round tabs: L (loops), T (tone), S (shape).
4. Section, 8 columns of 45 px.

Tab L, loops:
1. Row 1, PITCH: the pitch loop's 8 values (Seed, Steps, Rate, Mutate, Range, Density, Tie, Accent).
2. Rows 2 and 3, LANES: the four lanes side by side, two columns each: Steps, Seed, Mutate, a Roll button.
3. Row 4, ROLL: four buttons, Pitch, Lanes, Sound and All.

Tabs T and S, sound: a grid of 8 parameters by 5 rows. Row 1 is the base value, rows A to D the lane amounts in
the lane's colour. Zero amounts stay dim.
1. T: Ratio 1, Feedback, Ratio 2, Depth 2, Wave, Depth, Strike, Strike Decay.
2. S: Fold, Fold Place, Length, Held share, Sine Level, Sine Pitch, Glide, Velocity.

Decided 2026-11-13:
1. Every edit is audible at once. No Apply, no Revert (André rejected both, 2026-11-13).
2. A random for everything inside a pattern, to create unique new patterns in place. It changes the seeds, the
   lane lengths, the sound values and the mapping amounts. In the lab as `Pattern::random(seed)`, its draw ranges
   are frozen: André on `listen/random-01` to `random-12`: "amazing", "let's not change a thing" (2026-11-13).
   The engine must draw exactly like `Pattern::random`.
3. Pitch is shown in Hz, never as note names, because nothing is quantised. Tune is in Hz, Range in octaves.
4. Tune and Volume take no lanes.
5. Copy and paste of patterns by shortcuts and context menu.
6. Wording: the loop that makes the pitches is the "pitch loop", not "note loop".

7. Editing is upfront: the editor shows and edits the pattern that plays. There is no separate pattern to edit
   in the background.

## Listening rounds (2026-11-13)

What André heard in the lab and decided. The renders are in `crates/target/surgeon-lab` (`listen` holds the
current files, `archive` the earlier rounds).

1. First render (one modulator, fixed figure): "already sounds great", but "misses low/mid end".
2. An octave lower or a ratio below 1: rejected, "now it misses the high end, which was great". The low end is
   added as a parallel sine under the unchanged FM sound.
3. Fixed figures "lack variations". Sequencer and sound merged into one device with parallel lanes.
4. Lanes on a fixed figure: not enough. "It starts becoming interesting" with generated note loops plus lanes.
5. Favourites: generated loop seed 1 with the half and the rectified wave, seed 3 with the half wave ("amazing",
   "very close").
6. Reverb wet 3 dB lower in the lab wash.
7. Free pitch instead of semitones: kept, "all free". Scale blend: dropped.
8. Two modulators: wanted as a blend. All four waves stay.
9. Length lane with a quarter of the steps held: too many long notes. Random from short to long with a few held
   steps: "adds something".
10. Fold place: a parameter.
11. Lanes generic with the mapping in the sound, four lanes, amounts add up, every sound parameter mappable.
12. Favourite rebuilt as a pattern: still sounds like the favourite. More mapped parameters: "adds life".
13. Patterns: 8 (first 16), buttons in the editor, Off button, switch on the bar, join in phase, automation wins.

## FM background

1. Chowning 1973: one modulator gives sideband pairs around the carrier, spaced by the modulator frequency. The
   number of audible pairs grows with the depth, so an envelope on the depth moves a whole spectrum.
2. At a ratio that is not a whole number the sidebands that fall below zero fold back between the others. The
   spectrum gets about twice as dense and never lines up as harmonics. That is the metallic tone.
3. Feedback on a modulator turns its sine into a saw like wave and then into noise.
4. A fold after the carrier multiplies the partials again.

Sources: [Chowning 1973](https://web.eecs.umich.edu/%7Efessler/course/100/misc/chowning-73-tso.pdf),
[Truax, Frequency Modulation](https://www.sfu.ca/~truax/Frequency_Modulation.html).

## Inspiration, not cloning

Our own engine and controls. No circuit, parameter set, layout or preset name of a product is copied.

## Lab

`crates/surgeon-lab`, a dev only workspace crate, never built for the browser.

1. `voice.rs`: the prototype voice (`Patch`, `Voice`), runs at twice the output rate.
2. `sequencer.rs`: the seeded hash (`unit`), mutation (`generation`), seeded notes (`Seeded`) and the first lane
   model that binds a lane to one parameter (`Lane`, `Program`). Kept because the archive renders use it.
3. `pattern.rs`: the settled model. `GenericLane`, `Param` with its ranges, `Pattern` (base and amounts),
   `Performance` (patterns fired on bars, Off).
4. `figure.rs`: the fixed figures of the first rounds and the decimator.
5. `wash.rs`: ping pong delay into the Dattorro plate, for listening only.
6. `bin/render_ab.rs`: writes all renders. Run from `crates/surgeon-lab`:
   `cargo run --release --bin render_ab -- ../target/surgeon-lab`.
   `bin/render_random.rs` writes only Random all patterns into `listen`:
   `cargo run --release --bin render_random -- ../target/surgeon-lab [first seed] [count]`.
7. Tests (29, run `cargo test --release` in `crates/surgeon-lab`): sideband positions, slide without retrigger, held notes, sine layer, determinism, mutation,
   mapping sums and limits, switches, bar switching, Off, joining in phase, and the favourite as a pattern
   against its earlier render.

The favourite as a pattern (`listen/1-favourite-as-pattern`):
1. Notes: seed 1, 7 steps, Range 13, Density 80 %, Tie 25 %, Accent 60 %, Mutate 12 %.
2. Lanes: A 5 steps seed 21, B 9 steps seed 22, C 4 steps seed 23, D 11 steps seed 24, all Mutate 15 %.
3. Sound: Tune 50, Ratio 1 2.41, Ratio 2 5.19, Depth 2 0.6, Wave rectified, Depth 0.6, Strike Decay 140 ms,
   Fold Place before, Held share 8 %, Sine Level 0.6 an octave below, Glide 40 ms, Velocity 0.7.
4. Mapping: Feedback 0 to 0.8 on A, Strike 1 to 7 on B, Fold 0 to 0.5 on C, Length full range on D.

Never change the rolls in `Seeded::step` or `GenericLane::value`, the favourite loops depend on them. The engine
must reproduce the same hash.

Renders are not bit reproducible across builds. With feedback the voice amplifies rounding, so another compiler
profile gives the same loop and the same parameter values but samples that differ. The files André judged were
rendered while the lab was a workspace member. Do not render over them without need, and compare the engine to
the lab by notes, parameter values and spectra, never sample by sample.

## Engine notes

1. One device crate in `crates/stock-devices`, registered like the other stock devices.
2. The voice runs oversampled (the lab uses 2x), FM at high depth and the fold alias otherwise.
3. From `dsp`: `hit_envelope`, `svf`, `resampler`. New shared blocks in `dsp`: fold and a phase modulation
   operator, both also wanted by openDrum.
4. The loop reads the transport position of the block and computes its steps from it, no stored sequence.
5. Patterns are data in the box, 8 snapshots of about 108 values each.

## Parts

1. Box schema in `forge-boxes`, generated boxes. Pattern storage is the large part.
2. Adapter with the parameter mappings, factory entry, manual URL, icon, device tags.
3. Rust crate, engine module registration, parameter mapping parity test.
4. Editor.
5. Scripting API entries.
6. Manual page.

## Phases

1. ~~Lab: prototype voice, generated loops, lanes, mapping, patterns, listening rounds.~~
2. Editor layout and design. Layout drawn (`plans/surgeon-editor.svg`). A preview on `/testing` only when
   André asks for it.
3. Engine crate with node render tests, checked against the lab renders.
4. Box, adapter, real editor. Browser checkpoint.
5. Presets: patterns, and the chain with Delay and Dattorro Reverb.
6. Manual page, scripting API.

## Open

1. How the 110 values are shown in the editor.
2. Rate: which step lengths besides sixteenths.

