//! Metronome, ported from core-processors `Metronome.ts`: per-block beat scheduling over the
//! SIGNATURE TRACK's accumulated events (beat indices reset at each signature event), honoring the
//! preferences `beatSubDivision`, `gain` (dB) and `monophonic` (a new click fades every sounding one
//! out over 5 ms). Two click sounds — synthesized defaults (880 Hz downbeat / 440 Hz beat),
//! replaceable by uploaded PCM (`load_click_sound`) played back with linear-interpolated resampling
//! from the sound's own sample rate, exactly like the TS `Click`.
//!
//! `no_std`: no `f32`/`f64` std methods — `math::floor`-based helpers + `dsp::fast_sin`.

use alloc::vec::Vec;
use dsp::{db_to_gain, fast_sin, PI};
use engine_env::ppqn::{from_signature, pulses_to_samples};
use math::floor;
use transport::transport::Block;
use crate::signature_track::SignatureEvent;

const TAU: f32 = 2.0 * PI;

fn ceil(value: f64) -> f64 {
    -floor(-value)
}

/// JS `Math.round` (half toward +infinity) — exact for the NEGATIVE count-in beat indices too,
/// where libm's half-away-from-zero would differ.
fn js_round(value: f64) -> f64 {
    floor(value + 0.5)
}

/// A click's PCM (TS `AudioData`): planar frames at the sound's OWN sample rate (playback resamples).
pub struct ClickSound {
    frames: Vec<f32>,
    frame_count: usize,
    channels: usize,
    sample_rate: f32
}

impl ClickSound {
    pub fn new(frames: Vec<f32>, frame_count: usize, channels: usize, sample_rate: f32) -> Self {
        Self {frames, frame_count, channels, sample_rate}
    }

    /// The synthesized default (TS `createDefaultClickSounds`): a 2 ms attack + 50 ms release sine
    /// burst with a squared envelope, mono at the engine's sample rate.
    fn create(frequency: f32, sample_rate: f32) -> Self {
        let attack = (0.002 * sample_rate) as usize;
        let release = (0.050 * sample_rate) as usize;
        let count = attack + release;
        let mut frames = Vec::with_capacity(count);
        let increment = TAU * frequency / sample_rate;
        let mut phase = 0.0f32;
        for index in 0..count {
            let rising = index as f32 / attack as f32;
            let falling = 1.0 - (index as f32 - attack as f32) / release as f32;
            let envelope = if rising < falling {rising} else {falling};
            frames.push(fast_sin(phase) * envelope * envelope);
            phase += increment;
            if phase > PI {
                phase -= TAU
            }
        }
        Self {frames, frame_count: count, channels: 1, sample_rate}
    }
}

struct Click {
    sound_index: usize,
    position: f64,
    start_index: usize,
    fade_out_position: i32, // -1 = not fading; >= 0 counts the 5 ms monophonic fade (TS #fadeOutPosition)
    gain_db: f32
}

impl Click {
    /// Start the 5 ms fade-out (TS `Click.fadeOut`), idempotent.
    fn fade_out(&mut self) {
        if self.fade_out_position < 0 {
            self.fade_out_position = 0;
        }
    }

    /// Mix the click into both channels with linear-interpolated resampling (TS `Click.processAdd`).
    /// Returns true once exhausted (or the fade-out completed).
    fn process_add(&mut self, sounds: &[ClickSound; 2], fade_out_duration: i32, sample_rate: f32,
                   left: &mut [f32], right: &mut [f32]) -> bool {
        let sound = &sounds[self.sound_index];
        if sound.frame_count < 2 {
            return true; // the interpolation reads frame pInt+1; a <2-frame sound has nothing to play
        }
        let gain = db_to_gain(self.gain_db);
        let plane1 = if sound.channels > 1 {sound.frame_count} else {0};
        let ratio = (sound.sample_rate / sample_rate) as f64;
        let is_fading_out = self.fade_out_position >= 0;
        let mut fade_gain = 1.0f32;
        for index in self.start_index..left.len() {
            let p_int = self.position as usize;
            let p_alpha = (self.position - p_int as f64) as f32;
            if is_fading_out {
                fade_gain = 1.0 - self.fade_out_position as f32 / fade_out_duration as f32;
                self.fade_out_position += 1;
                if self.fade_out_position >= fade_out_duration {
                    return true;
                }
            }
            let left_a = sound.frames[p_int];
            let left_b = sound.frames[p_int + 1];
            let right_a = sound.frames[plane1 + p_int];
            let right_b = sound.frames[plane1 + p_int + 1];
            left[index] += (left_a + p_alpha * (left_b - left_a)) * gain * fade_gain;
            right[index] += (right_a + p_alpha * (right_b - right_a)) * gain * fade_gain;
            self.position += ratio;
            if self.position >= (sound.frame_count - 1) as f64 {
                return true;
            }
        }
        self.start_index = 0;
        false
    }
}

pub struct Metronome {
    sounds: [ClickSound; 2],
    clicks: Vec<Click>,
    fade_out_duration: i32, // 5 ms in samples (TS Click.FadeOutDuration)
    beat_sub_division: i32,
    gain_db: f32,
    monophonic: bool,
    sample_rate: f32,
    enabled: bool
}

impl Metronome {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            sounds: [ClickSound::create(880.0, sample_rate), ClickSound::create(440.0, sample_rate)],
            clicks: Vec::with_capacity(64), // click tails incl. subdivisions + fading monophonic cuts; pre-reserved so render (all but) never reallocs
            fade_out_duration: (0.005 * sample_rate) as i32,
            beat_sub_division: 1, // preferences defaults (EngineSettingsSchema.metronome); live values arrive via the setters
            gain_db: -6.0,
            monophonic: true,
            sample_rate,
            enabled: true
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled
    }

    pub fn set_gain(&mut self, gain_db: f32) {
        self.gain_db = gain_db
    }

    pub fn set_beat_sub_division(&mut self, division: u32) {
        if division > 0 {
            self.beat_sub_division = division as i32
        }
    }

    pub fn set_monophonic(&mut self, monophonic: bool) {
        self.monophonic = monophonic
    }

    /// Replace a click sound (TS `loadClickSound`): 0 the downbeat, 1 the beat.
    pub fn load_click_sound(&mut self, index: usize, sound: ClickSound) {
        if index < 2 {
            self.sounds[index] = sound
        }
    }

    /// TS `Metronome.process` per block: walk the accumulated signature events PAIR-WISE
    /// (`Iterables.pairWise(signatureTrack.iterateAll())`), schedule a click per (sub-divided) beat in
    /// `[p0, p1)` — the beat index resets at each signature event and accents the bar start
    /// (`beatIndex % nominator == 0`) — then mix the active clicks additively into the
    /// (already-cleared) output. `signature` is never empty: entry 0 is the storage signature
    /// (index -1) at pulse 0.
    pub fn process(&mut self, block: &Block, signature: &[SignatureEvent], left: &mut [f32], right: &mut [f32]) {
        if self.enabled {
            for (pair, curr) in signature.iter().enumerate() {
                let next = signature.get(pair + 1);
                let signature_start = curr.accumulated_ppqn;
                let signature_end = next.map_or(f64::INFINITY, |event| event.accumulated_ppqn);
                if signature_end <= block.p0 {
                    continue;
                }
                if signature_start >= block.p1 && curr.index != -1 {
                    break;
                }
                // the storage entry covers the count-in's NEGATIVE pulses too (TS: index -1 -> p0 as-is)
                let region_start = if curr.index == -1 || block.p0 > signature_start {block.p0} else {signature_start};
                let region_end = if block.p1 < signature_end {block.p1} else {signature_end};
                let denominator = curr.denominator * self.beat_sub_division;
                let step_size = from_signature(1, denominator);
                if step_size <= 0.0 {
                    continue; // unreachable for the schema's positive signatures; guards the loop below
                }
                let offset = region_start - signature_start;
                let first_beat_index = ceil(offset / step_size);
                let mut position = signature_start + first_beat_index * step_size;
                while position < region_end {
                    let distance = floor(pulses_to_samples(position - block.p0, block.bpm, self.sample_rate)) as usize;
                    let beat_index = js_round((position - signature_start) / step_size) as i64;
                    // JS `%` (truncated): a NEGATIVE count-in beat hits 0 only at exact bar multiples.
                    let click_index = if beat_index % curr.nominator as i64 == 0 {0} else {1};
                    if self.monophonic {
                        for click in self.clicks.iter_mut() {
                            click.fade_out();
                        }
                    }
                    if distance < left.len() { // TS asserts startIndex < RenderQuantum; rounding stays inside the block
                        self.clicks.push(Click {sound_index: click_index, position: 0.0, start_index: distance, fade_out_position: -1, gain_db: self.gain_db});
                    }
                    position += step_size;
                }
            }
        }
        let sounds = &self.sounds;
        let (fade_out_duration, sample_rate) = (self.fade_out_duration, self.sample_rate);
        self.clicks.retain_mut(|click| !click.process_add(sounds, fade_out_duration, sample_rate, left, right));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    use engine_env::ppqn::samples_to_pulses;

    const SAMPLE_RATE: f32 = 48000.0;
    const BPM: f32 = 120.0;
    const QUANTUM: usize = 128;

    fn storage(nominator: i32, denominator: i32) -> SignatureEvent {
        SignatureEvent {index: -1, accumulated_ppqn: 0.0, nominator, denominator}
    }

    fn event(index: i32, accumulated_ppqn: f64, nominator: i32, denominator: i32) -> SignatureEvent {
        SignatureEvent {index, accumulated_ppqn, nominator, denominator}
    }

    /// Two equal frames at the engine rate: the click contributes exactly ONE sample of `amplitude * gain`.
    fn impulse_sound(amplitude: f32) -> ClickSound {
        ClickSound::new(vec![amplitude, amplitude], 2, 1, SAMPLE_RATE)
    }

    /// A metronome with impulse clicks (downbeat 1.0, beat 0.5) at unity gain, so the output is a train
    /// of single-sample impulses whose value identifies the click kind.
    fn impulse_metronome() -> Metronome {
        let mut metronome = Metronome::new(SAMPLE_RATE);
        metronome.load_click_sound(0, impulse_sound(1.0));
        metronome.load_click_sound(1, impulse_sound(0.5));
        metronome.set_gain(0.0);
        metronome
    }

    /// Render `quanta` 128-sample quanta from pulse `start`, returning every non-zero LEFT sample as
    /// `(global_sample_index, value)`.
    fn render_impulses(metronome: &mut Metronome, signature: &[SignatureEvent], start: f64, quanta: usize) -> Vec<(usize, f32)> {
        let step = samples_to_pulses(QUANTUM as f64, BPM, SAMPLE_RATE);
        let mut result = Vec::new();
        let mut p0 = start;
        for quantum in 0..quanta {
            let p1 = start + (quantum + 1) as f64 * step;
            let block = Block {p0, p1, s0: 0, s1: QUANTUM, bpm: BPM, discontinuous: false};
            p0 = p1; // contiguous ranges like the transport's (p1 carries into the next block's p0)
            let mut left = [0.0f32; QUANTUM];
            let mut right = [0.0f32; QUANTUM];
            metronome.process(&block, signature, &mut left, &mut right);
            for (index, value) in left.iter().enumerate() {
                if *value != 0.0 {
                    result.push((quantum * QUANTUM + index, *value));
                }
            }
        }
        result
    }

    fn quanta_for(pulses: f64) -> usize {
        (pulses_to_samples(pulses, BPM, SAMPLE_RATE) / QUANTUM as f64) as usize
    }

    /// Each click lands within one sample of its pulse position (block-boundary rounding, as in TS)
    /// with the expected amplitude (1.0 downbeat / 0.5 beat at unity gain).
    fn assert_click_train(clicks: &[(usize, f32)], expected: &[(f64, f32)]) {
        assert_eq!(clicks.len(), expected.len(), "click count, got {:?}", clicks);
        for ((sample, value), (pulse, amplitude)) in clicks.iter().zip(expected) {
            let target = pulses_to_samples(*pulse, BPM, SAMPLE_RATE);
            assert!((*sample as f64 - target).abs() <= 1.0, "click at sample {sample}, expected near {target}");
            assert!((value - amplitude).abs() < 1.0e-6, "click value {value}, expected {amplitude} near {target}");
        }
    }

    #[test]
    fn accents_reset_at_a_signature_change() {
        // 4/4 storage, 3/4 from bar 1 (3840): beats stay quarters, but the DOWNBEATS move to 3840 and
        // 6720 (3840 + 3 * 960) — under a static 4/4 the second accent would sit at 7680 instead.
        let mut metronome = impulse_metronome();
        let signature = [storage(4, 4), event(0, 3840.0, 3, 4)];
        let clicks = render_impulses(&mut metronome, &signature, 0.0, quanta_for(8000.0));
        assert_click_train(&clicks, &[(0.0, 1.0), (960.0, 0.5), (1920.0, 0.5), (2880.0, 0.5),
            (3840.0, 1.0), (4800.0, 0.5), (5760.0, 0.5), (6720.0, 1.0), (7680.0, 0.5)]);
    }

    #[test]
    fn a_signature_change_mid_block_splits_the_step_grid() {
        // ONE block spanning the 4/4 -> 3/8 event at 480: the region before ticks the 4/4 quarter grid
        // (only 0), the region after restarts the (shorter) eighth grid AT the event.
        let mut metronome = impulse_metronome();
        let signature = [storage(4, 4), event(0, 480.0, 3, 8)];
        let block = Block {p0: 0.0, p1: 1000.0, s0: 0, s1: QUANTUM, bpm: 96000.0, discontinuous: false};
        let mut left = [0.0f32; QUANTUM];
        let mut right = [0.0f32; QUANTUM];
        metronome.process(&block, &signature, &mut left, &mut right);
        let clicks: Vec<(usize, f32)> = left.iter().enumerate()
            .filter(|(_, value)| **value != 0.0).map(|(index, value)| (index, *value)).collect();
        let offset = |pulse: f64| floor(pulses_to_samples(pulse, block.bpm, SAMPLE_RATE)) as usize;
        assert_eq!(clicks, vec![(offset(0.0), 1.0), (offset(480.0), 1.0), (offset(960.0), 0.5)],
                   "downbeat at 0 (4/4), downbeat at the event (3/8 beat 0), eighth-beat at 960");
    }

    #[test]
    fn count_in_before_zero_accents_the_true_downbeats() {
        // A one-bar 3/4 count-in from -2880: beat indices -3..-1 — only the exact bar multiple (-3) accents.
        let mut metronome = impulse_metronome();
        let signature = [storage(3, 4)];
        let clicks = render_impulses(&mut metronome, &signature, -2880.0, quanta_for(2880.0));
        assert_click_train(&clicks, &[(0.0, 1.0), (960.0, 0.5), (1920.0, 0.5)]);
    }

    #[test]
    fn count_in_into_a_signature_event_uses_the_prior_signature() {
        // Recording starts at 3840 where 3/4 takes over; the one-bar count-in [960, 3840) still runs in
        // the storage 4/4 (beats at 960/1920/2880, none accented), then 3840 is the new 3/4 downbeat.
        let mut metronome = impulse_metronome();
        let signature = [storage(4, 4), event(0, 3840.0, 3, 4)];
        let clicks = render_impulses(&mut metronome, &signature, 960.0, quanta_for(2900.0));
        assert_click_train(&clicks, &[(0.0, 0.5), (960.0, 0.5), (1920.0, 0.5), (2880.0, 1.0)]);
    }

    #[test]
    fn beat_sub_division_ticks_between_beats_and_accents_every_nominator_steps() {
        // TS: denominator = curr.denominator * beatSubDivision and the accent stays at
        // `beatIndex % nominator == 0` — with 4/4 and division 2 that is every 4 EIGHTHS (0/1920/3840).
        let mut metronome = impulse_metronome();
        metronome.set_beat_sub_division(2);
        let signature = [storage(4, 4)];
        let clicks = render_impulses(&mut metronome, &signature, 0.0, quanta_for(3900.0));
        assert_click_train(&clicks, &[(0.0, 1.0), (480.0, 0.5), (960.0, 0.5), (1440.0, 0.5),
            (1920.0, 1.0), (2400.0, 0.5), (2880.0, 0.5), (3360.0, 0.5), (3840.0, 1.0)]);
    }

    #[test]
    fn gain_scales_the_click_amplitude() {
        let mut metronome = impulse_metronome();
        metronome.set_gain(-12.0);
        let signature = [storage(4, 4)];
        let clicks = render_impulses(&mut metronome, &signature, 0.0, 1);
        assert_eq!(clicks.len(), 1);
        let expected = db_to_gain(-12.0);
        assert!((clicks[0].1 - expected).abs() < 1.0e-6, "downbeat at dbToGain(-12): {} vs {}", clicks[0].1, expected);
    }

    /// Long constant-1.0 clicks at unity gain overlap across beats: monophonic fades the previous one
    /// out within 5 ms of the new click, polyphonic lets them sum.
    fn overlap_metronome(monophonic: bool) -> Metronome {
        let mut metronome = Metronome::new(SAMPLE_RATE);
        let long = || ClickSound::new(vec![1.0; 48000], 48000, 1, SAMPLE_RATE);
        metronome.load_click_sound(0, long());
        metronome.load_click_sound(1, long());
        metronome.set_gain(0.0);
        metronome.set_monophonic(monophonic);
        metronome
    }

    #[test]
    fn monophonic_cuts_the_previous_click_with_a_short_fade() {
        // Beats are 24000 samples apart (960 pulses at 120 bpm); the 48000-frame click overlaps the next.
        let signature = [storage(4, 4)];
        let probe = 24000 + 480; // past the 240-sample (5 ms) fade of the first click
        let mut monophonic = overlap_metronome(true);
        let mono = render_impulses(&mut monophonic, &signature, 0.0, quanta_for(1920.0));
        let value_at = |clicks: &[(usize, f32)], sample: usize| clicks.iter()
            .find(|(index, _)| *index == sample).map(|(_, value)| *value).unwrap_or(0.0);
        assert!((value_at(&mono, probe) - 1.0).abs() < 1.0e-6, "only the new click sounds after the fade");
        let mut polyphonic = overlap_metronome(false);
        let poly = render_impulses(&mut polyphonic, &signature, 0.0, quanta_for(1920.0));
        assert!((value_at(&poly, probe) - 2.0).abs() < 1.0e-6, "polyphonic clicks sum");
    }

    #[test]
    fn an_uploaded_click_resamples_from_its_own_rate() {
        // A 3-frame [0, 1, 0] triangle at HALF the engine rate plays back linearly interpolated over
        // 4 samples: 0, 0.5, 1, 0.5 (TS Click's ratio walk, stopping at frame_count - 1).
        let mut metronome = Metronome::new(SAMPLE_RATE);
        metronome.load_click_sound(0, ClickSound::new(vec![0.0, 1.0, 0.0], 3, 1, SAMPLE_RATE * 0.5));
        metronome.set_gain(0.0);
        let signature = [storage(4, 4)];
        let block = Block {p0: 0.0, p1: 1.0, s0: 0, s1: QUANTUM, bpm: BPM, discontinuous: false};
        let mut left = [0.0f32; QUANTUM];
        let mut right = [0.0f32; QUANTUM];
        metronome.process(&block, &signature, &mut left, &mut right);
        assert_eq!(&left[0..5], &[0.0, 0.5, 1.0, 0.5, 0.0]);
    }

    #[test]
    fn the_synthesized_default_clicks_sound_without_an_upload() {
        let mut metronome = Metronome::new(SAMPLE_RATE);
        let signature = [storage(4, 4)];
        let clicks = render_impulses(&mut metronome, &signature, 0.0, 4);
        assert!(!clicks.is_empty(), "the default 880 Hz downbeat renders");
    }

    #[test]
    fn a_stereo_upload_plays_its_second_plane_on_the_right() {
        let mut metronome = Metronome::new(SAMPLE_RATE);
        metronome.load_click_sound(0, ClickSound::new(vec![1.0, 1.0, -1.0, -1.0], 2, 2, SAMPLE_RATE));
        metronome.set_gain(0.0);
        let signature = [storage(4, 4)];
        let block = Block {p0: 0.0, p1: 1.0, s0: 0, s1: QUANTUM, bpm: BPM, discontinuous: false};
        let mut left = [0.0f32; QUANTUM];
        let mut right = [0.0f32; QUANTUM];
        metronome.process(&block, &signature, &mut left, &mut right);
        assert_eq!((left[0], right[0]), (1.0, -1.0));
    }
}
