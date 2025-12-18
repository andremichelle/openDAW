# Vaporisateur

A classic subtractive synthesizer with dual oscillators, resonant low-pass filter, LFO, and ADSR envelope. Designed for
pads, leads, basses, and sound design.

---

![screenshot](vaporisateur.png)

---

## 0. Overview

_Vaporisateur_ follows the traditional subtractive synthesis signal flow: oscillators generate raw waveforms, which pass
through a resonant filter, modulated by an LFO and shaped by an amplitude envelope. The unison engine adds thickness
through detuned voice stacking.

Example uses:

- Warm analog-style pads with unison detuning
- Punchy mono basses with glide
- Evolving textures using LFO modulation
- Classic leads with filter sweeps

---

## 1. Voice Section

Controls for voice allocation and behavior.

### 1.1 Play-Mode

Switches between **MONO** and **POLY** voice modes.

- **MONO**: Single voice with note priority and optional glide
- **POLY**: Multiple simultaneous voices (polyphonic)

### 1.2 Glide Time

Portamento time between notes. Sets how long it takes to slide from one pitch to the next.

- **0%**: Instant pitch changes (no glide)
- **Higher values**: Longer, smoother transitions

Works in both MONO and POLY modes. In polyphonic mode, glide applies chord-to-chord, smoothly transitioning between held
chords.

---

## 2. Unison Section

Stacks multiple detuned voices for a thicker sound.

### 2.1 Unisono

Number of unison voices per note (1-8). Higher values create a fuller, chorus-like effect at the cost of CPU.

### 2.2 Detune

Amount of pitch spread between unison voices in cents. Higher values create a wider, more dramatic detuning effect.

### 2.3 Stereo

Stereo spread of unison voices across the stereo field.

- **0%**: All voices centered (mono)
- **100%**: Maximum stereo width

---

## 3. Oscillator Section

Two independent oscillators (A and B). Select the source using the tabs on the left.

### 3.1 Oscillator A / B

Each oscillator has identical controls:

#### 3.1.1 Waveform

Classic waveform selection:

- **Sine**: Pure fundamental, smooth tone
- **Triangle**: Odd harmonics, softer than square
- **Sawtooth**: All harmonics, bright and rich
- **Square**: Odd harmonics, hollow sound

#### 3.1.2 Octave

Pitch offset in octaves (-3 to +3). Use to layer oscillators at different octaves.

#### 3.1.3 Tune

Fine pitch adjustment in cents (-100 to +100). Useful for slight detuning between oscillators.

#### 3.1.4 Volume

Output level of the oscillator in dB.

---

## 4. Filter Section

Resonant low-pass filter for shaping the harmonic content.

### 4.1 Flt. Cutoff

Filter cutoff frequency in Hz. Frequencies above this point are attenuated.

### 4.2 Flt. Q (Resonance)

Emphasis at the cutoff frequency. Higher values create a sharper, more pronounced peak.

### 4.3 Flt. Env.

Amount of envelope modulation applied to the filter cutoff.

- **Positive values**: Envelope opens the filter
- **Negative values**: Envelope closes the filter
- **0%**: No envelope modulation

### 4.4 Flt. Kbd. (Keyboard Tracking)

How much the filter cutoff follows the played note pitch.

- **0%**: Cutoff stays constant regardless of pitch
- **100%**: Cutoff tracks pitch 1:1 (higher notes = higher cutoff)

### 4.5 Flt. Order

Filter slope/steepness in dB per octave (6, 12, 18, or 24 dB). Higher values create a sharper cutoff.

---

## 5. LFO Section

Low Frequency Oscillator for cyclic modulation.

### 5.1 LFO Shape

Waveform of the LFO:

- **Sine**: Smooth, natural modulation
- **Triangle**: Linear ramps up and down
- **Sawtooth**: Rising ramp with sudden reset
- **Square**: Abrupt on/off switching

### 5.2 Rate

LFO speed in Hz.

### 5.3 Vibrato

Amount of pitch modulation (tune). Creates vibrato effect.

### 5.4 Cutoff

Amount of filter cutoff modulation. Creates wah-like or sweeping effects.

### 5.5 Tremolo

Amount of volume modulation. Creates pulsing/tremolo effect.

---

## 6. Envelope Section (ADSR)

Amplitude envelope controlling the volume shape of each note.

### 6.1 Attack

Time to reach full volume after note-on. Short for percussive sounds, long for swells.

### 6.2 Decay

Time to fall from peak to sustain level.

### 6.3 Sustain

Volume level held while note is pressed (as percentage of peak).

### 6.4 Release

Fade-out time after note-off.

---

## 7. Signal Flow

```
Oscillator A ──┬──> Filter ──> Amplitude Envelope ──> Output
Oscillator B ──┘       ↑              ↑
                       │              │
                  LFO ─┴──────────────┘
                  Envelope ───────────┘
```

The ADSR envelope modulates both the amplitude and optionally the filter cutoff (via Flt. Env.). The LFO can modulate
pitch (Vibrato), filter (Cutoff), and amplitude (Tremolo) simultaneously.
