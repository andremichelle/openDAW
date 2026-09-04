# Crusher

A bit crusher and sample rate reducer for lo-fi and distortion effects.

---

![screenshot](crusher.webp)

---

## 0. Overview

_Crusher_ degrades audio quality by reducing bit depth and sample rate. Creates lo-fi, retro digital, and harsh distortion effects reminiscent of early samplers and video game consoles.

Example uses:

- Lo-fi and retro aesthetics
- Aggressive digital distortion
- 8-bit style sound design
- Drum destruction
- Parallel crush for texture

---

## 1. Crush

Sample rate reduction amount. Range: **0% to 100%**.

- **0%**: No sample rate reduction (full quality)
- **100%**: Maximum reduction (down to 20 Hz effective sample rate)

The effective sample rate scales exponentially from the native rate down to 20 Hz. Higher values create more aliasing and the characteristic "stair-step" waveform of low sample rates.

An anti-aliasing lowpass filter (minimum 1000 Hz cutoff) is applied before downsampling to control the harshness of the aliasing artifacts.

---

## 2. Bits

Bit depth reduction. Range: **1 to 16 bits** (integer).

- **16 bits**: Full quality (65,535 quantization levels)
- **8 bits**: Classic lo-fi (255 levels)
- **4 bits**: Harsh, gritty (15 levels)
- **1 bit**: Extreme square wave distortion (2 levels)

Lower bit depths create audible quantization noise and a "crunchy" character. The effect is most pronounced on quieter signals.

---

## 3. Boost

Pre-gain before crushing. Range: **0 dB to 24 dB**.

Drives the signal harder into the bit crusher, making quantization effects more pronounced. A post-gain of negative half the boost value is applied after processing (e.g., +12 dB boost results in -6 dB post-gain).

Useful for:

- Making bit reduction more audible on quiet signals
- Creating harder clipping at low bit depths
- Adding aggression to the crushed sound

---

## 4. Mix

Dry/wet blend. Range: **0.1% to 100%** (exponential scaling).

- **0.1%**: Nearly all dry signal
- **50%**: Equal blend of clean and crushed
- **100%**: Fully crushed signal

The exponential scaling provides fine control at low mix values, useful for subtle parallel crushing that adds texture without overwhelming the original signal.

---

## 5. Technical Notes

- Sample-and-hold downsampling with phase accumulator
- Quantization formula: `round(sample × (2^bits - 1)) / (2^bits - 1)`
- 20ms parameter smoothing prevents clicks when adjusting Crush
- Lowpass filter in signal path reduces harsh aliasing
- Stereo processing with independent left/right channels
