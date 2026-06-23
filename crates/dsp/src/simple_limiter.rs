//! A look-ahead-free stereo peak limiter, a port of lib-dsp `SimpleLimiter`. A fast-attack / slow-release
//! envelope follows the louder channel; when it exceeds 1.0 the frame is scaled by `1/env`, so the output
//! never clips. f64 envelope (TS `number`); f32 buffers. `prepare(sample_rate)` computes the coefficients,
//! so the limiter is valid when zeroed (the device calls `prepare` at init).

const ATTACK_SECONDS: f64 = 0.003;
const RELEASE_SECONDS: f64 = 0.020;

/// A peak limiter over a stereo pair. Mirrors lib-dsp `SimpleLimiter`.
#[derive(Clone, Copy, Default)]
pub struct SimpleLimiter {
    attack: f64,
    release: f64,
    envelope: f64
}

impl SimpleLimiter {
    pub fn new(sample_rate: f32) -> Self {
        let mut limiter = Self::default();
        limiter.prepare(sample_rate);
        limiter
    }

    /// Compute the attack / release coefficients for `sample_rate` (the TS constructor's `0.01^(1/(t*sr))`).
    /// Called once at the device's `init`, since a zeroed limiter has zero coefficients.
    pub fn prepare(&mut self, sample_rate: f32) {
        self.attack = libm::pow(0.01, 1.0 / (ATTACK_SECONDS * sample_rate as f64));
        self.release = libm::pow(0.01, 1.0 / (RELEASE_SECONDS * sample_rate as f64));
    }

    pub fn clear(&mut self) {
        self.envelope = 0.0;
    }

    /// Limit `left[from..to]` / `right[from..to]` in place. Mirrors `SimpleLimiter.replace`.
    pub fn replace(&mut self, left: &mut [f32], right: &mut [f32], from: usize, to: usize) {
        let mut envelope = self.envelope;
        for index in from..to {
            let sample_left = left[index] as f64;
            let sample_right = right[index] as f64;
            let peak = sample_left.abs().max(sample_right.abs());
            envelope = if peak > envelope {
                self.attack * (envelope - peak) + peak
            } else {
                self.release * (envelope - peak) + peak
            };
            if envelope > 1.0 {
                let gain = 1.0 / envelope;
                left[index] = (sample_left * gain) as f32;
                right[index] = (sample_right * gain) as f32;
            }
        }
        self.envelope = envelope;
    }
}

#[cfg(test)]
mod tests {
    use super::SimpleLimiter;

    const SR: f32 = 48_000.0;

    #[test]
    fn coefficients_are_stable_one_poles() {
        let limiter = SimpleLimiter::new(SR);
        // 0.01^(1/(t*sr)) is in (0, 1); a longer release is closer to 1 (slower) than the attack.
        assert!(limiter.attack > 0.0 && limiter.attack < 1.0);
        assert!(limiter.release > limiter.attack, "release is slower than attack");
    }

    #[test]
    fn it_pulls_loud_peaks_down_to_unity() {
        let mut limiter = SimpleLimiter::new(SR);
        let (mut left, mut right) = ([4.0f32; 4096], [4.0f32; 4096]); // +12 dB over full scale
        limiter.replace(&mut left, &mut right, 0, 4096);
        let tail = left[4095].abs();
        assert!(tail <= 1.01, "the sustained peak is brought to about unity");
        assert!(tail > 0.5, "it does not over-attenuate");
    }

    #[test]
    fn quiet_signals_pass_untouched() {
        let mut limiter = SimpleLimiter::new(SR);
        let (mut left, mut right) = ([0.3f32; 256], [0.3f32; 256]);
        limiter.replace(&mut left, &mut right, 0, 256);
        assert!(left.iter().all(|sample| (*sample - 0.3).abs() < 1.0e-6), "below unity, nothing changes");
    }
}
