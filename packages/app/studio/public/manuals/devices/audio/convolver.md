# Convolver

A zero-latency convolution effect that convolves the signal with any impulse-response sample: real spaces, springs, plates, cabinets or creative textures.

---

![screenshot](convolver.webp)

---

## 0. Overview

_Convolver_ multiplies your signal with the acoustic fingerprint of an impulse response (IR). Drop any sample onto the device and it becomes the room, spring, cabinet or texture your sound plays through. The convolution runs with zero latency, so it works on live input and inside feedback-sensitive routings without any delay compensation.

Any sample can act as an IR, up to 16 seconds at 48 kHz (longer samples are truncated). Mono IRs are applied to both channels, stereo IRs convolve each channel with its own side. Samples at a different sample rate are resampled to the engine rate automatically.

Example uses:

- Realistic rooms, halls and churches from recorded IRs
- Spring and plate reverbs from hardware IRs
- Guitar and bass cabinet simulation
- Turning drum hits, cymbals or vocal snippets into tonal reverb textures
- Reversed IRs for swelling, pre-echo effects

---

## 1. Impulse Response

The circular drop zone holds the IR sample.

- **Drop** a sample from the browser (or a file) onto the zone
- **Click** the zone to browse for a sample
- **Right-click** for further options

The name of the loaded sample appears below the zone. Without a sample the device passes the dry signal only.

Swapping the IR is glitch-free: the new response is prepared in the background and blends in within a few dozen milliseconds, without interrupting the audio.

---

## 2. Main Controls

### 2.1 Pre-Delay

Delays the wet (convolved) signal. Range: 1 ms to 500 ms.

Separates the dry signal from the onset of the response for clarity and depth, exactly like the pre-delay of an algorithmic reverb.

### 2.2 Wet

Level of the convolved signal. Range: -72 dB to 0 dB.

### 2.3 Dry

Level of the original signal. Range: -72 dB to 0 dB.

---

## 3. Options

### 3.1 NRM (Normalize)

Scales the response to unit energy, so the wet level stays comparable when switching between quiet and loud IR samples. Enabled by default. Disable it to use the sample's raw gain, for example when an IR was calibrated deliberately.

### 3.2 REV (Reverse)

Plays the impulse response backwards. The tail turns into a swell that builds up towards the sound, the classic reverse-reverb effect. The reversed response is delayed by the IR length, since the loudest part of most IRs sits at their start.

---

## 4. Technical Notes

**Algorithm**: Zero-latency non-uniform partitioned convolution (Gardner scheme)

- Direct FIR for the first 128 samples: zero latency, no delay compensation needed
- FFT-partitioned tail in three stages (128 / 1024 / 8192 samples), with the large partitions pipelined across their period so the CPU load stays flat, without spikes
- SIMD-accelerated spectral processing; the cost is nearly independent of the IR length (a full 16-second stereo IR costs about 1-2% of the audio budget)
- IRs are transformed in the background, spread over the render quanta: loading or swapping an IR never interrupts playback
