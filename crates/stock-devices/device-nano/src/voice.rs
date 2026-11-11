//! The Nano sampler's per-note voice: a pitch-rate read head over the loaded sample with linear interpolation
//! and a squared attack/release envelope, transposed against a root key and octave, confined to a start/end
//! region (start past end plays backwards) and optionally cycling a crossfaded loop range. Pure DSP over
//! slices, heap-free and valid when zeroed (voices live in the device's zeroed state, a fixed pool).

/// The device's live playback settings a voice renders against, refreshed every block.
#[derive(Clone, Copy)]
pub struct Playback {
    pub rate_ratio: f64, // sample rate / engine rate
    pub root_key: i32,
    pub octave: i32,
    pub tune_cents: f32,
    pub gain: f32,
    pub attack: u32,  // in engine samples
    pub release: u32, // in engine samples
    pub sample_start: f32, // unit region, start > end plays backwards
    pub sample_end: f32,
    pub loop_enabled: bool,
    pub loop_fade_frames: f64, // crossfade length in source frames
    pub loop_start: f32, // unit loop range, clamped inside the region
    pub loop_end: f32,
    pub one_shot: bool, // a note-off is ignored unless the loop is on
    pub fixed_pitch: bool, // every note plays at the root key
    pub tail: bool, // the region end releases a one-shot and fades out a gated voice instead of cutting it
    pub end_fade: u32 // the gated tail fade in engine samples
}

impl Playback {
    fn releases_on_note_off(&self) -> bool {
        releases_on_note_off(self.one_shot, self.loop_enabled)
    }
}

/// A looping voice would never end by itself, so one-shot only holds a note while the loop is off.
pub fn releases_on_note_off(one_shot: bool, loop_enabled: bool) -> bool {
    !one_shot || loop_enabled
}

/// The read-head rate for `pitch` (pitch + cent/100): `2^(pitch/12 - (root_key/12 - octave - tune/1200))`, so
/// the root key reads at the native rate (bit-identical to the original `2^(pitch/12 - 5)` at root key 60,
/// octave 0, tune 0).
pub fn rate(pitch: f32, root_key: i32, octave: i32, tune_cents: f32) -> f32 {
    libm::exp2f(pitch / 12.0 - (root_key as f32 / 12.0 - octave as f32 - tune_cents / 1200.0))
}

#[derive(Clone, Copy, Default)]
pub struct NanoVoice {
    active: bool,
    id: u32,
    pitch: f32, // pitch + cent/100
    velocity: f32,
    initialized: bool, // the region resolves against the sample on the first processed chunk
    start: f64, // region bounds in source frames, fixed for the note once resolved
    end: f64,
    position: f64, // read head in source frames (f64 for precision over long samples)
    env_position: u32,
    decay_position: u32, // the env position at note-off (only meaningful once `releasing`)
    released_level: f32, // the (pre-square) envelope level at note-off; the release decays from it
    releasing: bool,
    held: bool, // until its note-off arrives
    level: f32, // the (pre-square) envelope level of the last rendered sample
    fast_release: u32, // a forced release length in engine samples, 0 when none
    seq: u64 // start order, the oldest voice is stolen when the pool is full
}

impl NanoVoice {
    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn id(&self) -> u32 {
        self.id
    }

    /// The read head in source frames (the positions broadcast the editor paints as playheads).
    pub fn position(&self) -> f64 {
        self.position
    }

    pub fn seq(&self) -> u64 {
        self.seq
    }

    /// Begin a note. The read rate follows the live root key / octave (see [`rate`]).
    pub fn start(&mut self, id: u32, pitch: u32, cent: f32, velocity: f32, seq: u64) {
        self.active = true;
        self.held = true;
        self.level = 0.0;
        self.fast_release = 0;
        self.seq = seq;
        self.id = id;
        self.pitch = pitch as f32 + cent / 100.0;
        self.velocity = velocity;
        self.initialized = false;
        self.start = 0.0;
        self.end = 0.0;
        self.position = 0.0;
        self.env_position = 0;
        self.decay_position = 0;
        self.released_level = 0.0;
        self.releasing = false;
    }

    /// Note-off: capture the envelope level reached (the attack may still be ramping) and decay from it, so
    /// the output never rises after note-off.
    pub fn stop(&mut self, attack: u32) {
        if self.releasing {
            return;
        }
        self.releasing = true;
        self.decay_position = self.env_position;
        self.released_level = if self.env_position < attack {self.env_position as f32 / attack as f32} else {1.0};
    }

    /// The note-off of this voice's note: releases unless the voice plays one-shot (see [`Playback`]).
    pub fn note_off(&mut self, attack: u32, release: bool) {
        self.held = false;
        if release {
            self.stop(attack);
        }
    }

    /// Mono retrigger or choke: decay from the current level over `fast_release` samples, also mid-release.
    pub fn force_release(&mut self, fast_release: u32) {
        if self.fast_release > 0 {
            return;
        }
        self.releasing = true;
        self.decay_position = self.env_position;
        self.released_level = self.level;
        self.fast_release = fast_release.max(1);
    }

    /// Free the slot immediately.
    pub fn force_stop(&mut self) {
        self.active = false;
    }

    /// Render additively into the stereo chunk from the planar sample (`left` / `right`, mono passes the same
    /// slice for both). Returns `true` once finished (the region ran out unlooped, or the release elapsed).
    pub fn process(&mut self, out_left: &mut [f32], out_right: &mut [f32], left: &[f32], right: &[f32], playback: &Playback) -> bool {
        let num_frames = left.len();
        if num_frames < 2 {
            return true;
        }
        let full_span = (num_frames - 1) as f64;
        if !self.initialized {
            self.start = playback.sample_start as f64 * full_span;
            self.end = playback.sample_end as f64 * full_span;
            self.position = self.start;
            self.initialized = true;
        }
        let backwards = self.end < self.start;
        let (lo, hi) = if backwards {(self.end, self.start)} else {(self.start, self.end)};
        if hi - lo < 1.0 {
            return true;
        }
        let loop_a = playback.loop_start as f64 * full_span;
        let loop_b = playback.loop_end as f64 * full_span;
        let mut loop_lo = loop_a.min(loop_b).max(lo);
        let mut loop_hi = loop_a.max(loop_b).min(hi);
        if loop_hi - loop_lo < 1.0 {
            loop_lo = lo;
            loop_hi = hi;
        }
        let loop_enabled = playback.loop_enabled;
        let loop_span = loop_hi - loop_lo;
        let fade = if loop_enabled {playback.loop_fade_frames.min(loop_span * 0.5)} else {0.0};
        let shift = loop_span - fade; // >= loop_span/2, so wrapping always advances
        if !self.held && !self.releasing && playback.releases_on_note_off() {
            self.stop(playback.attack);
        }
        let pitch = if playback.fixed_pitch {playback.root_key as f32} else {self.pitch};
        let speed = rate(pitch, playback.root_key, playback.octave, playback.tune_cents);
        let increment = speed as f64 * playback.rate_ratio * if backwards {-1.0} else {1.0};
        let attack = playback.attack.max(1);
        let release = if self.fast_release > 0 {self.fast_release} else {playback.release.max(1)};
        let release_inverse = 1.0 / release as f32;
        let gain = playback.gain * self.velocity;
        let one_shot_tail = playback.tail && !playback.releases_on_note_off();
        let gated_tail = playback.tail && !loop_enabled && playback.releases_on_note_off();
        let end_fade = playback.end_fade.max(1) as f64;
        for index in 0..out_left.len() {
            if loop_enabled {
                if backwards && self.position <= loop_lo {
                    let wraps = libm::floor((loop_lo - self.position) / shift) + 1.0;
                    self.position += wraps * shift;
                } else if !backwards && self.position >= loop_hi {
                    let wraps = libm::floor((self.position - loop_hi) / shift) + 1.0;
                    self.position -= wraps * shift;
                }
            } else if if backwards {self.position <= lo} else {self.position >= hi} {
                if !one_shot_tail || (backwards && self.position <= 0.0) {
                    return true;
                }
                self.stop(playback.attack);
            }
            let int_position = self.position as usize;
            if int_position >= num_frames {
                return true; // past the CURRENT sample (it was swapped mid-note for a shorter one)
            }
            let partner = if int_position + 1 < num_frames {int_position + 1} else {int_position};
            let frac = (self.position - int_position as f64) as f32;
            let shaped = if self.releasing {
                self.released_level * (1.0 - (self.env_position - self.decay_position) as f32 * release_inverse).min(1.0).max(0.0)
            } else if self.env_position < attack {
                self.env_position as f32 / attack as f32
            } else {
                1.0
            };
            self.level = shaped;
            let faded = if gated_tail {
                let distance = (if backwards {self.position + increment - lo} else {hi - self.position - increment}) / increment.abs();
                if distance < end_fade {shaped * (distance.max(0.0) / end_fade) as f32} else {shaped}
            } else {
                shaped
            };
            let env = faded * faded;
            let mut sample_left = left[int_position] * (1.0 - frac) + left[partner] * frac;
            let mut sample_right = right[int_position] * (1.0 - frac) + right[partner] * frac;
            if loop_enabled {
                let cross = if backwards {
                    let zone_end = loop_lo + fade;
                    if self.position >= loop_lo && self.position < zone_end {Some(((zone_end - self.position) / fade, self.position + shift))} else {None}
                } else {
                    let zone_start = loop_hi - fade;
                    if self.position >= zone_start && self.position < loop_hi {Some(((self.position - zone_start) / fade, self.position - shift))} else {None}
                };
                if let Some((mix, other_position)) = cross {
                    let other_int = other_position as usize;
                    if other_int + 1 < num_frames {
                        let other_frac = (other_position - other_int as f64) as f32;
                        let mix = mix as f32;
                        let other_left = left[other_int] * (1.0 - other_frac) + left[other_int + 1] * other_frac;
                        let other_right = right[other_int] * (1.0 - other_frac) + right[other_int + 1] * other_frac;
                        sample_left = sample_left * (1.0 - mix) + other_left * mix;
                        sample_right = sample_right * (1.0 - mix) + other_right * mix;
                    }
                }
            }
            out_left[index] += sample_left * gain * env;
            out_right[index] += sample_right * gain * env;
            self.position += increment;
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
    use super::{rate, NanoVoice, Playback};

    const SR: f32 = 48_000.0;

    fn playback(sample_start: f32, sample_end: f32) -> Playback {
        Playback {
            rate_ratio: 1.0, root_key: 60, octave: 0, tune_cents: 0.0, gain: 1.0, attack: (0.003 * SR) as u32, release: 4_800, sample_start, sample_end,
            loop_enabled: false, loop_fade_frames: 0.0, loop_start: 0.0, loop_end: 1.0, one_shot: false, fixed_pitch: false,
            tail: false, end_fade: 240
        }
    }

    fn looped(sample_start: f32, sample_end: f32, loop_start: f32, loop_end: f32, fade: f64) -> Playback {
        Playback {loop_enabled: true, loop_fade_frames: fade, loop_start, loop_end, ..playback(sample_start, sample_end)}
    }

    fn started(pitch: u32) -> NanoVoice {
        let mut voice = NanoVoice::default();
        voice.start(7, pitch, 0.0, 1.0, 0);
        voice
    }

    // A ramp sample (frame index / count), so read direction shows in the output shape.
    fn ramp(frames: usize) -> Vec<f32> {
        (0..frames).map(|index| index as f32 / frames as f32).collect()
    }

    fn dc(frames: usize) -> Vec<f32> {
        vec![1.0f32; frames]
    }

    fn peak(buffer: &[f32]) -> f32 {
        buffer.iter().fold(0.0f32, |acc, value| acc.max(value.abs()))
    }

    fn run(voice: &mut NanoVoice, frames: &[f32], playback: &Playback, count: usize) -> (Vec<f32>, bool) {
        let (mut left, mut right) = (vec![0.0f32; count], vec![0.0f32; count]);
        let finished = voice.process(&mut left, &mut right, frames, frames, playback);
        (left, finished)
    }

    #[test]
    fn the_root_key_reads_at_the_native_rate() {
        assert!((rate(60.0, 60, 0, 0.0) - 1.0).abs() < 1.0e-6, "playing the root is rate 1.0");
        assert!((rate(69.0, 57, 0, 0.0) - 2.0).abs() < 1.0e-6, "an octave over the root doubles");
        assert!((rate(45.0, 45, 1, 0.0) - 2.0).abs() < 1.0e-6, "the octave shift stacks on top");
        assert!((rate(33.0, 45, 0, 0.0) - 0.5).abs() < 1.0e-6, "an octave under the root halves");
        assert!((rate(60.0, 60, 0, 1200.0) - 2.0).abs() < 1.0e-6, "+1200 cents doubles");
        assert!((rate(60.0, 60, 0, -1200.0) - 0.5).abs() < 1.0e-6, "-1200 cents halves");
        assert!((rate(60.0, 60, 0, 100.0) - rate(61.0, 60, 0, 0.0)).abs() < 1.0e-6, "100 cents is a semitone");
    }

    #[test]
    fn the_rate_at_root_key_60_is_bit_identical_to_the_original_formula() {
        for pitch in 0..128u32 {
            for cent in [-99.0f32, -37.0, 0.0, 12.5, 50.0, 99.0] {
                let legacy = libm::exp2f((pitch as f32 + cent / 100.0) / 12.0 - 5.0);
                assert_eq!(rate(pitch as f32 + cent / 100.0, 60, 0, 0.0).to_bits(), legacy.to_bits(), "pitch {pitch} cent {cent}");
            }
        }
    }

    #[test]
    fn a_root_key_change_retunes_a_held_note() {
        let frames = ramp(48_000);
        let mut voice = started(60);
        run(&mut voice, &frames, &playback(0.0, 1.0), 4_800);
        let before = voice.position();
        run(&mut voice, &frames, &Playback {root_key: 48, ..playback(0.0, 1.0)}, 4_800); // an octave down = 2x rate
        assert!((voice.position() - before - 9_600.0).abs() < 1.0e-6, "the held note reads at the new rate at once");
    }

    #[test]
    fn forward_and_backward_regions_trace_the_ramp_in_opposite_directions() {
        let frames = ramp(48_000);
        let mut forward = started(60);
        run(&mut forward, &frames, &playback(0.0, 1.0), 512); // past the attack
        let (fwd, _) = run(&mut forward, &frames, &playback(0.0, 1.0), 512);
        assert!(fwd[511] > fwd[0], "forward reads rising ramp values");
        let mut backward = started(60);
        run(&mut backward, &frames, &playback(1.0, 0.0), 512);
        let (bwd, _) = run(&mut backward, &frames, &playback(1.0, 0.0), 512);
        assert!(bwd[511] < bwd[0], "start past end reads the ramp falling");
        assert!(bwd[0] > 0.9, "backwards starts at the end of the sample");
    }

    #[test]
    fn the_region_confines_the_read_head_and_ends_the_voice() {
        let frames = dc(48_000);
        let mut voice = started(60);
        let (out, finished) = run(&mut voice, &frames, &playback(0.5, 0.51), 1_024); // 480 frames wide
        assert!(finished, "a 10 ms region runs out inside the chunk");
        assert!(peak(&out[..470]) > 0.0 && peak(&out[481..]) == 0.0, "silent past the region end");
        let mut backward = started(60);
        let (out, finished) = run(&mut backward, &frames, &playback(0.51, 0.5), 1_024);
        assert!(finished, "backwards runs out at the region start");
        assert_eq!(peak(&out[481..]), 0.0);
    }

    #[test]
    fn an_empty_region_ends_the_voice_at_once() {
        let frames = dc(48_000);
        let mut voice = started(60);
        let (out, finished) = run(&mut voice, &frames, &playback(0.3, 0.3), 64);
        assert!(finished && peak(&out) == 0.0, "nothing to read");
    }

    #[test]
    fn the_region_is_captured_at_the_first_chunk() {
        let frames = ramp(48_000);
        let mut voice = started(60);
        run(&mut voice, &frames, &playback(0.0, 0.5), 256);
        let (out, finished) = run(&mut voice, &frames, &playback(0.9, 1.0), 256); // moved region, held note ignores it
        assert!(!finished && out[0] < 0.1, "the note keeps its original region");
    }

    #[test]
    fn the_attack_ramps_from_silence_and_the_release_decays_to_silence() {
        let frames = dc(48_000);
        let mut voice = started(60);
        let (out, _) = run(&mut voice, &frames, &playback(0.0, 1.0), 4_800);
        assert!(out[0].abs() < 0.01 && out[143] > out[0] && (out[200] - 1.0).abs() < 1.0e-6, "3 ms squared ramp to 1.0");
        voice.stop(144);
        let settings = Playback {release: 480, ..playback(0.0, 1.0)};
        let (tail, finished) = run(&mut voice, &frames, &settings, 1_024);
        assert!(finished, "the release elapses within the chunk");
        assert!(tail[0] > 0.99 && tail[240] < 0.3 && peak(&tail[481..]) < 1.0e-6, "decays from full level to silence");
    }

    #[test]
    fn the_release_length_is_read_live() {
        let frames = dc(48_000);
        let mut voice = started(60);
        run(&mut voice, &frames, &playback(0.0, 1.0), 4_800);
        voice.stop(144);
        let long = Playback {release: 48_000, ..playback(0.0, 1.0)};
        let (out, finished) = run(&mut voice, &frames, &long, 4_800);
        assert!(!finished && out[4_799] > 0.8, "a long release keeps the voice");
        let short = Playback {release: 100, ..playback(0.0, 1.0)};
        let (_, finished) = run(&mut voice, &frames, &short, 4_800);
        assert!(finished, "shortening the release mid-tail ends it");
    }

    #[test]
    fn a_release_during_the_attack_never_swells() {
        let frames = dc(48_000);
        let mut voice = started(60);
        let (head, _) = run(&mut voice, &frames, &playback(0.0, 1.0), 48); // a third into the 144-frame attack
        voice.stop(144);
        let (tail, _) = run(&mut voice, &frames, &playback(0.0, 1.0), 1_024);
        assert!(tail[0] > head[47] && tail[0] - head[47] < 0.01, "the release starts one attack step above the last attack sample");
        assert!(tail[1..].iter().all(|value| *value <= tail[0]), "output never rises after note-off");
    }

    #[test]
    fn a_second_stop_keeps_the_first_release() {
        let frames = dc(48_000);
        let mut voice = started(60);
        run(&mut voice, &frames, &playback(0.0, 1.0), 4_800);
        voice.stop(144);
        run(&mut voice, &frames, &playback(0.0, 1.0), 2_400);
        voice.stop(144);
        let (tail, finished) = run(&mut voice, &frames, &playback(0.0, 1.0), 4_800);
        assert!(finished && tail[0] < 0.3, "the second stop does not restart the release");
    }

    #[test]
    fn a_looping_voice_sustains_and_stays_flat_at_the_wrap() {
        let frames = dc(48_000);
        let mut voice = started(60);
        let settings = looped(0.0, 0.1, 0.0, 1.0, 480.0); // 4800-frame region, 10 ms fade
        run(&mut voice, &frames, &settings, 4_800);
        for _ in 0..8 {
            let (out, finished) = run(&mut voice, &frames, &settings, 4_800);
            assert!(!finished, "a looping voice never runs out");
            for (index, value) in out.iter().enumerate() {
                assert!((value - 1.0).abs() < 1.0e-3, "sample {index} dips at the loop point: {value}");
            }
        }
    }

    #[test]
    fn a_looping_voice_still_ends_on_release() {
        let frames = dc(48_000);
        let mut voice = started(60);
        let settings = looped(0.0, 0.1, 0.0, 1.0, 480.0);
        run(&mut voice, &frames, &settings, 4_800);
        voice.stop(144);
        let (tail, finished) = run(&mut voice, &frames, &settings, 8_192);
        assert!(finished, "the release elapses even while looping");
        assert!(peak(&tail[4_801..]) < 1.0e-6, "silent once released");
    }

    #[test]
    fn the_inner_loop_cycles_between_the_loop_points_after_the_lead_in() {
        let frames = dc(48_000);
        let mut voice = started(60);
        let settings = looped(0.0, 1.0, 0.4, 0.6, 480.0); // 19200..28800
        for _ in 0..8 {
            let (_, finished) = run(&mut voice, &frames, &settings, 4_800);
            assert!(!finished);
        }
        let position = voice.position();
        assert!((19_200.0..28_800.5).contains(&position), "the head stays inside the loop range (at {position})");
    }

    #[test]
    fn a_backward_inner_loop_cycles_between_the_loop_points() {
        let frames = ramp(48_000);
        let mut voice = started(60);
        let settings = looped(1.0, 0.0, 0.2, 0.4, 480.0); // 9600..19200
        for _ in 0..12 {
            let (_, finished) = run(&mut voice, &frames, &settings, 4_800);
            assert!(!finished, "the backward voice stays alive cycling the inner loop");
        }
        let position = voice.position();
        assert!((9_599.5..19_200.5).contains(&position), "the backward head stays inside the loop range (at {position})");
    }

    #[test]
    fn a_degenerate_loop_range_falls_back_to_the_region() {
        let frames = dc(48_000);
        let mut voice = started(60);
        let settings = looped(0.0, 0.1, 0.5, 0.5, 480.0);
        for _ in 0..12 {
            let (_, finished) = run(&mut voice, &frames, &settings, 4_800);
            assert!(!finished, "a zero-width loop range loops the whole region instead of killing the voice");
        }
    }

    #[test]
    fn a_one_frame_loop_span_cannot_stall_the_render() {
        let frames = dc(48_000);
        let mut voice = started(84); // 4x rate stresses the wrap
        let settings = looped(0.0, 1.0, 0.0, 1.0 / 47_999.0, 480.0);
        for _ in 0..4 {
            let (_, finished) = run(&mut voice, &frames, &settings, 512);
            assert!(!finished, "the voice keeps rendering a one-frame loop");
        }
    }

    #[test]
    fn toggling_the_loop_off_mid_note_lets_the_voice_run_out() {
        let frames = dc(48_000);
        let mut voice = started(60);
        let settings = looped(0.0, 0.1, 0.0, 1.0, 480.0);
        for _ in 0..3 {
            run(&mut voice, &frames, &settings, 4_800);
        }
        let (_, finished) = run(&mut voice, &frames, &playback(0.0, 0.1), 4_800);
        assert!(finished, "without the loop the region end frees the voice");
    }

    #[test]
    fn a_shrunken_sample_mid_note_cannot_read_out_of_bounds() {
        let frames = dc(48_000);
        let mut voice = started(72); // 4x rate, far into the sample quickly
        let fast = Playback {octave: 1, ..playback(0.0, 1.0)};
        run(&mut voice, &frames, &fast, 4_096);
        let swapped = dc(1_024);
        let (_, finished) = run(&mut voice, &swapped, &fast, 4_096);
        assert!(finished, "the frame clamp ends the voice instead of reading past the new sample");
    }

    #[test]
    fn shortening_the_release_mid_tail_never_spikes() {
        let frames = dc(48_000);
        let mut voice = started(60);
        run(&mut voice, &frames, &playback(0.0, 1.0), 4_800);
        voice.stop(144);
        run(&mut voice, &frames, &Playback {release: 48_000, ..playback(0.0, 1.0)}, 4_800);
        let (out, finished) = run(&mut voice, &frames, &Playback {release: 100, ..playback(0.0, 1.0)}, 64);
        assert!(finished && peak(&out) <= 1.0, "an elapsed release writes nothing above full level (peak {})", peak(&out));
    }

    #[test]
    fn a_one_shot_ignores_the_note_off_and_plays_to_the_region_end() {
        let frames = dc(4_800);
        let mut voice = started(60);
        let settings = Playback {one_shot: true, ..playback(0.0, 1.0)};
        run(&mut voice, &frames, &settings, 480);
        voice.note_off(settings.attack, settings.releases_on_note_off());
        let (out, finished) = run(&mut voice, &frames, &settings, 2_400);
        assert!(!finished && (out[2_399] - 1.0).abs() < 1.0e-6, "still at full level after the note-off");
        let (_, finished) = run(&mut voice, &frames, &settings, 4_800);
        assert!(finished, "the region end frees the one-shot voice");
    }

    #[test]
    fn a_looping_one_shot_still_releases() {
        let frames = dc(48_000);
        let mut voice = started(60);
        let settings = Playback {one_shot: true, ..looped(0.0, 0.1, 0.0, 1.0, 480.0)};
        run(&mut voice, &frames, &settings, 4_800);
        voice.note_off(settings.attack, settings.releases_on_note_off());
        let (_, finished) = run(&mut voice, &frames, &Playback {release: 480, ..settings}, 4_800);
        assert!(finished, "a loop never ends by itself, so the note-off releases it");
    }

    #[test]
    fn switching_one_shot_off_releases_a_note_already_let_go() {
        let frames = dc(48_000);
        let mut voice = started(60);
        let one_shot = Playback {one_shot: true, release: 480, ..playback(0.0, 1.0)};
        run(&mut voice, &frames, &one_shot, 480);
        voice.note_off(one_shot.attack, one_shot.releases_on_note_off());
        let (_, finished) = run(&mut voice, &frames, &Playback {one_shot: false, ..one_shot}, 4_800);
        assert!(finished, "the pending note-off applies once one-shot is off");
    }

    #[test]
    fn with_fixed_pitch_every_note_plays_at_the_root_rate() {
        let frames = ramp(48_000);
        let fixed = Playback {fixed_pitch: true, ..playback(0.0, 1.0)};
        for pitch in [36, 60, 84] {
            let mut voice = started(pitch);
            run(&mut voice, &frames, &fixed, 4_800);
            assert!((voice.position() - 4_800.0).abs() < 1.0e-6, "pitch {pitch} reads at the native rate");
        }
        let mut tuned = started(84);
        run(&mut tuned, &frames, &Playback {octave: 1, ..fixed}, 4_800);
        assert!((tuned.position() - 9_600.0).abs() < 1.0e-6, "octave and tune still apply");
    }

    #[test]
    fn a_forced_release_fades_out_from_the_current_level() {
        let frames = dc(48_000);
        let mut voice = started(60);
        let (head, _) = run(&mut voice, &frames, &playback(0.0, 1.0), 48); // inside the attack
        voice.force_release(240);
        let (tail, finished) = run(&mut voice, &frames, &Playback {release: 48_000, ..playback(0.0, 1.0)}, 512);
        assert!(finished, "the 240-sample fast release overrides the long release");
        assert!((tail[0] - head[47]).abs() < 1.0e-6, "continues from the last level");
        assert!(tail[1..].iter().all(|value| *value <= tail[0]) && peak(&tail[241..]) == 0.0);
    }

    #[test]
    fn a_forced_release_shortens_a_running_release() {
        let frames = dc(48_000);
        let mut voice = started(60);
        let slow = Playback {release: 48_000, ..playback(0.0, 1.0)};
        run(&mut voice, &frames, &slow, 4_800);
        voice.stop(144);
        let (before, _) = run(&mut voice, &frames, &slow, 4_800);
        voice.force_release(240);
        let (tail, finished) = run(&mut voice, &frames, &slow, 512);
        assert!(finished && tail[0] <= before[4_799] && peak(&tail[241..]) == 0.0, "fades from the release level, no jump");
    }

    #[test]
    fn a_one_shot_tail_releases_at_the_region_end_and_reads_on() {
        let frames = dc(48_000);
        let settings = Playback {one_shot: true, tail: true, release: 480, ..playback(0.0, 0.1)};
        let mut voice = started(60);
        let (out, finished) = run(&mut voice, &frames, &settings, 8_192);
        assert!(finished, "the release elapses past the region end");
        assert!((out[4_700] - 1.0).abs() < 1.0e-6 && out[4_900] > 0.1 && out[4_900] < 1.0, "decays while reading past the region end");
        assert!(out[4_800..5_300].windows(2).all(|pair| pair[1] <= pair[0]), "the tail never rises");
        assert!(peak(&out[5_300..]) == 0.0, "silent once the release elapsed");
        let mut cut = started(60);
        let (out, finished) = run(&mut cut, &frames, &Playback {tail: false, ..settings}, 8_192);
        assert!(finished && peak(&out[4_801..]) == 0.0, "without the tail the region end cuts");
    }

    #[test]
    fn a_one_shot_tail_stops_at_the_sample_bounds() {
        let frames = dc(4_800);
        let settings = Playback {one_shot: true, tail: true, release: 48_000, ..playback(0.0, 0.9)};
        let mut voice = started(60);
        let (out, finished) = run(&mut voice, &frames, &settings, 8_192);
        assert!(finished && out[4_700] > 0.0 && peak(&out[4_800..]) == 0.0, "the long release ends at the last frame");
        let mut backward = started(60);
        let (out, finished) = run(&mut backward, &frames, &Playback {sample_start: 0.5, sample_end: 0.1, ..settings}, 8_192);
        assert!(finished && out[2_300] > 0.0 && peak(&out[2_400..]) == 0.0, "backwards ends at the first frame");
    }

    #[test]
    fn a_gated_tail_fades_out_before_the_region_end() {
        let frames = dc(48_000);
        let settings = Playback {tail: true, ..playback(0.0, 0.1)};
        let mut voice = started(60);
        let (out, finished) = run(&mut voice, &frames, &settings, 8_192);
        assert!(finished, "the region end still ends the voice");
        assert!((out[4_500] - 1.0).abs() < 1.0e-6, "full level before the fade");
        assert!(out[4_680] < 0.5 && out[4_680] > 0.0 && out[4_798] < 1.0e-3, "fades to silence over the last 5 ms");
        assert!(out[4_561..4_800].windows(2).all(|pair| pair[1] <= pair[0]), "the fade never rises");
        let mut held = started(60);
        let (out, _) = run(&mut held, &frames, &Playback {loop_enabled: true, ..settings}, 8_192);
        assert!(out[4_798] > 0.9, "a looping voice never fades at the region end");
    }

    #[test]
    fn a_gated_tail_fade_lasts_five_ms_at_any_rate() {
        let frames = dc(48_000);
        let settings = Playback {tail: true, octave: 1, ..playback(0.0, 0.2)};
        let mut voice = started(60);
        let (out, finished) = run(&mut voice, &frames, &settings, 8_192);
        assert!(finished, "the doubled rate reaches the region end after 4800 samples");
        assert!((out[4_550] - 1.0).abs() < 1.0e-6 && out[4_620] < 1.0, "the fade spans 240 output samples");
    }

    #[test]
    fn a_stereo_sample_feeds_each_channel_its_own_plane() {
        let left = dc(4_800);
        let right: Vec<f32> = vec![0.5f32; 4_800];
        let mut voice = started(60);
        let (mut out_left, mut out_right) = (vec![0.0f32; 1_024], vec![0.0f32; 1_024]);
        voice.process(&mut out_left, &mut out_right, &left, &right, &playback(0.0, 1.0));
        assert!((out_left[500] - 1.0).abs() < 1.0e-6 && (out_right[500] - 0.5).abs() < 1.0e-6);
    }
}
