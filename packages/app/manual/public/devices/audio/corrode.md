# Corrode

Degrades the signal by modulating a very short delay with band-passed noise or a sine wave. The result ranges from noisy, gritty artifacts to aliasing and downsampling-like distortion.

---

## 0. Overview

_Corrode_ reads the input from a short delay line whose read position moves at audio rate. A moving read position shifts the phase of everything that passes through, so the modulator becomes part of the sound: a sine adds metallic sidebands, band-passed noise adds hiss and crackle that follow the input.

The output is the modulated signal only, there is no dry signal mixed in. At **Amount** 0 the input passes unchanged.

Example uses:

- Digital grit and lo-fi texture on drums and synths
- Aliasing-like inharmonic tones with the sine modulator
- A subtle stereo spread with Wide Noise

---

## 1. Display

The display is an X-Y field. Drag the circle to change **Freq** (horizontal, 50 Hz to 18 kHz on a logarithmic scale) and **Amount** (vertical). A click moves the circle to the pointer.

In the noise modes the display draws the response of the noise band-pass filter, which gets wider with **Width**. Hold **Alt** (Windows) / **Option** (Mac) while dragging, and the vertical axis changes **Width** instead of **Amount**.

In Sine mode no curve is drawn and the circle is filled.

## 2. Mode

- **Noise**: one white noise source goes through a band-pass filter. The same modulation moves both channels.
- **Wide Noise**: each channel has its own noise source and filter, so the left and right modulation are independent. This adds a subtle stereo widening.
- **Sine**: a sine oscillator at **Freq** is the modulator, the same for both channels.

## 3. Freq

The sine frequency, or the centre of the noise band. Range: **50 Hz to 18 kHz**. It sets the colour of the distortion.

## 4. Width

The bandwidth of the noise filter in octaves. Range: **0.08 to 10**. Low values give a focused, pitched distortion, high values spread it over the whole spectrum. Width has no effect in Sine mode and is greyed out there.

## 5. Amount

The modulation depth. Range: **0 to 100**. The delay excursion rises with the square of Amount, up to ±1 ms at 100, so low values stay subtle.

---

## 6. Technical Notes

- The read position is `base + depth × modulation`, with the modulation limited to ±1 and a 4-point Hermite interpolation.
- The base delay is just over 1 ms. It is reported as latency, so delay compensation keeps the device aligned with other tracks.
- The noise is normalised to a constant level, so changing Width or Freq does not change the depth.
- Freq, Width, Amount and Mode changes are smoothed over 10 ms, so switching modes does not click.
