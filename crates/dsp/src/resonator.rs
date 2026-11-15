//! A struck two pole resonator: an impulse makes it ring as a decaying sine, the way a drum body or a bridged T
//! network rings. Built as a rotating phasor, so its pitch can move every sample without the level jumping.
//! Valid when zeroed (silent).

/// Pitch and decay of one resonator, computed by the caller when they change.
#[derive(Clone, Copy, Default, Debug)]
pub struct ResonatorCoefficients {
    cos: f32,
    sin: f32
}

impl ResonatorCoefficients {
    /// `frequency` in Hz, `decay` the time to -60 dB in seconds.
    pub fn new(frequency: f32, decay: f32, sample_rate: f32) -> Self {
        Self::with_radius(Self::radius(decay, sample_rate), frequency, sample_rate)
    }

    /// The per sample decay factor for `decay` seconds to -60 dB, for callers that move only the pitch per sample.
    pub fn radius(decay: f32, sample_rate: f32) -> f32 {
        libm::expf(libm::logf(0.001) / (decay.max(0.0001) * sample_rate))
    }

    pub fn with_radius(radius: f32, frequency: f32, sample_rate: f32) -> Self {
        let omega = 2.0 * core::f32::consts::PI * frequency.clamp(0.0, sample_rate * 0.49) / sample_rate;
        Self {cos: radius * libm::cosf(omega), sin: radius * libm::sinf(omega)}
    }
}

#[derive(Clone, Copy, Default, Debug)]
pub struct Resonator {
    real: f32,
    imaginary: f32
}

impl Resonator {
    pub fn reset(&mut self) {
        self.real = 0.0;
        self.imaginary = 0.0;
    }

    /// A single impulse of `amount`, the ring then starts at the next `process`.
    pub fn strike(&mut self, amount: f32) {self.real += amount;}

    /// Adds `input` as excitation and returns the ring. A single input sample `a` rings as about `a * sin`.
    #[inline]
    pub fn process(&mut self, input: f32, coefficients: &ResonatorCoefficients) -> f32 {
        let ResonatorCoefficients {cos, sin} = *coefficients;
        let real = cos * self.real - sin * self.imaginary + input;
        self.imaginary = sin * self.real + cos * self.imaginary;
        self.real = real;
        self.imaginary
    }

    /// The current ring amplitude, for detecting silence.
    pub fn amplitude(&self) -> f32 {libm::sqrtf(self.real * self.real + self.imaginary * self.imaginary)}
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    #[test]
    fn rings_at_its_frequency_and_decays_by_60_db_in_its_decay_time() {
        let coefficients = ResonatorCoefficients::new(100.0, 0.5, RATE);
        let mut resonator = Resonator::default();
        let mut crossings = 0;
        let mut last = resonator.process(1.0, &coefficients);
        let mut peak: f32 = last.abs();
        for _ in 1..(RATE as usize / 2) {
            let value = resonator.process(0.0, &coefficients);
            if last < 0.0 && value >= 0.0 {crossings += 1;}
            peak = peak.max(value.abs());
            last = value;
        }
        assert!((crossings as i32 - 50).abs() <= 1, "{crossings} periods in 0.5 s");
        let quarter_period_decay = libm::expf(libm::logf(0.001) * 0.0025 / 0.5);
        assert!((peak - quarter_period_decay).abs() < 0.005, "{peak} vs {quarter_period_decay}");
        assert!((resonator.amplitude() - 0.001).abs() < 0.0002, "{}", resonator.amplitude());
    }

    #[test]
    fn a_pitch_sweep_keeps_the_level() {
        let mut resonator = Resonator::default();
        resonator.process(1.0, &ResonatorCoefficients::new(130.0, 1000.0, RATE));
        for index in 0..4800 {
            let frequency = 50.0 + 80.0 * libm::expf(-(index as f32) / 300.0);
            resonator.process(0.0, &ResonatorCoefficients::new(frequency, 1000.0, RATE));
        }
        assert!((resonator.amplitude() - 1.0).abs() < 0.01, "{}", resonator.amplitude());
    }

    #[test]
    fn zeroed_is_silent() {
        let coefficients = ResonatorCoefficients::new(200.0, 0.2, RATE);
        assert_eq!(Resonator::default().process(0.0, &coefficients), 0.0);
    }
}
