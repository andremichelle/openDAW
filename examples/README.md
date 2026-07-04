# Scriptable Device Examples

Community-contributed DSP scripts for openDAW's scriptable devices:
- [Werkstatt](werkstatt/) — 15 audio effect scripts
- [Apparat](apparat/) — 5 instrument scripts
- [Spielwerk](spielwerk/) — 6 MIDI effect scripts

Each script is a self-contained `Processor` class that runs in the AudioWorklet.
Parameters are declared via `// @param` directives and auto-create UI knobs when compiled.

## Werkstatt (15 scripts)

| File | Effect | Parameters |
|------|--------|------------|
| `werkstatt_darksat.js` | Tape saturation / overdrive | drive, bias, tone, mix, output (dB) |
| `werkstatt_coldfold.js` | Wavefolding + bitcrush | drive, fold, crush, slew, mix |
| `werkstatt_reverb.js` | Schroeder plate reverb | decay, predelay, damping, width, mix |
| `werkstatt_chorus.js` | Stereo chorus (dual LFO) | rate (Hz), depth, center (s), feedback, mix |
| `werkstatt_phaser.js` | Allpass cascade phaser | rate (Hz), depth, feedback, stages (2-8), mix |
| `werkstatt_lookahead.js` | Lookahead compressor | threshold (dB), ratio, attack (s), release (s), knee (dB), makeup (dB), mix |
| `werkstatt_shimmer.js` | Pitch-shift delay | time (s), feedback, pitch (semitones), shimmer, damping, mix |
| `werkstatt_paulstretch.js` | Extreme time-stretch (Paul Nasca algorithm) | stretch, window, mix |
| `werkstatt_envfollower.js` | Envelope follower / sidechain ducking | attack, release, depth, threshold, invert, makeup |
| `werkstatt_adsr_trim.js` | ADSR envelope trim (gates sustained samples) | attack, decay, sustain, release, threshold, mix |
| `werkstatt_granular_stretch.js` | Granular time-stretch with pitch shift | stretch, grain, overlap, pitch, mix |
| `werkstatt_pitch_shift.js` | Real-time pitch shifter (delay-line sweep) | semitones, cents, latency, mix |
| `werkstatt_dcremover.js` | DC offset remover + stereo width tool (#91) | dc_freq (Hz), width, balance, mix |
| `werkstatt_allpass.js` | Allpass filter with invert + cascade (#133) | freq (Hz), stages (1-8), invert, feedback, mix |
| `werkstatt_ringmod_env.js` | Ring modulator with envelope-followed frequency (#277) | freq (Hz), modDepth, modRange, attack, release, threshold, mix, output |

## Apparat (5 scripts)

| File | Instrument | Parameters |
|------|-----------|------------|
| `apparat_darkbass.js` | Mono subtractive bass synth | waveform, cutoff (Hz), resonance, ADSR, subOsc, detune, volume |
| `apparat_subcrusher.js` | Sub-bass with sub-oscillator | waveform, cutoff (Hz), resonance, ADSR, sub, volume |
| `apparat_coldlead.js` | Lead synth with glide | waveform, cutoff (Hz), resonance, ADSR, glide, volume |
| `apparat_ringmod.js` | Ring modulator synth with ADSR | frequency (Hz), waveform, ADSR, adsrAmount, subOsc, volume |
| `apparat_fm.js` | 2-operator FM synth (#138) | carrier (Hz), ratio, mod_depth, waveform, ADSR, volume |

## Spielwerk (6 scripts)

| File | MIDI Effect | Parameters |
|------|------------|------------|
| `spielwerk_arpeggiator.js` | Arpeggiator with swing | rate, octaves, direction, hold, velocity, swing |
| `spielwerk_powerchord.js` | Power chord generator | interval, interval2, velScale, detune |
| `spielwerk_chordmemory.js` | Chord memory (major/minor/7/dim/aug) | chord (0-6), octave, velocity |
| `spielwerk_strum.js` | Strummer with up/down/random direction | speed, direction, spread, velocity |
| `spielwerk_velocity.js` | Velocity scaler with curve and clamp | scale, offset, curve, min_vel, max_vel |
| `spielwerk_mididelay.js` | MIDI delay with feedback + transpose | time, feedback, repeats, transpose, decay |

## Usage

1. Open openDAW
2. Add a scriptable device (Werkstatt/Apparat/Spielwerk) to a track
3. Click the code editor
4. Paste the script contents
5. The `@param` declarations auto-generate knobs — adjust and play

## API Reference

### Werkstatt (audio effect)

```javascript
class Processor {
  constructor() { /* sampleRate on globalThis, init buffers */ }
  process(io, block) {
    // io.src[0], io.src[1] — input (Float32Array)
    // io.out[0], io.out[1] — output (Float32Array)
    // block.s0, block.s1 — sample range
    for (let i = block.s0; i < block.s1; i++) {
      io.out[0][i] = io.src[0][i]
    }
  }
  paramChanged(label, value) { /* optional */ }
}
```

### Apparat (instrument)

```javascript
class Processor {
  constructor() { /* sampleRate on globalThis */ }
  process(output, block) {
    // output[0], output[1] — output channels (Float32Array)
    // block.s0, block.s1 — sample range
    // No input — instrument generates audio
  }
  paramChanged(label, value) {}
}
```

### Spielwerk (MIDI effect)

```javascript
class Processor {
  *process(block, events) {
    // Generator function — yield note events
    // block.from, block.to — ppqn range
    // events — Iterable of incoming MIDI events
    for (const ev of events) {
      if (ev.gate) {
        yield { position: ev.position, duration: ev.duration, pitch: ev.pitch, velocity: ev.velocity }
      }
    }
  }
  paramChanged(label, value) {}
}
```

## @param Format

```text
// @param <name> <default> <min> <max> <type> [unit]
```

Types: `linear`, `exp`, `int`, `bool`.

See `plans/werkstatt.md`, `plans/apparat.md`, `plans/spielwerk.md`, and `plans/custom-mapping.md` for full specifications.

## License

Apache-2.0 (same as openDAW)
