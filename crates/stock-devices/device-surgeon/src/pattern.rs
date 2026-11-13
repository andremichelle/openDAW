use crate::hash::{generation, unit};
use crate::param::{Param, PARAMS};
use crate::voice::{FoldPlace, Patch, Wave};

pub const LANES: usize = 4;
pub const MAX_STEPS: u32 = 32;
/// Pulses per step for an eighth, a sixteenth and a thirty-second.
pub const RATE_PULSES: [f64; 3] = [480.0, 240.0, 120.0];
pub const SIXTEENTH: u32 = 1;
pub const MAX_RANDOM_SLIDE: f32 = 0.5;

const HOLD_RELEASE: f32 = 0.1;
const SHORTEST: f32 = 0.05;
const LONGEST: f32 = 0.9;
const GATE_SHARE: f64 = 0.5;
const HOLD_SHARE: f64 = 0.96;
const TIE_SHARE: f64 = 1.1;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    Play,
    Tie,
    Rest
}

#[derive(Clone, Copy, Debug)]
pub struct Step {
    /// Semitones from Tune, never rounded to a note.
    pub offset: f32,
    pub velocity: f32,
    pub kind: Kind,
    /// The pitch glides to this step over one step.
    pub slide: bool
}

/// The loop that makes the pitches. `range` in semitones.
#[derive(Clone, Copy, Debug, Default)]
pub struct PitchLoop {
    pub steps: u32,
    pub seed: u32,
    pub mutate: f32,
    pub range: f32,
    pub density: f32,
    pub tie: f32,
    pub accent: f32,
    /// The chance that a step slides. At zero nothing slides.
    pub slide: f32
}

impl PitchLoop {
    pub fn step(&self, position: u32) -> Step {
        let steps = self.steps.clamp(1, MAX_STEPS);
        let (pass, step) = (position / steps, position % steps);
        let generation = generation(self.seed, step, pass, self.mutate);
        let roll = |channel: u32| unit(self.seed, step, generation, channel);
        let kind = if roll(2) >= self.density {Kind::Rest} else if roll(3) < self.tie {Kind::Tie} else {Kind::Play};
        Step {offset: (roll(1) * 2.0 - 1.0) * self.range, velocity: 1.0 - self.accent * roll(4), kind, slide: roll(5) < self.slide}
    }
}

/// A loop of 0 to 1 values with its own length. It knows nothing about what it moves.
#[derive(Clone, Copy, Debug, Default)]
pub struct Lane {
    pub steps: u32,
    pub seed: u32,
    pub mutate: f32
}

impl Lane {
    pub fn value(&self, position: u32) -> f32 {
        let steps = self.steps.clamp(1, MAX_STEPS);
        let (pass, step) = (position / steps, position % steps);
        unit(self.seed, step, generation(self.seed, step, pass, self.mutate), 1)
    }
}

/// What one step plays: the sound, and the note if the step is not a rest. `length` in steps.
#[derive(Clone, Copy, Debug)]
pub struct StepEvent {
    pub patch: Patch,
    pub note: Option<Note>
}

#[derive(Clone, Copy, Debug)]
pub struct Note {
    pub offset: f32,
    pub velocity: f32,
    pub length: f64,
    pub slide: bool
}

/// A pitch loop, four lanes and the sound with its mapping: every parameter has a base and an amount per lane,
/// both in the parameter's 0 to 1 position.
#[derive(Clone, Copy, Debug, Default)]
pub struct Pattern {
    /// Step length as an index into `RATE_PULSES`, shared by the pitch loop and the lanes.
    pub rate: u32,
    pub pitch: PitchLoop,
    pub lanes: [Lane; LANES],
    pub base: [f32; PARAMS],
    pub amounts: [[f32; LANES]; PARAMS]
}

impl Pattern {
    pub fn new(pitch: PitchLoop, lanes: [Lane; LANES]) -> Self {
        let mut pattern = Self {rate: SIXTEENTH, pitch, lanes, base: [0.0; PARAMS], amounts: [[0.0; LANES]; PARAMS]};
        pattern.set(Param::Ratio1, 2.41).set(Param::Feedback, 0.25).set(Param::Ratio2, 5.19).set(Param::Depth, 0.6)
            .set(Param::Strike, 4.0).set(Param::StrikeDecay, 0.14).set(Param::Length, 0.7).set(Param::Glide, 0.04)
            .set(Param::Velocity, 0.7);
        pattern
    }

    /// Sets the base of a parameter in its own unit (ratio, seconds, ...). Switches take their index.
    pub fn set(&mut self, param: Param, value: f32) -> &mut Self {
        let offset = if param.is_switch() {0.5} else {0.0};
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

    // WASM CONTRACT: Random all must keep drawing exactly like this (the ranges were approved by ear). The roll
    // indices and the order of the draws are part of it. Slide is not drawn, it stays at zero.
    pub fn random(seed: u32) -> Self {
        let roll = |index: u32| unit(seed, index, 0, 7);
        let between = |index: u32, low: f32, high: f32| low + (high - low) * roll(index);
        let pitch = PitchLoop {
            steps: between(0, 3.0, 17.0) as u32,
            seed: (roll(1) * 100_000.0) as u32,
            mutate: between(2, 0.04, 0.25),
            range: between(3, 5.0, 19.0),
            density: between(4, 0.55, 0.95),
            tie: between(5, 0.0, 0.4),
            accent: between(6, 0.3, 0.8),
            slide: 0.0
        };
        let lane = |index: u32| Lane {steps: between(10 + index, 2.0, 17.0) as u32, seed: (roll(20 + index) * 100_000.0) as u32, mutate: between(30 + index, 0.05, 0.3)};
        let mut pattern = Pattern::new(pitch, [lane(0), lane(1), lane(2), lane(3)]);
        pattern.set(Param::Ratio1, 0.5 * libm::powf(12.0, roll(40))).set(Param::Ratio2, libm::powf(12.0, roll(41)))
            .set(Param::Depth2, between(42, 0.0, 1.0)).set(Param::Wave, libm::floorf(roll(43) * 4.0).min(3.0))
            .set(Param::Depth, between(44, 0.2, 1.4)).set(Param::StrikeDecay, 0.06 * libm::powf(5.0, roll(45)))
            .set(Param::FoldPlace, libm::floorf(roll(46) * 2.0).min(1.0)).set(Param::HeldShare, between(47, 0.0, 0.15))
            .set(Param::SineLevel, between(48, 0.3, 0.9)).set(Param::SinePitch, libm::floorf(roll(49) * 2.0).min(1.0))
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

    /// What the All button does to a pattern: `random`, plus a Slide chance drawn on its own so `random` stays as
    /// approved. Mutate and Rate are never rolled, they stay as they are.
    pub fn roll_all(&self, seed: u32) -> Self {
        let mut pattern = Self::random(seed);
        pattern.pitch.slide = MAX_RANDOM_SLIDE * unit(seed, 8, 0, 7);
        pattern.pitch.mutate = self.pitch.mutate;
        pattern.rate = self.rate;
        for (rolled, current) in pattern.lanes.iter_mut().zip(self.lanes.iter()) {rolled.mutate = current.mutate;}
        pattern
    }

    /// The parameter's 0 to 1 position at a step: base plus what the lanes add, limited to the range.
    pub fn unit(&self, param: Param, position: u32) -> f32 {
        let added: f32 = (0..LANES).map(|lane| self.amounts[param as usize][lane] * self.lanes[lane].value(position)).sum();
        (self.base[param as usize] + added).clamp(0.0, 1.0)
    }

    pub fn step_pulses(&self) -> f64 {RATE_PULSES[(self.rate as usize).min(RATE_PULSES.len() - 1)]}

    pub fn patch(&self, position: u32) -> Patch {
        let lanes = self.lanes.map(|lane| lane.value(position));
        let unit = |param: Param| -> f32 {
            let added: f32 = (0..LANES).map(|lane| self.amounts[param as usize][lane] * lanes[lane]).sum();
            (self.base[param as usize] + added).clamp(0.0, 1.0)
        };
        let value = |param: Param| param.range().value(unit(param));
        let from = 1.0 - value(Param::HeldShare);
        let length = unit(Param::Length);
        let hold = length >= from;
        Patch {
            ratio: value(Param::Ratio1),
            depth: value(Param::Depth),
            strike: value(Param::Strike),
            strike_decay: value(Param::StrikeDecay),
            feedback: value(Param::Feedback),
            wave: [Wave::Sine, Wave::Half, Wave::Rectified, Wave::Burst][(value(Param::Wave) as usize).min(3)],
            fold: value(Param::Fold),
            fold_place: if value(Param::FoldPlace) < 1.0 {FoldPlace::BeforeGate} else {FoldPlace::AfterGate},
            decay: if hold {HOLD_RELEASE} else {SHORTEST * libm::powf(LONGEST / SHORTEST, length / from.max(1e-6))},
            glide: value(Param::Glide),
            velocity: value(Param::Velocity),
            second_ratio: value(Param::Ratio2),
            second_depth: value(Param::Depth2),
            sine: value(Param::SineLevel),
            sine_ratio: if value(Param::SinePitch) < 1.0 {0.5} else {1.0},
            hold
        }
    }

    pub fn event(&self, position: u32) -> StepEvent {
        let patch = self.patch(position);
        let Step {offset, velocity, kind, slide} = self.pitch.step(position);
        let note = match kind {
            Kind::Rest => None,
            Kind::Tie => Some(Note {offset, velocity, length: TIE_SHARE, slide}),
            Kind::Play => Some(Note {offset, velocity, length: if patch.hold {HOLD_SHARE} else {GATE_SHARE}, slide})
        };
        StepEvent {patch, note}
    }
}
