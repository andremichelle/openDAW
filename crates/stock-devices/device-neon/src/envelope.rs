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

/// Seconds for a FULL 0..99 swing at `rate`: the MEASURED VirtualCZ decay ladder (2026-07-31,
/// -5..-40dB windows / 0.566 span), log-time interpolated — the scale has region kinks (e.g. 45→40
/// doubles in 5 steps but 40→35 only ×1.38) that no single exponential fits.
fn full_swing_seconds(rate: f32) -> f32 {
    const POINTS: [(f32, f32); 14] = [
        (10.0, 40.43), (15.0, 20.28), (20.0, 14.45), (25.0, 8.509), (30.0, 4.240), (35.0, 2.519),
        (40.0, 1.820), (45.0, 0.901), (53.0, 0.428), (60.0, 0.187), (70.0, 0.064), (80.0, 0.028),
        (85.0, 0.014), (99.0, 0.0022)
    ];
    let first = POINTS[0];
    let last = POINTS[POINTS.len() - 1];
    if rate <= first.0 {
        return first.1 * libm::exp2f((first.0 - rate) / 5.0);
    }
    if rate >= last.0 {
        return last.1.max(0.0015);
    }
    let mut seconds = last.1;
    for pair in POINTS.windows(2) {
        let ((x0, y0), (x1, y1)) = (pair[0], pair[1]);
        if rate <= x1 {
            let t = (rate - x0) / (x1 - x0);
            seconds = libm::exp2f(libm::log2f(y0) + (libm::log2f(y1) - libm::log2f(y0)) * t);
            break;
        }
    }
    seconds.max(0.0015)
}

/// PEG full swing: measured on VirtualCZ pitch-track probes (settle times 12.96s/2.76s/0.49s/0.09s/0.02s
/// at rates 25/40/55/70/85) — its own law, slower than the DCA/DCW one at low rates.
fn full_swing_seconds_pitch(rate: f32) -> f32 {
    (0.29 * libm::exp2f((60.0 - rate) / 6.4)).max(0.002)
}

/// Raw pitch-env level to SEMITONES at the hardware depth: fresh VirtualCZ sustained ladder (default
/// depth, note-48 pitch tracks). Gentle to 63, the hardware jump region 63-70, then ~2 st per unit.
pub fn pitch_semitones(raw: f32) -> f32 {
    const POINTS: [(f32, f32); 18] = [
        (0.0, 0.0), (5.0, 0.35), (10.0, 1.02), (20.0, 2.26), (33.0, 4.01), (45.0, 5.5), (55.0, 6.75),
        (63.0, 7.62), (65.0, 9.87), (67.0, 11.87), (70.0, 19.87), (75.0, 27.88), (80.0, 37.88),
        (85.0, 47.87), (90.0, 59.88), (93.0, 63.88), (96.0, 71.87), (99.0, 79.0)
    ];
    let value = raw.clamp(0.0, 99.0);
    let mut semitones = 0.0;
    for pair in POINTS.windows(2) {
        let ((x0, y0), (x1, y1)) = (pair[0], pair[1]);
        if value <= x1 {
            semitones = y0 + (y1 - y0) * (value - x0) / (x1 - x0);
            break;
        }
        semitones = y1;
    }
    semitones
}

const PITCH_RANGE_SEMITONES: f32 = 79.0;

/// One running envelope instance (per voice, per line). Valid when zeroed.
#[derive(Clone, Copy, Default)]
pub struct Envelope {
    value: f32,
    stage: usize,
    releasing: bool,
    holding: bool,
    draining: bool // one-shot ran past step 8 still audible: ramp to zero at the last step's rate
}

/// A sustain marker past the end step is dead weight the hardware ignores (real dumps carry them, e.g.
/// synthlib's mr-drummin DCA s3/e2, and the editor allows dragging S past E) — treat it as no sustain,
/// otherwise the envelope wrongly HOLDS the end step's level while gated.
fn effective_sustain(spec: &EnvelopeSpec, end: usize) -> i32 {
    if spec.sustain > end as i32 {0} else {spec.sustain}
}

impl Envelope {
    pub fn start(&mut self) {
        self.value = 0.0;
        self.stage = 0;
        self.releasing = false;
        self.holding = false;
        self.draining = false;
    }

    pub fn release(&mut self, spec: &EnvelopeSpec) {
        let end = spec.end.clamp(1, STAGES as i32) as usize;
        let sustain = effective_sustain(spec, end);
        self.releasing = true;
        if sustain > 0 {
            self.holding = false;
            self.stage = (sustain as usize).min(end - 1);
        }
        // No sustain: a ONE-SHOT envelope — note-off must not restart a stage (jumping back to the end
        // stage re-targeted its level from the current value: an audible warp), the walk just continues.
    }

    pub fn finished(&self) -> bool {
        self.releasing && self.holding
    }

    pub fn is_released(&self) -> bool {
        self.releasing
    }

    /// Advance by `dt` seconds (scaled by the caller's key follow) and return the raw 0-99 value.
    pub fn process(&mut self, spec: &EnvelopeSpec, dt: f32) -> f32 {
        self.advance(spec, dt, false)
    }

    /// The PITCH envelope: measured on VirtualCZ, the PEG traverses LINEARLY IN SEMITONES (a 0→63 rise
    /// settles in 40ms where raw-linear predicts 318ms) under its own rate law — the value is held and
    /// returned in SEMITONES.
    pub fn process_pitch(&mut self, spec: &EnvelopeSpec, dt: f32) -> f32 {
        self.advance(spec, dt, true)
    }

    fn advance(&mut self, spec: &EnvelopeSpec, dt: f32, pitch: bool) -> f32 {
        if self.holding {
            return self.value;
        }
        let end = spec.end.clamp(1, STAGES as i32) as usize;
        let stage = self.stage.min(STAGES - 1);
        let rate = spec.rates[stage].clamp(0.0, 99.0);
        let (target, step) = if pitch {
            let target = if self.draining {0.0} else {pitch_semitones(spec.levels[stage])};
            (target, PITCH_RANGE_SEMITONES * dt / full_swing_seconds_pitch(rate))
        } else {
            let target = if self.draining {0.0} else {spec.levels[stage].clamp(0.0, 99.0)};
            (target, 99.0 * dt / full_swing_seconds(rate))
        };
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
            let sustain = effective_sustain(spec, end);
            if !self.releasing && sustain > 0 && step_number == sustain {
                self.holding = true; // hold at the sustain step until note-off
            } else if sustain == 0 && stage + 1 >= end {
                // MEASURED on VirtualCZ (step3-rate probe: tail time identical for step3 rate 90 vs 30):
                // steps past the end byte are NEVER played; a non-zero end level DRAINS to zero at the
                // END step's OWN rate (35@rate53 -> ~0.14s), then the envelope idles at zero. This is the
                // one rule for audible lines AND modulators (their noise burst fades at the same law).
                if self.value <= 0.0 {
                    self.releasing = true;
                    self.holding = true;
                    self.value = 0.0;
                } else {
                    self.draining = true;
                }
            } else if stage + 1 >= end {
                self.holding = true; // valid sustain: the post-sustain tail parks on the end step's level
            } else if sustain == 0 && stage + 2 == end && spec.levels[end - 1] > self.value {
                // MEASURED on VirtualCZ (dca-rate-slow contour + every one-shot noise ladder): a
                // one-shot env never PLAYS an ASCENDING end stage — it enters it DRAINING to zero at
                // that stage's rate (mid-stage ascents DO play; this rule also yields the noise-mode
                // falling burst, no separate noise envelope needed).
                self.stage = stage + 1;
                self.draining = true;
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
    fn a_sustain_marker_past_the_end_step_is_ignored() {
        // mr-drummin line1 DCA: end 2 at level 35 with a stray sustain flag on step 3 — the drum must
        // decay and silence, not hold at 35 forever while the key is down.
        let spec = EnvelopeSpec {
            rates: [99.0; STAGES],
            levels: [99.0, 35.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            sustain: 3,
            end: 2
        };
        let mut env = Envelope::default();
        env.start();
        let value = run(&mut env, &spec, 0.2);
        assert_eq!(value, 0.0, "invalid sustain: idles at zero past the end step, got {value}");
        assert!(env.finished(), "the envelope finishes while gated");
    }

    #[test]
    fn a_one_shot_envelope_plays_the_staircase_past_its_end_byte_and_never_jumps() {
        // mr-drummin line1 DCA: end 2 (level 35) with the real decay in step 3 (35→0). The walk must
        // continue smoothly past the end byte, and note-off must not restart a stage.
        let spec = EnvelopeSpec {
            rates: [99.0, 40.0, 40.0, 99.0, 99.0, 99.0, 99.0, 99.0],
            levels: [99.0, 35.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            sustain: 0,
            end: 2
        };
        let mut env = Envelope::default();
        env.start();
        run(&mut env, &spec, 0.05); // into the 99→35 decay
        env.release(&spec);
        let mut previous = env.value;
        let mut maximum_rise = 0.0f32;
        for _ in 0..(3.0 / DT) as usize {
            let value = env.process(&spec, DT);
            maximum_rise = maximum_rise.max(value - previous);
            previous = value;
        }
        assert!(maximum_rise <= 0.0, "monotonic decay through the staircase, rose by {maximum_rise}");
        assert_eq!(env.value, 0.0, "landed at zero");
        assert!(env.finished(), "finished after draining");
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
