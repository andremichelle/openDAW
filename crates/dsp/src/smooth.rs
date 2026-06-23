//! A one-pole smoother, a port of lib-dsp `Smooth`. Holds the smoothed value; the caller supplies the
//! coefficient (`Smooth::coefficient(time, sample_rate)`), so the smoother needs no construction-time rate
//! and stays valid when zeroed. f64, mirroring the TS `number` math.

/// A one-pole low-pass over a control value. Mirrors lib-dsp `Smooth`.
#[derive(Clone, Copy, Default)]
pub struct Smooth {
    value: f64
}

impl Smooth {
    /// The one-pole coefficient for a smoothing `time` (seconds) at `sample_rate`, mirroring the TS constructor
    /// `1 - exp(-1 / (time * sampleRate))`. The device computes it once per quantum (the rate is constant).
    pub fn coefficient(time: f64, sample_rate: f64) -> f64 {
        1.0 - libm::exp(-1.0 / (time * sample_rate))
    }

    /// Advance the smoothed value toward `x` by `coefficient` and return it. Mirrors `Smooth.process`.
    pub fn process(&mut self, coefficient: f64, x: f64) -> f64 {
        self.value += coefficient * (x - self.value);
        self.value
    }
}

#[cfg(test)]
mod tests {
    use super::Smooth;

    #[test]
    fn step_response_converges_toward_the_target() {
        let coefficient = Smooth::coefficient(0.003, 48_000.0);
        assert!(coefficient > 0.0 && coefficient < 1.0, "a stable one-pole coefficient");
        let mut smooth = Smooth::default();
        let mut last = 0.0;
        for _ in 0..4_000 {
            last = smooth.process(coefficient, 1.0);
        }
        assert!((last - 1.0).abs() < 1.0e-3, "settles at the target");
    }

    #[test]
    fn the_first_step_moves_by_the_coefficient() {
        let mut smooth = Smooth::default();
        let moved = smooth.process(0.25, 1.0);
        assert!((moved - 0.25).abs() < 1.0e-12, "from 0 toward 1 by exactly the coefficient");
    }
}
