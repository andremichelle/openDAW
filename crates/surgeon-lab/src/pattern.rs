use crate::figure::{decimate, Kind, Step, OVERSAMPLING};
use crate::sequencer::{generation, unit, Pitch, Seeded, GATE_SHARE, HOLD_RELEASE, HOLD_SHARE, LONGEST, SHORTEST, TIE_OVERLAP};
use crate::voice::{FoldPosition, Patch, Voice, Wave};

pub const LANES: usize = 4;
pub const PARAMS: usize = 18;
pub const STEPS_PER_BAR: u32 = 16;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Param {
    Tune,
    Ratio1,
    Feedback,
    Ratio2,
    Depth2,
    Wave,
    Depth,
    Strike,
    StrikeDecay,
    Fold,
    FoldPlace,
    Length,
    HeldShare,
    SineLevel,
    SinePitch,
    Glide,
    Velocity,
    Volume
}

#[derive(Clone, Copy, Debug)]
pub struct Range {
    pub min: f32,
    pub max: f32,
    pub exponential: bool
}

impl Range {
    const fn linear(min: f32, max: f32) -> Self {Self {min, max, exponential: false}}
    const fn exponential(min: f32, max: f32) -> Self {Self {min, max, exponential: true}}

    pub fn value(&self, unit: f32) -> f32 {
        if self.exponential {self.min * (self.max / self.min).powf(unit)} else {self.min + (self.max - self.min) * unit}
    }

    pub fn unit(&self, value: f32) -> f32 {
        if self.exponential {(value / self.min).ln() / (self.max / self.min).ln()} else {(value - self.min) / (self.max - self.min)}
    }
}

impl Param {
    pub fn range(self) -> Range {
        match self {
            Param::Tune => Range::linear(24.0, 72.0),
            Param::Ratio1 => Range::exponential(0.25, 8.0),
            Param::Ratio2 => Range::exponential(0.25, 16.0),
            Param::Depth2 => Range::linear(0.0, 1.5),
            Param::Depth => Range::linear(0.0, 4.0),
            Param::Strike => Range::linear(0.0, 8.0),
            Param::StrikeDecay => Range::exponential(0.02, 1.0),
            Param::SineLevel => Range::linear(0.0, 1.5),
            Param::Glide => Range::linear(0.0, 0.3),
            Param::Wave => Range::linear(0.0, 4.0),
            Param::FoldPlace | Param::SinePitch => Range::linear(0.0, 2.0),
            Param::Feedback | Param::Fold | Param::Length | Param::HeldShare | Param::Velocity | Param::Volume => Range::linear(0.0, 1.0)
        }
    }
}

/// A loop of 0 to 1 values with its own length. It knows nothing about what it moves.
#[derive(Clone, Copy, Debug)]
pub struct GenericLane {
    pub steps: u32,
    pub seed: u32,
    pub mutate: f32
}

impl GenericLane {
    pub fn value(&self, position: u32) -> f32 {
        let (pass, step) = (position / self.steps, position % self.steps);
        unit(self.seed, step, generation(self.seed, step, pass, self.mutate), 1)
    }
}

pub struct Sound {
    pub patch: Patch,
    pub tune: f32,
    pub volume: f32
}

/// A note loop, four lanes and the sound with its mapping: every parameter has a base and an amount per lane.
#[derive(Clone, Copy, Debug)]
pub struct Pattern {
    pub notes: Seeded,
    pub lanes: [GenericLane; LANES],
    pub base: [f32; PARAMS],
    pub amounts: [[f32; LANES]; PARAMS]
}

impl Pattern {
    pub fn new(notes: Seeded, lanes: [GenericLane; LANES]) -> Self {
        let mut pattern = Self {notes, lanes, base: [0.0; PARAMS], amounts: [[0.0; LANES]; PARAMS]};
        let Patch {ratio, depth, strike, strike_decay, feedback, glide, velocity, ..} = Patch::BASE;
        pattern.set(Param::Tune, 50.0).set(Param::Ratio1, ratio).set(Param::Feedback, feedback).set(Param::Ratio2, 5.19)
            .set(Param::Depth, depth).set(Param::Strike, strike).set(Param::StrikeDecay, strike_decay)
            .set(Param::Length, 0.7).set(Param::Glide, glide).set(Param::Velocity, velocity).set(Param::Volume, 1.0);
        pattern
    }

    /// Sets the base of a parameter in its own unit (Hz ratio, seconds, ...). Switches take their index.
    pub fn set(&mut self, param: Param, value: f32) -> &mut Self {
        let offset = if matches!(param, Param::Wave | Param::FoldPlace | Param::SinePitch) {0.5} else {0.0};
        self.base[param as usize] = param.range().unit(value + offset);
        self
    }

    /// Lets `lane` move a parameter between two values, on top of what other lanes add.
    pub fn map(&mut self, param: Param, lane: usize, from: f32, to: f32) -> &mut Self {
        let range = param.range();
        self.base[param as usize] = range.unit(from);
        self.amounts[param as usize][lane] = range.unit(to) - range.unit(from);
        self
    }

    /// Random all: new loops, lane lengths, sound values and mapping from one seed. Tune and Volume stay.
    pub fn random(seed: u32) -> Self {
        let roll = |index: u32| unit(seed, index, 0, 7);
        let between = |index: u32, low: f32, high: f32| low + (high - low) * roll(index);
        let notes = Seeded {
            steps: between(0, 3.0, 17.0) as u32,
            seed: (roll(1) * 100_000.0) as u32,
            mutate: between(2, 0.04, 0.25),
            range: between(3, 5.0, 19.0),
            density: between(4, 0.55, 0.95),
            tie: between(5, 0.0, 0.4),
            accent: between(6, 0.3, 0.8),
            pitch: Pitch::Free
        };
        let lane = |index: u32| GenericLane {steps: between(10 + index, 2.0, 17.0) as u32, seed: (roll(20 + index) * 100_000.0) as u32, mutate: between(30 + index, 0.05, 0.3)};
        let mut pattern = Pattern::new(notes, [lane(0), lane(1), lane(2), lane(3)]);
        pattern.set(Param::Ratio1, 0.5 * 12.0f32.powf(roll(40))).set(Param::Ratio2, 12.0f32.powf(roll(41)))
            .set(Param::Depth2, between(42, 0.0, 1.0)).set(Param::Wave, (roll(43) * 4.0).floor().min(3.0))
            .set(Param::Depth, between(44, 0.2, 1.4)).set(Param::StrikeDecay, 0.06 * 5.0f32.powf(roll(45)))
            .set(Param::FoldPlace, (roll(46) * 2.0).floor().min(1.0)).set(Param::HeldShare, between(47, 0.0, 0.15))
            .set(Param::SineLevel, between(48, 0.3, 0.9)).set(Param::SinePitch, (roll(49) * 2.0).floor().min(1.0))
            .set(Param::Glide, between(50, 0.01, 0.08)).set(Param::Velocity, between(51, 0.4, 1.0));
        let pick = |index: u32| ((roll(index) * LANES as f32) as usize).min(LANES - 1);
        pattern.map(Param::Feedback, pick(60), between(61, 0.0, 0.3), between(62, 0.4, 0.9))
            .map(Param::Strike, pick(63), between(64, 0.5, 2.5), between(65, 4.0, 8.0))
            .map(Param::Length, pick(66), between(67, 0.0, 0.3), between(68, 0.7, 1.0))
            .map(Param::Fold, pick(69), 0.0, between(70, 0.0, 0.6));
        for (index, param) in [Param::Depth2, Param::SineLevel, Param::StrikeDecay, Param::Depth, Param::Feedback, Param::Fold].into_iter().enumerate() {
            let index = 80 + index as u32 * 4;
            if roll(index) < 0.4 {pattern.amounts[param as usize][pick(index + 1)] += between(index + 2, -0.35, 0.35);}
        }
        pattern
    }

    pub fn sound(&self, position: u32) -> Sound {
        let lanes = self.lanes.map(|lane| lane.value(position));
        let unit = |param: Param| -> f32 {
            let added: f32 = (0..LANES).map(|lane| self.amounts[param as usize][lane] * lanes[lane]).sum();
            (self.base[param as usize] + added).clamp(0.0, 1.0)
        };
        let value = |param: Param| param.range().value(unit(param));
        let from = 1.0 - value(Param::HeldShare);
        let length = unit(Param::Length);
        let hold = length >= from;
        let wave = [Wave::Sine, Wave::Half, Wave::Rectified, Wave::Burst][(value(Param::Wave) as usize).min(3)];
        let patch = Patch {
            ratio: value(Param::Ratio1),
            depth: value(Param::Depth),
            strike: value(Param::Strike),
            strike_decay: value(Param::StrikeDecay),
            feedback: value(Param::Feedback),
            wave,
            fold: value(Param::Fold),
            fold_position: if value(Param::FoldPlace) < 1.0 {FoldPosition::BeforeGate} else {FoldPosition::AfterGate},
            decay: if hold {HOLD_RELEASE} else {SHORTEST * (LONGEST / SHORTEST).powf(length / from.max(1e-6))},
            glide: value(Param::Glide),
            velocity: value(Param::Velocity),
            second_ratio: value(Param::Ratio2),
            second_depth: value(Param::Depth2),
            sub: value(Param::SineLevel),
            sub_ratio: if value(Param::SinePitch) < 1.0 {0.5} else {1.0},
            sub_drive: 0.0,
            hold
        };
        Sound {patch, tune: value(Param::Tune), volume: value(Param::Volume)}
    }
}

enum Event {
    Sound(Patch, f32),
    On(f32, f32),
    Off
}

/// Patterns fired over time. A switch takes effect at the start of its bar, `None` is the off button.
pub struct Performance<'a> {
    pub patterns: &'a [Pattern],
    pub schedule: &'a [(u32, Option<usize>)],
    pub tempo: f64
}

impl Performance<'_> {
    pub fn active(&self, position: u32) -> Option<&Pattern> {
        let bar = position / STEPS_PER_BAR;
        self.schedule.iter().rev().find(|(from, _)| *from <= bar).and_then(|(_, index)| index.map(|index| &self.patterns[index]))
    }

    /// Renders `bars` bars, mono at `sample_rate`. The loops run on the song position, a fired pattern joins in phase.
    pub fn render(&self, bars: u32, tail: f64, sample_rate: f64) -> Vec<f32> {
        let rate = sample_rate * OVERSAMPLING as f64;
        let step_samples = 60.0 / self.tempo / 4.0 * rate;
        let steps = bars * STEPS_PER_BAR;
        let total = (steps as f64 * step_samples + tail * rate) as usize;
        let mut events: Vec<(usize, u8, Event)> = Vec::new();
        for position in 0..steps {
            let Some(pattern) = self.active(position) else {continue;};
            let start = position as f64 * step_samples;
            let Sound {patch, tune, volume} = pattern.sound(position);
            events.push((start as usize, 0, Event::Sound(patch, volume)));
            let Step {offset, velocity, kind} = pattern.notes.step(position);
            if kind == Kind::Rest {continue;}
            let length = if kind == Kind::Tie {1.0 + TIE_OVERLAP} else if patch.hold {HOLD_SHARE} else {GATE_SHARE};
            events.push((start as usize, 1, Event::On(tune + offset, velocity)));
            events.push(((start + length * step_samples) as usize, 2, Event::Off));
        }
        events.sort_by_key(|(position, order, _)| (*position, *order));
        let mut voice = Voice::new(Patch::BASE, rate as f32);
        let mut output = Vec::with_capacity(total);
        let (mut cursor, mut gain) = (0, 1.0);
        for position in 0..total {
            while cursor < events.len() && events[cursor].0 <= position {
                match events[cursor].2 {
                    Event::Sound(patch, volume) => {
                        voice.set_patch(patch);
                        gain = volume;
                    }
                    Event::On(pitch, velocity) => voice.note_on(pitch, velocity),
                    Event::Off => voice.note_off()
                }
                cursor += 1;
            }
            output.push(voice.next() * gain);
        }
        decimate(&output)
    }
}
