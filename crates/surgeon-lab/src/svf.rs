//! A trapezoidal (zero delay feedback) state variable filter: low, band and high pass from one state, stable when
//! the cutoff moves every sample (envelopes on a filter). Valid when zeroed.

/// The coefficients for one cutoff and resonance, computed by the caller when they change.
#[derive(Clone, Copy, Default, Debug)]
pub struct SvfCoefficients {
    k: f32,
    a1: f32,
    a2: f32,
    a3: f32
}

impl SvfCoefficients {
    /// `cutoff` in Hz (clamped below Nyquist), `q` above 0 (0.5 is the flattest without a peak, 0.707 Butterworth).
    pub fn new(cutoff: f32, q: f32, sample_rate: f32) -> Self {
        let g = libm::tanf(core::f32::consts::PI * cutoff.clamp(1.0, sample_rate * 0.49) / sample_rate);
        let k = 1.0 / q.max(0.01);
        let a1 = 1.0 / (1.0 + g * (g + k));
        let a2 = g * a1;
        Self {k, a1, a2, a3: g * a2}
    }
}

#[derive(Clone, Copy, Default, Debug)]
pub struct SvfOutput {
    pub low: f32,
    pub band: f32,
    pub high: f32
}

#[derive(Clone, Copy, Default, Debug)]
pub struct Svf {
    ic1: f32,
    ic2: f32
}

impl Svf {
    pub fn reset(&mut self) {
        self.ic1 = 0.0;
        self.ic2 = 0.0;
    }

    #[inline]
    pub fn process(&mut self, input: f32, coefficients: &SvfCoefficients) -> SvfOutput {
        let SvfCoefficients {k, a1, a2, a3} = *coefficients;
        let v3 = input - self.ic2;
        let v1 = a1 * self.ic1 + a2 * v3;
        let v2 = self.ic2 + a2 * self.ic1 + a3 * v3;
        self.ic1 = 2.0 * v1 - self.ic1;
        self.ic2 = 2.0 * v2 - self.ic2;
        SvfOutput {low: v2, band: v1, high: input - k * v1 - v2}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    fn gain_at(frequency: f32, coefficients: &SvfCoefficients, pick: impl Fn(&SvfOutput) -> f32) -> f32 {
        let mut filter = Svf::default();
        let mut peak: f32 = 0.0;
        for index in 0..(RATE as usize) {
            let input = libm::sinf(2.0 * core::f32::consts::PI * frequency * index as f32 / RATE);
            let output = pick(&filter.process(input, coefficients));
            if index > RATE as usize / 2 {peak = peak.max(output.abs());}
        }
        peak
    }

    #[test]
    fn responses_at_the_cutoff_and_far_from_it() {
        let coefficients = SvfCoefficients::new(1000.0, core::f32::consts::FRAC_1_SQRT_2, RATE);
        assert!((gain_at(1000.0, &coefficients, |out| out.low) - core::f32::consts::FRAC_1_SQRT_2).abs() < 0.02);
        assert!((gain_at(1000.0, &coefficients, |out| out.high) - core::f32::consts::FRAC_1_SQRT_2).abs() < 0.02);
        assert!(gain_at(100.0, &coefficients, |out| out.low) > 0.99);
        assert!(gain_at(10_000.0, &coefficients, |out| out.low) < 0.02, "12 dB per octave");
        assert!(gain_at(100.0, &coefficients, |out| out.high) < 0.02);
    }

    #[test]
    fn band_pass_peaks_at_unity_for_any_q() {
        for q in [0.5, 2.0, 10.0] {
            let coefficients = SvfCoefficients::new(2000.0, q, RATE);
            let peak = gain_at(2000.0, &coefficients, |out| out.band * (1.0 / q));
            assert!((peak - 1.0).abs() < 0.02, "q {q}: {peak}");
        }
    }

    #[test]
    fn a_cutoff_sweep_every_sample_stays_bounded() {
        let mut filter = Svf::default();
        for index in 0..96_000 {
            let cutoff = 20.0 + 19_000.0 * (0.5 + 0.5 * libm::sinf(index as f32 * 0.01));
            let coefficients = SvfCoefficients::new(cutoff, 8.0, RATE);
            let output = filter.process(if index % 100 == 0 {1.0} else {0.0}, &coefficients);
            assert!(output.low.is_finite() && output.low.abs() < 50.0);
        }
    }

    #[test]
    fn zeroed_state_is_silent() {
        let mut filter = Svf::default();
        let coefficients = SvfCoefficients::new(500.0, 1.0, RATE);
        assert_eq!(filter.process(0.0, &coefficients).low, 0.0);
    }
}
