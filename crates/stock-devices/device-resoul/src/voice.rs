//! The re-soul sampler's per-note voice, a port of the inner `Voice` of the (retired) TS
//! `ReSoulDeviceProcessor`: a pitch-rate read head over the loaded sample with linear interpolation and a
//! squared attack/release envelope, extended over the Nano voice by a root key (the pitch that plays the
//! sample at its native rate), an octave shift, a start/end region and reverse playback. Pure DSP over
//! slices, unit-testable with synthetic frames; heap-free and valid when zeroed (voices live in the device's
//! zeroed state, a fixed pool).

#[derive(Clone, Copy, Default)]
pub struct ReSoulVoice {
    active: bool,
    id: u32,
    speed: f32, // read-head increment per output sample, before the sample-rate ratio
    velocity: f32,
    reverse: bool,
    attack: u32,  // attack length in samples
    release: u32, // release length in samples
    initialized: bool, // the region resolves against the sample on the first processed chunk
    start: f64,        // region bounds in source frames (captured at first process, like the TS voice)
    end: f64,
    position: f64, // read head in source frames (f64 for precision over long samples)
    env_position: u32,
    decay_position: u32, // the env position at note-off (only meaningful once `releasing`)
    releasing: bool
}

impl ReSoulVoice {
    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn id(&self) -> u32 {
        self.id
    }

    /// The read head in source frames (for the positions broadcast the editor paints as playheads).
    pub fn position(&self) -> f64 {
        self.position
    }

    /// Begin a note: pitch-rate `2^((pitch - root_key + cent/100)/12 + octave)` (so playing the root key
    /// reads at the native rate), capturing the envelope and direction the device holds at note-on.
    #[allow(clippy::too_many_arguments)]
    pub fn start(&mut self, id: u32, pitch: u32, cent: f32, velocity: f32,
                 root_key: i32, octave: i32, reverse: bool, attack: u32, release: u32) {
        self.active = true;
        self.id = id;
        self.speed = libm::exp2f((pitch as f32 - root_key as f32 + cent / 100.0) / 12.0 + octave as f32);
        self.velocity = velocity;
        self.reverse = reverse;
        self.attack = attack.max(1);
        self.release = release.max(1);
        self.initialized = false;
        self.start = 0.0;
        self.end = 0.0;
        self.position = 0.0;
        self.env_position = 0;
        self.decay_position = 0;
        self.releasing = false;
    }

    /// Note-off: enter the release from the current envelope position.
    pub fn stop(&mut self) {
        if !self.releasing {
            self.releasing = true;
            self.decay_position = self.env_position;
        }
    }

    /// Free the slot immediately.
    pub fn force_stop(&mut self) {
        self.active = false;
    }

    /// Render additively into the stereo chunk from the planar sample, advancing the read head by
    /// `speed * rate_ratio` (negated in reverse). `sample_start`/`sample_end` are the device's unit region;
    /// the region resolves against the sample length on the voice's first chunk and stays fixed after (the
    /// TS behaviour), while the per-sample frame clamp guards a sample swapped mid-note. Returns `true` once
    /// finished (the region ran out or the release elapsed), so the device frees the slot.
    #[allow(clippy::too_many_arguments)]
    pub fn process(&mut self, out_left: &mut [f32], out_right: &mut [f32], left: &[f32], right: &[f32],
                   rate_ratio: f64, gain: f32, sample_start: f32, sample_end: f32) -> bool {
        let num_frames = left.len();
        if num_frames < 2 {
            return true;
        }
        if !self.initialized {
            let span = (num_frames - 1) as f64;
            let a = sample_start as f64 * span;
            let b = sample_end as f64 * span;
            self.start = if a < b {a} else {b};
            self.end = if a < b {b} else {a};
            self.position = if self.reverse {self.end} else {self.start};
            self.initialized = true;
        }
        if self.end - self.start < 1.0 {
            return true;
        }
        let increment = self.speed as f64 * rate_ratio * if self.reverse {-1.0} else {1.0};
        let gain = gain * self.velocity;
        let release_inverse = 1.0 / self.release as f32;
        for index in 0..out_left.len() {
            if self.reverse && self.position <= self.start {
                return true;
            }
            if !self.reverse && self.position >= self.end {
                return true;
            }
            let int_position = self.position as usize;
            if int_position >= num_frames {
                return true; // past the CURRENT sample (it was swapped mid-note for a shorter one)
            }
            let partner = if int_position + 1 < num_frames {int_position + 1} else {int_position};
            let frac = (self.position - int_position as f64) as f32;
            let att = if self.env_position < self.attack {self.env_position as f32 / self.attack as f32} else {1.0};
            let release_factor = if self.releasing {
                (1.0 - (self.env_position - self.decay_position) as f32 * release_inverse).min(1.0)
            } else {
                1.0
            };
            let shaped = release_factor * att;
            let env = shaped * shaped;
            let sample_left = left[int_position] * (1.0 - frac) + left[partner] * frac;
            let sample_right = right[int_position] * (1.0 - frac) + right[partner] * frac;
            out_left[index] += sample_left * gain * env;
            out_right[index] += sample_right * gain * env;
            self.position += increment;
            self.env_position += 1;
            if self.releasing && self.env_position - self.decay_position > self.release {
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::ReSoulVoice;

    const SR: f32 = 48_000.0;

    fn started(pitch: u32, root_key: i32, octave: i32, reverse: bool) -> ReSoulVoice {
        let mut voice = ReSoulVoice::default();
        voice.start(7, pitch, 0.0, 1.0, root_key, octave, reverse, (0.003 * SR) as u32, 4_800);
        voice
    }

    // A ramp sample (frame index / count), so read direction shows in the output shape.
    fn ramp(frames: usize) -> Vec<f32> {
        (0..frames).map(|index| index as f32 / frames as f32).collect()
    }

    fn dc(frames: usize) -> Vec<f32> {
        vec![1.0f32; frames]
    }

    #[test]
    fn the_root_key_reads_at_the_native_rate() {
        assert!((started(60, 60, 0, false).speed() - 1.0).abs() < 1.0e-6, "playing the root is rate 1.0");
        assert!((started(69, 57, 0, false).speed() - 2.0).abs() < 1.0e-6, "an octave over the root doubles");
        assert!((started(45, 45, 1, false).speed() - 2.0).abs() < 1.0e-6, "the octave shift stacks on top");
        assert!((started(33, 45, 0, false).speed() - 0.5).abs() < 1.0e-6, "an octave under the root halves");
    }

    #[test]
    fn forward_and_reverse_trace_the_ramp_in_opposite_directions() {
        let frames = ramp(48_000);
        let (mut fwd_l, mut fwd_r) = (vec![0.0f32; 512], vec![0.0f32; 512]);
        let mut forward = started(60, 60, 0, false);
        // run past the attack so the envelope is flat, then compare slopes
        forward.process(&mut fwd_l, &mut fwd_r, &frames, &frames, 1.0, 1.0, 0.0, 1.0);
        let (mut fwd_l2, mut fwd_r2) = (vec![0.0f32; 512], vec![0.0f32; 512]);
        forward.process(&mut fwd_l2, &mut fwd_r2, &frames, &frames, 1.0, 1.0, 0.0, 1.0);
        assert!(fwd_l2[511] > fwd_l2[0], "forward playback reads rising ramp values");
        let mut reverse = started(60, 60, 0, true);
        let (mut rev_l, mut rev_r) = (vec![0.0f32; 512], vec![0.0f32; 512]);
        reverse.process(&mut rev_l, &mut rev_r, &frames, &frames, 1.0, 1.0, 0.0, 1.0);
        let (mut rev_l2, mut rev_r2) = (vec![0.0f32; 512], vec![0.0f32; 512]);
        reverse.process(&mut rev_l2, &mut rev_r2, &frames, &frames, 1.0, 1.0, 0.0, 1.0);
        assert!(rev_l2[511] < rev_l2[0], "reverse playback reads falling ramp values");
        assert!(rev_l[0].abs() < 0.01, "reverse also ramps in over the attack");
    }

    #[test]
    fn the_region_bounds_playback() {
        let frames = dc(48_000);
        let mut voice = started(60, 60, 0, false);
        let (mut left, mut right) = (vec![0.0f32; 8_192], vec![0.0f32; 8_192]);
        // a region of 10% of a 1 s sample ends within a tenth of a second
        let finished = voice.process(&mut left, &mut right, &frames, &frames, 1.0, 1.0, 0.0, 0.1);
        assert!(finished, "the voice finishes at the region end");
        let silent_after = left[4_801..].iter().fold(0.0f32, |acc, value| acc.max(value.abs()));
        assert!(silent_after < 1.0e-6, "nothing renders past the region end");
        let mut degenerate = started(60, 60, 0, false);
        assert!(degenerate.process(&mut left, &mut right, &frames, &frames, 1.0, 1.0, 0.5, 0.5),
                "a zero-length region finishes immediately");
    }

    #[test]
    fn release_decays_to_silence_then_finishes() {
        let frames = dc(48_000);
        let mut voice = started(60, 60, 0, false);
        let (mut left, mut right) = (vec![0.0f32; 4_800], vec![0.0f32; 4_800]);
        voice.process(&mut left, &mut right, &frames, &frames, 1.0, 1.0, 0.0, 1.0);
        voice.stop();
        let (mut tail_left, mut tail_right) = (vec![0.0f32; 8_192], vec![0.0f32; 8_192]);
        let finished = voice.process(&mut tail_left, &mut tail_right, &frames, &frames, 1.0, 1.0, 0.0, 1.0);
        assert!(finished, "the release elapses within the chunk");
        let tail_peak = tail_left[4_800..].iter().fold(0.0f32, |acc, value| acc.max(value.abs()));
        assert!(tail_peak < 1.0e-6, "silent once released");
    }

    #[test]
    fn a_shrunken_sample_mid_note_cannot_read_out_of_bounds() {
        let frames = dc(48_000);
        let mut voice = started(72, 60, 1, false); // 4x rate, far into the sample quickly
        let (mut left, mut right) = (vec![0.0f32; 4_096], vec![0.0f32; 4_096]);
        voice.process(&mut left, &mut right, &frames, &frames, 1.0, 1.0, 0.0, 1.0);
        let swapped = dc(1_024); // the bound sample is replaced by a much shorter one
        let finished = voice.process(&mut left, &mut right, &swapped, &swapped, 1.0, 1.0, 0.0, 1.0);
        assert!(finished, "the frame clamp ends the voice instead of reading past the new sample");
    }

    impl ReSoulVoice {
        // test-only accessor for the computed read-head rate
        fn speed(&self) -> f32 {self.speed}
    }
}
