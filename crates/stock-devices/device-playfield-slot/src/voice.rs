//! One Playfield slot voice, a faithful port of the TS `SampleVoice` (the inner voice of
//! `Playfield/SampleProcessor`): a pitch-rate read head over the loaded sample with linear interpolation, a
//! windowed `start`..`end` region (reversed when `end < start`), gate modes (Off / On / Loop), and a squared
//! attack / release envelope scaled by the note's velocity gain. Pure DSP over slices, so it is unit-testable
//! with synthetic frames; the device owns the sample resolution and the voice pool. Heap-free and valid when
//! zeroed (voices live in the device's zeroed state, a fixed pool).
//!
//! Parity decisions (see `plans/wasm-audio/playfield-composite.md`):
//! - the read-head `position` is f64 (sub-sample precision over long samples), the ordinary math is f32;
//! - `sign` matches JS `Math.sign` (0 at 0), not `f32::signum` (which is +1 at 0);
//! - the envelope is a plain AR with sustain at 1, gated by a `released` flag, no `Infinity` sentinel;
//! - the final sample IS written, then the voice ends (TS drops it);
//! - a zero-length window (`sign == 0`) ends the voice rather than leaving a stuck read head.

const GATE_OFF: i32 = 0;
const GATE_ON: i32 = 1;
const GATE_LOOP: i32 = 2;

/// JS `Math.sign`: -1 / 0 / +1 (NOT `f32::signum`, which returns +1 for 0.0).
fn sign(value: f64) -> f32 {
    if value > 0.0 {
        1.0
    } else if value < 0.0 {
        -1.0
    } else {
        0.0
    }
}

/// Linear interpolation of a planar buffer at a fractional position. The neighbour past the end reads 0.0
/// (TS `inp[i + 1] ?? 0`); an out-of-range base index reads 0.0 too (defensive, the gate logic keeps the base
/// in range before the voice ends).
fn sample_at(buffer: &[f32], index: usize, frac: f32) -> f32 {
    let here = buffer.get(index).copied().unwrap_or(0.0);
    let next = buffer.get(index + 1).copied().unwrap_or(0.0);
    here * (1.0 - frac) + next * frac
}

#[derive(Clone, Copy, Default)]
pub struct SlotVoice {
    used: bool,       // slot occupied: `process` runs and the device frees it when `process` returns true
    releasable: bool, // TS `#active`: guards re-release; a forced release clears it but the voice keeps ringing
    released: bool,
    id: u32,
    gate: i32,
    gain: f32,        // velocity gain (velocityToGain is identity, so the note velocity)
    attack: f32,      // attack length in samples
    release: f32,     // release length in samples (set to `fast_release` on a forced release)
    fast_release: f32, // 5 ms in samples (the gate-On tail crossfade + forced release)
    start: f64,
    end: f64,
    distance: f64,    // end - start
    sign: f32,        // Math.sign(distance): playback direction (0 => zero-length window)
    position: f64,
    env_position: f32,
    decay_position: f32,
    start_seq: u64    // monotonic note-on order, for oldest-voice stealing
}

impl SlotVoice {
    pub fn is_used(&self) -> bool {
        self.used
    }

    pub fn id(&self) -> u32 {
        self.id
    }

    pub fn start_seq(&self) -> u64 {
        self.start_seq
    }

    /// Begin a note. Snapshots every parameter except pitch (read live each block): the velocity gain, the
    /// gate mode, the attack / release in samples, and the `start`..`end` window in source frames. Mirrors the
    /// TS `SampleVoice` constructor.
    #[allow(clippy::too_many_arguments)]
    pub fn start(&mut self, id: u32, velocity: f32, gate: i32, attack_seconds: f32, release_seconds: f32,
                 sample_start: f32, sample_end: f32, num_frames: usize, sample_rate: f32, start_seq: u64) {
        let last = (num_frames - 1) as f64;
        self.used = true;
        self.releasable = true;
        self.released = false;
        self.id = id;
        self.gate = gate;
        self.gain = velocity;
        self.attack = (attack_seconds * sample_rate).max(1.0);
        self.release = (release_seconds * sample_rate).max(1.0);
        self.fast_release = (0.005 * sample_rate).max(1.0);
        self.start = last * sample_start as f64;
        self.end = last * sample_end as f64;
        self.distance = self.end - self.start;
        self.sign = sign(self.distance);
        self.position = self.start;
        self.env_position = 0.0;
        self.decay_position = 0.0;
        self.start_seq = start_seq;
    }

    /// Note-off: enter the release (only gate On / Loop respect a note-off; gate Off plays to its end).
    pub fn release(&mut self) {
        if !self.releasable {
            return;
        }
        if self.gate != GATE_OFF {
            self.release_envelope();
        }
    }

    /// Forced fast release (mono retrigger, choke, panic): shorten the release to 5 ms and decay from here,
    /// then bar further releases. The voice keeps rendering its fast tail until the envelope elapses.
    pub fn force_release(&mut self) {
        if !self.releasable {
            return;
        }
        self.release = self.fast_release;
        self.release_envelope();
        self.releasable = false;
    }

    /// Free the slot immediately (no tail), e.g. when the sample is no longer resident.
    pub fn free(&mut self) {
        self.used = false;
    }

    fn release_envelope(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        self.decay_position = if self.env_position < self.attack {
            self.env_position - self.attack
        } else {
            self.env_position
        };
    }

    /// Render additively into the stereo chunk from the planar sample (`left` / `right`, mono passes the same
    /// slice for both). `pitch_cents` is read live (the one automatable-during-the-voice parameter). Returns
    /// `true` once finished, so the device frees the slot. Mirrors TS `processAdd`, with the parity decisions
    /// noted in the module docs.
    #[allow(clippy::too_many_arguments)]
    pub fn process(&mut self, out_left: &mut [f32], out_right: &mut [f32], left: &[f32], right: &[f32],
                   num_frames: usize, src_rate: f32, engine_rate: f32, pitch_cents: f32) -> bool {
        let pitch_factor = libm::exp2f(pitch_cents / 1200.0) as f64;
        let rate_ratio = (src_rate as f64 / engine_rate as f64) * self.sign as f64 * pitch_factor;
        for index in 0..out_left.len() {
            let int_position = self.position as usize;
            let frac = (self.position - int_position as f64) as f32;
            let sample_left = sample_at(left, int_position, frac);
            let sample_right = sample_at(right, int_position, frac);
            let attack_term = self.env_position / self.attack;
            let mut env = if self.released {
                let release_term = 1.0 - (self.env_position - (self.decay_position + self.attack)) / self.release;
                attack_term.min(release_term).min(1.0)
            } else {
                attack_term.min(1.0)
            };
            self.position += rate_ratio;
            let mut finished = false;
            if self.sign > 0.0 {
                match self.gate {
                    GATE_OFF => {
                        if self.position >= num_frames as f64 {
                            finished = true;
                        } else if !self.released && self.position >= self.end {
                            self.release_envelope();
                        }
                    }
                    GATE_ON => {
                        if self.position >= self.end - self.fast_release as f64 {
                            env *= ((self.end - self.position) as f32 / self.fast_release).max(0.0);
                            if self.position >= self.end {
                                finished = true;
                            }
                        }
                    }
                    GATE_LOOP => {
                        while self.position >= self.end {
                            self.position -= self.distance;
                        }
                    }
                    _ => {}
                }
            } else if self.sign < 0.0 {
                match self.gate {
                    GATE_OFF => {
                        if self.position <= 0.0 {
                            finished = true;
                        } else if !self.released && self.position <= self.end {
                            self.release_envelope();
                        }
                    }
                    GATE_ON => {
                        if self.position <= self.end + self.fast_release as f64 {
                            env *= ((self.end - self.position) as f32 / self.fast_release).max(0.0);
                            if self.position <= self.end {
                                finished = true;
                            }
                        }
                    }
                    GATE_LOOP => {
                        while self.position <= self.end {
                            self.position -= self.distance;
                        }
                    }
                    _ => {}
                }
            } else {
                // Zero-length window: the read head cannot advance. End the voice (the guard).
                finished = true;
            }
            self.env_position += 1.0;
            if self.released && self.env_position - self.decay_position > self.attack + self.release {
                finished = true;
            }
            let shaped = self.gain * env * env;
            out_left[index] += sample_left * shaped;
            out_right[index] += sample_right * shaped;
            if finished {
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::SlotVoice;

    const SR: f32 = 48_000.0;

    fn started(gate: i32, start: f32, end: f32, num_frames: usize) -> SlotVoice {
        let mut voice = SlotVoice::default();
        // attack 0.001 s, release 0.020 s, full velocity, no start_seq. The window is sized off `num_frames`,
        // so a test must pass the same `num_frames` to `process` for the read head and buffer to agree.
        voice.start(1, 1.0, gate, 0.001, 0.020, start, end, num_frames, SR, 0);
        voice
    }

    fn peak(buffer: &[f32]) -> f32 {
        buffer.iter().fold(0.0f32, |acc, value| acc.max(value.abs()))
    }

    #[test]
    fn gate_off_plays_to_the_end_and_finishes() {
        let mut voice = started(0, 0.0, 1.0, 64);
        let frames = vec![1.0f32; 64];
        let (mut left, mut right) = (vec![0.0f32; 256], vec![0.0f32; 256]);
        // 64-frame sample at native rate finishes within a 256-sample chunk.
        assert!(voice.process(&mut left, &mut right, &frames, &frames, 64, SR, SR, 0.0), "ends past the last frame");
    }

    #[test]
    fn attack_ramps_in_from_silence_and_is_squared() {
        let mut voice = started(0, 0.0, 1.0, 48_000);
        let frames = vec![1.0f32; 48_000];
        let (mut left, mut right) = (vec![0.0f32; 64], vec![0.0f32; 64]);
        assert!(!voice.process(&mut left, &mut right, &frames, &frames, 48_000, SR, SR, 0.0), "still sounding");
        assert!(left[0].abs() < 1.0e-6, "starts at silence (env 0)");
        assert!(left[63] > left[0], "ramps up across the attack");
        assert_eq!(left, right, "a mono sample feeds both channels equally");
    }

    #[test]
    fn pitch_cents_sets_the_rate_an_octave_up_doubles_it() {
        // A ramp sample (value == index) so the read position is observable as the output value at env 1.
        let frames: Vec<f32> = (0..4_000).map(|index| index as f32).collect();
        let mut native = started(0, 0.0, 1.0, 4_000);
        let mut octave = started(0, 0.0, 1.0, 4_000);
        let (mut l0, mut r0) = (vec![0.0f32; 1_000], vec![0.0f32; 1_000]);
        let (mut l1, mut r1) = (vec![0.0f32; 1_000], vec![0.0f32; 1_000]);
        native.process(&mut l0, &mut r0, &frames, &frames, 4_000, SR, SR, 0.0);
        octave.process(&mut l1, &mut r1, &frames, &frames, 4_000, SR, SR, 1200.0);
        // Past the attack the envelope is ~1; the octave-up voice has advanced ~twice as far.
        assert!(l1[900] > l0[900] * 1.8, "an octave up (1200 cents) roughly doubles the read rate");
    }

    #[test]
    fn reverse_window_plays_backwards_and_finishes_at_zero() {
        // end < start => reverse playback, ending when the head reaches 0.
        let mut voice = started(0, 1.0, 0.0, 4_000);
        let frames = vec![1.0f32; 4_000];
        let (mut left, mut right) = (vec![0.0f32; 8_000], vec![0.0f32; 8_000]);
        assert!(voice.process(&mut left, &mut right, &frames, &frames, 4_000, SR, SR, 0.0), "reverse run reaches 0 and ends");
    }

    #[test]
    fn gate_loop_wraps_and_keeps_sounding() {
        let mut voice = started(2, 0.0, 0.5, 4_000); // loop the first half
        let frames = vec![1.0f32; 4_000];
        let (mut left, mut right) = (vec![0.0f32; 16_000], vec![0.0f32; 16_000]);
        // Far more output than the window length: a non-looping voice would have ended; the loop keeps going.
        assert!(!voice.process(&mut left, &mut right, &frames, &frames, 4_000, SR, SR, 0.0), "loop never runs out");
    }

    #[test]
    fn release_decays_to_silence_then_finishes() {
        let mut voice = started(1, 0.0, 1.0, 48_000); // gate On so note-off releases
        let frames = vec![1.0f32; 48_000];
        let (mut left, mut right) = (vec![0.0f32; 4_800], vec![0.0f32; 4_800]);
        voice.process(&mut left, &mut right, &frames, &frames, 48_000, SR, SR, 0.0); // past the attack
        voice.release();
        let (mut tail_left, mut tail_right) = (vec![0.0f32; 4_096], vec![0.0f32; 4_096]);
        let finished = voice.process(&mut tail_left, &mut tail_right, &frames, &frames, 48_000, SR, SR, 0.0);
        assert!(finished, "the release elapses within the chunk");
        assert!(peak(&tail_left[2_048..]) < 1.0e-6, "silent once released");
    }

    #[test]
    fn zero_length_window_ends_the_voice() {
        let mut voice = started(2, 0.5, 0.5, 4_000); // start == end, gate Loop (the would-be hang)
        let frames = vec![1.0f32; 4_000];
        let (mut left, mut right) = (vec![0.0f32; 256], vec![0.0f32; 256]);
        assert!(voice.process(&mut left, &mut right, &frames, &frames, 4_000, SR, SR, 0.0), "a zero-length window ends at once");
    }
}
