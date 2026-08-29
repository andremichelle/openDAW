# Tidal

A tempo-synced tremolo effect with customizable waveshape and stereo phase control.

---

![screenshot](tidal.webp)

---

## 0. Overview

_Tidal_ modulates amplitude in sync with the project tempo. The waveshape can be precisely sculpted using slope and symmetry controls, from smooth sine-like curves to sharp rhythmic gates.

Example uses:

- Classic tremolo effects
- Rhythmic amplitude gating
- Stereo auto-pan (with channel offset)
- Sidechain-style pumping
- Choppy rhythmic textures

---

## 1. Rate

Modulation rate as a tempo-synced fraction. Available values:

| Long | Medium | Short |
|------|--------|-------|
| 1/1 | 1/6 | 1/32 |
| 1/2 | 1/8 | 1/48 |
| 1/3 | 3/32 | 1/64 |
| 1/4 | 1/12 | 1/96 |
| 3/16 | 1/16 | 1/128 |
|  | 3/64 | |
|  | 1/24 | |

---

## 2. Slope

Waveshape curvature. Range: **-100.0% to +100.0%**.

Controls the exponential curve of the modulation wave:

- **Negative values**: Curve bends toward sharp attack, slow release
- **0%**: Linear ramps
- **Positive values**: Curve bends toward slow attack, sharp release

Internally scaled by 10x and applied as an exponent (2^|slope×10|), allowing extreme curve shapes.

---

## 3. Offset

Phase offset from the beat. Range: **-180° to +180°**.

Shifts where in the cycle the modulation begins relative to the transport position. Use to align the tremolo peaks/troughs with specific beats.

---

## 4. Depth

Modulation intensity. Range: **0.0% to 100.0%**.

- **0%**: No modulation (signal passes unchanged)
- **50%**: Moderate tremolo
- **100%**: Full modulation (signal drops to silence at wave troughs)

---

## 5. Symmetry

Rise/fall ratio of the wave. Range: **-100.0% to +100.0%** (internally 0 to 1).

- **-100%**: Very short rise, long fall
- **0%**: Equal rise and fall times
- **+100%**: Long rise, very short fall

Combined with Slope, this shapes everything from smooth sine waves to sharp sawtooth or pulse patterns.

---

## 6. Ch. Offset

Stereo channel phase offset. Range: **-180° to +180°**.

Offsets the right channel's phase relative to the left:

- **0°**: Mono tremolo (both channels identical)
- **180°** or **-180°**: Opposite phase (auto-pan effect)
- **Other values**: Stereo width between channels

---

## 7. Visual Display

Shows the computed modulation waveform based on current Slope, Symmetry, and Depth settings. The vertical line indicates the current playback position within the cycle.

---

## 8. Technical Notes

- Tempo-synced via PPQN (pulses per quarter note) calculation
- 3ms gain smoothing prevents clicks during modulation
- Phase tracks transport position for consistent sync
- Independent left/right channel processing
