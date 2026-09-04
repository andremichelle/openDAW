# Compressor

A dynamic range compressor with auto-adaptive features, lookahead, and sidechain support. Based on the CTAGDRC algorithm.

---

![screenshot](compressor.webp)

---

## 0. Overview

_Compressor_ reduces dynamic range by attenuating signals that exceed a threshold. Features program-dependent attack/release, lookahead for transparent limiting, and external sidechain for ducking effects.

Example uses:

- Controlling dynamic range of vocals or instruments
- Glue compression on buses
- Parallel compression (using Dry/Wet)
- Sidechain ducking for electronic music

---

## 1. Mode Buttons

### 1.1 Auto Makeup

Automatically compensates for gain reduction. Calculates the average attenuation and applies an inverse gain to maintain consistent output levels.

### 1.2 Auto Attack

Program-dependent attack time. Analyzes the signal's crest factor (peak-to-RMS ratio) to adapt attack speed. Transient-heavy material gets faster attack; sustained signals get slower attack.

When enabled, the Attack Time control is bypassed.

### 1.3 Auto Release

Program-dependent release time. Adapts release based on signal dynamics to prevent pumping on sustained material while allowing fast recovery on transients.

When enabled, the Release Time control is bypassed.

### 1.4 Lookahead

Enables 5ms lookahead. The compressor "sees" transients before they arrive, allowing gain reduction to begin early. This enables transparent peak limiting without overshoots.

Introduces 5ms latency. Automatically compensated in the mix.

### 1.5 Sidechain

Routes an external signal to control the compressor. Click to select any track's output as the detection source. When active, compression responds to the sidechain signal rather than the input.

Classic use: Route a kick drum to duck a bass line.

---

## 2. Main Controls

### 2.1 Threshold

Level above which compression begins. Range: -60 dB to 0 dB.

Signals below the threshold pass unaffected. Signals above are compressed according to the ratio.

### 2.2 Ratio

Compression ratio. Range: 1:1 to 24:1 (exponential scaling).

- **1:1**: No compression
- **2:1**: Gentle compression (signal 10 dB over threshold becomes 5 dB over)
- **4:1**: Moderate compression
- **10:1+**: Limiting behavior

### 2.3 Knee

Softens the transition around the threshold. Range: 0 dB to 24 dB.

- **0 dB**: Hard knee, abrupt compression onset
- **Higher values**: Soft knee, gradual transition for more transparent compression

### 2.4 Makeup Gain

Output gain compensation. Range: -40 dB to +40 dB.

Use to restore level lost to compression. With Auto Makeup enabled, this adds to the automatic compensation.

---

## 3. Timing Controls

### 3.1 Attack Time

How quickly compression engages after signal exceeds threshold. Range: 0 ms to 100 ms.

- **Fast (0-5 ms)**: Catches transients, can reduce punch
- **Medium (5-30 ms)**: Lets initial transient through, then compresses
- **Slow (30+ ms)**: Preserves transients, controls sustain

Bypassed when Auto Attack is enabled.

### 3.2 Release Time

How quickly compression releases after signal falls below threshold. Range: 5 ms to 1500 ms.

- **Fast (5-50 ms)**: Quick recovery, can cause pumping
- **Medium (50-200 ms)**: Natural recovery for most material
- **Slow (200+ ms)**: Smooth, sustained compression

Bypassed when Auto Release is enabled.

---

## 4. Input/Output

### 4.1 Input Gain

Gain applied before compression. Range: -30 dB to +30 dB.

Use to drive more signal into the compressor without changing threshold.

### 4.2 Dry/Wet

Parallel compression mix. Range: 0% to 100%.

- **0%**: Fully dry (no compression)
- **100%**: Fully wet (only compressed signal)
- **Intermediate**: Blends compressed and original signal

Parallel compression (50-70% wet) can add density while preserving dynamics.

---

## 5. Visual Display

### 5.1 Compression Curve

Shows the input/output transfer function. The curve illustrates how input levels (horizontal) map to output levels (vertical) based on current threshold, ratio, and knee settings.

The dot indicates current input level position on the curve.

### 5.2 Meters

- **Left meter**: Input level
- **Center meter**: Gain reduction (orange, shows how much compression is applied)
- **Right meter**: Output level
