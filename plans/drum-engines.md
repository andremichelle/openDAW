# openDrum: a suite of synthesized drum devices

Status: plan 2026-11-13. Phase 1 preview on /testing (Kick, Hat in `PreviewDevicePanel`) accepted 2026-11-13, uncommitted.
The other devices need no preview, they share the frame and differ only in their engine groups.

## Goal

1. A family of instrument devices, one sound engine each (kick, snare, clap, hats, cymbals, toms, rim, ...).
2. They share the prefix openDrum and one recognisable editor frame, so a Playfield full of them reads as a kit.
3. Each device is a normal instrument: it sits on its own track or inside a Playfield pad (pads already host
   any instrument, see `plans/playfield-nano.md`).
4. No samples. Every sound is synthesized, deterministic (seeded noise), and renders identically in node tests.

## Name

Prefix **openDrum**, always written in full: openDrum Kick, openDrum Snare, openDrum Clap, openDrum Hat,
openDrum Cymbal, openDrum Tom, openDrum Rim, openDrum Bell, openDrum Shaker, openDrum Perc.

## Inspiration, not cloning

The engines are our own designs. Classic drum machines, kick synths and grooveboxes are inspiration only:
we take the general synthesis ideas (pitch swept sines, filtered noise, metallic oscillator banks, membrane
modes, repeated noise bursts for claps) and build our own controls, our own sound and our own ideas on top.
No device copies the circuit, the parameter set, the layout or the preset names of a product.

## Our own ideas across the suite

1. **Velocity shapes the sound**, not only the level: each device maps velocity to its most musical parameter
   (kick click, snare wire, hat openness, clap hand count).
2. **Hit display**: every editor shows the actual hit it will play.
3. Analog feel (random per hit differences) comes from the existing Random modulators, no device knob (decided
   2026-11-13).

## Rule: as few parameters as possible

Every engine gets the smallest parameter set that reaches its sounds (decided 2026-11-13). One control that
moves several internal values together beats several controls. A new parameter needs a sound it unlocks that no
existing parameter can reach.

The reference lab lives in `crates/opendrum-lab`, a dev only workspace crate, never built for the browser
(decided 2026-11-13).

## Rule: reach the classics

Kick, Snare, Tom, Clap and Rim must be able to emulate the classic analog drum machines 808 and 909 (decided
2026-11-13). This is a floor, not the goal: the engines reach much further. Our own engines and controls, no
copied circuits or preset names, but the parameter ranges and building blocks must reach those sounds.

### Circuit research (2026-11-13)

Collected from the service notes, the Werner/Abel/Smith DAFx 2014 808 bass drum paper and circuit write-ups.
Numbers vary between machines and board revisions (5% parts), so the references below decide, not these values.

1. 808 bass drum: a bridged T resonator pinged by a 1 ms trigger (no oscillator). Tune around 49 to 56 Hz.
   Decay sets the feedback, 50 to 800 ms (300 ms centre). At the attack the pitch is pushed up to about 130 Hz for
   about 6 ms, then a slow downward drift over the decay (leakage of the retrigger path). Tone is a passive low
   pass after the resonator that softens the click. Accent raises the trigger level.
2. 909 bass drum: a triangle VCO, reset to the same start phase on every trigger, swept by a pitch envelope
   (sources differ: Tune sets the depth or the length of that sweep), diode clipped towards a sine. Its amp
   envelope has a compressed shape (a held, slowly falling top), the source of the punch. The click: the trigger
   shaped into a pulse by a low pass and a band pass, plus low passed noise, through their own VCA and short
   envelope, Attack sets its level.
3. 808 snare: two bridged T resonators (238 and 476 Hz in the 1981 spec, about 173 and 336 Hz after a later part
   change), Tone sets their mix. Snappy: white noise through an envelope and a high pass, a low pass on the output.
4. 909 snare: two triangle VCOs (ratio about 1.47), reset in phase on every trigger, each diode clipped towards a
   sine, each with its own VCA and envelope. A pitch bend of about 20 ms at the start. Noise from a 32 stage shift
   register, low passed, then split: one path on its own envelope, one path high passed on a second envelope.
   Tone sets the noise length, Snappy the level of the high passed path.
5. 808 tom: a bridged T resonator per tom (low 80 to 100 Hz, mid 120 to 160, high 165 to 220), decays about 200,
   130 and 100 ms, diodes starve the ring as it fades (shorter decay plus a slight downward bend). A subtle dark
   pink noise layer on its own envelope, a bit longer than the body. 808 congas are the same circuit with half of
   the bridged T bypassed and no noise.
6. 909 tom: three triangle VCOs per tom at different pitches (one hobbyist calculation: 1 : 1.5 : 2.77), reset
   in sync on every trigger, one pitch envelope sweeps all three, Tune offsets them. Each VCO is diode clipped
   towards a sine through its own VCA and envelope, the lowest one with the adjustable Decay, so after a few ms
   mostly one tone remains. The clipper of one VCO moves from hard (square like) to soft (sine) over the hit. The
   highest VCO is mixed with "tom noise" before its VCA, a short noise share in the attack ("a more natural sound
   in the attack phase"). A board revision enlarged that noise "to emphasize attack of TOM TOMs".
7. 808 clap: white noise through a band pass at about 1 kHz, two parallel VCAs. One gets a comparator made
   sawtooth envelope: three 10 ms bursts, then a 20 ms discharge. The other gets a 100 ms decay only "reverb".
8. 909 clap: the same idea with shift register noise, a four part burst envelope plus a one part "reverb" envelope.
9. 808 rim: two bridged T resonators at about 455 and 1667 Hz, a 10 ms envelope into an overdriven VCA, then a
   high pass. 808 claves: one resonator at about 2.5 kHz.
10. 909 rim: three bridged T resonators pinged together (reported as about 220, 500, 1000 Hz or 250, 495,
    1580 Hz), their decay set by each resonator's Q, mixed, diode clipped, a VCA on a simple envelope, then a high
    pass. A later revision raised the pitch.
11. 909 noise: one shared source for bass drum click, snare, toms and clap, a 32 stage shift register (digital,
    slightly periodic, two 18 stage shift registers per the TR-909 mods guide, corrected 2026-11-13). The 808 uses
    an analog noise source (a noisy transistor).

### First measurements (2026-11-13)

1. 808 kick: the first half period sits at 121 to 130 Hz around 5 ms, 77 Hz at 10 ms, 57 to 60 Hz at 20 ms, then
   drifts from about 56 to 49.5 Hz over the decay. Decay 0 to 10 spans 36 ms to 1.1 s (-20 dB). Tone hardly moves
   pitch or partials.
2. 909 kick: starts at 162 Hz (Tune 0) or 181 Hz (Tune 3), reaches about 50 Hz by 40 ms.
3. 808 toms carry a dark noise layer: their noise floor between 100 Hz and 2 kHz late in the hit is about 35 dB
   above the congas (-40 to -47 dB against -73 to -84 dB), nothing measurable above 2 kHz.
4. 909 toms carry clear noise in the attack (-34 dB above 2 kHz, falling later).
5. 808 rim partials at 476 and 1712 Hz, 909 rim at 220, 459 and 899 Hz.
6. Claps: bursts at 0, 12, 25 and 31 ms (808), 0, 11, 24 and 32 to 33 ms (909), then the tail.

### What the engines need for it

1. Kick: two body types, a pinged resonator with an attack pitch kick and slow drift, and an oscillator with a
   phase reset, a swept pitch envelope and an adjustable sine shaper (hard to soft). An amp envelope that can hold
   its top (the compressed punch). A click from a shaped pulse plus low passed noise with its own envelope. A low
   pass Tone.
2. Snare: two tuned bodies (pinged or oscillator, mix and ratio), each with its own decay, a short start pitch
   bend, noise with two paths (low passed, and high passed on top) each with its own envelope.
3. Tom: up to three tuned partials (pinged or oscillator) sharing one pitch envelope, each with its own decay, a
   shaper that moves from hard to soft over the hit, and an optional noise layer (dark, own envelope, from a short
   attack burst to a longer layer). So 808 congas (no noise), 808 toms (soft pink layer) and 909 toms (noise in
   the attack) are all reachable.
4. Clap: band passed noise, burst count and spacing, a sawtooth burst shape, a separate decaying tail.
5. Rim: up to three short pinged resonators, drive (clipper), a short VCA envelope, high pass. Claves with one
   resonator.
6. Noise: white noise plus an optional shift register noise mode (the slightly periodic digital character).

Sources: [Werner/Abel/Smith, 808 bass drum model (DAFx 2014)](https://www.dafx14.fau.de/papers/dafx14_kurt_james_werner_a_physically_informed,_ci.pdf),
[TR-909 service notes](https://archive.org/stream/roland_TR-909_SERVICE_NOTES/TR-909_SERVICE_NOTES_djvu.txt),
[network-909.de circuit pages](http://www.network-909.de/bassdrum.htm),
[Baratatronix 808 analyses](https://www.baratatronix.com/blog/808-bd-synthesis),
[808 snare notes](https://norgatronics.blogspot.com/2021/11/808-snare-mutations.html).
6. Verification: measured against reference recordings (below), not by ear first. Where the research and the
   references disagree (for example how much noise a 909 tom has), the references win. André listens to A/B files
   only from measured states. Stock presets prove the reach, with our own names.

## Reference matching

References (local only, never committed, read through a path setting):
1. `~/Documents/Resources/samples/TR808WAV`: 118 hits from one real 808, 16 bit 44.1 kHz mono, dry, level at max.
   Knobs at 0, 2.5, 5, 7.5, 10 in the file name (BD tune x decay grid of 25, SD tone x snappy 25, toms and congas
   tune 5 each, single RS, CP, CL, MA, CB, CH, 25 CY, 5 OH).
2. `~/Documents/Resources/samples/Roland TR-909`: 161 hits from one real 909, 16 bit 44.1 kHz mono, dry,
   normalised. Knobs at 0, 3, 7, 10 (BD tune x attack x decay 24, SD tune x tone x snappy 52, toms tune x decay 16
   each, RIM and HAND at two velocities, hats and cymbals).
3. The 909 set is normalised, so absolute level is never compared, only shapes and ratios.

Measures per hit (the report card, each with its own audibility threshold, no single summed score):
1. Amplitude envelope (1 ms RMS), decay times to -20 and -40 dB.
2. Pitch track of the body over the first 200 ms (start pitch, end pitch, sweep time).
3. Spectral centroid over time, octave band energies in an early (0 to 20 ms) and a late window.
4. Attack: peak position and brightness of the first 5 ms (click).
5. Tonal versus noise share over time (snare snappy, clap, rim).
6. Clap: burst count and spacing.

Process, per engine:
1. Measure the references first and keep the numbers, they are the truth.
2. Fit the engine parameters to each reference hit, then check the whole knob grid is reachable inside our
   parameter ranges (a 808 BD at decay 10 must not need a value beyond our Decay maximum).
3. The engine's parameter set is decided up front and frozen during fitting. A dimension that cannot pass needs a
   better building block, never an extra correction table.
4. A/B files (reference, ours) go to André only from measured states.

## Shared core

1. Trigger: note start fires a hit, velocity scales level and the device's velocity target. Note end is ignored
   unless the device has a gate mode (kick, cymbal choke).
2. Pitch: every device is tuned by its own Tune parameter at root key 60 (Playfield sends 60 to every pad).
   On a track, other keys transpose relative to 60. No pitch modes (decided 2026-11-13).
3. Voices: the UI shows Mono or Poly only (decided 2026-11-13). Mono retriggers its one voice with a short
   declick. Poly runs 16 voices internally, the oldest is stolen when all are busy. The count is not shown.
4. Common DSP goes into the general `dsp` crate, not into a drum module, so every device can use it (decided
   2026-11-13). Existing devices keep their own copies untouched (nothing must break). Built 2026-11-13:
   1. `svf`: state variable filter, low, band and high pass from one state, stable under per sample cutoff moves.
   2. `noise`: seeded white noise (on `math::random::Mulberry32`) and a clocked 32 stage shift register noise.
   3. `hit_envelope`: attack, hold, exponential decay to -60 dB, retrigger from the current value. Also drives
      pitch sweeps (scale it into Hz).
   4. `resonator`: struck two pole resonator as a rotating phasor (pitch moves every sample, level stays), the
      bridged T style body. A modal bank is several of them.
   5. `drum_oscillator`: phase reset per hit, sine, and a triangle bent by one drive value from triangle over sine
      to square.
   Reused, not rebuilt: drive from `waveshaper` (tanh, hard clip) plus the 2x `resampler`, `osc` for band limited
   shapes. Built when a phase needs them, not before: fold, pulse click shaper, square bank and 2-op FM (Hat,
   Cymbal, Bell, Perc).
5. Drum specific code stays in the device crates: the hit and voice model, each engine's signal flow.
6. Choke: Playfield exclude already exists, so open/closed hats choke across pads with no new code.
   openDrum Hat in Mono chokes its own ringing hit, openness comes from Pedal and velocity, not from a second key.

## Engines (devices)

Each engine lists the sound territory it covers (what a user can reach), then its controls and its own ideas.

### 1. openDrum Kick

Covers deep long booming kicks, short punchy club kicks, layered modern kicks, hard distorted kicks with a pitched
"tok", rumble kicks, acoustic bass drums.

Parameter set (2026-11-13, 20 parameters, groups fill four rows of 78px columns: Body 8 (Tune, Pitch, Sweep, Drift,
Decay, Punch, Shape, Skin), Strike 4 (Click, Tone, Noise, Drive), Rumble 4 (Level, Length, Duck, Bright), Play 4
(Volume, Velocity, Mode, Glide)):

Body (two columns)
1. Tune, 30 to 120 Hz: the pitch the body settles on (808 and 909 both near 50 Hz).
2. Pitch, 0 to 48 semitones: how far above Tune the hit starts (808 about +14, 909 +20 to +25).
3. Sweep, 1 to 200 ms: how long the fall from Pitch to Tune takes (renamed from Time, 2026-11-13). The fall is
   exponential in Hz, like a swept oscillator, which fits both machines better than a fall in semitones. 808 about
   6 ms, 909 longer, longer again at high 909 Tune, where that knob moves start pitch and sweep length together
   (163 Hz at Tune 0, 217 Hz at Tune 10).
4. Drift, 0 to 12 semitones: a second, slow fall over ten times Sweep, the 808's sinking pitch during the decay
   (added 2026-11-13: the first fit could not match the 808 pitch track without it, about 3.5 semitones).
5. Decay, 20 ms to 6 s: time to -60 dB.
6. Punch, -100 to 100 %: the decay curve. Negative drops fast and lingers (a long boom, the 808's long decays
   fade slower than exponential), 0 exponential (the ringing 808), positive a straight fall of the level (the
   compressed 909). Replaced Hold on 2026-11-13: the 909 short decay drops 3, 20 and 40 dB at 23, 89 and 103 ms,
   a linear fall over about 100 ms, not a hold.
7. Shape, 0 to 100 %: the body wave, a pure sine (808) through a rounded triangle (909) to a square like wave.

Strike
8. Click, 0 to 100 %: level of an impulse plus a short noise burst, both band passed at Tone (Q 1.5, chosen by the fit), the
   909 Attack (which measures about +6 dB noise).
9. Tone, 200 Hz to 16 kHz: the click band, dark (808 Tone) to bright.
10. Skin, 0 to 100 %: membrane overtones (circular membrane ratios over the body pitch) that ring shortly after
   the strike, for acoustic bass drums (decided 2026-11-13: acoustic kicks stay in scope, without a group).

Rumble
11. Level, 0 to 100 %: a dense diffuse tail (four damped combs, two allpasses) fed by the kick, saturated, low
    passed at Bright.
12. Length, 1/16 to 1/1, synced.
13. Duck, 0 to 100 %: how strongly the kick's own level pushes the rumble down, instantly and for as long as the
    kick is loud (a compressor curve: at 100 % away above about -20 dB, back below it), so they sound like one
    sound that starts together. No time control, the return follows the kick (decided 2026-11-13).
    Below 100 % the rumble (about six times louder than the body under the kick) leaked into the hit and clipped,
    so kick and rumble together now stay below a peak of 2 (0 dBFS in the preview, 2026-11-14). At Duck 100 % the
    ceiling never engages, except where Rumble, Length and Drive near their maximum already clipped.
14. Drive, 0 to 36 dB: asymmetric soft saturation like a diode, 2x oversampled with a DC blocker. It adds the even
    harmonics both machines measure (the octave at about -21 dB, which a sine or triangle body cannot make). 0 is
    a clean body.
15. Velocity, 0 to 100 %: how much velocity moves level, Click and Pitch.
16. Mode: Mono (retrigger), Poly, or Gate (mono, note end releases, for sustained kick basses, decided 2026-11-13).
    In Gate a new note while the gate is held plays legato (no new hit, the pitch moves).
17. Bright, 0 to 100 %: the rumble low pass from 1.5 to 30 times Tune, dark sub to open and gritty.
    The level is compensated by the cutoff ((1500 Hz / cutoff)^0.35), a dark rumble needs more level to sound as
    loud (his request 2026-11-13).
18. Volume, -36 to +6 dB.
19. Noise, 0 to 100 %: the click's mix of impulse and noise burst (the 909 Attack knob adds mainly noise).
20. Glide, 0 to 1 s: in Mono and Gate a new note slides from the sounding pitch, the 808 bass line slide.
    Added 2026-11-13 with Bright, Volume and Noise (his request: Bright and a Play column).

Not in the set: Gain (the track and the Playfield cell already have a volume), the drawn breakpoint curve, start
phase, the acoustic body group, Morph (Velocity does it), drive type and mix, rumble tone. Open until the first
fit: whether the 808's slow pitch drift during long decays (about -2 semitones) needs its own control (decided
2026-11-13: wait for the fit).

### 2. openDrum Snare

Covers tight electronic snares, fat snappy snares, acoustic snares, rim heavy and piccolo snares.

1. Body: two tuned components (tune, ratio, decay, pitch drop).
2. Wires: noise through HP and BP with its own decay. The body amplitude drives the wires, like real snare wires
   rattling with the skin.
3. Balance, tone, drive.
4. Own idea, wire tension: one knob from loose (long, low rattle) to tight (short, bright crack), velocity can
   push it.

### 3. openDrum Clap

Covers single and group claps, tight electronic claps, roomy claps, finger snaps.

1. Hands: number of clappers (1 to 8). Each hand gets its own seeded timing offset, tone and level, so a group
   sounds like people, not a repeated burst.
2. Spread: how loose the group is in time, from one tight hit to a sloppy crowd.
3. Burst: bandpassed noise, tone, Q, per hand decay.
4. Room: diffuse tail after the last hand, size and level.
5. Snap mode: one hand, high band, very short tail.
6. Own idea: velocity sets how many hands join in.

### 4. openDrum Hat

Covers metallic electronic hats, noisy hats, FM hats, soft shaker like hats.

1. Source: square oscillator bank, FM metal and noise, with a morph between them.
2. Tone: band frequency, high pass, metal spread (detunes the bank).
3. Closed and open decay, Pedal sets the openness between them. Choke: in Mono a new hit cuts the ringing one.
4. Own idea, openness: one continuous control from closed to open, mapped to velocity or a modulator, so a single
   pad plays every state in between (like a real hi hat pedal).

### 5. openDrum Cymbal

Covers crashes, rides with bell, chinas, splashes, electronic cymbals.

1. Partials: dense inharmonic network (oscillator bank or FM) plus noise.
2. Spectral decay: highs decay faster or slower than lows (brightness over time).
3. Bell: tuned ringing partial cluster for ride bells.
4. Size (decay), shimmer (slow movement of the partials), choke on note end (optional).
5. Own idea, swell: a bowed or reversed onset, so the cymbal can rise into a downbeat without a sample.

### 6. openDrum Tom

Covers electronic toms, congas, bongos, sweeping disco toms, timbales, acoustic toms.

1. Membrane: modal resonator bank (circular membrane ratios) or plain sine.
2. Pitch sweep: amount, time, direction (up for "pew" sounds).
3. Strike: noise or stick transient, position (centre to edge changes the mode weights).
4. Damping, decay, tune.

### 7. openDrum Rim

Covers rimshots, claves, woodblocks, side sticks.

1. Two tuned resonators, ratio, decay (very short range), high pass, click.
2. Own idea, material: one control from wood to metal changes resonator damping and ratio together.

### 8. openDrum Bell

Covers cowbells, agogos, tuned bells, triangles.

1. Mode: square pair or FM, tune, ratio, decay, two stage envelope (fast then slow decay).

### 9. openDrum Shaker

Covers maracas, cabasas, shakers, tambourines with jingles, sleigh bells. Particle model: noise grains with a
stochastic density driven by an energy envelope, through resonant filters.

1. Grains: density, energy decay, system decay.
2. Resonance: one to three filter resonances (jingles add metal).
3. Own idea, note length is shake length: a longer note shakes longer, so one pad plays short ticks and long
   shakes.

### 10. openDrum Perc

Covers zaps, lasers, blips, glitch hits, metallic and industrial hits.

1. Carrier and modulator with ratio, index envelope, pitch envelope, noise mix, drive.
2. Evolving glitch hits come from Random modulators on ratio, index and pitch.

### Later candidates (not in phase list)

1. openDrum Kit: one device holding several engines on a key map. Questionable, Playfield already is the kit.
2. Resynthesis: analyse a dropped sample into openDrum Kick click and sub parameters.

## Editor ("recognisable UI")

1. One shared frame for every openDrum device: the openDrum wordmark plus the engine name, one engine glyph.
2. Top: a hit display that renders the actual one shot (offline, from the same DSP, on every parameter change)
   as waveform plus amp envelope. Kick shows the editable pitch curve on top of it.
3. Below: knob rows in sections (Source, Tone, Envelope, Drive, Output), same grid and column widths in every
   device, built grid first.
4. One accent colour per family (low drums, skins, metal, noise), so a Playfield grid reads at a glance.
5. Follows the device editor house style and the layout rules (no layout jumps, fixed row heights).
6. A trigger button on the display auditions the hit.

## Architecture per device

1. Box schema in `forge-boxes/src/schema/devices/instruments/` (one file per box).
2. Adapter with `createParameter` mappings (the single source of value mappings).
3. Crate `crates/stock-devices/device-opendrum-<engine>`, template `device-sine`, DSP from the shared `drum` module.
4. Registration: `engine-modules.ts`, `InstrumentFactories`, `InstrumentBox`, `BoxAdapters`, `DeviceEditorFactory`.
5. Device browser group "openDrum" with all openDrum devices.
6. Manual page per device, factory presets per device with our own names.
7. Playfield: an "openDrum Kit" preset that fills pads at GM keys (36 kick, 38 snare, 39 clap, 37 rim, 42 closed
   hat, 46 open hat with exclude group, 41 to 50 toms, 49 crash, 51 ride, 56 cowbell).

## Presets and controls

Collected 2026-11-14 from the /testing preview before it was removed. The controls are the device layout (sections
of at most four values, each with its range and unit), the presets are the fitted and the by-ear settings. Percent
values are stored 0 to 1 (or -1 to 1). Preset names here say what they were fitted to, stock presets get our own
names.

### 1. Kick

Controls:

1. Body (orange, two columns): Tune (tune) 30 to 120 Hz, Pitch (pitch) 0 to 48 st, Sweep (sweep) 0.001 to 0.2 s, Drift
   (drift) 0 to 12 st, Decay (decay) 0.02 to 6 s, Punch (punch) -100 to 100 %, Shape (shape) 0 to 100 %, Skin (skin) 0
   to 100 %.
2. Strike (yellow): Click (click) 0 to 100 %, Tone (tone) 200 to 16000 Hz, Noise (noise) 0 to 100 %, Drive (drive) 0 to
   36 dB.
3. Rumble (purple): Level (rumble) 0 to 100 %, Length (length) 1/16, 1/8, 1/4, 1/2, 1/1, Duck (duck) 0 to 100 %, Bright
   (bright) 0 to 100 %.
4. Play (cream): Volume (volume) -36 to 6 dB, Velocity (velocity) 0 to 100 %, Mode (play) Mono, Poly, Gate, Glide
   (glide) 0 to 1 s.

Presets:

1. Kick (808 fit) (reference TR808WAV/BD/BD5050.WAV): tune: 51.43, pitch: 28.23, sweep: 0.0025, drift: 4.1, decay:
   1.137, punch: 0.078, shape: 0.001, click: 0.034, tone: 873.1, skin: 0.295, rumble: 0, length: 2, duck: 1, drive:
   0.82, velocity: 0.5, play: 0, bright: 0.25, volume: 0, noise: 0.5, glide: 0.
2. Kick (909 fit) (reference Roland TR-909/BT3AADA.WAV): tune: 46.84, pitch: 26.68, sweep: 0.0106, drift: 2.04, decay:
   0.708, punch: -0.477, shape: 0.352, click: 0.342, tone: 1013.3, skin: 0.144, rumble: 0, length: 2, duck: 1, drive:
   3.25, velocity: 0.5, play: 0, bright: 0.25, volume: 0, noise: 0.5, glide: 0.

### 2. Snare

Controls:

1. Body (orange, two columns): Tune (tune) 80 to 600 Hz, Ratio (ratio) 1 to 3, Balance (balance) 0 to 100 %, Pitch
   (pitch) 0 to 24 st, Sweep (sweep) 0.001 to 0.1 s, Decay (decay) 0.02 to 2 s, Punch (punch) -100 to 100 %, Shape
   (shape) 0 to 100 %.
2. Strike (yellow): Click (click) 0 to 100 %, Tone (tone) 200 to 16000 Hz, Skin (skin) 0 to 100 %, Drive (drive) 0 to
   36 dB.
3. Noise (green): Level (level) -48 to -3 dB, Decay (wireDecay) 0.02 to 2 s, Width (width) 0 to 100 %, Curve (curve)
   -100 to 100 %.
4. Play (cream): Volume (volume) -36 to 6 dB, Velocity (velocity) 0 to 100 %, Mode (play) Mono, Poly, Gate, Glide
   (glide) 0 to 1 s.

Presets:

1. Snare (808 fit) (reference TR808WAV/SD/SD5050.WAV): tune: 171.16, ratio: 1.943, balance: 0.7243, pitch: 2.065,
   sweep: 0.0092, decay: 0.2093, punch: -0.0221, shape: 0, level: -5.3, wireDecay: 0.1944, width: 0.46, curve: -0.2745,
   click: 0.1079, tone: 4779, skin: 0.1612, drive: 0, volume: 0, velocity: 0.5, play: 0, glide: 0.
2. Snare (909) (reference Roland TR-909/ST3T3S3.WAV): tune: 145, ratio: 1.5, balance: 0.292, pitch: 9.7, sweep: 0.0078,
   decay: 0.188, punch: 0, shape: 0.5, level: -23.7, wireDecay: 0.1394, width: 0.81, curve: 1, click: 0, tone: 759,
   skin: 0, drive: 0, volume: 0, velocity: 0.5, play: 0, glide: 0.

### 3. Clap

Controls:

1. Hands (orange): Hands (hands) 1 to 8, Gap (gap) 0 to 0.04 s, Last (last) 0.3 to 1.5, Spread (spread) 0 to 100 %.
2. Burst (yellow): Attack (attack) 0 to 0.005 s, Decay (decay) 0.002 to 0.2 s, Snap (snap) 0 to 100 %, Drive (drive) 0
   to 36 dB.
3. Tone (purple): Tone (tone) 300 to 8000 Hz, Reso (resonance) 0 to 100 %.
4. Room (green): Level (room) -48 to 0 dB, Decay (roomDecay) 0.02 to 2 s, Tail (tail) 0 to 100 %.
5. Play (cream): Volume (volume) -36 to 6 dB, Velocity (velocity) 0 to 100 %, Mode (play) Mono, Poly, Gate.

Presets:

1. Clap (808) (reference TR808WAV/CP/CP.WAV): hands: 4, gap: 0.0115, last: 0.71, spread: 0, attack: 0.00075, decay:
   0.019, snap: 0.6, drive: 0, tone: 1055, resonance: 1, room: -1.25, roomDecay: 0.41, tail: 0.5, volume: -2, velocity:
   0.5, play: 0.
2. Clap (909) (reference Roland TR-909/HANDCLP1.WAV): hands: 4, gap: 0.0116, last: 0.885, spread: 0, attack: 0, decay:
   0.0255, snap: 0, drive: 0, tone: 865, resonance: 0.36, room: -3.25, roomDecay: 0.72, tail: 0, volume: 0, velocity:
   0.5, play: 0.

### 4. Tom

Controls:

1. Body (orange, two columns): Tune (tune) 40 to 800 Hz, Pitch (pitch) 0 to 24 st, Sweep (sweep) 0.001 to 0.2 s, Drift
   (drift) 0 to 12 st, Decay (decay) 0.02 to 3 s, Punch (punch) -100 to 100 %, Shape (shape) 0 to 100 %, Drive (drive)
   0 to 36 dB.
2. Layers (yellow): Sub (sub) 0 to 100 %, Ratio (ratio) 0.5 to 1, Top (top) 0 to 100 %, Length (length) 0.02 to 1 s.
3. Noise (green): Level (noise) -48 to 0 dB, Decay (noiseDecay) 0.02 to 3 s, Color (color) 0 to 100 %, Air (air) 0 to
   100 %.
4. Play (cream): Volume (volume) -36 to 6 dB, Velocity (velocity) 0 to 100 %, Mode (play) Mono, Poly, Gate, Glide
   (glide) 0 to 1 s.

Presets:

1. Conga (808 low) (reference TR808WAV/LC/LC50.WAV): tune: 200.5, pitch: 24, sweep: 0.0005, drift: 0, decay: 0.55,
   punch: 0, shape: 0, drive: 0, sub: 0, ratio: 0.67, top: 0, length: 0.2, noise: -48, noiseDecay: 0.02, color: 0, air:
   0, volume: 0, velocity: 0.5, play: 0, glide: 0.
2. Conga (808 mid) (reference TR808WAV/MC/MC50.WAV): tune: 281.5, pitch: 12, sweep: 0.001, drift: 0, decay: 0.3, punch:
   -0.3, shape: 0, drive: 0, sub: 0, ratio: 0.67, top: 0, length: 0.2, noise: -48, noiseDecay: 0.02, color: 0, air: 0,
   volume: 0, velocity: 0.5, play: 0, glide: 0.
3. Conga (808 high) (reference TR808WAV/HC/HC50.WAV): tune: 412.5, pitch: 12, sweep: 0.0005, drift: 0, decay: 0.25,
   punch: -0.15, shape: 0, drive: 0, sub: 0, ratio: 0.67, top: 0, length: 0.2, noise: -48, noiseDecay: 0.02, color: 0,
   air: 0, volume: 0, velocity: 0.5, play: 0, glide: 0.
4. Tom (808 low) (reference TR808WAV/LT/LT50.WAV): tune: 88, pitch: 0.4, sweep: 0.05, drift: 0, decay: 0.62, punch: 0,
   shape: 0, drive: 0, sub: 0, ratio: 0.67, top: 0, length: 0.2, noise: -34, noiseDecay: 0.7, color: 0, air: 0, volume:
   0, velocity: 0.5, play: 0, glide: 0.
5. Tom (909 low) (reference Roland TR-909/LT3D3.WAV): tune: 74.4, pitch: 4.8, sweep: 0.0246, drift: 2.1, decay: 0.7,
   punch: 0, shape: 1, drive: 0, sub: 0.3, ratio: 0.67, top: 0.8, length: 0.2, noise: -16, noiseDecay: 0.25, color:
   0.3, air: 0.35, volume: -2, velocity: 0.5, play: 0, glide: 0.
6. Tom (909 high) (reference Roland TR-909/HT3D3.WAV): tune: 113.1, pitch: 4.3, sweep: 0.0254, drift: 2.2, decay: 0.5,
   punch: 0, shape: 1, drive: 0, sub: 0.25, ratio: 0.69, top: 0.7, length: 0.2, noise: -30, noiseDecay: 0.25, color:
   0.5, air: 0.35, volume: -2, velocity: 0.5, play: 0, glide: 0.

### 5. Rim

Controls:

1. Tones (orange): Tune (tune) 100 to 4000 Hz, Ratio (ratio) 1 to 5, Balance (balance) 0 to 100 %, Ring (ring) 0.005 to
   1 s.
2. High (yellow): Level (high) 0 to 100 %, Ratio (highRatio) 1 to 12, Ring (ringHigh) 0.005 to 1 s, Swell (swell) 0 to
   8.
3. Shape (green): Decay (decay) 0.002 to 0.5 s, Punch (punch) -100 to 100 %, Drive (drive) 0 to 36 dB, Hard (hard) 0 to
   100 %.
4. Strike (purple): Click (click) 0 to 100 %, Cut (cut) 20 to 4000 Hz, Restart (restart) Off, On.
5. Play (cream): Volume (volume) -36 to 6 dB, Velocity (velocity) 0 to 100 %, Mode (play) Mono, Poly, Gate.

Presets:

1. Rim (808) (reference TR808WAV/RS/RS.WAV): tune: 476, ratio: 3.6, balance: 1, high: 0, highRatio: 6.3, ring: 0.17,
   ringHigh: 0.035, decay: 0.012, punch: 0.7, drive: 12, hard: 0, click: 0.05, swell: 3, cut: 300, restart: 1, volume:
   -3, velocity: 0.5, play: 0.
2. Rim (909) (reference Roland TR-909/RIM127.WAV): tune: 220, ratio: 2.08, balance: 1, high: 0.625, highRatio: 5.2,
   ring: 0.0775, ringHigh: 0.04, decay: 0.205, punch: -0.19, drive: 12, hard: 0.4, click: 0, swell: 0.4, cut: 60,
   restart: 1, volume: 0, velocity: 0.5, play: 0.
3. Claves (808) (reference TR808WAV/CL/CL.WAV): tune: 2422, ratio: 1, balance: 0, high: 0, highRatio: 1, ring: 0.1,
   ringHigh: 0.1, decay: 0.05, punch: 0.6, drive: 0, hard: 0, click: 0, swell: 3, cut: 20, restart: 1, volume: 0,
   velocity: 0.5, play: 0.

### 6. Hat

Controls:

1. Source (orange): Tune (tune) 0.25 to 4, Color (color) 200 to 16000 Hz.
2. Character (purple): Spread (spread) -100 to 100 %, Ring (ring) 0 to 100 %, Reso (reso) 0 to 100 %, Curve (curve)
   -100 to 100 %.
3. Shape (green): Hold (hold) 0 to 0.5 s, Decay (decay) 0.005 to 4 s.
4. Play (cream): Volume (volume) -36 to 6 dB, Velocity (velocity) 0 to 100 %, Mode (play) Mono, Poly, Gate.

Presets:

1. Hat (808 closed) (reference TR808WAV/CH/CH.WAV): tune: 1, color: 6300, hold: 0, decay: 0.13, spread: 0, ring: 0,
   reso: 0, curve: 0, volume: 0, velocity: 0.5, play: 0.
2. Hat (808 open) (reference TR808WAV/OH/OH00.WAV): tune: 1, color: 6200, hold: 0.2, decay: 0.15, spread: 0, ring: 0,
   reso: 0, curve: 0, volume: 0, velocity: 0.5, play: 0.

### 7. Shaker

Controls:

1. Shape (orange): Color (color) 200 to 16000 Hz, Attack (attack) 0 to 0.2 s, Decay (decay) 0.002 to 2 s, Curve (curve)
   -100 to 100 %.
2. Play (cream): Volume (volume) -36 to 6 dB, Velocity (velocity) 0 to 100 %, Mode (play) Mono, Poly, Gate.

Presets:

1. Maracas (808) (reference TR808WAV/MA/MA.WAV): color: 7200, attack: 0.02, decay: 0.012, curve: 0.3, volume: 0,
   velocity: 0.5, play: 0.

### 8. Cymbal

Controls:

1. Shape (orange): Tune (tune) 0.25 to 4, Tone (tone) 0 to 100 %, Attack (attack) 0 to 2 s, Decay (decay) 0.05 to 8 s.
2. Play (cream): Volume (volume) -36 to 6 dB, Velocity (velocity) 0 to 100 %, Mode (play) Mono, Poly, Gate.

Presets:

1. Cymbal (808) (reference TR808WAV/CY/CY0000.WAV): tune: 1, tone: 0, attack: 0, decay: 0.75, volume: 0, velocity: 0.5,
   play: 0.

### 9. Bell

Controls:

1. Tones (orange): Tune (tune) 50 to 4000 Hz, Ratio (ratio) 1 to 4, Balance (balance) 0 to 100 %.
2. Shape (orange): Color (color) 100 to 16000 Hz, Strike (strike) 0 to 100 %, Decay (decay) 0.01 to 4 s.
3. Play (cream): Volume (volume) -36 to 6 dB, Velocity (velocity) 0 to 100 %, Mode (play) Mono, Poly, Gate.

Presets:

1. Cowbell (808) (reference TR808WAV/CB/CB.WAV): tune: 558, ratio: 1.477, balance: 0.7, color: 1050, strike: 0.8,
   decay: 0.7, volume: 0, velocity: 0.5, play: 0.

### 10. Perc

Controls:

1. FM (orange): Tune (tune) 20 to 8000 Hz, Ratio (ratio) 0.25 to 16, Index (index) 0 to 100 %, Bite (bite) 0.001 to 2 s.
2. Shape (orange): Pitch (pitch) -48 to 48 st, Sweep (sweep) 0.0005 to 2 s, Decay (decay) 0.005 to 4 s, Curve (curve)
   -100 to 100 %.
3. Grit (orange): Noise (noise) 0 to 100 %, Drive (drive) 0 to 36 dB.
4. Play (cream): Volume (volume) -36 to 6 dB, Velocity (velocity) 0 to 100 %, Mode (play) Mono, Poly, Gate.

Presets:

1. Zap: tune: 120, ratio: 1, index: 0.2, bite: 0.03, pitch: 48, sweep: 0.02, decay: 0.2, curve: 0, noise: 0, drive: 0,
   volume: 0, velocity: 0.5, play: 0.
2. Laser: tune: 400, ratio: 0.5, index: 0.4, bite: 0.15, pitch: 36, sweep: 0.08, decay: 0.35, curve: 0.3, noise: 0,
   drive: 0, volume: 0, velocity: 0.5, play: 0.
3. Blip: tune: 1200, ratio: 2, index: 0.1, bite: 0.01, pitch: 0, sweep: 0.01, decay: 0.06, curve: 0.5, noise: 0, drive:
   0, volume: 0, velocity: 0.5, play: 0.
4. Rise: tune: 300, ratio: 1.5, index: 0.3, bite: 0.2, pitch: -24, sweep: 0.06, decay: 0.25, curve: 0.2, noise: 0,
   drive: 0, volume: 0, velocity: 0.5, play: 0.
5. Metal: tune: 330, ratio: 3.53, index: 0.6, bite: 0.4, pitch: 2, sweep: 0.005, decay: 0.6, curve: -0.3, noise: 0,
   drive: 0, volume: 0, velocity: 0.5, play: 0.
6. Industrial: tune: 80, ratio: 1.41, index: 0.8, bite: 0.1, pitch: 24, sweep: 0.01, decay: 0.3, curve: -0.5, noise:
   0.25, drive: 18, volume: 0, velocity: 0.5, play: 0.


## Devices, as built

Started 2026-11-14 with the Kick as the template, the other nine follow it after the browser check.
The /testing preview, its reference players and the dev only reference route are removed (2026-11-14), every
control and preset it held is in "Presets and controls" above. The lab (`crates/opendrum-lab`) still reads the
references from disk.

1. `crates/opendrum-device`: the glue every openDrum device shares. An engine describes its parameters (box key
   and mapping) and how a value lands in its params, `export_device!` writes the device exports. Notes transpose
   by key minus 60 plus the host's base tuning, the mono engine output goes to both channels.
2. One crate per device, `crates/stock-devices/device-opendrum-<engine>`, one line: `export_device!(engine)`.
   `opendrum` and `opendrum-device` build at opt-level 3 (the preview module renders bit identically).
3. Box `OpenDrum<Engine>DeviceBox` (defaults are the fitted preset), adapter with the same mappings (the parity
   test checks every value), factory "openDrum <Engine>" with the DrumSet icon, browser tags drums and synth,
   manual page `opendrum-<engine>`.
4. Editor: one shared `OpenDrumDeviceEditor`. Left the hit display (Vaporisateur's display frame), right one
   column of label controls per four values, sections with Delay's heads and tinted bands. The display renders
   through the shared `lib-wasm-worker`, it is optional: without the worker it stays empty.
5. Kick: built 2026-11-14. Parity (3 checks) and a render test in the full engine (the device plays the engine's
   hit, correlation above 0.9999, a key 12 above plays an octave higher). Not checked in a browser yet.
   Open: a trigger to audition the hit from the display, stock presets.
6. Snare, Clap, Tom, Rim, Hat, Shaker, Cymbal, Bell and Perc: built 2026-11-14 on the Kick's template, generated
   from one spec per engine (values in the module's order, box key, mapping, range, unit, default = the first
   preset of "Presets and controls", label, section, manual text) into the Rust parameter table, box, adapter,
   editor, registrations and manual, so the layers cannot drift apart. Labels that repeat in a device carry their
   section in the parameter name ("Noise Decay"), the editor drops the section under its heading. Parity for all
   ten and a render test per device in the full engine (each plays its engine's hit, correlation above 0.9999).
   Modules 24 to 50 kB. Not checked in a browser yet.
7. Gate, new meaning (decided 2026-11-14, replaces the held Gate of 2026-11-13 which held the hit at full level and
   played legato): a held note plays the hit exactly as Mono, the note's end cuts it with a short linear fade
   (Kick and Tom 10 ms, Snare, Clap, Cymbal, Bell and Perc 5 ms, Hat, Shaker and Rim 2 ms), every note is a new hit.
   The display renders Gate as Mono. Velocity defaults to 100 % in every device (decided 2026-11-14).
8. Display (2026-11-14): the same colors in every device (waveform blue, level curve white, pitch curves cream), a
   white dot on the level curve for every sounding hit (the device sends the seconds since each hit started at
   address key 1001, up to 16, -1 ends the list). Each engine shows a fixed span, a zoom would jump under
   automation (decided 2026-11-14): Kick and Cymbal 1 s, Snare, Clap, Tom, Hat, Bell and Perc 0.5 s, Rim and
   Shaker 0.125 s.

Next (decided 2026-11-14):

1. No stock presets yet, they would appear on PROD.
2. After the scripting API of the openDrum devices is final, and after merging next-release: a script builds a
   Playfield with an 808 set and a 909 set from the openDrum devices. The 909 set uses the samples the existing 909
   preset already uses where openDrum has no engine for them (the 909 hats, crash and ride are recordings).

## Phases

1. ~~UI preview of the shared frame on /testing with Kick and Hat (layout sign off before any box or DSP exists,
   decided 2026-11-13).~~
2. ~~Reference lab: wav reader, the report card measures, the measured numbers of every 808 and 909 reference
   hit~~ (2026-11-13: `crates/opendrum-lab`, 10 tests on synthetic hits, 211 hits in `measured/references.tsv`,
   run `cargo run -p opendrum-lab --release --bin measure_references`).
   ~~Then the common DSP blocks in the `dsp` crate (shared core item 4)~~ (2026-11-13: 19 unit tests in `dsp`,
   4 report card cross checks in `opendrum-lab/tests/blocks.rs`, no_std wasm build clean).
3. openDrum Kick including Rumble. Engine built 2026-11-13 (`crates/opendrum/src/kick.rs`, 7 tests), the /testing
   preview plays it through `crates/opendrum-wasm` (standalone like stretch_wasm, built by build-wasm.sh into
   core-wasm dist/wasm). Engines live in `crates/opendrum` (decided 2026-11-13), not in the device crates, so the
   lab, the preview and the device share one implementation. First fit 2026-11-13 (`fit_kick`, Nelder-Mead,
   35 report card dimensions): 808 BD5050 27 of 35 within tolerance, the misses are the pitch track (fast fall
   plus the slow drift, one exponential sweep cannot do both, so the drift question gets an answer), 909 BT3AADA
   28 of 35, misses in mid bands and pitch at 40 ms. Both fits lean on Click and Skin to shape the spectrum
   (808 Skin 0.36 although the 808 has no membrane modes), a sign the click model is not right yet. The preview
   shows both fits next to their reference (dev only route `/opendrum-references/`, never bundled).
   Fit of all 49 kicks 2026-11-13 (`fit_kick all`, parallel, `measured/kick_fits.tsv`) after adding Drift, the Hz
   linear sweep, the band passed impulse click (Q 1.5), Punch, and the sliding 20 ms envelope with decays measured
   from the onset: 808 93 % of the measures within tolerance (worst: long decays, the 808 tail decays slower than
   exponential), 909 83 % (worst: Tune 10 with short decay). Knob mappings are monotonic: 808 Decay 0.08 to 2.7 s,
   909 Tune moves Sweep 8, 11, 18, 32 ms. Open: Click does not follow the 909 Attack knob, and Skin is used on
   every fit (0.2 to 0.9) although neither machine has membrane modes, both point at a missing mid range component.
   Refit 2026-11-13 after asymmetric Drive, bipolar Punch, trimming the 909 garbage start (about 21 samples of
   broken header in many 909 files) and a longer, louder click (6 ms noise, gain x3): 808 mean distance 7.3,
   93 % within, 909 19.8, 86 % within. Click now fits mid range (909 0.27 at Attack 0, 0.35 at Attack 10, 808
   0.03), still a weak link to the Attack knob, which adds mainly noise: proposed Noise (pulse versus noise).
   Proposed additions awaiting approval: Bright (rumble), Volume, Noise, Glide, a Play column.
   The Kick sound was accepted on 2026-11-13 ("perfect, consider this thing done") after Bright, Volume, Noise, Glide,
   the diffuse rumble tail, the duck follower on the smoothed level and the rumble gain (RUMBLE_GAIN 3.0,
   compensation exponent 0.35). No further refit (decided 2026-11-13, "close enough"). Final settings, the seeds
   for the stock presets (our own names), Rumble off, Duck 100 %, Bright 25 %, Volume 0 dB, Noise 50 %, Glide 0,
   Velocity 50 %, Mode Mono:
   1. 808 style (fitted to BD5050): Tune 51.43 Hz, Pitch 28.23 st, Sweep 2.5 ms, Drift 4.1 st, Decay 1.137 s,
      Punch 7.8 %, Shape 0.1 %, Click 3.4 %, Tone 873 Hz, Skin 29.5 %, Drive 0.82 dB.
   2. 909 style (fitted to BT3AADA): Tune 46.84 Hz, Pitch 26.68 st, Sweep 10.6 ms, Drift 2.04 st, Decay 0.708 s,
      Punch -47.7 %, Shape 35.2 %, Click 34.2 %, Tone 1013 Hz, Skin 14.4 %, Drive 3.25 dB.
   Both stay on /testing next to their references while the other engines are built.
   Next: box, adapter, editor,
   presets, manual. Snare, Tom, Clap and Rim follow the same order in their phases.
4. openDrum Snare and openDrum Clap. Snare engine built 2026-11-13 (`crates/opendrum/src/snare.rs`, 6 tests, 20
   parameters: Body Tune, Ratio, Balance, Pitch, Sweep, Decay, Punch, Shape; Strike Click, Tone, Skin, Drive; Wires
   Level, Decay, Color, Tension; Play Volume, Velocity, Mode, Glide). Click and Drive moved into
   `crates/opendrum/src/common.rs`, the Kick renders bit identical after the move (golden render compared). The lab
   fitter is shared (`engine_fit.rs`, `fit_kick`, `fit_snare`), the report card gained the late noise level, the
   pitch tracker low passes closer to the body on noisy hits. First fits: 808 SD5050 distance 11.0 (33 of 36), 909
   ST3T3S3 93.7 (25 of 36), the 909 seemed to miss a slow pitch tail (208 Hz at 10 ms, 159 at 20, 140 at 160).
   Tried 2026-11-13 (his choice, option 2): a fixed 15 % of Pitch falling slowly, and shorter second body decays.
   Neither helps both machines (808 SD5050 11.0 to 19.7 with the share), reverted. The "tail" is most likely the
   zero crossing pitch track reading a mix of two bodies, so the snare report card needs partial tracking (the two
   strongest partials and their levels, early and late) instead of the kick style pitch track. Both on /testing
   next to their references.
   Snare report card built 2026-11-13 (`fit::Card::TwoBodies`: the two strongest tones 80 to 1200 Hz, pitch and
   level, early 0 to 40 ms and late 40 to 160 ms, instead of the zero crossing track; the Kick keeps `OneBody`).
   The "sub thump" was the drive: its asymmetry switched on fully at any drive above 0 dB and left a low shift, the
   Snare now grows the asymmetry with Drive (full at 12 dB), the Kick keeps its constant bias (bit identical). The
   tone tracker starts at 80 Hz, some 909 references carry 60 Hz mains hum. Bend seeds come from the reference's
   tone fall. Fits: 808 SD5050 27.8 (27 of 37), 909 ST3T3S3 30.4 (30 of 37), ST0T0S0 60.6, STAT3S7 55.7.
   He listened: both too far from the references. A band by band comparison over time (8 bands, 10 ms frames,
   `examples/spectrogram_compare.rs`) showed what the card missed: the 808's upper body rang up to 22 dB too long,
   its wires lacked 1.3 to 5 kHz, the 909 had too much air. Fixes: the upper body decays by Decay / Ratio^2 (a
   higher mode dies faster, no parameter), the wire band spans 6x its low cut (was 30x). The 808 now sits within
   about 3 dB in every band through 80 ms (SD5050 distance 7.3). Open on the 909: its two noise paths (low passed
   and high passed snappy, own envelopes) are one path here, and its low body is 5 to 7 dB weak in the first 30 ms.
   Then (2026-11-13): the wires run two paths (a dark band, a bright snap above it at 0.35 of the wire decay). The
   TR-909 mods guide (firstpr.com.au) describes the 909 snappy envelope: flat for about 24 ms, then faster than
   exponential, cut off at the VCA threshold, "a noise blast like a steam valve". Tension was replaced by the wire
   Curve (his decision, still 20 parameters): -1 fast drop with a long tail (808), +1 held top then a straight fall
   (909), the hold is up to a quarter of the wire decay. The snare report card now includes the band grid (8 bands x
   8 moments up to 160 ms, 4 dB tolerance) in place of the two broad band sets, the view that matched his ears. Fits:
   909 ST3T3S3 within about 3 dB nearly everywhere with Curve +1.0 (the steam valve), 808 SD5050 with Curve -0.42,
   its tail within 3 dB at 160 ms except one band.
   He listened: 808 close but its noise should be smoother and it lacks a tiny tail, 909 has ugly overtones. Drive
   works on the finished mix and distorts both bodies and the wires together (inharmonic products, rough noise);
   the snare fits now keep Drive at 0 (the machines shape each oscillator alone, that is Shape). The Snare's
   envelopes ring on to -100 dB (`HitEnvelope::set_floor`, the Kick keeps -66 dB and stays bit identical), the band
   grid reaches 250 ms. The 808's noise still falls about 10 dB too fast between 160 and 250 ms.
   He: no difference in both, the 909 tone far off, the 808 still lacks the tiny tail. Strongest tones showed the
   909 carries the octave of each body (310 Hz at -16 dB over 155 Hz), ours odd harmonics (3x, from the triangle
   Shape). Shape is now an asymmetric bend of each body's full level wave (like the 909's crude single transistor
   VCAs), unity gain for small signals, with a 30 Hz DC blocker on the bodies. The upper body decays by
   (1.42 / Ratio)^4.4 (as long as the lower at the 909's ratio, a quarter at the 808's, capped at 2x). A negative
   wire Curve is now the normal decay plus a quiet tail stage (6 %, four times longer), a positive one holds and
   falls straight. Fits: 909 ST3T3S3 26.3, within about 5 dB in every band 50 to 160 ms, its tones match early,
   808 SD5050 32.8 with the tail within about 4 dB at 200 and 250 ms. The fit tool prints tones with OPENDRUM_TONES.
   He: the 808 is good now. The 909 still off: its noise holds longer in the original, ours seems to decay at once,
   and its tone has too high overtones. Measured against the body, our noise level matches the reference within
   1 to 3 dB from 0 to 170 ms in both 1 to 4 and 4 to 16 kHz, and the reference noise is not steadier (flicker
   1.44 dB against 1.14). Research (firstpr mods guide, network-909, Lemus netlist, SD909, RE-909 advisory): two
   diode rounded triangle VCOs with own crude VCAs, a shared pitch CV with a start pulse (3 to 10 % high at first),
   shift register noise low passed then split, main snappy VCA held about 24 ms then faster than exponential, the
   snappy noise "bursts as its trigger ends" (Lemus), Accent shifts noise against tone (SD909). Listening experiment
   on /testing: three 909 variants on the same values, `SnareParams::variant` (not a parameter, to be removed): 1
   shift register noise, 2 joint body saturation (tanh x2 on the summed bodies), 3 wires delayed by 4 ms.
   Found while setting it up: the 909 snare fit peaks at 1.94 (click 0.34 banded at 759 Hz rings as a loud ping),
   the 909 kick at 1.08. The browser clipped them in every listening round so far. The preview now scales a hit
   that would pass 0.95 down to peak at 0.95 (`OpenDrumSynth.ts`), like the normalised references.
   He: all variants sound the same, the noise has no presence and falls at once, the tone is still not right. A
   plain split (noise above 3 kHz, body below 400 Hz, 10 ms frames, on exactly what the preview plays) finally
   showed it: the reference noise holds about -22 dB for 50 ms, ours was a click spike, then 5 dB too quiet; the
   fit had used the click to fake the burst, and the lab card hid it. Third octaves showed the tone gap: the
   reference has sum and difference tones of its two bodies (around 100 Hz and 360 Hz). Shape now bends both bodies
   together at full level (their balance follows their own envelopes), the per body bend and the variant switch are
   gone. The 909 on /testing is set by hand against that split view: Decay 0.22, Punch 0, Shape 0.5, Level 0.085,
   Curve +1, Click 0, Skin 0. Noise within 2 dB and body within 3 dB of the reference from 0 to 160 ms, third
   octaves within about 2 to 5 dB early. Lesson: check the plain level split and third octaves on the preview
   render before trusting the card.
   He raised the 909 Level to 0.17, then heard the noise lower in the original, missing low end. Band grid with
   both bodies at equal level (5 bands, 10 ms): at 0.17 our noise was 5 to 12 dB too loud above 1.5 kHz, worst
   above 10 kHz, the 808 too also had too much above 10 kHz. Electric Druid (TR-909 noise generator): 31 stage
   shift register, taps 31 and 13, clock about 300 kHz, flat to 100 kHz, so white noise is right. A model he found
   splits the 909 noise into a low passed snap (1.5 kHz, about 20 ms) and the high passed snappy. Now: the wire
   band has fourth order Butterworth edges, the bright top path is gone (it only added the excess above 10 kHz),
   a positive Curve adds a low passed snap (1.5 kHz, 10 ms, 6x Level, the 808 sits at a negative Curve and gets
   none). Band grid error (mean dB over 4 noise bands x 16 frames): 909 2.54 to 1.81 at Color 0.47 Level 0.07,
   808 3.13 to 1.82 at Color 0.41 Level 0.6. The snap barely moves the 909's 400 to 1500 Hz attack gap (7 dB
   short in the first 10 ms): the reference has the octaves of its bodies there (306 and 429 Hz in the first
   5 ms, gone by 10 ms), a level dependent bend, still open.
   He: the 808 stays great, how do we analyse the 909 better. The 909 set has 52 snares over Tune, Tone and
   Snappy (0, 3, 7, A); Snappy 0 has no noise (43 dB under the body), so the tone is measured alone there. Matrix
   pencil (damped sinusoids in short windows) was unstable in the first 10 ms. Analysis by synthesis works: two
   bodies on one exponential pitch drop, harmonics 1 to 4 per body with their own decay, three decaying DC terms,
   amplitudes by least squares, the rest by Nelder-Mead (scratchpad tonefit.py, residual -14 to -18 dB). Over
   Tune 0, 3, 7, A: body 1 at 130, 146, 205, 233 Hz, ratio 1.42 to 1.44, start +9.8, +10.0, +8.2, +7.6 semitones
   (about +100 to +130 Hz, a near constant Hz bump), drop 7 to 9 ms, decays about 29 ms lower and 26 ms upper,
   body 2 at -7.7 dB, body 1 harmonics -17, -24, -31 dB, body 2 octave -23 dB. Our 909 had half the start (+5)
   and a four times slower drop. Set by refitting our render: Tune 146.4, Ratio 1.421, Pitch 11, Sweep 7.1 ms,
   Decay 0.197, it measures 145.9/207.8 Hz, +10.4 st, 7.7 ms, 27.1/28.5 ms. Still off: body 2's octave is 13 dB
   weak (the joint bend puts the octave on body 1 only), body 2 decays 3 ms long.
   He: fix the octave. A per body tanh bend fixed the octave balance but added a 3rd harmonic 8 to 10 dB too
   strong (likely the "too high overtones" he heard before). Shape is now a Chebyshev shaper per body (T2, T3, T4
   on the full level sine, each adds exactly one harmonic), Shape 0.5 is the 909 recipe (-16.7, -24.1, -31.8 dB),
   Shape 1 twice that; Shape 0 is bit identical to before (808 untouched). 909 preset: Tune 146, Ratio 1.421,
   Balance 0.292, Pitch 9.7, Sweep 7.8 ms, Decay 0.188, Shape 0.5, Level 0.14 (the tanh had squashed the bodies
   by about 7 dB), Color 0.44. Measured: 146.0/207.3 Hz, +10.4 st, 7.9 ms, 27.1 ms, body 1 harmonics exact, body 2
   at -7.7 dB with harmonics within 1.3 dB, noise grid 1.86. Open: body 2 decays 27 ms against 25 ms.
   He set Tune 145 and Ratio 1.5 by ear ("very close"), the noise still different. Subtracting the Snappy 0 hit
   does not cancel the bodies (0.8 dB), the oscillators do not restart in phase, so the noise is measured above
   1 kHz. A 2-pole high-pass plus a resonant 2-pole low-pass fits both reference noises within 0.5 to 0.9 dB: 909
   high-pass about 1 kHz, low-pass about 8.4 kHz at Q 1.4 to 2 (unchanged over its Tone, Tune and Snappy knobs),
   808 2 to 2.7 kHz and 4.5 to 6 kHz at Q 0.5 to 0.7. Centres are close (3.0 and 3.5 kHz), the width differs, so
   the Snare got Width (his decision, 21 parameters): Color sets the centre (600 Hz x 30^Color), Width spreads the
   two filters (span 1.5 to 12) and raises the low-pass Q (0.6 to 2.0, by Width squared), the gain follows the
   passed band so Level holds. The 909 opens with a short broad burst (centroid 3.6 kHz, 0 to 2 ms): the snap is
   now low-passed at 4 kHz, 4 ms, 12x Level, at positive Curve. Scorer (scratchpad noise_search.py): 2 ms envelope
   above 1 kHz against the body plus sixth octave shape. 909 Level 0.072 Color 0.504 Width 0.8: envelope 1.61 dB,
   shape 1.41 dB. 808 Level 0.59 Color 0.52 Width 0.37: envelope 1.33 dB, shape 1.71 dB (late residual within
   about 3 dB). The 808's noise changed with this (no longer the old flat band).
   He: much closer, can do much better; Level 50 to 100 % barely audible (linear amplitude, plus the preview's clip
   guard scaling the whole hit). Level is now in dB (-48 dB off to 0 dB). Ruled out: oscillator modulation of the
   noise (envelope ripple depth 0.56 against our 0.54, no lines that follow Tune). A tone model residual first
   suggested strong noise under the bodies, but the model soaks up noise; the model free check (450 to 1500 Hz,
   Snappy 3 against Snappy 0 at the same Tune and Tone) shows Snappy adds about 4 dB there, as a burst over the
   first 20 ms, the same at Snappy 3 and A. A positive Curve now adds that burst: noise low-passed at 700 Hz, held
   8 ms, falling over 8 ms, 16x Level (a share following the wires made no difference and was dropped). Low band
   error 3.23 to 2.24 dB, upper noise unchanged (envelope 1.68, shape 1.18 dB). 909 Level -22.85 dB, 808 -4.58 dB.
   He: tone fine, noise still not quite; raising the noise covers the tone; why "Wires", Color barely differs. The
   909 samples keep the body at -10 dBFS from Snappy 0 to A, so the covering was the preview's per hit scaling.
   The preview now plays every hit and every reference 6 dB down (`OpenDrumSynth.Headroom`) and has a Noise only
   switch per device (both through two 1 kHz high-passes). The row is now Noise (Level, Decay, Width, Curve),
   Color is gone, the band centre fixed at 3.3 kHz, back to 20 parameters. Refit: 909 Level -23.7 dB Width 0.81
   (score 2.71, was 2.86), 808 Level -5.3 dB Width 0.46 (3.07, was 3.04).
   Level is capped at -3 dB (his decision, `LEVEL_MAX`, the knob runs -48 to -3 dB). The Snare sound was accepted
   on 2026-11-13 ("we are fine with that and can continue"). Stock preset seeds, Volume 0 dB, Velocity 50 %, Mode
   Mono, Glide 0, Drive 0:
   1. 808 style (SD5050): Tune 171.16 Hz, Ratio 1.943, Balance 72.4 %, Pitch 2.07 st, Sweep 9.2 ms, Decay 0.209 s,
      Punch -2.2 %, Shape 0; Click 10.8 %, Tone 4779 Hz, Skin 16.1 %; Noise Level -5.3 dB, Decay 0.194 s, Width
      46 %, Curve -27.5 %.
   2. 909 style (ST3T3S3, Tune and Ratio by his ear): Tune 145 Hz, Ratio 1.5, Balance 29.2 %, Pitch 9.7 st, Sweep
      7.8 ms, Decay 0.188 s, Punch 0, Shape 50 %; Click 0, Skin 0; Noise Level -23.7 dB, Decay 0.139 s, Width 81 %,
      Curve 100 %.
   Clap started 2026-11-13 (his go), /testing lists the newest engine on top. Measured on CP (808), HANDCLP1 and
   HANDCLP2 (909), the two machines nearly alike: four bursts at about 0, 11.5, 23.5 and 31.5 ms (the last gap
   shorter), each a sawtooth falling about 20 dB in 9 ms, the gaps dipping to -20 to -33 dB; the room starts with
   the last burst, about -4 dB for 10 ms, -20 dB at 80 ms, a quiet stage near -30 dB from 100 to 200 ms. Bursts
   band-passed around 1.4 to 1.5 kHz (Q 1 to 1.4), the room darker and narrower (0.95 to 1.2 kHz, Q 1.4 to 2).
   Engine `crates/opendrum/src/clap.rs` (5 tests), 12 parameters: Hands (1 to 8, the plan's limit), Gap, Spread
   (seeded per hand timing, tone and level), Decay; Tone, Width, Drive; Room Level (dB), Decay; Volume, Velocity
   (also sets how many hands join), Mode. Fixed: the last hand at 0.7 Gap, the room at 0.75 Tone and 1.5x the Q,
   a fast-drop-long-tail room curve (-0.6). Fitted (scratchpad clap_search.py, 2 ms envelope plus sixth octave
   band): 808 CP envelope 1.99 dB, band 2.08 dB, Gap 11.6 ms, Decay 21.5 ms, Tone 1608 Hz, Width 70.5 %, Room
   -4.75 dB, 0.48 s; 909 HANDCLP1 envelope 1.89 dB, band 2.09 dB, Gap 11.4 ms, Decay 27.5 ms, Tone 1214 Hz,
   Width 82 %, Room -6 dB, 0.54 s.
   He: both sound nothing like the references, ours 808 and 909 nearly identical, research the noise spectrum and
   envelopes. Circuits (Baratatronix 808 clap, Robin Whittle's TR-909 mods, KVR threads): noise through a band-pass
   (808 about 1 kHz; 909 a bridged-T, one forum estimate 1140 Hz Q 1.95) whose two outputs feed two VCAs, one with
   the multi-pulse sawtooth envelope (808: a 30 ms pulse makes three 10 ms charge cycles, then a 20 ms discharge),
   one with a 100 ms decay only "reverb". 909: the sawtooth drives the VCA through a log to linear converter "to make
   the sawtooth peaks very high indeed", the control pulses feed through as clicks; 909 noise from the shift register,
   808 from a noisy transistor ("spikier"). Fine measurement (scratchpad clap_deep.py, clap_filter_fit.py):
   1. Spectrum: peak at 0.85 to 1.07 kHz (ours was 1.5 to 1.7), steep below (+10 to +18 dB/oct), gentle above
      (-4 to -7 dB/oct), a high shelf at 8 to 14 kHz (-17 to -30 dB). Bursts fit a resonant 2-pole high-pass (808
      1.09 kHz Q 4, 909 0.87 to 0.97 kHz Q 2 to 2.8) times a 1-pole low-pass (1.6 to 2.1 kHz), error about 2 dB, a
      symmetric band-pass misses by 3.3 to 3.5 dB.
   2. Room: band at 0.85 to 1.2 kHz, Q 1.4 to 2 (40 to 120 ms), darkening: after 120 ms a low-pass at 0.5 to 0.8 kHz,
      highs falling -13 dB/oct.
   3. Bursts: 808 at 1.2, 12.3, 25.3, 36.7 ms, each rising over 1 to 2 ms; 909 at 0.2, 11.6, 24.3, 32.7 ms (last
      gap 8.4 ms), each instant (0 to 0.5 ms). All fall about 2 to 3 dB/ms (exponential, a linear amplitude ramp does
      not fit), the gaps dip to -25 to -34 dB.
   4. Each burst onset carries a broadband transient: above 6 kHz -8 to -15 dB falling within 1 to 2 ms (the 1 kHz
      band holds), the 909's first burst a low thump below 300 Hz (-19 to -28 dB).
   5. Noise kurtosis 5.5 to 14 (Gaussian 3), HANDCLP2 the spikiest.
   Our first engine missed 1 (band 0.5 octave too high, symmetric), 2 (room not darkening), 3 (one attack for both,
   the 808's last gap is not early) and 4 (no onset transient). The earlier band score hid 1: it removed the level
   offset and fitted a symmetric band-pass.
   Rebuilt (his go, labelled fields as before, Resonance shown as Reso), 15 parameters: Hands, Gap, Last (the final
   gap as a share of Gap, 808 1.0, 909 0.7), Spread; Attack (808 about 1 ms, 909 0), Decay, Snap (2 kHz high-passed
   noise per hand, 4 ms), Drive; Tone, Reso (resonant 2-pole high-pass at Tone, Q 0.7 to 6, then a 1-pole low-pass
   at 1.8x Tone, after the burst envelope a plain high-pass at 0.6x Tone removes the lows the fast envelope smears
   down); Room Level, Decay (high-pass at 0.8x Tone Q 1.2, a low-pass closing from 6x to 0.6x Tone as it fades);
   Volume, Velocity, Mode. Scorer clap_fit2.py: 1 ms envelope 300 Hz to 6 kHz and above 6 kHz, sixth octave spectra
   150 Hz to 16 kHz for bursts, early and late room, no offset removal. 808 CP 17.3 (first engine) to 10.9, 909
   HANDCLP1 8.9 (band envelope 2.5, high 2.7, spectra 3.7 dB). Open: the 808's burst peak is sharper than ours, its
   room carries less low end, the 909's late room darker than ours.
   He: the 808 reference has a much longer tail, the 909 sounds too hollow. The scorer only looked to 300 ms: the
   808 room falls to about -30 dB by 200 ms, then fades slowly (-45 dB at 700 ms, -62 at 1.2 s, -71 at 1.9 s; the
   909 files end at 446 and 365 ms). The room now has a quiet second stage (8 % of the room level, 6x its decay,
   floor -80 dB). The 909's hollowness was 5 to 10 dB missing at 100 to 400 Hz and 4 to 7 dB too much at 1.6 to
   6.4 kHz: the burst low-pass moved from 1.8x to 1.2x Tone, the fit chose a broad peak (Reso 21 %). Tried and
   dropped: the envelope's own feed-through as part of Snap (the fit set Snap to 0), a 2-pole low-pass (took too much
   top). The scorer now covers the whole file (tail windows to 1.8 s) and the whole-hit third octaves. 808 CP 12.6
   (tail 1.8 dB, whole spectrum 2.5 dB), 909 HANDCLP1 14.1 (whole spectrum 3.5 dB, still 3 to 7 dB too much at 0.5
   to 0.8 and 1.6 to 5 kHz).
   He: leading nowhere, the 808 too low, the 909 too low with a too long tail, "you must be able to detect these
   differences". The energy centre did not show it (it said ours was higher). Energy quantiles do (the frequency
   below which 25, 50, 75 % of the energy lies, 100 Hz to 16 kHz, scratchpad clap_quant.py): 808 bursts median
   1379 Hz against our 1112, late room 1081 against 933; 909 late room 931 against 632, its tail -50 dB at 424 ms
   (file end) against our 858. Causes: the fit had traded Tone down against other terms (no pitch term), the
   room's low-pass closed to 0.6x Tone and opened to 6x (the reference rooms are a narrow band at the tone that
   only loses its top), the second stage ran on the 909 too. Also found: two fits in parallel wrote the same
   temporary file and corrupted each other (now one file per process). Changes: Room Tail (amount of the long
   second stage, 16 parameters, 808 50 %, 909 0), the room band high-passed at 0.95x Tone with its low-pass
   closing from 1.6x to 1.0x Tone, the burst low-pass at 2x Tone, the scorer weighs the quantiles (2 per semitone)
   and penalises sound after the end of a reference file. Other sources: Replicant909 models the 909 clap as a
   band-pass at 1180 Hz Q 1.8 with a tail of 80 to 600 ms, a KVR estimate from the schematic 1140 Hz Q 1.95.
   Now: 808 bursts median 1380 Hz (ref 1379), whole hit 1172 (1196), late room 1161 (1081), tail -50 dB at 893 ms
   (823); 909 whole hit 993 (1003), late room 982 (931), bursts 1532 (1291, still high), tail -40 dB at 389 ms
   (414). Presets: 808 Tone 1055 Hz, Reso 100 %, Last 0.71, Attack 0.75 ms, Decay 19 ms, Snap 60 %, Room -1.25 dB
   0.41 s, Tail 50 %; 909 Tone 865 Hz, Reso 36 %, Last 0.885, Decay 25.5 ms, Snap 0, Room -3.25 dB 0.72 s, Tail 0.
   Open: the highs above 6 kHz per burst fit worse than before (6.5 and 5.2 dB), the 808's top 10 % too bright.
   The Clap was accepted on 2026-11-13 ("close enough"), committed 86a8868b7, next-release merged in.
5. openDrum Tom, then Rim, Hats and the rest (his order 2026-11-13: engines first, devices later). Tom engine built
   2026-11-13 (`crates/opendrum/src/tom.rs`, 5 tests, 18 parameters: Body Tune, Pitch, Sweep, Decay, Punch, Shape,
   Sub, Ratio; Strike Click, Tone, Drive; Noise Level, Decay, Color; Play Volume, Velocity, Mode, Glide). Measured
   (scratchpad tom_measure.py): 808 toms one sine with a 2 % fall, -60 dB after about 650 ms (low) and 330 ms
   (high), a dark noise layer; 909 toms fall 4 to 6 semitones in 20 to 50 ms, harmonics 2 to 5 at -20, -14, -30,
   -28 dB (Shape 1 is exactly that), mid and high toms carry a second oscillator at 0.61 to 0.69 of the main one,
   7 to 10 dB down (Sub, Ratio), attack noise above 2 kHz at about -25 dB. Presets set from the numbers: 808 LT50
   Tune 88, Pitch 0.4, Sweep 50 ms, Decay 0.62, Noise -30 dB 0.7 s Color 20 %; 909 LT3D3 Tune 81, Pitch 6.5, Sweep
   20 ms, Decay 0.65, Shape 100 %, Noise -26 dB 80 ms Color 80 %; 909 HT3D3 Tune 119, Pitch 4.3, Sweep 35 ms, Decay
   0.46, Shape 100 %, Sub 35 %, Ratio 0.69. Pitch track, partials and levels within 1 to 3 dB of the references.
   Not judged by ear yet.
   He: the 808 not too far, the 909 not even close, build the tools. Published sources give only the outline (three
   VCOs per tom, one hobbyist ratio 1 : 1.5 : 2.77, a board revision enlarging the tom noise). New tool, scratchpad
   osc_fit.py: analysis by synthesis, up to 3 oscillators on one shared two-stage pitch fall, 5 harmonics each, every
   partial free over time (ridge regularised, partials grouped by frequency), the residual per band as the noise.
   Result, the same for LT3D3, MT3D3, HT3D3: pitch starts 6 to 6.4 st high, 4.2 to 4.8 st fall in 22 to 25 ms plus
   2.1 to 2.5 st over 80 to 200 ms; the main body; a lower body at 0.60 to 0.69, 10 to 14 dB down and as long (the
   low tom has it too); an upper body at 1.72 to 1.85, as loud as the main one at the start (-2 dB), -10 dB at
   20 ms, gone by 80 ms, rich in harmonics; the main body's harmonics 2, 3, 5 at -10, -9, -11 dB in the attack
   settling to -22, -14, -30; noise strongest at 0.3 to 2.5 kHz for about 60 ms. The first engine had none of the
   upper body, the drift, the attack edge. Rebuilt, 19 parameters: Body Tune, Pitch, Sweep, Drift (falls 4x slower
   than Sweep), Decay, Punch, Shape (plus a fixed attack edge for 60 ms), Drive; Layers Sub, Ratio, Top (ratio fixed
   1.78, own fixed harmonics), Length; Noise Level, Decay, Color; Play as before. Click and Tone are gone. Presets
   from the analysis: 909 low Tune 74.4, Pitch 4.8, Sweep 24.6 ms, Drift 2.1, Decay 0.7, Shape 100 %, Sub 30 %,
   Ratio 0.67, Top 80 %, Length 0.2 s, Noise -16 dB 0.18 s Color 40 %; 909 high Tune 113.1, Pitch 4.3, Sweep 25.4 ms,
   Drift 2.2, Decay 0.5, Sub 25 %, Ratio 0.69, Top 70 %. The same tool on our renders: pitch curves equal, partials
   within 1 to 5 dB over time. Still off: the level falls 2 to 4 dB faster in the first 100 ms.
   He: much better, the 909 reference a bit brighter. A first band comparison without a window misled (the strong
   low tone leaked into every band); with a Hann window (scratchpad bright.py, 8 bands x 4 time windows) and a grid
   search over the noise (tom_noise_grid.py): the noise band now runs from half its centre to 3x the centre with a
   gentle top (Q 0.5). 909 low Noise -16 dB 0.25 s Color 30 % (mean error 2.75 dB), 909 high -30 dB 0.25 s Color
   50 % (1.86 dB), 808 low -34 dB 0.7 s Color 0 (4.98 dB). Left: all references carry 8 to 19 dB more above 10 kHz
   (about -50 dB re the hit, following the body), the 808 has 11 to 18 dB more at 150 to 600 Hz late in the hit (its
   dark layer is narrower than our band).
   He: could still be brighter. Noise got Air (20 parameters): noise above 3.5 kHz on the noise envelope (following
   the body's envelope instead was 20 to 30 dB too loud late in the hit). 909 presets Air 35 %: above 10 kHz now
   within 2 to 4 dB, 5 to 10 kHz still 5 to 10 dB short. While this was built the served wasm was one parameter
   behind the page, so Volume did nothing in the preview (it landed on Velocity); fixed by serving the new build.
   The Tom was accepted on 2026-11-13 ("all good"), committed e00abd07a.
6. openDrum Rim. Analysed first (scratchpad rim_measure.py: partials with their swell and decay, level over time,
   bands): 808 rimshot tones at 476 and 1713 Hz (the upper one rings 33 ms, the lower 168 ms), cut hard after about
   10 ms (-33 dB at 12 ms), in-between tones at 740, 931, 1263 Hz from overdriving the two together, a bright
   2 ms attack; 808 claves one tone at 2422 Hz, -0.91 dB/ms; 909 rim tones at 220, 459 (-7 dB), 899 Hz (-23 dB), a
   broadband attack, the file only 40 ms long. Every tone swells in over 2 to 5 of its own cycles. Engine
   `crates/opendrum/src/rim.rs` (4 tests), 14 parameters: Tones Tune, Ratio, Balance, High (a third tone at Ratio
   squared); Shape Ring, Ring Hi, Decay, Punch, Drive; Strike Click, Cut; Play Volume, Velocity, Mode. Fixed: the
   swell over 3 cycles per tone. Presets: 808 Tune 476, Ratio 3.6, Balance 100 %, Ring 0.17 s, Ring Hi 35 ms, Decay
   12 ms, Punch 70 %, Drive 12 dB, Cut 300 Hz; 909 Tune 220, Ratio 2.09, Balance 25 %, High 5 %, Ring 90 ms, Ring
   Hi 0.19 s, Decay 50 ms; claves Tune 2422, Ring 0.1 s, Decay 50 ms. Measured on our renders: tone frequencies,
   swell times and decays match (808 peaks at 6.2 and 2.6 ms against 6.3 and 2.5), the 808 level curve within 2 dB.
   Off: the 808's in-between tones are 10 to 15 dB weak, its attack above 3 kHz is darker and our click rings on
   to 30 ms, the 909 level holds about 5 dB too high around 10 ms. Not judged by ear yet.
   He: 808 rim and claves fine (claves must not change), the 909 rim off. Damped sinusoid analysis (matrix pencil,
   scratchpad damped.py, it works here because the tones do not sweep): the 909 rim has a strong third tone at
   about 1145 Hz (-8 dB early, -2.3 dB/ms), products near 656 and 900 Hz, its attack sits at 1.1 to 2.5 kHz, and
   its low tone is there from the start. Ours had the third tone at Ratio squared (961 Hz, 5 %), a click at 3 kHz
   and a low tone swelling in over 13 ms. Now 16 parameters: the third tone has its own ratio (Ratio Hi) and rings
   half of Ring Hi, the click sits at the third tone's pitch, Swell (cycles) is a parameter (808 rim and claves 3
   as before, their renders unchanged; 909 1). 909 preset: Tune 220, Ratio 2.08, Balance 60 %, High 30 %, Ratio Hi
   5.2, Ring 70 ms, Ring Hi 60 ms, Decay 0.11 s, Punch 30 %, Drive 6 dB, Click 18 %, Swell 1, Cut 60 Hz. Bands
   within about 3 to 6 dB in the first 30 ms, level curve within 3 dB; above 3 kHz ours stays 8 to 20 dB too loud
   after the first 3 ms (the shared click lasts 6 ms).
   The preview shows the engine name above every device. He: the 909 rim too shallow, then still off. New general
   tool, scratchpad specdiff.py: third octaves x short time frames, ours minus reference, and a coordinate fitter
   on it (rim_fit.py). The waveform itself showed the cause: the first cycles of the 909 rim are hard clipped
   (flat tops at full scale, a square-like wave with odd harmonics at 1046, 1747, 2475 Hz), relaxing into the
   separate tones after about 8 ms. So the tones are driven far into the clipper, there is no separate click.
   909 preset now: Balance 41 %, High 26 %, Ring 60 ms, Ring Hi 46 ms, Decay 0.12 s, Punch -30 %, Drive 24 dB,
   Click 0, Swell 0.8, Cut 20 Hz. Fine grid: within 0 to 6 dB in the first 4 ms and after 16 ms; from 4 to 16 ms
   ours stays saturated longer (+8 to +14 dB at 300 to 500 Hz, +10 to +17 dB at 1 to 3 kHz). Engine unchanged,
   808 rim and claves untouched.
   He: too dark and a little crunchy. The shared soft drive keeps adding grit while the level falls and rounds the
   edges. New `Clipper` in common.rs (2x oversampled, blends tanh to a hard clip) and a Rim parameter Hard (17
   parameters; at 0 the shared drive runs as before, 808 rim and claves render byte identical). Fitted with Hard:
   909 Balance 100 %, High 62.5 %, Ring 77.5 ms, Ring Hi 40 ms, Decay 0.205 s, Punch -19 %, Drive 12 dB, Hard 40 %,
   Swell 0.4, Cut 60 Hz, fine grid 3.14 dB (was 4.04).
   The Rim was committed b5ebbdd61 on his "commit. next".
7. openDrum Hat, 808 only (his decision 2026-11-13: "leave the 909 hats", they are recordings of a real cymbal).
   Measured (scratchpad hat_measure.py): a dense cluster of lines at 5.8 to 8.5 kHz, almost everything above 5 kHz
   (peak 6.4 to 12.8 kHz, about 23 dB/oct below), the closed hat -18 dB at 40 ms and -40 at 80, its top above
   10 kHz fading fastest, the open hat holding about 30 ms, then fading (short at Decay 0, -9 dB at 300 ms at
   Decay 75), its top darker than the closed one. Engine `crates/opendrum/src/hat.rs` (4 tests), 10 parameters:
   Source Tune, Noise; Filter Color (4-pole high-pass), Top (low-pass); Decay Closed, Open, Pedal (runs the length
   from Closed to Open and adds up to 30 ms of hold); Play Volume, Velocity, Mode. Six polyBLEP squares at 205.3,
   304.4, 369.6, 522.7, 540, 800 Hz (the published 808 values) scaled by Tune; a new hit chokes the ringing one in
   Mono. Presets: closed Color 6300 Hz, Top 18 kHz, Closed 0.13 s (fine grid 3.84 dB); open (OH00) Color 6200 Hz,
   Top 11 kHz, Open 0.15 s, Pedal 100 %. The line cluster of this unit's samples sits at slightly other
   frequencies than the published oscillator values give. Not judged by ear yet.
   He: just a hold and a decay. Closed, Open and Pedal became Shape Hold and Decay (9 parameters): closed Hold 0,
   Decay 0.13 s; open Hold 30 ms, Decay 0.15 s. The renders are the same as before.
   Top is gone too (it did little above 12 kHz and silenced the hat below Color): the low-pass is fixed at 14 kHz,
   8 parameters: Source Tune, Noise; Filter Color; Shape Hold, Decay; Play Volume, Velocity, Mode.
   Noise clipped (plain noise was 7x louder than the squares behind the filters): it now crossfades at equal
   power with the noise matched in level (x0.14).
   The Rim's preview columns had grown to 5 and 6 fields; regrouped to at most 4: Tones Tune, Ratio, Balance,
   Ring; High Level, Ratio, Ring, Swell; Shape Decay, Punch, Drive, Hard; Strike Click, Cut; Play. Rule for the
   coming engines: at most 4 fields a column.
   The Hat was committed 2cfd4ff93. Clap, his find: with a larger Gap the bursts faded to silence in between and
   left a trail of clicks. The burst fade now stretches with the Gap above 11.6 ms (the machines' gap), so each
   burst has fallen by the same amount when the next arrives (about -26 dB at a 40 ms gap, as at 11.6 ms). At
   11.6 ms and below nothing changes: both presets render byte identical.
   He: still running to silence, they need to restart mid-run. The stretch is now the gap ratio squared, so the dip
   gets shallower as the gap widens: just before the next burst about -22 dB at 11.6 ms (unchanged), -15 dB at
   20 ms, -7 to -11 dB at 30 ms, -7 dB at 50 ms. Presets still byte identical.
   Gap's maximum is 40 ms (his decision).
   OPEN, needs its own run (his find 2026-11-14): Drive jumps when it leaves 0. At 0 the shared drive is bypassed,
   above 0 the signal passes a tanh with its ceiling at 1.0 whatever the engine's level. The 808 clap peaks at 2.6
   before the drive, so at 0.5 dB its bursts collapse to 1.0 (first 45 ms: peak 2.64 to 1.02, level -3 dB) while
   the tail stays. The same holds for every engine whose hit peaks above about 0.5 (Snare, Tom, Rim; the Kick is
   accepted and must stay bit identical). To decide: a ceiling that follows the engine's own level, or engine
   levels that sit under the ceiling, so that a small Drive is a small change.
   Fixed the same day (his "fix the Drive now"): Clap, Snare and Tom scale their mix into the shared drive by a
   ceiling at their own level (Clap 4, Snare 2, Tom 4, powers of two so Drive 0 stays bit exact) and back out,
   with `drive_makeup` (1 at Drive 0, a half from 12 dB on) so a driven hit stays near its undriven peak. 808 clap,
   first 45 ms: Drive 0 peak 2.64, 0.5 dB 2.31 (level -0.4 dB), 3 dB 2.32, 12 dB 2.50, 24 dB 2.87. Clap, Tom and
   Snare presets (all at Drive 0) render byte identical. Kick and Rim are untouched: the Kick is accepted, the Rim's
   presets rely on the drive as it is.
   Every trigger differs slightly in the device: the noise is seeded by the engine's hit counter (the preview
   always renders hit 1, so it shows the same hit every time). A project rendered from its start repeats exactly.
   Rule (his, 2026-11-14): every trigger varies in Hat, Cymbal, Crash, Shaker (maracas), Snare, Tom and Clap, not
   in Rim and claves. Snare, Tom, Clap and Kick click already seed their noise by the hit counter. The Hat's six
   oscillators now start every hit at seeded positions in their cycles (they started at zero after silence, so
   hits without Noise were identical). The Rim's click uses one fixed seed, so rims and claves repeat exactly
   (808 rim preset byte identical). Cymbal and Shaker have to follow the rule when they are built.
   Display cost, measured in node at 48 kHz: 2 s of sound render in 3 to 5 ms (Snare, Clap with 8 hands and
   drive, Tom, Hat), the Kick with Rumble in 10 ms, 8 s in 14 ms (Hat) and 26 ms (Kick with Rumble). The preview
   module is about 70 kB.
   The preview has a navigation row of all preview names on top (his request).
   Rim Restart (his idea): On restarts the tones at the same point every hit (as before, the default), Off starts
   them somewhere else in their cycles each hit, audible once they are driven. 18 parameters, the 808 rim preset
   renders byte identical with Restart on. Rendering the display off the main thread: see plans/worker.md.
   Committed f316e7aec. After it (2026-11-14):
   1. Typed values: a number typed without a unit is read in the unit on display. Fixed in the preview and, with
      his go, in the three studio places that lacked it (FieldAdapter.setPrintValue, the automation value editor,
      the note property editor), using `StringMapping.withDisplayUnit` like the automatable parameters already do.
   2. 808 open hat Hold 200 ms (his value).
   3. Hat, more control without changing the 808 (his request, all four in a column of their own, Character):
      Spread (-1 to 1, stretches or shrinks the oscillators' intervals above the lowest), Ring (the oscillators
      multiply in pairs instead of adding), Reso (a peak at Color, up to 8x the Q of the second filter stage), Curve
      (the fade's shape, like Punch). All neutral at 0, both presets render byte identical. 12 parameters.
      Then: the Character column moved second, Color moved into Source (the Filter column had one field), Noise was
      removed (his call, it did little), 11 parameters: Source Tune, Color; Character Spread, Ring, Reso, Curve;
      Shape Hold, Decay; Play. Level over Color (his find, the waveform blew up at low Color): measured level
      rises with Color to the power of -0.7 below 6 kHz, the output is turned down by that below 6 kHz (808 presets
      at 6.2 and 6.3 kHz byte identical), and Reso is turned down by the square root of its Q gain. Level now
      0.094 to 0.136 rms from 200 Hz to 6.3 kHz at Reso 0 (was 1.01 to 0.115), 0.056 to 0.18 with Reso up.
      Above 6.3 kHz the hat still gets quieter (12 kHz 0.040), not compensated. The preview refuses to render when
      the page and the served engine disagree on the number of values (it showed dead controls twice).
   Committed 15f397c9b.
8. openDrum Shaker (his decision 2026-11-14: an engine of its own, the Hat cannot reach the 808 maracas: they are
   pure noise, flatness 0.31 against the Hat's 0.02 to 0.11, and they swell in). Measured: the maracas rise over
   about 18 ms like a linear ramp, hold about 2 ms, then fall about 5 dB/ms, a steep band above about 7 kHz
   (12 dB/oct below), rolling off above 16 kHz. Engine `crates/opendrum/src/shaker.rs` (3 tests), 7 parameters:
   Shape Color (2-pole high-pass, fixed low-pass at 18 kHz), Attack, Decay, Curve; Play Volume, Velocity, Mode.
   The level follows the passed band's width, every hit has its own noise. Preset: Color 7200 Hz, Attack 20 ms,
   Decay 12 ms, Curve 30 %: envelope within 1.9 dB (2 ms steps), spectrum within 2.3 dB (third octaves). Not
   judged by ear yet.
   The Shaker was accepted ("perfect"), committed 3c4426893.
9. openDrum Cymbal, 808 only (the 909 crash and ride are recordings). The first build (two bands) was 7 to 11 dB
   off. Level per band over time (scratchpad band_env.py) showed three parts: a body around 2 to 5 kHz that swells
   in over about 100 ms and rings longest (the Decay knob moves it most, the shortest setting cuts near 1 s), a top
   above about 5 kHz with a peak near 6.5 kHz at full level from the start (-60 dB after about 0.85 s at the
   shortest setting), and a bright part above about 8 kHz. The 808's Tone knob raises the bright part through the whole hit and
   lowers the body by about 3 dB. Engine
   `crates/opendrum/src/cymbal.rs` (5 tests), 7 parameters: Shape Tune, Tone (sizzle up, body down), Attack
   (all parts fade in, the body never faster than its 40 ms swell), Decay; Play
   Volume, Velocity, Mode. Body: fourth-order high-pass at 2.6 kHz, gentle low-pass at 4.5 kHz, 40 ms swell, a
   straight fall over Decay. Top: fourth-order high-pass at 6 kHz with a resonant second stage, fading in
   0.85 x Decay^0.6. Sizzle: high-pass at 9 kHz, as long as the top, level Tone, body x (1 - 0.4 Tone). Presets: CY0000 Tone 0 Decay 0.75 s (fine grid 4.2 dB),
   CY7500 Tone 30 % Decay 0.9 s (4.7 dB), CY0075 Decay 5 s (6.2 dB); the bands sit within about 0 to 5 dB over the first
   400 ms. The display in the preview covers 2 s, the long cymbal runs past it. Not judged by ear yet.
   4. Cymbal in progress: `crates/opendrum/src/cymbal.rs` (4 tests), the shared square oscillator moved to
      common.rs. Body and top as two fourth-order high-passes (2.8 and 6.5 kHz), the body swelling in over 15 ms
      and ringing for Decay, the top for 0.45 of it, Tone moving the weight. Still about 7 dB off the references
      on the fine grid, not in the preview yet.
10. openDrum Bell, the 808 cowbell first (2026-11-14). Measured (scratchpad bell_fit.py, bell_env.py): two tones at
   558 and 824 Hz (ratio 1.477) with strong even harmonics, so pulses high for 44 % of the cycle, not squares, the
   lower tone at 70 %, a band-pass at 1050 Hz (Q 4). The level falls in two stages: 80 % gone within 50 ms, the
   rest rings to -60 dB in 0.7 s. Engine `crates/opendrum/src/bell.rs` (3 tests), 9 parameters: Tones Tune, Ratio,
   Balance; Shape Color, Strike, Decay; Play Volume, Velocity, Mode. Every hit starts the pulses at the same point
   (bells repeat exactly, like rims). Preset "Cowbell (808)": harmonics within 4 dB, level over time within 0.9 dB.
   A band on a tone clipped (up to 2.6), so a band that lets more through than the 808 setting is turned down to
   its level (computed from both tones and 48 harmonics), never up: lifting a distant band made the hit spiky.
   Not judged by ear yet.
11. 808 congas with the Tom engine, no engine of their own (2026-11-14). Measured: pure sines at a fixed pitch
   (low 200.5, mid 281.5, high 412.5 Hz, harmonics below -63 dB, no noise from 5 ms on), the first half cycle
   shortened by the ping. Fitted on level over time and the first 4 ms: Pitch 12 to 24 st over 0.5 to 1 ms, Noise
   off, low Decay 0.55 s, mid 0.3 s Punch -30 %, high 0.25 s Punch -15 %; level within 0.4, 2.5 and 1.2 dB. Three
   Tom presets on /testing next to LC50, MC50 and HC50.
12. openDrum Perc (2026-11-14), no reference, set by ear. Engine `crates/opendrum/src/perc.rs` (4 tests), 13
   parameters: FM Tune, Ratio, Index (phase modulation up to 8 radians), Bite (how fast Index falls); Shape Pitch
   (-48 to 48 st, negative rises), Sweep, Decay, Curve; Grit Noise (mix), Drive (the shared drive, ceiling 2);
   Play Volume, Velocity (level and Index), Mode. Every hit repeats exactly. Presets Zap, Laser, Blip, Rise, Metal,
   Industrial, all peaking near 1. The preview accepts a device without a reference ("No reference").