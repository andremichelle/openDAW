# TB-303 Bass Synthesizer — Apparat Emulation

Compiled 2026-03-19 for openDAW Apparat implementation.

## Sources

- **Open303** (Robin Schmidt) — full C++ DSP implementation
- **Robin Whittle** (Devil Fish) — circuit analysis
- **Tim Stinchcombe** — diode ladder filter mathematical model
- **a1k0n/303** — JS/Python resynthesis experiments
- **KVR Audio DSP forums** — community measurements
- **Csound diode_ladder** documentation

## Implementation

Example file: `packages/app/studio/src/ui/devices/instruments/examples/tb-303.js`

### Parameters (Knobs)

| Knob | Default | Range | Type | Description |
|------|---------|-------|------|-------------|
| waveform | 0 | 0–1 | int | 0=sawtooth, 1=square |
| tuning | 0 | -5–5 | linear (st) | Pitch offset in semitones |
| cutoff | 500 | 80–5000 | exp (Hz) | Base filter cutoff frequency |
| resonance | 0.5 | 0–1 | linear | Filter resonance |
| envmod | 0.5 | 0–1 | linear | Filter envelope modulation depth |
| decay | 400 | 200–2000 | exp (ms) | Filter envelope decay time |
| accent | 0.5 | 0–1 | linear | Accent amount |
| volume | 0.7 | 0–1 | linear | Output level |

### Architecture

Monophonic. Overlapping notes trigger slide (portamento). High velocity (>0.78) triggers accent.

---

## 1. Oscillator (VCO)

**Circuit:** Discrete thyristor-based oscillator (Q24, Q25, Q27 as SCR) with integrator capacitor C33. Faster reset time than conventional switched-integrator designs.

### Sawtooth

- NOT mathematically ideal
- Raw saw passes through ~10 high-pass filters (coupling capacitors), the ladder filter, VCA, and mixer
- Even harmonics present due to S-curve shaping in the ramp
- **DSP:** bandlimited sawtooth via polyBLEP with DC blocking

### Square

- Derived from sawtooth via single-transistor waveshaper (Q8, PNP)
- **Frequency-dependent duty cycle:**
  - ~71% at lowest pitches (65 Hz)
  - ~45% at highest pitches (660 Hz)
  - Linear mapping: `duty = 0.71 - 0.26 * clamp((freq - 65) / 595, 0, 1)`
- Two capacitors in waveshaper circuit cause this behavior
- **DSP:** bandlimited pulse via polyBLEP with pitch-dependent duty cycle

### Tuning

- 3 octaves in pattern mode (C2–C5), 4 in track mode
- Untransposed low C ≈ 65 Hz (2.0V CV)
- Tuning control: ±500 cents (±5 semitones)
- 6-bit R2R DAC: theoretical range ~16.35 Hz to ~659 Hz

---

## 2. Filter (VCF) — The Key to the 303 Sound

**Architecture:** 4-pole DIODE ladder filter (NOT Moog transistor ladder). Transistors with base-collector shorted to function as diodes.

### The C18 Mismatch (Critical Characteristic)

- **C18 = 0.18 µF**, other three caps = **0.33 µF** each
- First pole sits **~1.83x higher** than the other three (≈ one octave)
- Result: "1+3 pole" filter — three matched poles at nominal cutoff, one pole an octave above
- Effective slope: **~18 dB/oct** near cutoff (not 24 dB/oct)
- Deeper in stopband: transitions toward 24 dB/oct
- **Prevents true self-oscillation** (phase shift never reaches 360°)

### Open303 Filter Structure

```
y1 += 2*b0*(y0 - y1 + y2)   // First stage: 2x coeff (halved cap)
y2 +=   b0*(y1 - 2*y2 + y3) // Stages 2-4: normal coeff
y3 +=   b0*(y2 - 2*y3 + y4)
y4 +=   b0*(y3 - 2*y4)
```

Cross-coupling terms model the bidirectional coupling between stages through the diodes. Sequential evaluation (each stage uses updated value of previous stage).

### Filter Coefficient

For native sample rate (no oversampling):
```
g = tan(π * cutoff / sampleRate)
b0 = g / (1 + g)
```

For 2x oversampled inner loop (used in our implementation):
```
g = tan(π * cutoff / (sampleRate * 2))
b0 = g / (1 + g)
```

### Resonance Feedback

- Global feedback from y4 back to input
- **High-pass filter in feedback path** (~150 Hz cutoff) from coupling capacitors
- Tim Stinchcombe: ~6 additional poles/zeros from coupling caps
- Resonant peak around 8–10 Hz (measured on hardware)

Resonance mapping:
```
resoSkewed = (1 - exp(-3 * resonance)) / (1 - exp(-3))
kFeedback = resoSkewed * 17
```

### Gain Compensation

```
gNorm = kFeedback / 17
gComp = (gNorm - 1) * resoSkewed + 1
gComp *= (1 + resoSkewed)
output = 2 * gComp * y4
```

### Saturation

- tanh() nonlinearity at filter input: `y0 = tanh(input - feedbackHP)`
- Transistor-diode ladder natural saturation
- Csound alternative: `(1/tanh(k_sat)) * tanh(k_sat * input)`

### Cutoff Range

| Condition | Range |
|-----------|-------|
| Env Mod at minimum | ~77 Hz – ~620 Hz |
| Env Mod at maximum | up to ~36 kHz |
| Practical maximum | ~20 kHz |

### Post-Filter Chain (Open303 reference values)

- Allpass: 14.008 Hz
- Highpass: 24.167 Hz
- Notch: 7.5164 Hz, BW 4.7
- Pre-filter highpass: 44.486 Hz

---

## 3. Envelopes

Two separate envelope generators.

### VEG (Volume Envelope) → VCA

| Parameter | Normal | Accented |
|-----------|--------|----------|
| Attack | ~3 ms | ~3 ms |
| Decay | 1230 ms | 200 ms |
| Sustain | 0 | 0 |
| Release | 0.5 ms | 50 ms |

RC-filter style:
```
attack:  out += coeff * (1.3 - out); transition to decay when out >= 1.0
decay:   out *= exp(-1 / (decayTime * sr))
release: out *= exp(-1 / (releaseTime * sr))
```

### MEG (Main Envelope) → Filter Cutoff

- Attack: near-instantaneous (~3 ms smoothing)
- Decay: **variable**, controlled by Decay knob (200 ms – 2000 ms)
- On **accented notes**: decay **fixed at ~200 ms** regardless of knob

```
megEnv *= exp(-1 / (decayTime * sr))
```

### VCA + MEG Compound

The MEG contributes to the VCA while gate is on:
```
ampOut = vcaEnv + 0.45 * megEnv + accentGain * 4.0 * megEnv
```

### Retriggering

- Retriggers on each new note gate
- During **slide**: gate stays HIGH → envelope does NOT restart

---

## 4. Accent

Accent simultaneously affects multiple parameters. Triggered when velocity > ~0.78 (100/127).

### Effect on VCA

- MEG voltage → Accent pot → VCA control current
- Through RC: **47k resistor + 0.033 µF capacitor**
- Primary reason accented notes are louder

### Accent Sweep Circuit

Adds to filter control current. Components:

| Component | Value |
|-----------|-------|
| Diode + resistor in series | 47k |
| Pot (second section of Resonance pot) | 100k |
| Capacitor to ground | **1 µF** |
| Mixing resistor to filter | 100k |

**Time constants:**
- Charge: (47k + 100k) × 1 µF = **~147 ms**
- Discharge: 100k × 1 µF = **~100 ms**

### Accent Stacking (Iconic 303 Behavior)

The 1 µF capacitor **does NOT fully discharge** between steps. Each successive accented note creates a **higher filter peak** due to charge accumulation. This "building" effect is one of the most iconic 303 behaviors.

```
if (accented && gate):
    accentCap += (1 - exp(-1/(0.147*sr))) * (megEnv * accent - accentCap)
else:
    accentCap *= exp(-1/(0.1*sr))
cutoff *= pow(2, accentCap * sweepOctaves)
```

### Accent on Envelopes

- MEG decay: **fixed 200 ms** (regardless of Decay knob)
- VCA decay: **200 ms** (vs 1230 ms normal)
- VCA release: **50 ms** (vs 0.5 ms normal)

### "Gimmick" Circuit

Three transistors pull cutoff **down** at end of envelope decay, creating characteristic dip/pluck. Partially modeled by accent sweep discharge behavior.

---

## 5. Slide (Portamento)

### Characteristics

- **Exponential** glide (NOT linear)
- Equivalent to 6 dB/octave lowpass on pitch CV
- **Constant time** regardless of interval size
- Time constant: **~60 ms** (stock TB-303)
- Devil Fish: 60–360 ms via Slide Time pot

### Circuit

RC lowpass on pitch CV. When slide activated, pitch CV charges capacitor through resistor.

### Implementation

```
freqSmoothed += (freqTarget - freqSmoothed) * (1 - exp(-1/(0.012*sr)))
```

Time constant 12 ms for the RC gives ~60 ms effective glide time.

### Behavior

- Overlapping notes trigger slide (gate stays HIGH)
- NO envelope retrigger during slide
- Oscillator phase NOT reset
- Filter state NOT reset

### Sequencer Gate Timing

- 12 internal clock ticks per 16th note
- Gate high at tick 0, low halfway through tick 3 (~50% duty)
- Slide extends gate through current step into next
- Slide activates on the NEXT note after the slid note
- Sequencer does NOT anticipate the next note

---

## 6. Parameter Ranges Summary

| Parameter | Range | Notes |
|-----------|-------|-------|
| Cutoff frequency | ~77 Hz – ~620 Hz | Up to ~36 kHz with full envmod |
| Resonance | 0 – just below self-osc | 303 can't truly self-oscillate |
| Env Mod | 0–1 | ~4 octaves sweep at maximum |
| Decay time | ~200 ms – ~2000 ms | Fixed ~200 ms on accented notes |
| Tuning | ±500 cents | ±5 semitones |
| Oscillator range | ~32 Hz – ~660 Hz | 3-4 octaves |
| Slide time | ~60 ms | Exponential RC lowpass |
| VCA attack | ~3 ms | |
| VCA decay | ~1230 ms / ~200 ms | Normal / accent |
| VCA release | ~0.5 ms / ~50 ms | Normal / accent |

---

## 7. Circuit Quirks Critical for Authentic Emulation

1. **Mismatched first filter pole** — C18=0.18µF vs 0.33µF → first stage 2×b0 coefficient
2. **High-pass in resonance feedback** — ~150 Hz HPF from coupling capacitors
3. **Accent stacking** — 1µF cap doesn't fully discharge between steps
4. **No true self-oscillation** — mismatched poles prevent 360° phase shift
5. **Frequency-dependent square duty cycle** — 45% high pitches, 71% low pitches
6. **VCA = ADSR(sustain=0) + MEG** — compound envelope, not simple gate
7. **tanh saturation at filter input** — transistor-diode ladder natural clipping
8. **Slide prevents envelope retrigger** — gate stays high, smooth transitions
9. **Low-frequency resonance peak (~8–10 Hz)** — from coupling caps in filter core
10. **BA662 OTA for VCA** — introduces subtle saturation and offset

---

## 8. Open303 Magic Numbers

```
Oversampling:           4x
Wavetable length:       2048 samples
Mip-map tables:         12

Square shaping:
  tanhShaperFactor:     dB2amp(36.9) ≈ 69.98
  tanhShaperOffset:     4.37

Filter:
  Feedback HP:          150 Hz (one-pole)
  Cutoff clamp:         200 Hz – 20000 Hz
  Post-filter allpass:  14.008 Hz
  Post-filter HP:       24.167 Hz
  Post-filter notch:    7.5164 Hz, BW 4.7
  Pre-filter HP:        44.486 Hz

Envelopes:
  VCA attack:           3 ms
  VCA decay:            1230 ms (normal), 200 ms (accent)
  VCA release:          0.5 ms (normal), 50 ms (accent)
  MEG RC1 smoothing:    0 ms
  MEG RC2 smoothing:    15 ms

Envelope modulation scaling (from measurement):
  c0   = 3.138152786059267e+002
  c1   = 2.394411986817546e+003
  oF   = 0.048292930943553
  oC   = 0.294391201442418
  sLoF = 3.773996325111173
  sLoC = 0.736965594166206
  sHiF = 4.194548788411135
  sHiC = 0.864344900642434

VCA MEG contribution:
  ampEnvOut += 0.45 * mainEnvOut + accentGain * 4.0 * mainEnvOut

Default level:          -12 dB
Level by velocity:      12 dB
Default cutoff:         1000 Hz
Default envMod:         25%
envUpFraction:          2/3
AmpDeClicker:           Biquad LP 12dB/oct, 200 Hz, Q=sqrt(0.5)
Slide time:             60 ms (tau = 12 ms)
Anti-alias:             Elliptic quarter-band
```

---

## 9. a1k0n/303 JS Reference

```
VCA:
  attack:     1.0 - 0.94406088 = 0.05593912
  decay:      0.99897516
  amplitude:  0.5
  Update rate: every 64 samples

VCF envelope (measured from x0xb0x):
  vcf_e1 = exp(5.55921003 + 2.17788267*cutoff + 1.99224351*envmod) + 103
  vcf_e0 = exp(5.22617147 + 1.70418937*cutoff - 0.68382928*envmod) + 103

Filter: 5 poles + 1 zero
  Section 1: one-zero + one-pole HP (~100 Hz)
  Section 2: complex conjugate pole pair (biquad)
  Section 3: complex conjugate pole pair (biquad)
  Lookup: 64 resonance × 10 coefficients
  Gain: 2/(1+reso_k) + 0.5*reso, where reso_k = reso * 4.0
```

---

## 10. References

- [Tim Stinchcombe — TB-303 Diode Ladder Filter Model](https://www.timstinchcombe.co.uk/index.php?pge=diode2)
- [Robin Whittle — TB-303 Unique Characteristics](https://www.firstpr.com.au/rwi/dfish/303-unique.html)
- [Robin Whittle — TB-303 Slide Analysis](https://www.firstpr.com.au/rwi/dfish/303-slide.html)
- [Open303 (Robin Schmidt)](https://github.com/RobinSchmidt/Open303)
- [a1k0n/303 — Resynthesis Experiments](https://github.com/a1k0n/303)
- [Csound diode_ladder](https://csound.com/manual/opcodes/diode_ladder/)
- [Vadim Zavalishin — The Art of VA Filter Design](https://www.native-instruments.com/fileadmin/ni_media/downloads/pdf/VAFilterDesign_2.1.0.pdf)
- [TB-303 Wikipedia](https://en.wikipedia.org/wiki/Roland_TB-303)
- KVR Audio DSP Forums: [filter](https://www.kvraudio.com/forum/viewtopic.php?t=346155), [envelopes](https://www.kvraudio.com/forum/viewtopic.php?t=258816), [square duty](https://www.kvraudio.com/forum/viewtopic.php?t=261379), [facts](https://www.kvraudio.com/forum/viewtopic.php?t=455469)
- [Eddy Bergman — TB-303 VCF Build](https://www.eddybergman.com/2025/03/TB303-VCF.html)
- [Sequence 15 — How Many Poles?](http://sequence15.blogspot.com/2009/02/how-many-poles-does-tb-303-filter-have.html)
