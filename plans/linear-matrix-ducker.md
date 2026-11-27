# Linear Matrix Ducker

A built-in audio effect with the feature set of Kilohearts Compactor: a sample-accurate ceiling for a signal and its
sidechain together ("ring-mod sidechaining"), a clipper/limiter without a sidechain.

## Reference

Behaviour taken from the Compactor product page, the Snapins manual section, "Introducing Kilohearts Compactor" and
"Compact mixing with Kilohearts Compactor":

- Threshold: "when sidechain level reaches the threshold the input will be silenced", without a sidechain the input is
  limited to the threshold ("acts like a conventional clipper").
- Attack is lookahead ("how far ahead the audio is ducked"), each instance adds 10 ms of latency.
- Hold keeps the full ducking after the input falls below the threshold, Release returns to full volume afterwards.
- PEAK follows per-sample peaks, ISP inter-sample peaks, RMS the average power.
- Range: below 100 % ignores quieter sidechain levels (a blue line shows the floor), above 100 % quiet levels duck
  harder, "like pushing the sidechain signal into a soft clipper".
- Stereo: 0 % processes both channels the same, 100 % independently. Mix blends dry and processed.
- Display: grey sidechain, blue ducked output, white ducking amount, white threshold line.

Not documented by Kilohearts and decided here: parameter ranges, the RMS window (5 ms), the oversampling filter
(4x polyphase, 12 taps per phase, Hann-windowed sinc), and the Range curves.

## DSP (`crates/stock-devices/device-linear-matrix-ducker`)

Per sample and channel, the target gain is `min(1, allowed / carrier)` with
`allowed = threshold * (1 - shape(sidechain / threshold, range))`. `shape` is the identity at 100 %, subtracts a floor
of `1 - range` below it and is `1 - (1 - x)^range` above it. Stereo blends between the linked target (computed from the
channel maxima, never above either channel) and the per-channel target.

The target runs through a gain path that keeps the guarantee `|out(n)| + |sidechain(n - latency)| <= threshold` for
Range 100 % in PEAK mode:

1. a sliding minimum over `attack + 1` samples (monotonic queue),
2. hold counter, then an exponential release towards the minimum (the envelope never rises above the minimum),
3. a moving average over `attack + 1` samples, which ramps the gain down across the lookahead window.

Every value averaged in step 3 covers the delayed sample, so the average stays at or below its target. The carrier
is delayed by a fixed `10 ms + 6` frames (the ISP filter delay), so the reported latency never changes when Attack or
the mode changes. A change of either rebuilds the window from the stored target history and lowers the past averaged
values to the new window minimum, so the ceiling also holds while Attack is automated. Mix blends the delayed dry
signal. All buffers are fixed arrays sized for 192 kHz, nothing allocates in the process loop.

Telemetry at `address.append(0)`: a counter plus a ring of 64 entries `[dry peak, output peak, sidechain level,
minimum gain]`, one per 5 ms. The editor appends the entries it has not seen yet, so the display does not depend on
the frame rate.

## UI

The screen keeps the Compactor layout: the scrolling display with the draggable threshold line and arrow handle
(double-click types a value), Attack, Hold and Release as draggable values, and the PEAK/ISP/RMS radio group. To fit
the 176 px body, Range, Stereo, Mix and the sidechain selector sit in a column beside the screen.

## Verification

- `cargo test -p device-linear-matrix-ducker`: the carrier plus sidechain ceiling over attack, hold, release and stereo
  combinations, the ceiling while Attack changes every block, clipper behaviour, the attack ramp, hold and release
  timing, latency alignment of the dry and wet paths, ISP and RMS detection, Range and Stereo, the reported latency.
- `test/linear-matrix-ducker.test.ts` (full engine): delay compensation aligns a parallel dry track by 486 frames, the
  carrier stays under the threshold, and the master sum of a 0.8 carrier and a 0.4 sidechain stays at or below 0 dBFS
  (1.2 without the device). The parameter mapping parity test covers the device.
- Browser: the device is listed under Dynamics and in Spotlight, the screen animates with and without a sidechain,
  dragging the threshold line sets the value (-23 dB for the dragged distance), typing works, PEAK/ISP/RMS switch, and
  the status bar shows a PDC of 10.1 ms for one instance.
