use crate::figure::{decimate, Kind, Step, OVERSAMPLING};
use crate::voice::{Patch, Voice};

pub(crate) const GATE_SHARE: f64 = 0.5;
pub(crate) const HOLD_SHARE: f64 = 0.96;
pub(crate) const HOLD_RELEASE: f32 = 0.1;
pub(crate) const SHORTEST: f32 = 0.05;
pub(crate) const LONGEST: f32 = 0.9;
pub(crate) const TIE_OVERLAP: f64 = 0.1;

fn mix(mut value: u32) -> u32 {
    value ^= value >> 16;
    value = value.wrapping_mul(0x7FEB_352D);
    value ^= value >> 15;
    value = value.wrapping_mul(0x846C_A68B);
    value ^ (value >> 16)
}

/// A stable 0 to 1 value for a seed and three indices.
pub fn unit(seed: u32, first: u32, second: u32, third: u32) -> f32 {
    let hashed = mix(mix(mix(mix(seed) ^ first).wrapping_add(second)) ^ third.wrapping_mul(0x9E37_79B9));
    (hashed >> 8) as f32 / (1u32 << 24) as f32
}

/// How often a step has been replaced after `pass` passes: every pass rolls once per step against `mutate`.
pub fn generation(seed: u32, step: u32, pass: u32, mutate: f32) -> u32 {
    (1..=pass).filter(|index| unit(seed, step, *index, 0) < mutate).count() as u32
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Target {
    Feedback,
    Strike,
    Fold,
    Decay,
    Ratio {centre: f32, spread: f32},
    Sub,
    SecondDepth,
    /// From a short hit to a long decay, the top `held` share of the values holds the whole step.
    Length {held: f32}
}

/// A loop of values with its own length, so it turns against the notes and the other lanes.
#[derive(Clone, Copy, Debug)]
pub struct Lane {
    pub target: Target,
    pub steps: u32,
    pub seed: u32,
    pub mutate: f32,
    pub low: f32,
    pub high: f32,
    pub window: Window
}

/// When a lane acts: always, or only in the last `length` steps of every `period` steps (a break).
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Window {
    Always,
    Break {period: u32, length: u32}
}

impl Window {
    pub fn open(&self, position: u32) -> bool {
        match *self {
            Window::Always => true,
            Window::Break {period, length} => position % period >= period - length
        }
    }
}

impl Lane {
    /// A ratio lane spreading `amount` octaves around `centre`. At 0 it leaves the ratio alone.
    pub const fn ratio(centre: f32, amount: f32, steps: u32, seed: u32) -> Lane {
        let spread = amount * 0.75;
        Lane {target: Target::Ratio {centre, spread}, steps, seed, mutate: 0.0, low: -1.0, high: 1.0, window: Window::Always}
    }

    pub fn value(&self, position: u32) -> f32 {
        let (pass, step) = (position / self.steps, position % self.steps);
        let amount = unit(self.seed, step, generation(self.seed, step, pass, self.mutate), 1);
        self.low + (self.high - self.low) * amount
    }

    pub fn apply(&self, patch: &mut Patch, position: u32) {
        if !self.window.open(position) {return;}
        let value = self.value(position);
        match self.target {
            Target::Feedback => patch.feedback = value,
            Target::Strike => patch.strike = value,
            Target::Fold => patch.fold = value,
            Target::Decay => patch.decay = value,
            Target::Ratio {centre, spread} => patch.ratio = centre * (value * spread).exp2(),
            Target::Sub => patch.sub = value,
            Target::SecondDepth => patch.second_depth = value,
            Target::Length {held} => {
                let from = 1.0 - held;
                patch.hold = value >= from;
                patch.decay = if patch.hold {HOLD_RELEASE} else {SHORTEST * (LONGEST / SHORTEST).powf(value / from.max(1e-6))};
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Seeded {
    pub steps: u32,
    pub seed: u32,
    pub mutate: f32,
    pub range: f32,
    pub density: f32,
    pub tie: f32,
    pub accent: f32,
    pub pitch: Pitch
}

/// How the loop's pitches are placed: on semitones or anywhere.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Pitch {
    Semitones,
    Free
}

impl Seeded {
    pub fn step(&self, position: u32) -> Step {
        let (pass, step) = (position / self.steps, position % self.steps);
        let generation = generation(self.seed, step, pass, self.mutate);
        let roll = |channel: u32| unit(self.seed, step, generation, channel);
        let kind = if roll(2) >= self.density {Kind::Rest} else if roll(3) < self.tie {Kind::Tie} else {Kind::Play};
        let free = (roll(1) * 2.0 - 1.0) * self.range;
        let offset = if self.pitch == Pitch::Semitones {free.round()} else {free};
        Step {offset, velocity: 1.0 - self.accent * roll(4), kind}
    }
}

#[derive(Clone, Copy, Debug)]
pub enum Notes<'a> {
    Fixed(&'a [Step]),
    Seeded(Seeded)
}

impl Notes<'_> {
    pub fn step(&self, position: u32) -> Step {
        match self {
            Notes::Fixed(figure) => figure[position as usize % figure.len()],
            Notes::Seeded(seeded) => seeded.step(position)
        }
    }
}

enum Event {
    Patch(Patch),
    On(f32, f32),
    Off
}

pub struct Program<'a> {
    pub patch: Patch,
    pub notes: Notes<'a>,
    pub lanes: &'a [Lane],
    pub centre: f32,
    pub tempo: f64
}

impl Program<'_> {
    /// Renders `steps` sixteenths, mono at `sample_rate`. Every lane sets its value at the start of each step.
    pub fn render(&self, steps: u32, tail: f64, sample_rate: f64) -> Vec<f32> {
        let rate = sample_rate * OVERSAMPLING as f64;
        let step_samples = 60.0 / self.tempo / 4.0 * rate;
        let total = (steps as f64 * step_samples + tail * rate) as usize;
        let mut events: Vec<(usize, u8, Event)> = Vec::new();
        for position in 0..steps {
            let start = position as f64 * step_samples;
            let mut patch = self.patch;
            if !self.lanes.is_empty() {
                self.lanes.iter().for_each(|lane| lane.apply(&mut patch, position));
                events.push((start as usize, 0, Event::Patch(patch)));
            }
            let Step {offset, velocity, kind} = self.notes.step(position);
            if kind == Kind::Rest {continue;}
            let length = if kind == Kind::Tie {1.0 + TIE_OVERLAP} else if patch.hold {HOLD_SHARE} else {GATE_SHARE};
            events.push((start as usize, 1, Event::On(self.centre + offset, velocity)));
            events.push(((start + length * step_samples) as usize, 2, Event::Off));
        }
        events.sort_by_key(|(position, order, _)| (*position, *order));
        let mut voice = Voice::new(self.patch, rate as f32);
        let mut output = Vec::with_capacity(total);
        let mut cursor = 0;
        for position in 0..total {
            while cursor < events.len() && events[cursor].0 <= position {
                match events[cursor].2 {
                    Event::Patch(patch) => voice.set_patch(patch),
                    Event::On(pitch, velocity) => voice.note_on(pitch, velocity),
                    Event::Off => voice.note_off()
                }
                cursor += 1;
            }
            output.push(voice.next());
        }
        decimate(&output)
    }
}
