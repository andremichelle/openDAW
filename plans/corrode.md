# Corrode: delay-modulation degrader

## Request

A built-in audio effect that degrades the signal by modulating a very short delay with band-passed noise or a sine, from noisy grit to aliasing-like inharmonic tones. The editor is an X-Y display over a log-frequency grid, three modes (Noise, Wide Noise, Sine) and Freq, Width and Amount value fields.

## Behaviour

- The input is read from a short delay whose read position is moved by band-passed noise or a sine.
- Noise and Sine use one modulator for both channels, Wide Noise has independent noise per channel.
- Width is the noise bandwidth in octaves and has no effect in Sine mode.
- X of the X-Y field is Freq, Y is Amount. Alt / Option drag turns Y into Width.
- Ranges: Freq 50 Hz to 18 kHz, Width 0.08 to 10 octaves, Amount 0 to 100. The output is wet only.

## Design

- Schema `CorrodeDeviceBox`: mode (int 0..2, automatable), frequency (exponential 50..18000 Hz), width (exponential 0.08..10 octaves), amount (linear 0..100).
- DSP (`crates/stock-devices/device-corrode`): a 2048-frame ring buffer per channel, read at `base + depth × M[n]` with 4-point Hermite interpolation. `depth = (amount / 100)² × 1 ms`, `base = ceil(1 ms) + 2` frames, reported through `abi::set_latency`, so Amount 0 is a bit-exact delay by the latency. `M` is clamped to ±1.
- Modulators: a sine phase accumulator, and two seeded white noise sources through RBJ constant-peak band-passes with `Q = √2^N / (2^N − 1)` for a width of N octaves. The noise is normalised by its equivalent noise bandwidth to a constant RMS of 0.35. All modulators always run; the mode only moves two smoothed weights (sine vs noise, mono vs wide), so a mode change crossfades instead of jumping the delay.
- Smoothing: one-pole 10 ms on frequency, width, depth and both weights, filter coefficients refreshed every 16 frames. Glides snap to their target below 1e-9 (no denormal tails), the biquad already flushes. No allocation in `process`.
- Editor: a 208px wide body, display 114px, mode row 18px, label controls 32px, 6px gaps (176px). The display has the Tidal frame (8px rounded outline, canvas inset 4px), a hairline log-frequency grid and the analog band-pass magnitude on a 36 dB scale with its peak at the handle, filled with the display gradient. The handle is a filled orange dot, the plot is inset by its radius so it stays whole at the edges. The modes are three framed buttons of one column each, the active one orange. Width is disabled in Sine mode. A press moves the handle to the pointer, a drag is one undo step, Alt-drag changes Width.

## Acceptance

- Rust: Sine mode produces the J0/J1/J2 Bessel sidebands of the expected modulation index; Wide Noise decorrelates the channels while Noise keeps them identical; Amount 0 is an exact delay by the reported latency; all mode/frequency/width/amount extremes at 44.1 and 192 kHz stay finite and bounded, silence stays silent; parameter jumps every block stay finite; parameter routing and mappings.
- Engine (`core-wasm/test/corrode-device.test.ts`): in a real unit chain the tone stays pure at Amount 0 and grows sidebands at full Amount in Sine mode. Mapping parity covers the four parameters.
- Studio: `CorrodeCurve` unit tests; manual check in the browser that the device is in the effects menu, processes audio, the handle drag works and the modes switch.
