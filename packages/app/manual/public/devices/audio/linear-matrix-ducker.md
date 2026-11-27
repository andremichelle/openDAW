# Linear Matrix Ducker

A sample-accurate sidechain ducker. The level of the sidechain turns the main signal down: at the threshold, the main signal is silent. Without a sidechain, it is a soft clipper.

---

## 0. Overview

_Linear Matrix Ducker_ is built for mixing a kick against a bass, a vocal against a pad, or any part that must make room for another. Instead of a ratio it uses the sidechain level itself. When the sidechain is at half the threshold, the main signal is at half its level. When the sidechain reaches the threshold, the main signal is silent. When the sidechain is quiet, the main signal passes untouched.

As long as the main signal stays below the threshold, the main signal plus the sidechain never pass the threshold. A chain of these devices, each with the previous part as its sidechain, keeps the whole mix under the threshold.

Without a sidechain, the main signal is clipped at the threshold. Range sets how soft the clipping is.

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

**Attack** (0 to 10 ms) is how far ahead the device reacts. The ducking eases in over this time, slowly at first and faster towards the peak, so it is complete when the peak arrives. At 0 ms the gain changes at the sample of the peak.

**Hold** (0 to 10 ms) keeps the full ducking for this long after the sidechain falls.

**Release** (0 to 1000 ms) is how fast the ducking fades once the hold time is over. The ducking halves every release time. At 0 ms it follows the sidechain instantly.

## 3. Detection

**PEAK** follows every sample.

**ISP** also finds the peaks between the samples, the true peaks a converter reconstructs, by upsampling four times. Use it on the master or before a lossy export.

**RMS** follows the average power with a time constant of about 1 ms. It is calibrated to a sine, so a sine reads the same in RMS and in PEAK. It reacts smoother and lets short peaks through.

## 4. Range, Stereo, Mix

**Range** sets how much of the sidechain level counts. At 100 % the ducking follows the sidechain level exactly. Below 100 %, quieter parts of the sidechain are ignored and only its loud parts duck: at 50 % the ducking starts at half the threshold. At 0 % the main signal is only muted while the sidechain is at the threshold. Above 100 %, quiet sidechain levels already duck strongly, like pushing the sidechain into a soft clipper.

Without a sidechain, Range is the width of the soft knee around the threshold. At 0 % it is a hard clipper.

**Stereo** links the channels. At 0 % both channels get the same gain, so the stereo image stays in place. At 100 % left and right are processed independently.

**Mix** blends the delayed dry signal with the ducked signal.

## 5. Sidechain

Pick the track whose signal makes room. With no sidechain selected, the device clips the main signal on its own.

## 6. Tips

- Put the most important part first, for example the kick. Duck the bass with the kick as its sidechain, then duck the pad with the bass, and so on.
- Set Attack to the length of the transients you want to keep clean. 1 to 5 ms works for drums.
- Range below 100 % keeps the main signal untouched by quiet tails of the sidechain.
