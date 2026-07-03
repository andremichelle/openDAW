//! A band-limited oscillator, a port of lib-dsp `osc.ts`. Naive sine, and PolyBLEP-corrected saw / square /
//! triangle (the triangle integrates the band-limited square with a leaky integrator). f64 phase (like the TS
//! `number`) for precision over long notes; f32 output samples. Generic, shareable by any synth voice.

use core::f64::consts::TAU;

/// The four classic oscillator shapes, mirroring lib-dsp `ClassicWaveform` (sine = 0, triangle = 1, saw = 2,
/// square = 3 — the order a synth's waveform parameter indexes).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ClassicWaveform {
    Sine,
    Triangle,
    Saw,
    Square
}

impl ClassicWaveform {
    /// The waveform at `index` (0 = sine, 1 = triangle, 2 = saw, 3 = square); anything else is sine.
    pub fn from_index(index: i32) -> Self {
        match index {
            1 => ClassicWaveform::Triangle,
            2 => ClassicWaveform::Saw,
            3 => ClassicWaveform::Square,
            _ => ClassicWaveform::Sine
        }
    }
}

/// A band-limited oscillator with a persistent phase (and a leaky integrator for the triangle). Mirrors
/// lib-dsp `BandLimitedOscillator`.
#[derive(Clone, Copy, Default)]
pub struct BandLimitedOscillator {
    inv_sample_rate: f64,
    phase: f64,
    integrator: f64
}

impl BandLimitedOscillator {
    pub fn new(sample_rate: f32) -> Self {
        Self {inv_sample_rate: 1.0 / sample_rate as f64, phase: 0.0, integrator: 0.0}
    }

    /// Fill `output[from..to]` at a constant `frequency`.
    pub fn generate(&mut self, output: &mut [f32], frequency: f32, waveform: ClassicWaveform, from: usize, to: usize) {
        let inc = frequency as f64 * self.inv_sample_rate;
        self.run(output, waveform, from, to, |_| inc);
    }

    /// Fill `output[from..to]` with a per-sample `frequencies[i]` (FM / glide / vibrato).
    pub fn generate_from_frequencies(&mut self, output: &mut [f32], frequencies: &[f32], waveform: ClassicWaveform, from: usize, to: usize) {
        let inv_sample_rate = self.inv_sample_rate;
        self.run(output, waveform, from, to, |index| frequencies[index] as f64 * inv_sample_rate);
    }

    // The waveform is loop-invariant, so it is branched on ONCE and each shape gets its own tight loop (rather
    // than a per-sample match) — clean for the optimiser / a future SIMD target. `inc_at` is monomorphised, so
    // the constant-frequency and per-sample-frequency callers each specialise these loops independently.
    fn run(&mut self, output: &mut [f32], waveform: ClassicWaveform, from: usize, to: usize, inc_at: impl Fn(usize) -> f64) {
        let mut phase = self.phase;
        match waveform {
            ClassicWaveform::Sine => {
                // WASM CONTRACT: `fast_sin_tau` mirrors lib-dsp `fastSinTau` (identical arithmetic both engines).
                for index in from..to {
                    output[index] = crate::fast_math::fast_sin_tau(phase) as f32;
                    phase += inc_at(index);
                }
            }
            ClassicWaveform::Saw => {
                for index in from..to {
                    let inc = inc_at(index);
                    let t = phase % 1.0;
                    output[index] = (2.0 * t - 1.0 - poly_blep(t, inc)) as f32;
                    phase += inc;
                }
            }
            ClassicWaveform::Square => {
                for index in from..to {
                    let inc = inc_at(index);
                    output[index] = square(phase % 1.0, inc) as f32;
                    phase += inc;
                }
            }
            ClassicWaveform::Triangle => {
                let mut integrator = self.integrator;
                for index in from..to {
                    let inc = inc_at(index);
                    integrator = integrator * 0.9995 + square(phase % 1.0, inc) * (4.0 * inc);
                    output[index] = integrator as f32;
                    phase += inc;
                }
                self.integrator = integrator;
            }
        }
        self.phase = phase;
    }
}

/// A band-limited square: the naive ±1 pulse minus the PolyBLEP correction at each of its two discontinuities.
fn square(t: f64, dt: f64) -> f64 {
    let naive = if t < 0.5 {1.0} else {-1.0};
    naive + poly_blep(t, dt) - poly_blep((t + 0.5) % 1.0, dt)
}

/// The PolyBLEP residual that smooths a step discontinuity at the phase wrap (a port of the TS `polyBLEP`).
fn poly_blep(t: f64, dt: f64) -> f64 {
    if t < dt {
        let t = t / dt;
        t + t - t * t - 1.0
    } else if t > 1.0 - dt {
        let t = (t - 1.0) / dt;
        t * t + t + t + 1.0
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::{BandLimitedOscillator, ClassicWaveform};

    const SR: f32 = 48_000.0;
    // 1000 Hz at 48 kHz is exactly 48 samples per period, so sample 12 is a quarter period, 24 a half.
    const FREQ: f32 = 1_000.0;

    fn osc() -> BandLimitedOscillator {
        BandLimitedOscillator::new(SR)
    }

    fn bounded(buffer: &[f32], limit: f32) -> bool {
        buffer.iter().all(|sample| sample.abs() <= limit)
    }

    #[test]
    fn sine_is_a_clean_cycle() {
        let mut buffer = [0.0f32; 48];
        osc().generate(&mut buffer, FREQ, ClassicWaveform::Sine, 0, 48);
        assert!(buffer[0].abs() < 1.0e-6, "sin(0) = 0");
        assert!((buffer[12] - 1.0).abs() < 1.0e-3, "quarter period peaks at +1");
        assert!(buffer[24].abs() < 1.0e-3, "half period returns to 0");
        assert!(bounded(&buffer, 1.0 + 1.0e-6));
    }

    #[test]
    fn saw_ramps_through_zero_at_the_midpoint() {
        let mut buffer = [0.0f32; 48];
        osc().generate(&mut buffer, FREQ, ClassicWaveform::Saw, 0, 48);
        assert!(buffer[24].abs() < 0.05, "the ramp crosses zero mid-period");
        assert!(buffer[24] > buffer[6], "it rises across the period");
        assert!(bounded(&buffer, 1.2));
    }

    #[test]
    fn square_holds_each_half() {
        let mut buffer = [0.0f32; 48];
        osc().generate(&mut buffer, FREQ, ClassicWaveform::Square, 0, 48);
        assert!(buffer[6] > 0.9, "first half is high");
        assert!(buffer[30] < -0.9, "second half is low");
        assert!(bounded(&buffer, 1.5)); // BLEP overshoots slightly at the edges
    }

    #[test]
    fn triangle_stays_bounded_and_moves() {
        // The leaky integrator of a band-limited square ramps to roughly +/-2 (the 4*inc scale), not +/-1.
        let mut buffer = [0.0f32; 96];
        osc().generate(&mut buffer, FREQ, ClassicWaveform::Triangle, 0, 96);
        assert!(bounded(&buffer, 3.0), "stays finite, does not run away");
        let min = buffer.iter().cloned().fold(f32::INFINITY, f32::min);
        let max = buffer.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        assert!(max - min > 0.5, "it actually oscillates");
    }

    #[test]
    fn per_sample_frequencies_match_a_constant() {
        let mut from_const = [0.0f32; 48];
        let mut from_buffer = [0.0f32; 48];
        let frequencies = [FREQ; 48];
        osc().generate(&mut from_const, FREQ, ClassicWaveform::Saw, 0, 48);
        osc().generate_from_frequencies(&mut from_buffer, &frequencies, ClassicWaveform::Saw, 0, 48);
        assert_eq!(from_const, from_buffer, "a constant frequency buffer equals the constant-frequency path");
    }

    #[test]
    fn from_index_maps_the_waveform_order() {
        assert_eq!(ClassicWaveform::from_index(0), ClassicWaveform::Sine);
        assert_eq!(ClassicWaveform::from_index(1), ClassicWaveform::Triangle);
        assert_eq!(ClassicWaveform::from_index(2), ClassicWaveform::Saw);
        assert_eq!(ClassicWaveform::from_index(3), ClassicWaveform::Square);
    }
}
