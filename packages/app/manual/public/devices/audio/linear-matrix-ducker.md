# Linear Matrix Ducker

A sample-accurate ceiling for one signal and its sidechain together. With a sidechain, the main signal is turned down exactly as much as needed so that main signal plus sidechain never pass the threshold. Without a sidechain, it is a limiter or clipper.

---

## 0. Overview

_Linear Matrix Ducker_ is built for mixing a kick against a bass, a vocal against a pad, or any part that must make room for another. Instead of a ratio it uses a ceiling. Every sample, the level of the sidechain is subtracted from the threshold and the main signal is limited to what is left. When the sidechain reaches the threshold, the main signal is silent. When the sidechain is quiet, the main signal passes up to the threshold.

Because the two signals can never add up to more than the threshold, a chain of these devices, each with the previous part as its sidechain, keeps the whole mix under the threshold without a master limiter.

Without a sidechain, the main signal is held at the threshold, a clipper with Attack at 0 ms and a smooth limiter above that.

The device adds 10 ms of latency, the time it looks ahead. openDAW compensates it on all other paths, so the main signal and its sidechain stay aligned.

## 1. Display

The display scrolls from right to left and shows the last second.

- **Grey** is the sidechain, or the input when there is no sidechain.
- **Blue** is the output, the main signal after ducking.
- **White** at the top is the gain reduction. It hangs from the top edge by the number of decibels the signal is turned down.
- The **white line** with the arrow on the left is the threshold. Drag it up or down to change the threshold, or double-click it to type a value.
- With Range below 100 %, a **blue line** shows the lowest sidechain level that still causes ducking.

## 2. Attack, Hold, Release

The values below the display can be dragged, or double-clicked to type a value.

**Attack** (0 to 10 ms) is how far ahead the device reacts. The gain is lowered smoothly over this time, so it is already down when the peak arrives. At 0 ms the gain changes at the sample of the peak, which clips.

**Hold** (0 to 500 ms) keeps the full reduction for this long after the signal falls below the threshold.

**Release** (1 to 2000 ms) is how long the gain takes to return once the hold time is over. Short values are tight and transparent, long values pump.

## 3. Detection

**PEAK** follows every sample, so no sample passes the threshold.

**ISP** also finds the peaks between the samples, the true peaks a converter reconstructs, by upsampling four times. Use it on the master or before a lossy export. The processing itself can still create small inter-sample peaks.

**RMS** follows the average level over 5 ms. It reacts smoother and lets short peaks through.

## 4. Range, Stereo, Mix

**Range** sets how much of the sidechain level counts. At 100 % the full sidechain is subtracted from the threshold. Below 100 %, quieter parts of the sidechain are ignored and only its loud parts duck. Above 100 %, quiet sidechain levels already duck strongly, like pushing the sidechain into a soft clipper.

**Stereo** links the channels. At 0 % both channels get the same gain, so the stereo image stays in place. At 100 % left and right are processed independently.

**Mix** blends the delayed dry signal with the ducked signal. Leave it at 100 % to keep the ceiling.

## 5. Sidechain

Pick the track whose signal makes room. With no sidechain selected, the device limits the main signal on its own.

## 6. Tips

- Put the most important part first, for example the kick. Duck the bass with the kick as its sidechain, then duck the pad with the bass, and so on.
- Set Attack to the length of the transients you want to keep clean. 1 to 5 ms works for drums.
- Range below 100 % keeps the main signal untouched by quiet tails of the sidechain.
