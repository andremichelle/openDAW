# Surgeon

Status 2026-11-13: Surgeon is a real stock instrument. It is in the device browser, plays in the studio and in
the headless engine, has its editor, a manual page and tests. The `/testing` preview and its own module are
removed. Scripts can use it. The default volume is -3 dB. Open: presets, a screenshot for the manual (see
"Device" below).

Branch: `surgeon`, in its own checkout `../openDAW-surgeon` (a git worktree, created 2026-11-13 from
`9fee779f6`). Committed, not pushed. The main checkout holds other work and must stay free of these files.
1. Files of this work: `plans/surgeon.md`, `plans/surgeon-architecture.svg`, `plans/surgeon-editor.svg`,
   `crates/surgeon-lab/`. Renders in `crates/target/surgeon-lab` (ignored).
2. The lab is a workspace member through the engine crate's dev-dependency, and the engine crate through the
   `stock-devices/*` glob. `crates/Cargo.toml` is unchanged on this branch, only `Cargo.lock` gains the two crates.
3. `hit_envelope.rs` and `svf.rs` in the lab and in the engine crate are copies of the openDrum blocks from the
   `opendrum` branch, which are not in `dsp` yet. Both switch to the `dsp` versions once those have landed.

Diagram: `plans/surgeon-architecture.svg`.

Name: Surgeon (decided 2026-11-13).

## Rule: the sound is frozen

Nothing may change the sound any more (André 2026-11-13). Every further feature must leave existing patterns
bit for bit as they are when it is not used. A new control starts at a value that changes nothing, and a test
proves it (as for Slide: at 0 % the engine renders the same samples as before).

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
| Tie | 0 to 100 % | share of sounding steps that tie into the next, which then gets no new strike |
| Slide | 0 to 100 % | chance that a step slides: its pitch glides from the previous pitch over one step. 0 % changes nothing, at 100 % every note slides |
| Accent | 0 to 100 % | how far velocities spread below full |

Rules:
1. Pitches are free. They are never rounded to notes and there is no scale (a scale blend was tried and dropped,
   "does not sound like I expected").
2. A tied step lasts a little longer than its step, so it overlaps the next note, which gets no new strike and
   reaches its pitch over Glide.
   The All button rolls Slide too, between 0 and 50 % (`Pattern::roll_all`). It never rolls Mutate or Rate, they
   stay as they are (André 2026-11-13: "Mutate should not be randomized"). The approved draw `Pattern::random`
   itself stays untouched, so a seed still gives the loops and the sound that were approved by ear.
3. A slide is separate from a tie (decided 2026-11-13): the pitch glides evenly from the previous pitch to the
   step's own pitch over exactly one step. The note is struck as usual unless it is also tied into.
4. A step that is not tied lasts half a step, a held step (see Length) almost the whole step.
5. Lab values of the favourite: 7 steps, Range 13, Density 80 %, Tie 25 %, Accent 60 %, Mutate 12 %.

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
7. Monophonic. A tied step runs into the next note without restarting the envelopes.

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
| Sine Gain | 0 to 1.5 | parallel sine. Lab: 0.6 |
| Sine Pitch | octave below, at pitch | pitch of the parallel sine |
| Glide | 0 to 300 ms | how fast a tied note reaches its pitch. Lab: 40 ms |
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

## Editor

The draft on `/testing` is the reference since 2026-11-13, it has moved on from the wireframe
(`plans/surgeon-editor.svg`) after André's review:
1. Pattern tiles are circles: a 3 x 3 grid of 1 to 8 and Off, with Tune and Volume below it.
2. The display has no outline.
3. Tabs are text tabs above the section, LOOPS, TONE and SHAPE, in the style of Delay's heads.
4. Every row sits on a tinted band with its rotated title at the right edge, as in Delay and Tubular: PITCH,
   LANES and ROLL on the loops tab, BASE and A to D (in the lane colours) on the sound tabs.
5. Columns are 50 px so no caption is cut.
6. Mutate starts at 0 % in every pattern and is never rolled by any button.
8. The pitch row is Seed, Steps, Mutate, Range, Density, Tie, Slide, Accent. Rate sits under the pattern circles
   above Tune and Volume, because the row has eight columns.
9. On the sound tabs the base row is titled 0 and the rows are lower, which gives the caption row more height.
   Captions stay on one line, a name that does not fit is abbreviated (Strike Dec, Held).
7. Table buttons are outlines in their row's colour, pressed looks like hover. Holding Lanes highlights the four
   lane Roll buttons, holding All highlights Pitch, Lanes, Sound and the lane Rolls.

The earlier layout notes follow.


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
2. S: Fold, Fold Place, Length, Held share, Sine Gain, Sine Pitch, Glide, Velocity.

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

## Device

How the engine core became an instrument (2026-11-13).

### Box

`SurgeonDeviceBox` (`forge-boxes/.../instruments/SurgeonDeviceBox.ts`):
1. `tune` (Hz), `volume` (dB) and `slot` (which pattern plays, -1 is off): automatable parameters.
2. `pattern`: the pattern the live controls belong to. It stays when the slot goes off.
3. `live`: 101 automatable parameters, the controls of the editor (rate, the pitch loop, the lanes, the sound and
   its lane amounts).
4. `patterns`: 8 times the same 101 values as plain fields.

One spec list generates both the live parameters and the pattern fields, so they cannot drift apart.

### Who uses what

1. The engine plays the stored patterns. A live control only counts while it is automated or modulated, then its
   value replaces that value in every pattern. So an automation lane keeps acting whichever pattern plays.
2. An edit of a live control is written into the pattern it belongs to in the same transaction (the adapter
   mirrors it). That is why an edit is heard at once and is kept, with one undo step.
3. Selecting a pattern sets `slot` and `pattern` and copies the pattern into the live controls. The engine takes
   over at the next bar, the bar comes from the signature track.
4. The engine reports the playing slot and the slot that waits for its bar. The editor shows the flash from it.

### Files

1. Rust: `crates/stock-devices/device-surgeon/src/device.rs` (the wrapper) and the exports in `lib.rs`.
2. Adapter: `adapters/src/devices/instruments/SurgeonDeviceBoxAdapter.ts`, with the loop model in
   `Surgeon/SurgeonModel.ts`.
3. Editor: `app/studio/src/ui/devices/instruments/SurgeonDeviceEditor.tsx` and `.sass`, the layout of the reviewed
   draft with the studio's own parameter controls.
4. Registration: device list of the schema, `BoxAdapters`, `InstrumentBox`, `InstrumentFactories` (the description
   contains "raw techno"), `DeviceManualUrls`, `IconSymbol` and `IconLibrary`, `engine-modules.ts`, `DEVICE_CRATES`
   in `build-wasm.sh`, `DeviceEditorFactory`, `DeviceTags`, the manual page and `Manuals.ts`.
5. Generated and committed: `crates/studio-boxes/src/registry.rs`.

### Tests

1. `core-wasm/test/param-mapping-parity.test.ts`: every bound parameter maps like its adapter.
2. `core-wasm/test/surgeon-render.test.ts`: the full engine plays the device from a project, Off is silent, a
   pattern plays its stored values, a live control that is not automated is ignored, the volume acts.
3. `adapters/.../Surgeon/SurgeonModel.test.ts` and `SurgeonValues.test.ts`: the loop model against the engine's
   values, and box values against the model.
4. `scripting/src/test/Surgeon.test.ts` and the scripting parity test: scripts reach tune, volume, slot,
   pattern, the live controls and all eight patterns with every value.
5. In the studio (checked in Chrome): the device is in the browser with its description, the editor renders, the
   transport plays it, a fired pattern flashes and takes over at the bar, Off silences it, no console errors.

### Open

1. Presets, and the chain with Delay and Dattorro Reverb.
2. The manual page has no screenshot.
3. `crates/Cargo.toml` has no `opt-level = 3` entry for the crate (a shared file, the other synths have one).
4. If the slot is automated, the playing pattern can differ from the one the live controls belong to. Edits then
   go to the pattern the controls show, not to the one that plays.
5. The engine delivers at most 32 automation changes per update position to one device. With more than 32
   controls automated at once, the rest is dropped.
6. Tune and Volume changes are not smoothed.
7. A script that writes a `live` value is only kept in a pattern while the project is open in the studio (the
   adapter does the keeping). Scripts should write `patterns`.

## Lab

`crates/surgeon-lab`, a dev only workspace crate, never built for the browser.

1. `voice.rs`: the prototype voice (`Patch`, `Voice`), runs at twice the output rate.
2. `sequencer.rs`: the seeded hash (`unit`), mutation (`generation`), seeded notes (`Seeded`) and the first lane
   model that binds a lane to one parameter (`Lane`, `Program`). Kept because the archive renders use it.
3. `pattern.rs`: the settled model. `GenericLane`, `Param` with its ranges, `Pattern` (base and amounts),
   `Performance` (patterns fired on bars, Off).
4. `figure.rs`: the fixed figures of the first rounds and the decimator.
5. `wash.rs`: ping pong delay into the Dattorro plate, for listening only.
6. `bin/render_ab.rs`: writes all renders. Run from `crates`:
   `cargo run -p surgeon-lab --release --bin render_ab`, output in `target/surgeon-lab`.
   `bin/render_random.rs` writes only Random all patterns into `listen`:
   `cargo run -p surgeon-lab --release --bin render_random -- target/surgeon-lab [first seed] [count]`.
7. Tests (41, `cargo test -p surgeon-lab --release`): sideband positions, slide without retrigger, held notes, sine layer, determinism, mutation,
   mapping sums and limits, switches, bar switching, Off, joining in phase, and the favourite as a pattern
   against its earlier render.

The favourite as a pattern (`listen/1-favourite-as-pattern`):
1. Notes: seed 1, 7 steps, Range 13, Density 80 %, Tie 25 %, Accent 60 %, Mutate 12 %.
2. Lanes: A 5 steps seed 21, B 9 steps seed 22, C 4 steps seed 23, D 11 steps seed 24, all Mutate 15 %.
3. Sound: Tune 50, Ratio 1 2.41, Ratio 2 5.19, Depth 2 0.6, Wave rectified, Depth 0.6, Strike Decay 140 ms,
   Fold Place before, Held share 8 %, Sine Gain 0.6 an octave below, Glide 40 ms, Velocity 0.7.
4. Mapping: Feedback 0 to 0.8 on A, Strike 1 to 7 on B, Fold 0 to 0.5 on C, Length full range on D.

Never change the rolls in `Seeded::step` or `GenericLane::value`, the favourite loops depend on them. The engine
must reproduce the same hash.

Renders are not bit reproducible across builds. With feedback the voice amplifies rounding, so another compiler
profile gives the same loop and the same parameter values but samples that differ. The files André judged were
rendered while the lab was a workspace member. Do not render over them without need, and compare the engine to
the lab by notes, parameter values and spectra, never sample by sample.

## Engine

`crates/stock-devices/device-surgeon`, the engine core: plain Rust, heap free, builds for the browser target. It
is not in the wasm build list yet and has no device ABI wrapper, that comes with the box.

1. `hash.rs`: the rolls, identical to the lab's. `pattern.rs`: `PitchLoop`, `Lane`, `Pattern` (base and amounts for
   the 16 mappable sound parameters), `Pattern::random`, and `event(step)`, what a step plays.
2. `voice.rs`: the voice, ported from the lab with `libm`.
3. `engine.rs`: `Engine` with 8 patterns, Tune and Volume. `process(p0, p1, playing, discontinuous, output)` renders
   one block from the block's pulse range, 2x oversampled through `dsp::resampler`. It keeps no sequence: every
   step is computed from the song position.
4. Behaviour: a step starts when the position crosses its sixteenth. A fired slot (pattern or Off) takes over at
   the next bar line. A start exactly on a step plays it, a start inside a step waits for the next. A stop or a
   jump lets go of held notes, the tail rings out. Positions before zero are silent.
5. Tune is held as a MIDI number with fractions internally, the editor shows Hz.

Checked against the lab (`tests/parity.rs`, 14 tests, `cargo test -p device-surgeon --release`):
1. The rolls are the lab's rolls.
2. The favourite plays the lab's notes and parameter values over 4000 steps.
3. Random all draws exactly like the lab for 300 seeds.
4. The voice matches the lab's voice within rounding while the phases have not drifted, and by level afterwards.
5. The engine plays the favourite at the lab's levels, bar by bar within 1.5 dB.
6. Bar switching, Off, firing the active slot again, stop, start on and inside a step, locate, block size,
   determinism, all random patterns finite and bounded.

Rate: a pattern has a rate (eighth, sixteenth, thirty-second) shared by the pitch loop and the lanes. Bars are
counted in pulses, so patterns of different rates switch on the same bar lines. `select` switches a slot at once,
for a stopped transport.

No clicks (2026-11-13): when a step starts while the previous note still rings, the level, the strike, the
depth, the feedback, the second modulator, the fold and the sine gain reach their new value within about 2 ms
instead of one sample. A note that starts from silence is untouched, a fingerprint test proves it sample for
sample. `examples/clicks.rs` measures the jumps: before, up to 174 of 256 step starts jumped in a Random all
pattern, none at note ends. André confirmed by ear on the rebuilt preview that the crackle is gone.

Cost: replacement counts are carried forward step by step in the engine (and in the editor's copy), they are no
longer counted from the song start on every step. A changed Rate waits for its next grid line instead of
starting a note inside a step.

Fixed with André's yes (2026-11-13), the one deliberate change to the frozen sound: with Held at 0 % a Length of
exactly 100 % used to play as a held note with a short release. It now gives the longest decay.

Open in the engine:
1. Tune and Volume changes are not smoothed.
2. The device ABI wrapper: parameter binding, automation of every value, the pattern data and the fired slot
   coming from the box.

## Parts

1. Box schema in `forge-boxes`, generated boxes. Pattern storage is the large part.
2. Adapter with the parameter mappings, factory entry, manual URL, icon, device tags.
3. Rust crate, engine module registration, parameter mapping parity test.
4. Editor.
5. Scripting API entries.
6. Manual page.

## Phases

1. ~~Lab: prototype voice, generated loops, lanes, mapping, patterns, listening rounds.~~
2. Editor layout and design. Layout drawn (`plans/surgeon-editor.svg`). Draft on `/testing`:
   `packages/app/studio/src/ui/pages/testing/SurgeonPreview.tsx`, every control works on a TypeScript model of the
   loops (`surgeon/SurgeonModel.ts`, tested against values printed by the engine), the display follows a preview
   clock. It sits in the `PreviewDevicePanel` frame copied from the `opendrum` branch. Sound: the real engine
   core as `crates/surgeon-wasm` (`surgeon_wasm.wasm`, built by hand) inside an audio worklet
   (`surgeon/SurgeonWorklet.js`, `surgeon/SurgeonAudio.ts`), which also reports the position the display follows.
3. ~~Engine core, checked against the lab.~~
4. Box, adapter, device ABI wrapper, real editor. Browser checkpoint.
5. Presets: patterns, and the chain with Delay and Dattorro Reverb.
6. Manual page, scripting API.

## Open

1. How the 110 values are shown in the editor.
2. Shared build files (decided 2026-11-13): this branch leaves `crates/Cargo.toml` and `TestingPage.tsx` as they
   are on `next-release`. In `build-wasm.sh` it only adds `device-surgeon` to the device list, a line `opendrum`
   does not touch. The `/testing` preview and its module `surgeon-wasm` are removed.

