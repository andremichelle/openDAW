# Maximizer

A brickwall limiter with automatic makeup gain for loudness maximization.

---

![screenshot](maximizer.webp)

---

## 0. Overview

_Maximizer_ is a peak limiter that prevents audio from exceeding 0 dB (with lookahead enabled). It applies gain reduction when peaks exceed the threshold, then automatically boosts the output to reach the ceiling.

---

## 1. Thoughts on Loudness

From the 1990s to 2010s, the music industry waged a "loudness war" — crushing dynamics to make records louder. This ended when streaming platforms introduced loudness normalization (around **-14 LUFS**). Over-compressed tracks now get turned _down_, revealing their damaged dynamics.

Use Maximizer for **peak control**, not loudness wars. If you're seeing more than 6 dB of constant reduction, fix your mix first.

---

## 2. Threshold

Level above which limiting begins. Range: **-24 dB to 0 dB**.

Lower threshold = more limiting = louder output. Maximizer automatically applies makeup gain to bring the output up to the ceiling.

---

## 3. Lookahead

Enables 5ms lookahead for the envelope detector.

- **Enabled** (default): Gain reduction begins before peaks arrive. No overshoots. Introduces 5ms latency (automatically compensated).
- **Disabled**: Zero latency. Fast transients may briefly exceed the ceiling.

---

## 4. Meters

- **Left pair**: Input level (peak and RMS)
- **Center bar**: Gain reduction (**0 dB to -24 dB**)
- **Right pair**: Output level (peak and RMS)

---

## 5. Preparing Your Mix

For Maximizer to be effective, your mix needs headroom before the limiter.

- **-6 dB peaks**: Good headroom for moderate limiting
- **-3 dB peaks**: Minimal headroom, aggressive limiting required
- **0 dB peaks**: No headroom, limiter cannot help

---

## 6. Technical Notes

- Attack time: 5ms linear ramp (matches lookahead)
- Release time: 200ms exponential decay
