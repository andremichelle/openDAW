//! Frequency portamento, a port of lib-dsp `Glide`. It linearly slides the frequency from the current value
//! to a target over a duration in pulses (so it is tempo-relative), MULTIPLYING a frequency buffer that may
//! already hold a per-sample detune. Two changes from the TS: the sample rate is passed in (the TS read an
//! undefined `sampleRate` global — a bug), and the `NaN` "not set" / "not gliding" sentinels become bool
//! flags so the struct is valid when zeroed (voices live in a zeroed pool, no constructor runs).

use crate::ppqn;

#[derive(Clone, Copy, Default)]
pub struct Glide {
    begin_frequency: f64,
    current_frequency: f64,
    target_frequency: f64,
    glide_position: f64,
    glide_duration: f64,
    initialized: bool, // current_frequency has been seeded (replaces the TS `isNaN(current)`)
    gliding: bool      // a glide is in progress (replaces the TS `isNaN(target)`)
}

impl Glide {
    /// Reset to the un-initialised state (used when a pooled voice slot is reused for a new note).
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// Seed the starting frequency. The current frequency takes it only the first time (so a re-trigger keeps
    /// the current value to glide FROM). Mirrors `Glide.init`.
    pub fn init(&mut self, frequency: f64) {
        self.begin_frequency = frequency;
        if !self.initialized {
            self.current_frequency = frequency;
            self.initialized = true;
        }
    }

    pub fn current_frequency(&self) -> f64 {
        self.current_frequency
    }

    /// Begin a glide to `target_frequency` over `glide_duration` pulses. A zero duration jumps immediately
    /// (just moves the start point). Mirrors `Glide.glideTo`.
    pub fn glide_to(&mut self, target_frequency: f64, glide_duration: f64) {
        if glide_duration == 0.0 {
            self.begin_frequency = target_frequency;
            return;
        }
        self.begin_frequency = self.current_frequency;
        self.target_frequency = target_frequency;
        self.glide_position = 0.0;
        self.glide_duration = glide_duration;
        self.gliding = true;
    }

    /// Multiply `freq_buffer[from..to]` by the (possibly gliding) frequency, advancing the glide per sample.
    /// `bpm` / `sample_rate` convert the pulse-relative duration to a per-sample step. Mirrors `Glide.process`.
    pub fn process(&mut self, freq_buffer: &mut [f32], bpm: f32, sample_rate: f32, from: usize, to: usize) {
        if !self.gliding {
            for sample in &mut freq_buffer[from..to] {
                *sample *= self.begin_frequency as f32;
            }
            self.current_frequency = self.begin_frequency;
            return;
        }
        let step = ppqn::samples_to_pulses(1.0, bpm, sample_rate) / self.glide_duration;
        for index in from..to {
            self.glide_position += step;
            if self.glide_position >= 1.0 {
                self.begin_frequency = self.target_frequency;
                self.current_frequency = self.target_frequency;
                self.gliding = false;
                for sample in &mut freq_buffer[index..to] {
                    *sample *= self.begin_frequency as f32;
                }
                return;
            }
            self.current_frequency = self.begin_frequency + (self.target_frequency - self.begin_frequency) * self.glide_position;
            freq_buffer[index] *= self.current_frequency as f32;
        }
    }

    /// Advance the glide over `to - from` samples WITHOUT touching a buffer (a shared unison glide, whose
    /// sub-voices each apply the frequency themselves). Mirrors `Glide.advance`.
    pub fn advance(&mut self, bpm: f32, sample_rate: f32, from: usize, to: usize) {
        if !self.gliding {
            self.current_frequency = self.begin_frequency;
            return;
        }
        self.glide_position += ppqn::samples_to_pulses((to - from) as f64, bpm, sample_rate) / self.glide_duration;
        if self.glide_position >= 1.0 {
            self.begin_frequency = self.target_frequency;
            self.current_frequency = self.target_frequency;
            self.gliding = false;
        } else {
            self.current_frequency = self.begin_frequency + (self.target_frequency - self.begin_frequency) * self.glide_position;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Glide;

    const SR: f32 = 48_000.0;
    const BPM: f32 = 120.0;

    // The frequency buffer is a per-sample multiplier (a detune); fill it with 1.0 to read the raw frequency.
    fn unit_buffer(len: usize) -> Vec<f32> {
        vec![1.0f32; len]
    }

    #[test]
    fn without_a_target_it_holds_the_init_frequency() {
        let mut glide = Glide::default();
        glide.init(440.0);
        let mut buffer = unit_buffer(8);
        glide.process(&mut buffer, BPM, SR, 0, 8);
        assert!(buffer.iter().all(|frequency| (*frequency - 440.0).abs() < 1.0e-3), "holds 440 Hz");
        assert_eq!(glide.current_frequency(), 440.0);
    }

    #[test]
    fn a_zero_duration_glide_jumps_immediately() {
        let mut glide = Glide::default();
        glide.init(220.0);
        glide.glide_to(440.0, 0.0);
        let mut buffer = unit_buffer(4);
        glide.process(&mut buffer, BPM, SR, 0, 4);
        assert!((buffer[0] - 440.0).abs() < 1.0e-3, "jumps straight to the target");
    }

    #[test]
    fn it_glides_linearly_and_settles_at_the_target() {
        // At 120 bpm there are 1920 pulses/s, so a 480-pulse glide lasts 0.25 s = 12000 samples at 48 kHz.
        let mut glide = Glide::default();
        glide.init(100.0);
        glide.glide_to(200.0, 480.0);
        let mut early = unit_buffer(1);
        glide.process(&mut early, BPM, SR, 0, 1); // one sample in: barely moved
        assert!(early[0] > 100.0 && early[0] < 101.0, "starts near the begin frequency");
        // 6000 samples total is the half-way point: a linear glide is at the midpoint frequency.
        let mut mid = unit_buffer(5_999);
        glide.process(&mut mid, BPM, SR, 0, 5_999);
        assert!((glide.current_frequency() - 150.0).abs() < 1.0, "about halfway after half the duration");
        // run past the 12000-sample end: it settles exactly on the target and stops gliding.
        let mut tail = unit_buffer(12_000);
        glide.process(&mut tail, BPM, SR, 0, 12_000);
        assert!((glide.current_frequency() - 200.0).abs() < 1.0e-3, "settles on the target");
        assert!((tail[tail.len() - 1] - 200.0).abs() < 1.0e-3);
    }

    #[test]
    fn reset_clears_the_glide() {
        let mut glide = Glide::default();
        glide.init(440.0);
        glide.glide_to(880.0, 480.0);
        glide.reset();
        glide.init(110.0);
        let mut buffer = unit_buffer(4);
        glide.process(&mut buffer, BPM, SR, 0, 4);
        assert!((buffer[0] - 110.0).abs() < 1.0e-3, "after reset it holds the fresh init frequency");
    }
}
