//! Seeded noise sources. The same seed always gives the same stream, so a hit renders identically every time.
//! Valid when zeroed (seed 0).

use math::random::Mulberry32;

/// White noise in [-1, 1).
#[derive(Clone, Copy, Default)]
pub struct WhiteNoise {
    random: Mulberry32
}

impl WhiteNoise {
    pub fn reset(&mut self, seed: u32) {self.random.set_seed(seed);}

    #[inline]
    pub fn next(&mut self) -> f32 {self.random.uniform() * 2.0 - 1.0}
}

/// The digital noise of a clocked 32 stage shift register (taps 32, 22, 2, 1, a maximal sequence). Each clock
/// shifts in a new bit, the output holds +1 or -1 between clocks. Its slight periodicity and the held steps give
/// the grainy character of drum machines that used one instead of an analog noise source.
#[derive(Clone, Copy, Default)]
pub struct ShiftRegisterNoise {
    register: u32,
    phase: f32
}

impl ShiftRegisterNoise {
    pub fn reset(&mut self, seed: u32) {
        self.register = if seed == 0 {0xACE1_2468} else {seed};
        self.phase = 0.0;
    }

    /// `clock` is the shift rate relative to the sample rate (clock Hz / sample rate), above 1 shifts several times.
    #[inline]
    pub fn next(&mut self, clock: f32) -> f32 {
        if self.register == 0 {self.register = 0xACE1_2468;}
        self.phase += clock;
        while self.phase >= 1.0 {
            self.phase -= 1.0;
            let register = self.register;
            let bit = (register >> 31 ^ register >> 21 ^ register >> 1 ^ register) & 1;
            self.register = register << 1 | bit;
        }
        if self.register & 1 == 1 {1.0} else {-1.0}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn white_noise_is_seeded_bounded_and_centred() {
        let (mut first, mut second) = (WhiteNoise::default(), WhiteNoise::default());
        first.reset(42);
        second.reset(42);
        let mut sum = 0.0f64;
        for _ in 0..100_000 {
            let value = first.next();
            assert_eq!(value, second.next());
            assert!((-1.0..1.0).contains(&value));
            sum += value as f64;
        }
        assert!((sum / 100_000.0).abs() < 0.01);
    }

    #[test]
    fn shift_register_is_balanced_and_never_sticks() {
        let mut noise = ShiftRegisterNoise::default();
        noise.reset(1);
        let (mut ones, mut longest, mut run, mut last) = (0, 0, 0, 0.0);
        for _ in 0..100_000 {
            let value = noise.next(1.0);
            if value > 0.0 {ones += 1;}
            run = if value == last {run + 1} else {1};
            longest = longest.max(run);
            last = value;
        }
        assert!((ones as f64 / 100_000.0 - 0.5).abs() < 0.01, "{ones}");
        assert!(longest < 40, "a stuck register would hold one value, longest run {longest}");
    }

    #[test]
    fn a_slow_clock_holds_its_value() {
        let mut noise = ShiftRegisterNoise::default();
        noise.reset(7);
        let values: [f32; 400] = core::array::from_fn(|_| noise.next(0.25));
        let steps = values.windows(2).filter(|pair| pair[0] != pair[1]).count();
        assert!(steps <= 100 && steps > 20, "one shift per 4 samples, {steps} steps");
    }

    #[test]
    fn zeroed_state_still_produces_noise() {
        let mut noise = ShiftRegisterNoise::default();
        let values: [f32; 64] = core::array::from_fn(|_| noise.next(1.0));
        assert!(values.iter().any(|value| *value > 0.0) && values.iter().any(|value| *value < 0.0));
    }
}
