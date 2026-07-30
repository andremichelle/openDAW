//! The CZ 8-stage envelope: per step a RATE (0-99, a slope) and a LEVEL (0-99, the target), one step
//! optionally the SUSTAIN point (hold there until note-off) and one the END. Note-off jumps to the step
//! AFTER the sustain (or to the end step when no sustain is set), continuing from the CURRENT value.
//! Values stay in the raw 0-99 hardware domain; the caller maps them (gain / distortion / semitones).

pub const STAGES: usize = 8;

/// One envelope's configuration in raw hardware values, pushed by the engine from the box fields.
#[derive(Clone, Copy)]
pub struct EnvelopeSpec {
    pub rates: [f32; STAGES],
    pub levels: [f32; STAGES],
    pub sustain: i32, // 1-based step, 0 = none
    pub end: i32      // 1-based step
}

impl EnvelopeSpec {
    pub const fn flat() -> Self {
        Self {rates: [99.0; STAGES], levels: [0.0; STAGES], sustain: 0, end: 1}
    }
}

/// Seconds for a FULL 0..99 swing at `rate`, fitted to the VirtualCZ staircase probes (16 measured
/// segments, 2ms @95 to 6.7s @25): doubling every ~6.7 rate steps, anchored at 197ms @60.
fn full_swing_seconds(rate: f32) -> f32 {
    (0.1967 * libm::exp2f((60.0 - rate) / 6.7)).max(0.0015)
}

/// One running envelope instance (per voice, per line). Valid when zeroed.
#[derive(Clone, Copy, Default)]
pub struct Envelope {
    value: f32,
    stage: usize,
    releasing: bool,
    holding: bool
}

impl Envelope {
    pub fn start(&mut self) {
        self.value = 0.0;
        self.stage = 0;
        self.releasing = false;
        self.holding = false;
    }

    pub fn release(&mut self, spec: &EnvelopeSpec) {
        let end = spec.end.clamp(1, STAGES as i32) as usize;
        self.releasing = true;
        self.holding = false;
        self.stage = if spec.sustain > 0 {(spec.sustain as usize).min(end - 1)} else {end - 1};
    }

    pub fn force_finish(&mut self) {
        self.releasing = true;
        self.holding = true;
        self.value = 0.0;
    }

    pub fn finished(&self) -> bool {
        self.releasing && self.holding
    }

    /// Advance by `dt` seconds (scaled by the caller's key follow) and return the raw 0-99 value.
    pub fn process(&mut self, spec: &EnvelopeSpec, dt: f32) -> f32 {
        if self.holding {
            return self.value;
        }
        let end = spec.end.clamp(1, STAGES as i32) as usize;
        let stage = self.stage.min(end - 1);
        let target = spec.levels[stage].clamp(0.0, 99.0);
        let step = 99.0 * dt / full_swing_seconds(spec.rates[stage].clamp(0.0, 99.0));
        let reached = if self.value < target {
            self.value = (self.value + step).min(target);
            self.value == target
        } else if self.value > target {
            self.value = (self.value - step).max(target);
            self.value == target
        } else {
            true
        };
        if reached {
            let step_number = (stage + 1) as i32;
            if !self.releasing && spec.sustain > 0 && step_number == spec.sustain {
                self.holding = true; // hold at the sustain step until note-off
            } else if stage + 1 >= end {
                self.holding = true;
                if spec.sustain == 0 {
                    // Measured on VirtualCZ: with sustain OFF an envelope IDLES AT ZERO past its end
                    // step, it does not hold the final level — a DCA env silences the note even while
                    // the key is held (level-staircase probe), and a DCW env falls back to a pure
                    // cosine (the dcw-level staircase reads h2 ≈ −71dB after its end).
                    self.releasing = true;
                    self.value = 0.0;
                }
            } else {
                self.stage = stage + 1;
            }
        }
        self.value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DT: f32 = 1.0 / 48_000.0;

    fn run(env: &mut Envelope, spec: &EnvelopeSpec, seconds: f32) -> f32 {
        let mut value = 0.0;
        for _ in 0..(seconds / DT) as usize {
            value = env.process(spec, DT);
        }
        value
    }

    #[test]
    fn sustain_holds_until_release_then_runs_the_tail() {
        let spec = EnvelopeSpec {
            rates: [99.0; STAGES],
            levels: [99.0, 50.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            sustain: 1,
            end: 3
        };
        let mut env = Envelope::default();
        env.start();
        let held = run(&mut env, &spec, 0.1);
        assert_eq!(held, 99.0, "held at the sustain step's level");
        assert!(!env.finished(), "gated: not finished while holding");
        env.release(&spec);
        let released = run(&mut env, &spec, 0.5);
        assert_eq!(released, 0.0, "the post-sustain tail ran to the end level");
        assert!(env.finished(), "released and at the end: finished");
    }

    #[test]
    fn no_sustain_finishes_at_the_end_even_while_gated() {
        // Measured on VirtualCZ (level-staircase probe): with sustain OFF, reaching the end step ends
        // the note — the envelope does NOT hold its final level while the key stays down.
        let spec = EnvelopeSpec {
            rates: [99.0; STAGES],
            levels: [99.0, 30.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            sustain: 0,
            end: 2
        };
        let mut env = Envelope::default();
        env.start();
        let value = run(&mut env, &spec, 0.2);
        assert_eq!(value, 0.0, "idles at ZERO past the end step (not the end step's level)");
        assert!(env.finished(), "sustain OFF: the end step finishes the envelope while gated");
    }

    #[test]
    fn slow_rates_take_longer_than_fast_rates() {
        let fast = EnvelopeSpec {rates: [99.0; STAGES], levels: [99.0; STAGES], sustain: 1, end: 1};
        let slow = EnvelopeSpec {rates: [50.0; STAGES], levels: [99.0; STAGES], sustain: 1, end: 1};
        let mut env_fast = Envelope::default();
        let mut env_slow = Envelope::default();
        env_fast.start();
        env_slow.start();
        run(&mut env_fast, &fast, 0.01);
        run(&mut env_slow, &slow, 0.01);
        assert_eq!(env_fast.value, 99.0, "rate 99 is (near) instant");
        assert!(env_slow.value < 99.0, "rate 50 is still rising after 10ms");
    }
}
