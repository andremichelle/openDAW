//! A control-rate low-frequency oscillator, a port of lib-dsp `LFO`. It fills a buffer with one of the four
//! [`ClassicWaveform`] shapes at a given frequency, advancing a persistent phase (wrapped to `0..1`). The
//! sample rate is stored at construction; valid when zeroed (a zero rate just never advances). Shareable by
//! any modulating synth.

use crate::osc::ClassicWaveform;

/// A naive (non-band-limited) LFO over a control value, mirroring lib-dsp `LFO`.
#[derive(Clone, Copy, Default)]
pub struct Lfo {
    sample_rate: f64,
    phase: f64
}

impl Lfo {
    pub fn new(sample_rate: f32) -> Self {
        Self {sample_rate: sample_rate as f64, phase: 0.0}
    }

    /// Fill `buffer[from..to]` with `shape` at `frequency` Hz, advancing the phase. Mirrors `LFO.fill`: the
    /// shape is branched once and each gets its own loop, the phase wrapping by subtracting 1 when it reaches it.
    pub fn fill(&mut self, buffer: &mut [f32], shape: ClassicWaveform, frequency: f32, from: usize, to: usize) {
        // A DIVISION like the TS (`frequency / this.sampleRate`), not a reciprocal multiply: the two can
        // differ by an ulp and the phase drift accumulates over a held note. Zero rate stays inert.
        let phase_inc = if self.sample_rate > 0.0 { frequency as f64 / self.sample_rate } else { 0.0 };
        match shape {
            ClassicWaveform::Sine => {
                // WASM CONTRACT: `fast_sin_tau` mirrors lib-dsp `fastSinTau` (identical arithmetic both engines).
                for sample in &mut buffer[from..to] {
                    *sample = crate::fast_math::fast_sin_tau(self.phase) as f32;
                    self.phase += phase_inc;
                    if self.phase >= 1.0 {self.phase -= 1.0;}
                }
            }
            ClassicWaveform::Triangle => {
                for sample in &mut buffer[from..to] {
                    let phase = self.phase % 1.0;
                    *sample = (4.0 * libm::fabs(phase - 0.5) - 1.0) as f32;
                    self.phase += phase_inc;
                    if self.phase >= 1.0 {self.phase -= 1.0;}
                }
            }
            ClassicWaveform::Saw => {
                for sample in &mut buffer[from..to] {
                    let phase = self.phase % 1.0;
                    *sample = (2.0 * phase - 1.0) as f32;
                    self.phase += phase_inc;
                    if self.phase >= 1.0 {self.phase -= 1.0;}
                }
            }
            ClassicWaveform::Square => {
                for sample in &mut buffer[from..to] {
                    let phase = self.phase % 1.0;
                    *sample = if phase < 0.5 {1.0} else {-1.0};
                    self.phase += phase_inc;
                    if self.phase >= 1.0 {self.phase -= 1.0;}
                }
            }
        }
    }

    pub fn reset(&mut self) {
        self.phase = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::Lfo;
    use crate::osc::ClassicWaveform;

    const SR: f32 = 48_000.0;
    // 1 Hz at 48 kHz: one full period spans 48000 samples, so sample 12000 is a quarter, 24000 a half.
    const FREQ: f32 = 1.0;

    fn bounded(buffer: &[f32]) -> bool {
        buffer.iter().all(|sample| sample.abs() <= 1.0 + 1.0e-6)
    }

    #[test]
    fn sine_starts_at_zero_and_peaks_at_a_quarter() {
        let mut buffer = [0.0f32; 24_001];
        Lfo::new(SR).fill(&mut buffer, ClassicWaveform::Sine, FREQ, 0, 24_001);
        assert!(buffer[0].abs() < 1.0e-6, "sin(0) = 0");
        assert!((buffer[12_000] - 1.0).abs() < 1.0e-3, "quarter period peaks at +1");
        assert!(buffer[24_000].abs() < 1.0e-3, "half period back to 0");
        assert!(bounded(&buffer));
    }

    #[test]
    fn saw_ramps_from_minus_one_to_plus_one() {
        let mut buffer = [0.0f32; 48_000];
        Lfo::new(SR).fill(&mut buffer, ClassicWaveform::Saw, FREQ, 0, 48_000);
        assert!((buffer[0] + 1.0).abs() < 1.0e-3, "starts at -1");
        assert!(buffer[24_000].abs() < 1.0e-3, "crosses zero at the midpoint");
        assert!(buffer[47_999] > 0.99, "approaches +1 at the end");
        assert!(bounded(&buffer));
    }

    #[test]
    fn triangle_peaks_high_at_the_midpoint_and_square_holds_each_half() {
        let mut triangle = [0.0f32; 48_000];
        Lfo::new(SR).fill(&mut triangle, ClassicWaveform::Triangle, FREQ, 0, 48_000);
        assert!((triangle[0] - 1.0).abs() < 1.0e-3, "triangle starts at +1 (4*|0-0.5|-1)");
        assert!((triangle[24_000] + 1.0).abs() < 1.0e-3, "triangle dips to -1 mid-period");
        assert!(bounded(&triangle));
        let mut square = [0.0f32; 48_000];
        Lfo::new(SR).fill(&mut square, ClassicWaveform::Square, FREQ, 0, 48_000);
        assert_eq!(square[0], 1.0, "first half high");
        assert_eq!(square[24_000], -1.0, "second half low");
    }
}
