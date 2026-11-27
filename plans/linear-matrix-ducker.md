# Linear Matrix Ducker

A built-in audio effect that behaves like Kilohearts Compactor: a sidechain ducker whose gain follows the sidechain
level sample by sample ("ring-mod sidechaining"), and a soft clipper without a sidechain.

## Reference

The behaviour is measured, not taken from the documentation. Compactor (Kilohearts Essentials, AU) was hosted by a
small AudioToolbox program that feeds the main input and the sidechain bus (input element 1) and sets the parameters.
The sidechain only takes effect with the plugin state `sidechain: {id: "external"}`, which the host loads as class
info. Test signals (DC steps, impulses, ramps, sines, kicks, noise) were rendered through Compactor and through the
Rust ducker, and compared sample by sample.

Parameter ranges read from the plugin:

| Parameter | Range                     | Default |
|-----------|---------------------------|---------|
| Threshold | -60 to +6 dB              | 0 dB    |
| Range     | 0 to 200 %                | 100 %   |
| Attack    | 0 to 10 ms                | 5 ms    |
| Hold      | 0 to 10 ms                | 0 ms    |
| Release   | 0 to 1000 ms              | 5 ms    |
| Stereo    | 0 to 100 %                | 0 %     |
| Mix       | 0 to 100 %                | 100 %   |

Compactor maps Release as `10 * (101^x - 1)` ms. openDAW has no such mapping, the adapter uses `powerByCenter(90.5,
0, 1000)`, which agrees at 0, 90.5 and 1000 ms. Only the knob feel differs, the value in ms means the same.

Latency is `round(10 ms * sr) + 9` frames in every mode (489 at 48 kHz, 450 at 44.1 kHz).

## Measured model (`crates/stock-devices/device-linear-matrix-ducker`)

Detection per channel: PEAK `|x|`, ISP the maximum of a 4x oversampled signal within half a sample (18-tap
Hann-windowed sinc, 9 frames delay), RMS `sqrt(2 * ms)` with a one-pole mean square of time constant 1.04685 ms.
The stereo link is the maximum of both channels (RMS: the mean power), `Stereo` blends each channel between the linked
and its own level.

With a sidechain the carrier level does not matter. The level is normalised `u = min(level / T, 1)`. Below 100 % Range
the floor is removed first, `u = (u - (1 - r)) / r`. The envelope runs on `u` and the gain is `1 - e`. Above 100 %
the gain is a soft knee of `v = 1 - e` with `q = r - 1`: `(v - q / 2) / (1 - q / 2)` for `v >= q`, else
`v^2 / (2 q (1 - q / 2))`.

Without a sidechain the envelope runs on the carrier level and the gain is `soft(e) / e`, a quadratic soft knee of half
width `T * r / 2` around the threshold.

The envelope, per output frame `n`, attack `A`, hold `H`, release coefficient `c = 2^(-1 / release)`:

1. A level that enters the lookahead window (`j = n + A`) gets the base `c * e(n - 1)`.
2. Each level above its base ramps in quadratically: `base + (level - base) * (1 - (j - n) / A)^2`.
3. `M` is the maximum level in `[n - H, n + A]`. The envelope above `M` releases towards it, `M + (e - M) * c`. It
   never falls while a higher level is ahead.
4. The envelope is the maximum of the release, the ramps and the levels in `[n - H, n]`.

Only levels above their base are kept as ramp candidates, so the loop is short except on rising ramps.

Not reproduced: Compactor starts some releases up to 4 frames late (depending on the attack setting), and scales the
sidechain level by 1.00055.

## Accuracy

80 comparisons (kick into pad, noise into noise, clipper; every parameter and mode; 44.1, 48 and 96 kHz): median maximum
sample error 0.0003, 90th percentile 0.006. The largest errors are the extreme of 10 ms attack with 5 ms release (up
to 0.027) and ISP on white noise (up to 0.017).

## UI

The screen keeps the Compactor layout: the scrolling display (-60 to +6 dB) with the draggable threshold line and arrow
handle (double-click types a value), Attack, Hold and Release as draggable values, and the PEAK/ISP/RMS radio group.
To fit the 176 px body, Range, Stereo, Mix and the sidechain selector sit in a column beside the screen.

## Verification

- `cargo test -p device-linear-matrix-ducker`: the values measured on Compactor (gain law, range curves, soft knee,
  attack ramp and its base, release half-life and its target, hold, the envelope between two peaks, RMS calibration
  and stereo link, stereo blend, mix, ISP), the ceilings, latency per sample rate, the display.
- `test/linear-matrix-ducker.test.ts` (full engine): delay compensation aligns a parallel dry track by 489 frames, the
  clipper, the master sum of carrier and sidechain stays at or below 0 dBFS, a quiet carrier is ducked by the
  sidechain. The parameter mapping parity test covers the device.
- Browser: the device is listed under Dynamics and in Spotlight, the screen animates with and without a sidechain,
  dragging and typing the threshold work, PEAK/ISP/RMS switch, the status bar shows the PDC.
