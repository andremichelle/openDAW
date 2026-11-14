//! A one-shot envelope for struck sounds: linear attack, hold, decay to -60 dB. The decay curve blends from a fast
//! drop with a long tail (curve -1, a booming body) over exponential (0, a ringing body) to a straight fall of the
//! level (1, a compressed punchy hit). All three reach -60 dB at the decay time.
//! A retrigger starts from the current value, so a fast repeat never clicks. Valid when zeroed (idle).

const SILENCE: f32 = 0.001;

#[derive(Clone, Copy, Default, PartialEq, Debug)]
enum Stage {
    #[default]
    Idle,
    Attack,
    Hold,
    Decay
}

#[derive(Clone, Copy, Default, Debug)]
pub struct HitEnvelope {
    stage: Stage,
    value: f32,
    level: f32,
    remaining: u32,
    attack_samples: u32,
    hold_samples: u32,
    decay_factor: f32,
    linear_step: f32,
    tail_rate: f32,
    decayed: u32,
    curve: f32,
    floor: f32,
    exponential: f32,
    linear: f32
}

impl HitEnvelope {
    /// Times in seconds. `decay` is the time from the top to -60 dB.
    pub fn set(&mut self, attack: f32, hold: f32, decay: f32, sample_rate: f32) {
        self.attack_samples = (attack.max(0.0) * sample_rate) as u32;
        self.hold_samples = (hold.max(0.0) * sample_rate) as u32;
        self.decay_factor = libm::expf(libm::logf(SILENCE) / (decay.max(0.0001) * sample_rate));
        self.linear_step = 1.0 / (decay.max(0.0001) * sample_rate);
        self.tail_rate = (libm::sqrtf(1.0 / SILENCE) - 1.0) / (decay.max(0.0001) * sample_rate);
    }

    /// The level under which the envelope stops, 0 keeps the default (-66 dB). Lower lets a quiet tail ring on.
    pub fn set_floor(&mut self, floor: f32) {self.floor = floor;}

    /// -1 fast drop with a long tail, 0 exponential, 1 linear in level, blends in between.
    pub fn set_curve(&mut self, curve: f32) {self.curve = curve.clamp(-1.0, 1.0);}

    pub fn trigger(&mut self, level: f32) {
        self.level = level;
        if self.attack_samples > 0 {
            self.stage = Stage::Attack;
            self.remaining = self.attack_samples;
        } else {
            self.value = level;
            self.stage = Stage::Hold;
            self.remaining = self.hold_samples;
        }
    }

    pub fn stop(&mut self) {
        self.stage = Stage::Idle;
        self.value = 0.0;
    }

    pub fn is_idle(&self) -> bool {self.stage == Stage::Idle}

    #[inline]
    pub fn next(&mut self) -> f32 {
        match self.stage {
            Stage::Idle => {}
            Stage::Attack => {
                self.value += (self.level - self.value) / self.remaining as f32;
                self.remaining -= 1;
                if self.remaining == 0 {
                    self.value = self.level;
                    self.stage = Stage::Hold;
                    self.remaining = self.hold_samples;
                }
            }
            Stage::Hold => {
                if self.remaining > 0 {
                    self.remaining -= 1;
                } else {
                    self.stage = Stage::Decay;
                    self.exponential = 1.0;
                    self.linear = 1.0;
                    self.decayed = 0;
                }
            }
            Stage::Decay => {
                self.exponential *= self.decay_factor;
                self.linear = (self.linear - self.linear_step).max(0.0);
                self.decayed = self.decayed.saturating_add(1);
                let shape = if self.curve >= 0.0 {
                    self.exponential + (self.linear - self.exponential) * self.curve
                } else {
                    let tail = 1.0 + self.tail_rate * self.decayed as f32;
                    self.exponential + (1.0 / (tail * tail) - self.exponential) * -self.curve
                };
                self.value = self.level * shape;
                if shape < if self.floor > 0.0 {self.floor} else {SILENCE * 0.5} {self.stop();}
            }
        }
        self.value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    fn run(envelope: &mut HitEnvelope, samples: usize) -> [f32; 2] {
        let mut last = [0.0; 2];
        for _ in 0..samples {
            last = [last[1], envelope.next()];
        }
        last
    }

    #[test]
    fn attack_hold_decay_timing() {
        let mut envelope = HitEnvelope::default();
        envelope.set(0.001, 0.010, 0.5, RATE);
        envelope.trigger(1.0);
        assert!((run(&mut envelope, 48)[1] - 1.0).abs() < 1e-6, "top after the attack");
        assert_eq!(run(&mut envelope, 470)[1], 1.0, "held");
        let decayed = run(&mut envelope, (0.25 * RATE) as usize)[1];
        assert!((decayed - 0.0316).abs() < 0.003, "-30 dB halfway through a 0.5 s decay, {decayed}");
    }

    #[test]
    fn ends_idle_after_the_decay() {
        let mut envelope = HitEnvelope::default();
        envelope.set(0.0, 0.0, 0.1, RATE);
        envelope.trigger(0.8);
        run(&mut envelope, (0.15 * RATE) as usize);
        assert!(envelope.is_idle());
        assert_eq!(envelope.next(), 0.0);
    }

    #[test]
    fn retrigger_never_jumps_down() {
        let mut envelope = HitEnvelope::default();
        envelope.set(0.002, 0.0, 0.3, RATE);
        envelope.trigger(1.0);
        let before = run(&mut envelope, 500)[1];
        envelope.trigger(1.0);
        let after = envelope.next();
        assert!(after >= before, "{before} -> {after}");
    }

    #[test]
    fn linear_curve_falls_straight_and_ends_at_the_decay_time() {
        let mut envelope = HitEnvelope::default();
        envelope.set(0.0, 0.0, 0.1, RATE);
        envelope.set_curve(1.0);
        envelope.trigger(1.0);
        let half = run(&mut envelope, (0.05 * RATE) as usize)[1];
        assert!((half - 0.5).abs() < 0.01, "half the level halfway, {half}");
        run(&mut envelope, (0.051 * RATE) as usize);
        assert!(envelope.is_idle());
    }

    #[test]
    fn negative_curve_drops_fast_and_lingers() {
        let mut envelope = HitEnvelope::default();
        envelope.set(0.0, 0.0, 1.0, RATE);
        envelope.set_curve(-1.0);
        envelope.trigger(1.0);
        let early = run(&mut envelope, (0.05 * RATE) as usize)[1];
        assert!(early < 0.3, "below the exponential 0.708 after 50 ms, {early}");
        let late = run(&mut envelope, (0.85 * RATE) as usize)[1];
        assert!(late > 0.001 && late < 0.002, "still above -60 dB at 0.9 s, {late}");
        run(&mut envelope, (0.7 * RATE) as usize);
        assert!(envelope.is_idle(), "ends once below -66 dB, about 1.45 decay times for the long tail");
    }

    #[test]
    fn zeroed_is_silent() {
        assert_eq!(HitEnvelope::default().next(), 0.0);
    }
}
