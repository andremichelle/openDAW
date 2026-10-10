pub struct Yin<const LAGS: usize> {
    difference: [f64; LAGS],
    lag: usize,
    index: usize,
    accumulated: f64,
    running: f64,
}

impl<const LAGS: usize> Yin<LAGS> {
    /// Starts a new fixed-storage analysis without allocating.
    pub fn reset(&mut self) {
        self.difference[0] = 1.0;
        self.lag = 1;
        self.index = 0;
        self.accumulated = 0.0;
        self.running = 0.0;
    }

    /// Evaluates at most `budget` sample pairs; returns the number evaluated.
    pub fn advance(
        &mut self,
        samples: &[f32],
        window: usize,
        max_lag: usize,
        budget: usize,
    ) -> usize {
        let mut work = 0;
        while work < budget && self.lag <= max_lag {
            let delta = samples[self.index] as f64 - samples[self.index + self.lag] as f64;
            self.accumulated += delta * delta;
            self.index += 1;
            work += 1;
            if self.index == window {
                self.running += self.accumulated;
                self.difference[self.lag] = if self.running > 0.0 {
                    self.accumulated * self.lag as f64 / self.running
                } else {
                    1.0
                };
                self.lag += 1;
                self.index = 0;
                self.accumulated = 0.0;
            }
        }
        work
    }

    /// Reports whether every requested lag has been normalized.
    pub fn complete(&self, max_lag: usize) -> bool {
        self.lag > max_lag
    }

    /// Selects the first local dip, or the global minimum when no dip passes the threshold.
    pub fn estimate(&self, min: usize, max: usize, threshold: f64) -> (f64, f64) {
        let mut best = 0;
        for lag in min..=max {
            if self.difference[lag] < threshold
                && self.difference[lag] <= self.difference[lag - 1]
                && self.difference[lag] <= self.difference[lag + 1]
            {
                best = lag;
                break;
            }
        }
        if best == 0 {
            let mut minimum = f64::INFINITY;
            for lag in min..=max {
                if self.difference[lag] < minimum {
                    minimum = self.difference[lag];
                    best = lag;
                }
            }
        }
        let clarity = self.difference[best];
        let below = self.difference[best - 1];
        let above = self.difference[best + 1];
        let denominator = below - 2.0 * clarity + above;
        let offset = if libm::fabs(denominator) > 1.0e-12 {
            math::clamp(0.5 * (below - above) / denominator, -0.5, 0.5)
        } else {
            0.0
        };
        (best as f64 + offset, clarity)
    }
}

#[cfg(test)]
mod tests {
    use super::Yin;

    #[test]
    fn chunked_analysis_is_identical_and_respects_its_budget() {
        let samples: [f32; 128] = core::array::from_fn(|index| (index as f32 * 0.4).sin());
        let mut full: Yin<65> = unsafe { core::mem::zeroed() };
        let mut chunked: Yin<65> = unsafe { core::mem::zeroed() };
        full.reset();
        chunked.reset();
        assert_eq!(full.advance(&samples, 64, 64, usize::MAX), 4096);
        let mut work = 0;
        while !chunked.complete(64) {
            let used = chunked.advance(&samples, 64, 64, 19);
            assert!(used <= 19);
            work += used;
        }
        assert_eq!(work, 4096);
        assert_eq!(full.difference, chunked.difference);
        assert_eq!(full.estimate(2, 63, 0.15), chunked.estimate(2, 63, 0.15));
    }
}
