# Werkstatt DSP Examples

Community-contributed DSP scripts for the [Werkstatt](../plans/werkstatt.md) audio effect device.

Each script is a self-contained `Processor` class that runs in the AudioWorklet.
Parameters are declared via `// @param` directives and auto-create UI knobs when compiled.

## Scripts

| File | Effect | Parameters |
|------|--------|------------|
| `werkstatt_darksat.js` | Tape saturation / overdrive | drive, bias, tone, mix, output (dB) |
| `werkstatt_coldfold.js` | Wavefolding + bitcrush | drive, fold, crush, slew, mix |
| `werkstatt_reverb.js` | Schroeder plate reverb | decay, predelay, damping, width, mix |
| `werkstatt_chorus.js` | Stereo chorus (dual LFO) | rate (Hz), depth, center (s), feedback, mix |
| `werkstatt_phaser.js` | Allpass cascade phaser | rate (Hz), depth, feedback, stages (2-8), mix |
| `werkstatt_lookahead.js` | Lookahead compressor | threshold (dB), ratio, attack (s), release (s), knee (dB), makeup (dB), mix |
| `werkstatt_shimmer.js` | Pitch-shift delay | time (s), feedback, pitch (semitones), shimmer, damping, mix |

## Usage

1. Open openDAW
2. Add a **Werkstatt** audio effect to a track
3. Click the code editor
4. Paste the script contents
5. The `@param` declarations auto-generate knobs — adjust and play

## API

```javascript
class Processor {
  constructor() {
    // sampleRate is available on globalThis
    // allocate buffers, initialize state here
  }

  process(io, block) {
    // io.src[0], io.src[1] — input channels (Float32Array)
    // io.out[0], io.out[1] — output channels (Float32Array)
    // block.s0, block.s1 — sample range to process
    for (let i = block.s0; i < block.s1; i++) {
      io.out[0][i] = io.src[0][i]  // pass-through
      io.out[1][i] = io.src[1][i]
    }
  }

  paramChanged(label, value) {
    // Optional: called when a @param knob changes
    // Store the value for use in process()
  }
}
```

## @param Format

```
// @param <name> <default> <min> <max> <type> [unit]
```

Types: `linear`, `exp`, `int`, `bool`, or omit for `unipolar` (0–1).

See `plans/werkstatt.md` and `plans/custom-mapping.md` for the full specification.

## License

Apache-2.0 (same as openDAW)
