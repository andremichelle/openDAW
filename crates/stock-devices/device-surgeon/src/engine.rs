use crate::pattern::Pattern;
use crate::voice::Voice;
use dsp::resampler::ResamplerMono;

pub const PATTERNS: usize = 8;
pub const STEP_PULSES: f64 = 240.0;
pub const BAR_PULSES: f64 = 3840.0;
pub const MAX_FRAMES: usize = 128;

const OVERSAMPLING: usize = 2;
const MAX_OFFS: usize = 4;
const NONE: i64 = i64::MIN;

/// What plays: one of the patterns, or nothing (the Off button).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Slot {
    Off,
    Pattern(usize)
}

pub struct Engine {
    pub patterns: [Pattern; PATTERNS],
    /// Centre pitch as a MIDI number with fractions (the editor shows Hz).
    pub tune: f32,
    pub volume: f32,
    active: Slot,
    fired: Option<Slot>,
    voice: Voice,
    resampler: ResamplerMono,
    scratch: [f32; MAX_FRAMES * OVERSAMPLING],
    bar: i64,
    step: i64,
    offs: [f64; MAX_OFFS],
    off_count: usize,
    was_playing: bool
}

impl Engine {
    pub fn new(sample_rate: f32) -> Self {
        let mut voice = Voice::default();
        voice.init(sample_rate * OVERSAMPLING as f32);
        Self {
            patterns: [Pattern::default(); PATTERNS],
            tune: 50.0,
            volume: 1.0,
            active: Slot::Pattern(0),
            fired: None,
            voice,
            resampler: ResamplerMono::new(OVERSAMPLING),
            scratch: [0.0; MAX_FRAMES * OVERSAMPLING],
            bar: NONE,
            step: NONE,
            offs: [0.0; MAX_OFFS],
            off_count: 0,
            was_playing: false
        }
    }

    /// Asks for a pattern or for Off. It takes over at the start of the next bar.
    pub fn fire(&mut self, slot: Slot) {
        self.fired = if slot == self.active {None} else {Some(slot)};
    }

    /// Switches at once, for a stopped transport.
    pub fn select(&mut self, slot: Slot) {
        self.active = slot;
        self.fired = None;
    }

    pub fn active(&self) -> Slot {self.active}

    /// The slot that waits for its bar, if any (its tile flashes).
    pub fn fired(&self) -> Option<Slot> {self.fired}

    fn pattern(&self) -> Option<&Pattern> {
        match self.active {
            Slot::Pattern(index) => Some(&self.patterns[index.min(PATTERNS - 1)]),
            Slot::Off => None
        }
    }

    fn release(&mut self) {
        self.voice.release_all();
        self.off_count = 0;
    }

    fn enter(&mut self, step: i64, step_pulses: f64) {
        if step < 0 {return;}
        let Some(pattern) = self.pattern() else {return;};
        let event = pattern.event(step as u32);
        self.voice.set_patch(event.patch);
        let Some(note) = event.note else {return;};
        self.voice.note_on(self.tune + note.offset, note.velocity);
        if self.off_count == MAX_OFFS {
            self.voice.note_off();
            self.offs.copy_within(1.., 0);
            self.off_count -= 1;
        }
        self.offs[self.off_count] = (step as f64 + note.length) * step_pulses;
        self.off_count += 1;
    }

    // the index before `pulse` when it sits exactly on a grid line, so that line still counts as crossed
    fn index_before(pulse: f64, grid: f64) -> i64 {
        let position = pulse / grid;
        let floor = libm::floor(position);
        if position == floor {floor as i64 - 1} else {floor as i64}
    }

    /// Renders one block: the pulse range `[p0, p1)` spread over `output` (at most `MAX_FRAMES` frames). While the
    /// transport does not play, or after a jump, held notes are let go and ring out.
    pub fn process(&mut self, p0: f64, p1: f64, playing: bool, discontinuous: bool, output: &mut [f32]) {
        let frames = output.len().min(MAX_FRAMES);
        let count = frames * OVERSAMPLING;
        if !playing {
            if self.was_playing {self.release();}
            self.bar = NONE;
            self.step = NONE;
        } else if discontinuous || !self.was_playing {
            self.release();
            self.bar = Self::index_before(p0, BAR_PULSES);
            self.step = self.pattern().map_or(NONE, |pattern| Self::index_before(p0, pattern.step_pulses()));
        }
        self.was_playing = playing;
        let advance = (p1 - p0) / count as f64;
        for index in 0..count {
            if playing {
                let pulse = p0 + advance * index as f64;
                let bar = libm::floor(pulse / BAR_PULSES) as i64;
                if bar != self.bar {
                    self.bar = bar;
                    if let Some(slot) = self.fired.take() {
                        self.active = slot;
                        self.step = NONE;
                    }
                }
                if let Some(step_pulses) = self.pattern().map(Pattern::step_pulses) {
                    let step = libm::floor(pulse / step_pulses) as i64;
                    if step != self.step {
                        self.step = step;
                        self.enter(step, step_pulses);
                    }
                }
                let mut read = 0;
                while read < self.off_count {
                    if self.offs[read] <= pulse {
                        self.voice.note_off();
                        self.offs.copy_within(read + 1..self.off_count, read);
                        self.off_count -= 1;
                    } else {
                        read += 1;
                    }
                }
            }
            self.scratch[index] = self.voice.next() * self.volume;
        }
        self.resampler.downsample(&self.scratch, output, 0, frames);
    }
}
