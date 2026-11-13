use crate::hash::unit;
use crate::pattern::{Pattern, LOOPS, MAX_STEPS};
use crate::voice::Voice;
use dsp::resampler::ResamplerMono;

pub const PATTERNS: usize = 8;
pub const STEP_PULSES: f64 = 240.0;
pub const BAR_PULSES: f64 = 3840.0;
pub const MAX_FRAMES: usize = 128;

const OVERSAMPLING: usize = 2;
const MAX_OFFS: usize = 4;
const NONE: i64 = i64::MIN;

// Counts how often each step of one loop has been replaced, carried forward pass by pass. Counting from the song
// start on every step would grow without bound. A jump back or a changed loop starts the count again.
#[derive(Clone, Copy)]
struct Counter {
    key: (u32, u32, u32),
    passes: [u32; MAX_STEPS as usize],
    counts: [u32; MAX_STEPS as usize]
}

impl Counter {
    const NEW: Counter = Counter {key: (0, 0, 0), passes: [0; MAX_STEPS as usize], counts: [0; MAX_STEPS as usize]};

    fn generation(&mut self, seed: u32, mutate: f32, steps: u32, position: u32) -> u32 {
        if mutate <= 0.0 {return 0;}
        let steps = steps.clamp(1, MAX_STEPS);
        let key = (seed, mutate.to_bits(), steps);
        if key != self.key {*self = Counter {key, ..Counter::NEW};}
        let (pass, step) = (position / steps, (position % steps) as usize);
        if pass < self.passes[step] {
            self.passes[step] = 0;
            self.counts[step] = 0;
        }
        for index in self.passes[step] + 1..=pass {
            if unit(seed, step as u32, index, 0) < mutate {self.counts[step] += 1;}
        }
        self.passes[step] = pass;
        self.counts[step]
    }
}

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
    bar: f64,
    step: i64,
    rate: u32,
    counters: [Counter; LOOPS],
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
            bar: f64::NAN,
            step: NONE,
            rate: 0,
            counters: [Counter::NEW; LOOPS],
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

    fn enter(&mut self, step: i64, step_pulses: f64, step_samples: f64) {
        if step < 0 {return;}
        let Some(pattern) = self.pattern().copied() else {return;};
        let mut generations = [0; LOOPS];
        for (index, (seed, mutate, steps)) in pattern.loops().into_iter().enumerate() {
            generations[index] = self.counters[index].generation(seed, mutate, steps, step as u32);
        }
        let event = pattern.event_with(step as u32, &generations);
        self.voice.set_patch(event.patch);
        let Some(note) = event.note else {return;};
        self.voice.note_on(self.tune + note.offset, note.velocity, if note.slide {step_samples as u32} else {0});
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

    /// `process_bars` in 4/4 from pulse zero.
    pub fn process(&mut self, p0: f64, p1: f64, playing: bool, discontinuous: bool, output: &mut [f32]) {
        self.process_bars(p0, p1, playing, discontinuous, 0.0, BAR_PULSES, output);
    }

    /// Lets go of every held note at once (the transport stopped), the tail rings out.
    pub fn stop(&mut self) {
        self.release();
        self.was_playing = false;
    }

    // the start of the bar holding `pulse`, for bars of `length` pulses counted from `origin`
    fn bar_of(pulse: f64, origin: f64, length: f64) -> f64 {origin + libm::floor((pulse - origin) / length) * length}

    /// Renders one block: the pulse range `[p0, p1)` spread over `output` (at most `MAX_FRAMES` frames). While the
    /// transport does not play, or after a jump, held notes are let go and ring out. `bar_start` and `bar_length`
    /// describe the bar around `p0` (the signature), a fired slot takes over where a bar starts.
    pub fn process_bars(&mut self, p0: f64, p1: f64, playing: bool, discontinuous: bool, bar_start: f64, bar_length: f64,
                        output: &mut [f32]) {
        let bar_length = if bar_length > 0.0 {bar_length} else {BAR_PULSES};
        let frames = output.len().min(MAX_FRAMES);
        let count = frames * OVERSAMPLING;
        if !playing {
            if self.was_playing {self.release();}
            self.bar = f64::NAN;
            self.step = NONE;
        } else if discontinuous || !self.was_playing {
            self.release();
            let bar = Self::bar_of(p0, bar_start, bar_length);
            self.bar = if bar == p0 {bar - bar_length} else {bar};
            self.step = self.pattern().map_or(NONE, |pattern| Self::index_before(p0, pattern.step_pulses()));
            self.rate = self.pattern().map_or(0, |pattern| pattern.rate);
        }
        self.was_playing = playing;
        let advance = (p1 - p0) / count as f64;
        for index in 0..count {
            if playing {
                let pulse = p0 + advance * index as f64;
                let bar = Self::bar_of(pulse, bar_start, bar_length);
                if bar != self.bar {
                    self.bar = bar;
                    if let Some(slot) = self.fired.take() {
                        self.active = slot;
                        self.step = NONE;
                        self.rate = self.pattern().map_or(0, |pattern| pattern.rate);
                    }
                }
                if let Some((step_pulses, rate)) = self.pattern().map(|pattern| (pattern.step_pulses(), pattern.rate)) {
                    let step = libm::floor(pulse / step_pulses) as i64;
                    if rate != self.rate {
                        // a changed rate moves the grid: wait for its next line instead of starting a note inside a step
                        self.rate = rate;
                        self.step = step;
                    } else if step != self.step {
                        self.step = step;
                        self.enter(step, step_pulses, if advance > 0.0 {step_pulses / advance} else {0.0});
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

#[cfg(test)]
mod tests {
    use super::Counter;
    use crate::hash::generation;

    #[test]
    fn the_counter_agrees_with_counting_from_the_start_in_any_order() {
        let mut counter = Counter::NEW;
        let positions = [0, 1, 2, 3, 40, 41, 7, 8, 500, 501, 502, 12, 3000, 3001, 2999, 0, 77];
        for (seed, mutate, steps) in [(21, 0.15, 5), (9, 1.0, 1), (4, 0.5, 32), (4, 0.0, 7), (21, 0.15, 5)] {
            for position in positions {
                let expected = generation(seed, position % steps, position / steps, mutate);
                assert_eq!(counter.generation(seed, mutate, steps, position), expected, "seed {seed} at {position}");
            }
        }
    }
}
