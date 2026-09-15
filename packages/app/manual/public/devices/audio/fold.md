# Fold

A wavefolding distortion effect with oversampling for clean, harmonic-rich saturation.

---

![screenshot](fold.webp)

---

## 0. Overview

_Fold_ applies wavefolding distortion—when the signal exceeds a threshold, it "folds" back instead of clipping. This creates complex harmonic content with a distinctive metallic, bell-like character different from traditional clipping or saturation.

Example uses:

- Harmonic enhancement on synths and bass
- Aggressive metallic distortion
- Sound design and texture creation
- Adding presence to dull sounds
- West Coast synthesis-style timbres

---

## 1. Oversampling

Processing quality selector: **2x**, **4x**, or **8x**.

Oversampling reduces aliasing artifacts caused by the nonlinear wavefolding process:

- **2x**: Light oversampling, lowest CPU usage (default)
- **4x**: Good balance of quality and performance
- **8x**: Highest quality, best for extreme drive settings

Higher oversampling is recommended when using high Drive values, as wavefolding generates many high-frequency harmonics that can alias back into the audible range.

---

## 2. Drive

Input gain before wavefolding. Range: **0 dB to 30 dB**.

Controls how hard the signal is driven into the wavefolder:

- **0-6 dB**: Subtle harmonic enhancement
- **6-15 dB**: Moderate folding, rich harmonics
- **15-30 dB**: Aggressive multi-fold distortion

Higher drive creates more folds per cycle, adding increasingly complex harmonic content. The display shows the resulting transfer curve in real-time.

---

## 3. Volume

Output gain after wavefolding. Range: **-18 dB to 0 dB**.

Compensates for level changes caused by the Drive setting. Use to match the output level to the bypassed signal or to tame excessively loud results.

---

## 4. Visual Display

Shows the wavefolding transfer function—how input amplitude (horizontal) maps to output amplitude (vertical). As Drive increases, the curve develops more folds, visualizing the harmonic complexity being added.

---

## 5. Technical Notes

- Wavefolding formula: signal folds back at ±1.0 boundaries instead of clipping
- Upsample → process → downsample pipeline for alias reduction
- Smooth parameter ramping prevents clicks during automation
- Stereo processing with matched left/right channels
