//! Metronome, ported from core-processors `Metronome.ts`. Two pre-rendered click sounds (880 Hz
//! downbeat / 440 Hz beat); per-block beat detection schedules clicks at sample offsets and mixes
//! them into the output. Simplified for the metronome page: a single signature from bar 0 (no
//! signature track), no beat sub-division, fixed gain. bpm + signature are driven live by the
//! engine's `TimelineBox` subscriptions.
//!
//! `no_std`: no `f32`/`f64` std methods (floor/ceil/min/sin) — integer-cast helpers + `dsp::fast_sin`.

use alloc::vec::Vec;
use dsp::{fast_sin, PI};
use transport::ppqn::{from_signature, pulses_to_samples};
use transport::transport::Block;

const TAU: f32 = 2.0 * PI;
const CLICK_GAIN: f32 = 0.5;

fn floor_nonneg(value: f64) -> f64 {
    (value as i64) as f64
}

fn ceil_nonneg(value: f64) -> f64 {
    let truncated = (value as i64) as f64;
    if truncated < value {truncated + 1.0} else {truncated}
}

struct ClickSound {
    frames: Vec<f32>
}

impl ClickSound {
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
        Self {frames}
    }
}

struct Click {
    sound_index: usize,
    position: usize,
    start_index: usize
}

impl Click {
    /// Mix the click sound into both channels, advancing. Returns true once exhausted.
    fn process_add(&mut self, sounds: &[ClickSound; 2], left: &mut [f32], right: &mut [f32]) -> bool {
        let frames = &sounds[self.sound_index].frames;
        let mut index = self.start_index;
        while index < left.len() {
            if self.position >= frames.len() {
                return true;
            }
            let sample = frames[self.position] * CLICK_GAIN;
            left[index] += sample;
            right[index] += sample;
            self.position += 1;
            index += 1;
        }
        self.start_index = 0;
        false
    }
}

pub struct Metronome {
    sounds: [ClickSound; 2],
    clicks: Vec<Click>,
    nominator: u32,
    denominator: u32,
    sample_rate: f32,
    enabled: bool
}

impl Metronome {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            sounds: [ClickSound::create(880.0, sample_rate), ClickSound::create(440.0, sample_rate)],
            clicks: Vec::new(),
            nominator: 4,
            denominator: 4,
            sample_rate,
            enabled: true
        }
    }

    pub fn set_nominator(&mut self, nominator: u32) {
        if nominator > 0 {
            self.nominator = nominator
        }
    }

    pub fn set_denominator(&mut self, denominator: u32) {
        if denominator > 0 {
            self.denominator = denominator
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled
    }

    /// Detect the beats inside `block`, schedule a click per beat (880 Hz on the bar's first beat,
    /// 440 Hz otherwise), then mix the active clicks additively into the (already-cleared) output.
    pub fn process(&mut self, block: &Block, left: &mut [f32], right: &mut [f32]) {
        if self.enabled {
            let step = from_signature(1, self.denominator as i32); // pulses per beat
            if step > 0.0 {
                let mut beat_index = ceil_nonneg(block.p0 / step) as i64;
                let mut position = beat_index as f64 * step;
                while position < block.p1 {
                    let offset = floor_nonneg(pulses_to_samples(position - block.p0, block.bpm, self.sample_rate)) as usize;
                    let click_index = if (beat_index as u32).is_multiple_of(self.nominator) {0} else {1};
                    if offset < left.len() {
                        self.clicks.push(Click {sound_index: click_index, position: 0, start_index: offset})
                    }
                    beat_index += 1;
                    position = beat_index as f64 * step;
                }
            }
        }
        let sounds = &self.sounds;
        self.clicks.retain_mut(|click| !click.process_add(sounds, left, right));
    }
}
