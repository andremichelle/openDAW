//! The Nano sampler's per-note voice, a port of the inner `Voice` of TS `NanoDeviceProcessor`: a pitch-rate
//! read head over the loaded sample with linear interpolation and a squared attack/release envelope. Pure DSP
//! over slices, so it is unit-testable with synthetic frames; the device owns the sample resolution and the
//! voice pool. Heap-free and valid when zeroed (voices live in the device's zeroed state, a fixed pool).

const ATTACK_SECONDS: f32 = 0.003; // the TS voice's fixed 3 ms attack ramp

#[derive(Clone, Copy, Default)]
pub struct NanoVoice {
    active: bool,
    id: u32,
    speed: f32, // read-head increment per output sample, before the sample-rate ratio
    velocity: f32,
    position: f64, // read head in source frames (f64 for precision over long samples)
    attack: u32,   // attack length in samples
    env_position: u32,
    decay_position: u32, // the env position at note-off (only meaningful once `releasing`)
    releasing: bool
}

impl NanoVoice {
    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn id(&self) -> u32 {
        self.id
    }

    /// Begin a note: pitch-rate `2^((pitch + cent/100)/12 - 5)` (so pitch 60 plays at the native rate), and
    /// the 3 ms attack derived from the engine `sample_rate`.
    pub fn start(&mut self, id: u32, pitch: u32, cent: f32, velocity: f32, sample_rate: f32) {
        self.active = true;
        self.id = id;
        self.speed = libm::exp2f((pitch as f32 + cent / 100.0) / 12.0 - 5.0);
        self.velocity = velocity;
        self.position = 0.0;
        self.attack = (ATTACK_SECONDS * sample_rate) as u32;
        self.env_position = 0;
        self.decay_position = 0;
        self.releasing = false;
    }

    /// Note-off: enter the release from the current envelope position (mirrors `decayPosition = envPosition`).
    pub fn stop(&mut self) {
        self.releasing = true;
        self.decay_position = self.env_position;
    }

    /// Free the slot immediately.
    pub fn force_stop(&mut self) {
        self.active = false;
    }

    /// Render additively into the stereo chunk from the planar sample (`left` / `right`, mono passes the same
    /// slice for both), advancing the read head by `speed * rate_ratio`. Returns `true` once finished (the
    /// sample ran out or the release elapsed), so the device frees the slot. `gain` is the device gain (the
    /// per-note velocity is applied here); `release` is the release length in samples. Mirrors `processSimple`.
    pub fn process(&mut self, out_left: &mut [f32], out_right: &mut [f32], left: &[f32], right: &[f32], rate_ratio: f64, gain: f32, release: u32) -> bool {
        let num_frames = left.len();
        if num_frames < 2 {
            return true;
        }
        let release = release.max(1);
        let release_inverse = 1.0 / release as f32;
        let gain = gain * self.velocity;
        for index in 0..out_left.len() {
            let int_position = self.position as usize;
            if int_position >= num_frames - 1 {
                return true;
            }
            let frac = (self.position - int_position as f64) as f32;
            let att = if self.env_position < self.attack {self.env_position as f32 / self.attack as f32} else {1.0};
            let release_factor = if self.releasing {
                (1.0 - (self.env_position - self.decay_position) as f32 * release_inverse).min(1.0)
            } else {
                1.0
            };
            let shaped = release_factor * att;
            let env = shaped * shaped;
            let sample_left = left[int_position] * (1.0 - frac) + left[int_position + 1] * frac;
            let sample_right = right[int_position] * (1.0 - frac) + right[int_position + 1] * frac;
            out_left[index] += sample_left * gain * env;
            out_right[index] += sample_right * gain * env;
            self.position += self.speed as f64 * rate_ratio;
            self.env_position += 1;
            if self.releasing && self.env_position - self.decay_position > release {
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::NanoVoice;

    const SR: f32 = 48_000.0;

    fn started(pitch: u32) -> NanoVoice {
        let mut voice = NanoVoice::default();
        voice.start(7, pitch, 0.0, 1.0, SR);
        voice
    }

    // A DC sample (every frame 1.0), so the output traces the envelope directly.
    fn dc(frames: usize) -> Vec<f32> {
        vec![1.0f32; frames]
    }

    fn peak(buffer: &[f32]) -> f32 {
        buffer.iter().fold(0.0f32, |acc, value| acc.max(value.abs()))
    }

    #[test]
    fn pitch_60_reads_at_the_native_rate() {
        let mut voice = started(60);
        assert!((voice.process_speed() - 1.0).abs() < 1.0e-6, "pitch 60 maps to rate 1.0");
        let mut octave = started(72);
        assert!((octave.process_speed() - 2.0).abs() < 1.0e-6, "an octave up doubles the rate");
    }

    #[test]
    fn renders_the_sample_and_ramps_in_over_the_attack() {
        let mut voice = started(60);
        let frames = dc(48_000);
        let (mut left, mut right) = (vec![0.0f32; 64], vec![0.0f32; 64]);
        assert!(!voice.process(&mut left, &mut right, &frames, &frames, 1.0, 1.0, 4_800), "still sounding");
        assert!(left[0].abs() < 0.01, "starts near silent (attack ramp from 0)");
        assert!(left[63] > left[0], "ramps up across the attack");
        assert_eq!(left, right, "a mono sample feeds both channels equally");
    }

    #[test]
    fn finishes_when_the_sample_runs_out() {
        let mut voice = started(60);
        let frames = dc(32); // tiny sample
        let (mut left, mut right) = (vec![0.0f32; 64], vec![0.0f32; 64]);
        assert!(voice.process(&mut left, &mut right, &frames, &frames, 1.0, 1.0, 4_800), "ends past the last frame");
    }

    #[test]
    fn release_decays_to_silence_then_finishes() {
        let mut voice = started(60);
        let frames = dc(48_000);
        let (mut left, mut right) = (vec![0.0f32; 4_800], vec![0.0f32; 4_800]);
        voice.process(&mut left, &mut right, &frames, &frames, 1.0, 1.0, 4_800); // run past the attack
        voice.stop();
        let release = 480; // ~10 ms
        let (mut tail_left, mut tail_right) = (vec![0.0f32; 1_024], vec![0.0f32; 1_024]);
        let finished = voice.process(&mut tail_left, &mut tail_right, &frames, &frames, 1.0, 1.0, release);
        assert!(finished, "the release elapses within the chunk");
        assert!(peak(&tail_left[release as usize..]) < 1.0e-6, "silent once released");
    }

    impl NanoVoice {
        // test-only accessor for the computed read-head rate
        fn process_speed(&self) -> f32 {self.speed}
    }
}
