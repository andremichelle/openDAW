# Enhanced Arpeggio

Status: phases 0 to 3 implemented 2026-11-04, uncommitted. Phase 4 (controlled chaos, polymetric lanes, scale) open.

## Implementation notes (what differs from the plan below)

1. **18 modes**, not 19: "Played" was dropped as a mode, Order = Played with Up gives the same. Migration maps
   old unit → `round(unit × 2) / 17`.
2. **Field keys as built**: 16 order, 17 hold, 18 retrigger, 19 offset (parameters), 20 seed, 30..36 the lanes
   as int32 arrays of 64 (kinds, velocities %, gates %, transposes, octaves, chances %, ratchets), 37
   pattern-length, 99 version. Lanes are int arrays so the engine observes 7 fields (`FieldValue::Ints`).
3. Not built yet: Transpose Distance, Scale, Order "Played Locked", Slide lane, per-lane lengths, controlled
   chaos, Mutate.
4. Pitches above 127 pass through as the legacy device emitted them (the golden test requires it), only notes
   below 0 are dropped. Worth a separate fix for both old and new paths.
5. Device migrations moved to `studio-adapters/src/migration` (`DeviceMigration`), shared by `ProjectMigration`
   and `PresetDecoder` (presets were copied in unmigrated, a gap for Delay too). They run in their own pass after
   the event migrations, so copied collections never carry legacy slopes.
6. `MigrateDelayDeviceBox` automation branch never ran (it searched the parameter's incoming pointers for
   `ValueEventBox`es). Fixed via the shared `migrateAutomation`, which also copies shared collections.
7. Walk and Random Other sum over every earlier step, cached and recomputed from 0 after a jump back, so they
   never depend on playback history.
8. Engine capacities: retained notes 64 → 256, events per block 128 → 256 (the host's per-quantum capacity),
   ratchet hits due in later blocks get their own buffer (32 × 7).

Tests: `device-arpeggio` golden (20 000 random scenarios + full legacy grid against a frozen copy of the
old device), 45 feature tests (walk sequences, lanes, hold, retrigger, block-size independence, loop
determinism, note-on/off pairing), adapters migration tests (shared regions/clips copied, two arps, presets),
core-wasm `arp-steps.test.ts` (lanes, seed and migrated automation through the real engine).

Goal: turn the stock Arpeggio into a sophisticated arpeggiator with more walks (note orders), a step sequencer
with rest / tie / chord steps and value lanes. Scripted arpeggiators stay a Spielwerk topic. An existing
project must play bit-identically after the upgrade.

---

## 1. What exists today (the behaviour we freeze)

Engine: `crates/stock-devices/device-arpeggio/src/lib.rs` (Rust, the TS processor is gone). Schema:
`ArpeggioDeviceBox` fields 10 to 15. Adapter: `ArpeggioDeviceBoxAdapter`. Editor: six knobs.

1. **Mode** `[10]` int 0..2: Up, Down, UpDown (UpDown cycle `notes × octaves × 2 − 2`).
2. **Octaves** `[11]` int 1..5, always upward, the octave advances once per full note cycle.
3. **Rate** `[12]` index into 17 fractions (1/1 … 1/128, incl. 1/3, 3/16, 3/32, 3/64 …).
4. **Gate** `[13]` 0..200 % of the rate.
5. **Repeat** `[14]` 1..16, `walkStep = gridIndex / repeat`.
6. **Velocity** `[15]` bipolar magnet (fixed velocity below 50 %, blend to input above).

Implicit behaviour that is part of the contract, easy to break by accident:

1. **The pool is ordered by (start position, pitch)**, not by pitch. A chord struck at once sorts by pitch, notes
   that start at different times play in the order they started. "Up" is therefore really "As Played, ties
   broken by pitch".
2. **The phase is absolute.** Steps land on `index × rate` of the song grid and the walk step is derived from
   that absolute index. Nothing restarts when a key goes down.
3. The pool at a step is "every source note whose span covers that step position". Adding or removing a note
   mid cycle re-indexes the walk (`step % count`).
4. Stopped transport arpeggiates live notes on a free-running grid.
5. A DISCONTINUOUS block (seek, loop wrap) releases every emitted note at `from`.
6. Note-on before note-off at an equal position (keeps mono synths legato at gate 100 %).
7. Emitted notes ignore the release of their source note, they always last `rate × gate`.
8. Fixed capacities: 32 source notes, 64 retained notes, 128 events per block.
9. Parameter mapping parity: `map_parameter` ids follow the `init` bind order (`param-mapping-parity.test.ts`).

---

## 2. Research: what sophisticated arpeggiators do

| Product | Notable ideas |
|---|---|
| Ableton Live Arpeggiator | Styles Up, Down, UpDown, DownUp, Up&Down, Down&Up, Converge, Diverge, Con&Diverge, Pinky Up / UpDown, Thumb Up / UpDown, Play Order, Chord Trigger, Random, Random Other, Random Once. Retrigger Off / Note / Beat, Hold, Offset (rotate start), Transpose with Distance + Steps (optionally in key), velocity decay with Retrigger. |
| Logic Pro Arpeggiator | Note order presets + Variation knob, As Played with Lock (keeps the played order shape when new notes replace old ones). 16-step grid with velocity, length, rest, tie, chord per step. **Grid length cycles independently of the note cycle**, steps are locked to step numbers so rests survive note order changes. Live mode inserts rests / ties / chords while latched. |
| Cubase Arpache 5 / Arpache SX | Classic modes plus Sequence mode: a dropped MIDI phrase is the pattern, held notes map onto its voices (Trigger, Trigger Continue, Chord modes). |
| Deluge (community firmware) | Split **Octave Mode** (Up, Down, UpDown, Alternate, Random) from **Note Mode** (Up, Down, UpDown, Random, Walk1/2/3, Played Order, Pattern). Rhythm presets (50 rest patterns), Sequence Length, Step Repeat. Randomizer with a **Lock**: octave spread, gate spread, velocity spread, ratchet amount + probability, chord polyphony + probability, note probability, bass probability, step probability (jump), glide probability. |
| Arturia MiniFreak / KeyStep | Walk (weighted forward / repeat / back), Pattern, Random Octave, Repeat, Ratchet as performance holds, **Mutate** (evolve the pattern a little on each press), **Spice + Dice** (randomise gate, velocity, octave per step, amount controlled). |
| Kirnu Cream | Four tracks, each with order, velocity, length, transpose, division lanes plus CC lanes, **every lane with its own loop length and direction** (polymetric), chord memory, 40 scales, notes outside the input chord. |
| BlueARP | Key lane (which held key by index), octave lane and semitone lane per step, step types Normal / Tie / Rest, works as a classic arp when the key lane is neutral. |
| Elektron Digitone | Modes True, Up, Down, Cycle, Shuffle, Random, per-step on/off, per-step semitone offset, arp length up to 16, range, Chord mode playing held notes on the arp rhythm. |
| Audiotool Matrix Arp, Output Arcade, Cherry Audio, Minimal Audio | Per-step mute, tie that extends instead of retriggering, per-step velocity override, octave, probability, chance and humanise lanes. |
| Gradus | Nine polymetric lanes, each with own step count, speed and timing. |
| Serum 2 | Built-in arp with up to 32 steps and a piano-roll "pattern" option for syncopated rhythms. |

Common feature set across the field, grouped:

1. **Note pool**: order source (pitch, played, played-locked), hold / latch, octave range with its own direction,
   octave spread, transpose distance and steps (Ableton "Distance"), scale quantise, chord memory.
2. **Walks**: directional, folding (converge / diverge), pedal (pinky / thumb), random variants (with and
   without repeats, once per phrase), weighted random walk, played order, generated pattern.
3. **Rhythm**: rest steps, tie steps, chord steps, ratchets, accents, per-step gate, per-step velocity,
   per-step transpose / octave, per-step probability, glide / slide.
4. **Time**: retrigger on note / bar / beat, pattern offset (rotate), pattern length decoupled from the note
   cycle, polymetric lane lengths, swing.
5. **Controlled chaos**: probability lanes with a seed and a lock, mutate, dice with an amount.

Sources: [Ableton MIDI effect reference](https://ableton.com/en/manual/live-midi-effect-reference),
[Logic Pro arpeggiator (iPad guide)](https://support.apple.com/guide/logicpro-ipad/lpipe427b7a5/ipados),
[Logic Pro arpeggiator grid](https://help.apple.com/logicpro-effects/mac/10.2/en.lproj/lgceb8988421.html),
[Arpache SX reference](https://archive.steinberg.help/nuendo_plugin_reference/v13/en/_shared/topics/plug_ref/arpache_sx_r.html),
[Deluge community firmware arpeggiator](https://mgabor3141.github.io/DelugeFirmware/features/arpeggiator),
[Deluge Walk mode PR](https://github.com/SynthstromAudible/DelugeFirmware/pull/3285),
[KeyStep Mutate and Spice](https://support.arturia.com/hc/en-us/articles/24773018134684-KeyStep-37-mk2-Mutate-and-Spice),
[MiniFreak details](https://www.arturia.com/products/hardware-synths/minifreak/details),
[Kirnu Cream review](https://rekkerd.org/review-arto-vaarala-kirnu-cream-midi-performer-plugin/),
[BlueARP discussion](https://www.kvraudio.com/forum/viewtopic.php?p=6676953),
[Digitone arp questions](https://www.elektronauts.com/t/digitone-arp-questions/130327),
[Audiotool Matrix Arpeggiator](https://help.audiotool.com/manuals/Plugins/Tools/MatrixArpeggiator.html),
[Output Arcade arp](https://support.output.com/en/articles/10297671),
[Gradus manual](https://rolandzwaga.github.io/krate-audio/gradus/manual.html),
[Serum 2 announcement](https://musicradar.com/music-tech/serum-2-just-dropped-one-of-the-greatest-soft-synths-of-all-time-gets-a-massive-update-and-its-completely-free-for-existing-users).

---

## 3. Backwards compatibility contract

1. **Fields 10 to 15 keep key, type and meaning.** Existing values keep their meaning: Up / Down / UpDown stay
   indices 0 / 1 / 2 of `mode-index`, the 17 rates keep their indices.
2. **Widening a range comes with an automation migration** (`MigrateArpeggioDeviceBox`, see 3.1).
3. Every new field defaults to the value that reproduces today's output. A project saved before the upgrade
   loads the defaults and plays identically.
3. New parameters are bound AFTER the existing six, so `map_parameter` ids 0 to 5 stay.
4. The legacy path is not a special case to maintain forever by hand: a **golden test** (phase 0) records the
   current output for a matrix of inputs and parameters and must stay green through every phase.
5. Field keys are never reused with another type (schema migration rule).
6. `ArpeggioDeviceBoxAdapter.namedParameter` and the scripting API (`packages/studio/scripting`
   `MIDIEffects.ts`, `DeviceBoxes.ts`) only gain members (SDK consumers).
7. Device presets and community content keep loading (they carry the box, missing fields get defaults, the
   same migration runs on preset load).
8. Forward compatibility is NOT required: an older studio does not need to open a project saved by the new one.

### 3.1 Automation migration

Automation stores unit values (0..1), so widening `mode-index` from 3 to 19 entries would turn an automated
"Down" (unit 0.5) into another walk. The migration rewrites them.

1. **Gate**: a new `version` field `[99]` int (default 0, like `DelayDeviceBox`). `EffectFactories` sets the
   current version on every new box, `migrateArpeggioDeviceBox` runs in `ProjectMigration` for `version < 1`
   and sets it to 1. Presets go through the same migration on load.
2. **Path**: the parameter field ← `TrackBox.target` (automation track) → `TrackBox.regions` / `clips` ←
   `ValueRegionBox` / `ValueClipBox` → `events` → `ValueEventCollectionBox` ← `ValueEventBox`es.
3. **Value**: old unit → old index `round(unit × 2)` → new unit `index / 18`. Exact for every stored integer
   value. Interpolated ramps between two events keep their endpoints, the steps in between are integers
   either way.
4. **Shared events**: a `ValueEventCollectionBox` can be referenced by several regions or clips. If any of
   them belongs to a track whose target is NOT this arp's `mode-index`, the collection (with its events) is
   copied first, the arp's regions are pointed at the copy, and only the copy is rewritten. The other users keep
   the original untouched. Several regions of the same arp mode track sharing one collection share the
   migrated copy, so their link stays.
5. **Two arps sharing one collection** (both `mode-index`): migrate once, keep it shared. The collection is
   tracked by address so it is never rewritten twice.
6. Only fields whose range widens need this. Today that is `mode-index` only, the rest keep their ranges.
7. Not migrated, stated in the release notes: a MIDI-learned controller on Mode now sweeps 19 entries instead
   of 3, and a modulation amount on Mode covers a different span of modes.

Note: `MigrateDelayDeviceBox` looks for `ValueEventBox`es among the incoming pointers of the parameter field,
but those pointers come from `TrackBox.target`, so its automation branch may never run. Verify it while writing
this migration, and fix it in a separate change.

---

## 4. Signal flow of the new device

Per grid step (the rate grid stays the master clock):

1. **Pool**: the covering source notes (as today), plus held notes if Hold is on, ordered by Order.
2. **Expand**: notes × octaves (one long row, today's behaviour), plus transpose distance, optional scale
   quantise.
3. **Walk**: the walk picks one index (or several for a chord, or none for a rest) from the expanded pool for
   the current walk step.
4. **Step**: the step sequencer lanes decide rest / tie / chord / ratchet and modify gate, velocity, transpose,
   probability for this grid step.
5. **Emit**: note-ons with exact durations (ties are resolved by look-ahead, see 6.3), note-offs as today.

With Mode 0 to 2, default pool settings and neutral steps, steps 1 to 5 collapse to today's code path.

---

## 5. Features and new fields

Field keys below are proposals, 16 onward for scalars, 30 onward for the step sequencer.

### 5.1 Note pool

1. **Order** `[16]` int: Played (default, today's (start, pitch) order), Pitch, Played Locked (Logic's Lock,
   keeps the shape of the order when notes are replaced). The UI names "Played" honestly, the manual sentence
   "notes are sorted by pitch" gets corrected.
2. **Hold** `[17]` bool, default off: keeps the pool after all keys are up until the next new key press.
   Works live and with sequenced notes.
3. No separate octave direction (decided 2026-11-04): the walk runs over notes × octaves as one row, the
   modes already cover the musical cases.
4. **Transpose Distance** `[19]` int −12..12 semitones, default 12. Octaves become "repetitions" that step by
   Distance (Ableton). 12 reproduces today.
5. **Scale** `[20]` root + `[21]` mask, default chromatic / off. Quantises the expanded pool and the transpose
   lanes. No project-wide scale exists yet, so this lives on the device (open question 6).

### 5.2 Walks

The walks extend **`mode-index` `[10]`** itself (with the automation migration of 3.2). Indices 0, 1, 2 stay
Up, Down, UpDown with today's arithmetic. New entries follow:

1. DownUp, Up & Down (repeats ends), Down & Up
2. Converge, Diverge, Converge & Diverge
3. Pinky Up, Pinky UpDown, Thumb Up, Thumb UpDown
4. Played (alias that ignores Order, uses play order)
5. Random (with repeats), Random Other (never the same note twice), Shuffle (random permutation per cycle),
   Random Once (one permutation kept until the pool changes)
6. Walk (weighted forward / repeat / back, fixed weights 50 / 25 / 25 like the Deluge Walk2)

No script mode: a custom walk is a Spielwerk script (decided 2026-11-04).

Chord is not a walk: it is a step type of the sequencer (5.3).

Plus **Offset** `[24]` int (rotate the walk start, Ableton) and **Retrigger** `[25]` int: Off (default,
absolute phase as today), Note (restart when the pool goes from empty to non-empty), Bar, Beat.

All random walks draw from a **deterministic hash** of (seed, absolute step index, lane), not from a running
generator. A loop, a seek, an offline export and a composite replica therefore all hear the same pattern.
**Seed** `[26]` int 0..999999, shown like the Random modulator: an editable Seed number field plus a framed
orange **Reseed** button showing the dice icon (`IconSymbol.Random`) that writes a random seed in one undoable edit (`RandomModulatorBoxAdapter.reseed`,
`MaxSeed`).

### 5.3 Step sequencer

**Steps** `[30]` fixed array of **64** step objects (approved, precedent: `CubedDeviceBox`,
`StepsModulatorBox`), **Pattern Length** `[31]` int 1..64. The sequencer is always present, a fresh step is a
plain Note with neutral lanes, so 16 neutral steps play exactly the legacy arp (no on/off switch).

Per step:

1. **Type**: Note, Rest, Tie, Chord (Logic grid). Chord plays the whole pool (or **Chord Size** notes from the
   walk position upward, and an optional strum).
2. **Velocity** 0..100 %, multiplies the magnet result (100 % is identity).
3. **Gate** 0..200 %, multiplies the global gate.
4. **Transpose** −24..24 semitones (scale degrees when a scale is set).
5. **Octave** −3..3.
6. **Probability** 0..100 %, deterministic hash per absolute step.
7. **Ratchet** 1..7, splits the step into equal hits.
8. **Slide**: extends the gate into the next step so mono synths glide (uses the existing ON-before-OFF order).

Design rules taken from the research:

1. The step grid cycles independently of the walk cycle (Logic): a rest stays on step 3 when notes change.
2. **Every step advances the walk**, rests, ties and chords included (decided). A rest silences the note the
   walk would have played, so the melody stays locked to the grid.
3. A Chord step plays the whole pool and **does not call the walk**.
4. **Rest and Tie steps have no values.** Their lanes are inactive and cannot be edited. A tied note takes
   velocity, pitch, octave and gate from the step that started it.
5. **Gate is multiplied**: note length = `rate / ratchets × globalGate × stepGate`. A step gate of 100 % leaves
   the global gate unchanged. A tie adds one full `rate` per tie step, and the start step's gate shapes only
   the last tied step.
6. **Velocity**: the global velocity stays the bipolar magnet (−100 … +100 %, 0 = full velocity, as today).
   The step velocity multiplies the magnet result, so 100 % changes nothing.
7. Each value lane may have its own length (Cream polymeter), defaulting to Pattern Length. This can come in a
   later phase.

### 5.4 Controlled chaos (later phase)

Global amounts in the Deluge style, all deterministic per seed: Octave Spread, Gate Spread, Velocity Spread,
Ratchet Probability, Chord Probability, Jump Probability, Glide Probability. A **Mutate** action rewrites a
few step values in the box (undoable, so the result is saved and shareable).

---

## 6. Engine design (Rust)

1. One `process` loop stays. The step function becomes `pool → expand → walk → step → emit`, each a small
   function so modes 0 to 2 keep the same arithmetic as now (the golden test guards it).
2. Walks are a `match` over `mode-index`. Each walk is a pure function `(walkStep, count, seed) -> pick`, so
   loops, seeks, offline export and composite replicas agree.
3. **Ties by look-ahead**: at a note-on the device scans the following steps of the deterministic step lane
   (including probability hashes) and sets the note's duration across all tied steps. The note-on then carries
   the true duration, which downstream Spielwerk and Zeitgeist read. A seek inside a tie releases as today.
4. Ratchets emit up to N note-ons in one step, chords up to the pool size. The 64 retained / 128 per block
   capacities stay unless the step maximum needs more (open question 1).
5. Field observation: scalar fields that should be automatable are parameters (`bind_parameter`), the steps
   array is read through `observe_field` paths like `device-cubed`, so step edits are never automation.
6. Live telemetry: the current grid step and walk step go out through `bind_broadcast_ints` for the editor's
   playhead, like the Step Arp community script.

---

## 7. UI

1. No knobs. The panel is rebuilt once, every control keeps its place across all modes (no layout jumps).
2. Label controls (Delay style, no knobs) in three groups: WALK Mode, Order, Octaves, Hold, TIME Rate,
   Repeat, Retrigger, Offset, NOTE Gate, Velocity. Seed field and Reseed button sit in the sequencer toolbar
   (as in `RandomEditor`).
3. Sequencer: a step strip with a lane selector (Type, Velocity, Gate, Transpose, Octave, Probability,
   Ratchet), Pattern Length, playhead from the broadcast. Toolbar actions as in Cubed `PatternControls`:
   framed blue `<` / `>` rotate the steps within Pattern Length (`rotateCurrentPattern`), framed green Clear
   resets every step to a neutral Note, each one undoable edit. The panel keeps its size, the parent scrolls.
4. Manual: rewrite `devices/midi/arpeggio.md`, fix the "sorted by pitch" claim, document every walk with a
   small example sequence.

---

## 8. Phases

0. **Golden test first.** Native Rust test over a matrix: modes × octaves × rates × repeat × gate × velocity
   × staggered and struck chords × note changes mid cycle × seek / loop × stopped transport. Store expected
   event lists. Also extend `param-mapping-parity.test.ts` expectations for the six ids.
1. **Migration first, then pool + walks.** `version` field, `migrateArpeggioDeviceBox` with its tests (below),
   then Order, Distance, all native walks, Offset, Retrigger, Seed. Schema, adapter, scripting API, panel
   controls. Golden test green, new walk tests (one expected sequence per walk for 1, 2, 3, 4 and 7 notes).

   Migration tests (`MigrateArpeggioDeviceBox.test.ts`, building the box graph directly):
   1. Static values 0 / 1 / 2 stay Up / Down / UpDown, `version` becomes 1.
   2. Automation events at units 0, 0.5, 1 become 0, 1/18, 2/18 and decode to Up / Down / UpDown.
   3. A collection shared with a track that automates ANOTHER parameter (e.g. a Delay's sync) is copied: the
      other track's events are bit-identical afterwards, the arp's regions point at a new collection with
      migrated values.
   4. Regions and clips both: a shared `ValueClipBox` collection is handled like a region.
   5. Two regions on the same arp mode track sharing one collection still share one (migrated) collection.
   6. Two arps sharing one collection: migrated once, values decode correctly for both, still shared.
   7. Running the migration twice changes nothing (version gate).
   8. A new box from `EffectFactories` has the current version and is never migrated.
   9. A project with no automation on Mode migrates without creating boxes.
   10. Round trip: render the migrated project in core-wasm and compare against the golden output of the
       unmigrated legacy arp for an automated Mode sweep.
2. **Step sequencer**: steps array, Type with rest / tie / chord, velocity, gate, transpose, octave lanes,
   tie look-ahead. Browser checkpoint on the panel.
3. **Probability, ratchet, slide, Hold.**
4. **Controlled chaos + polymetric lane lengths + scale.**
5. Manual, video notes, community announcement.

Each phase: `cargo test` for the device, the wasm build, the core-wasm tests that touch the arp
(`arp-rate`, `instrument-composite-unit-arp`, `playfield-unit-arp`, `midi-fx-disable-release`,
`param-mapping-parity`), and the golden test.

---

## 9. Open questions

Decided 2026-11-04: 64 steps, no script walks (that is Spielwerk), every step advances the walk, no forward
compatibility, widened ranges get an automation migration.

1. May ratchets and chords raise the 64 retained notes capacity?
2. Should emitted notes end early when their source note is released (many hardware arps do), as a new option
   with today's behaviour as the default?
3. Hold: device-local, or should it follow a global sustain pedal (see `plans/midi-sustain.md`)?
4. Scale on the device now, or wait for a project-wide scale?
5. Should Arpache-style phrase mode (a dropped MIDI region as the pattern) be in scope, or a separate device
   later?
