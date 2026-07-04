# openDAW Werkstatt Presets

Five audio-effect presets for the Werkstatt scriptable device, ready to import into openDAW.

## Presets

| File | Effect | Description |
|------|--------|-------------|
| `Dark_Saturation.opb` | Tape saturation | DC-blocked tanh waveshaper with drive, bias, shelving tone and dry/wet mix |
| `Plate_Reverb.opb` | Plate reverb | Schroeder reverb: 4 comb filters + 2 allpass per channel, M/S width, predelay |
| `Cold_Fold_Distortion.opb` | Wavefold distortion | Mirror wavefolding + bitcrush + sample-rate reduction + slew limiting |
| `Stereo_Phaser.opb` | Stereo phaser | 6-stage allpass phaser with LFO modulation, quadrature L/R for wide image |
| `Stereo_Chorus.opb` | Stereo chorus | Modulated delay chorus, 90° offset L/R LFOs, fractional delay read, feedback |

## How to import

1. Open openDAW
2. Drag and drop a `.opb` file onto the application
3. The preset appears in the preset browser under **Werkstatt** → **User Presets**

## Preset format

Each `.opb` file is a ZIP bundle containing:
- `version` — bundle format version (1)
- `meta.json` — preset metadata (name, description, category, device)
- `preset.odp` — encoded rack binary (OPRE header + box graph)

The binary uses `PresetEncoder.encodeEffects()` with `ChainKind.Audio`.
