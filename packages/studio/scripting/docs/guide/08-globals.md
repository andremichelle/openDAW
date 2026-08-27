---
title: Globals
group: Guide
order: 8
---

# Globals

Scripts have no imports. These names are available everywhere:

| Global                | What it is                                                                                     |
|-----------------------|------------------------------------------------------------------------------------------------|
| `openDAW`             | The {@link Api}, entry point of every script                                  |
| `sampleRate`          | Sample rate of the studio in Hz                                                                 |
| `baseFrequency`       | Tuning reference of the studio in Hz                                                            |
| `PPQN`                | `Bar`, `Quarter`, `SemiQuaver`, `fromSignature()`, `secondsToPulses()`, `pulsesToSeconds()`, `toString()` |
| `AudioData`           | `AudioData.create(sampleRate, numberOfFrames, numberOfChannels)` for {@link Api | addSample} |
| `midiToHz`            | `midiToHz(note, baseFrequency?)`                                                                |
| `dbToGain`, `gainToDb`| Decibel conversions                                                                             |
| `FFT`                 | Fast Fourier transform helper                                                                   |
| `Chord`               | Chord and interval helper                                                                       |
| `Interpolation`       | `Interpolation.None`, `Interpolation.Linear`, `Interpolation.Curve(slope)` for automation and tempo points |
| `ClassicWaveform`     | Oscillator waveforms of Vaporisateur                                                            |
| `VoicingMode`         | `Monophonic`, `Polyphonic`                                                                      |
| `Mixing`              | Panning laws for StereoTool                                                                     |
| `TransientPlayMode`   | `Once`, `Repeat`, `Pingpong` for time-stretched audio regions                                   |
| `AudioSendRouting`    | `Pre`, `Post`                                                                                   |

All interface names of the reference are available as types for annotations, e.g. `const effects:
ReadonlyArray<AnyAudioEffect> = unit.audioEffects`.

The standard library is a subset: `Array`, `Map`, `Set`, `Math`, `JSON`, `Promise`, typed arrays, `setTimeout`.
There is no DOM and no `fetch`.
