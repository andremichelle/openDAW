use crate::voice::{Patch, Voice};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    Play,
    Tie,
    Rest
}

#[derive(Clone, Copy, Debug)]
pub struct Step {
    pub offset: f32,
    pub velocity: f32,
    pub kind: Kind
}

const fn step(offset: f32, velocity: f32, kind: Kind) -> Step {Step {offset, velocity, kind}}

/// Seven sixteenths with no key: a short figure that turns against the bar.
pub const FIGURE: [Step; 7] = [
    step(0.0, 1.0, Kind::Play),
    step(6.0, 0.5, Kind::Tie),
    step(1.0, 0.7, Kind::Play),
    step(0.0, 0.0, Kind::Rest),
    step(11.0, 0.9, Kind::Tie),
    step(-2.0, 0.6, Kind::Play),
    step(13.0, 0.4, Kind::Play)
];

const THREE: [Step; 3] = [step(0.0, 1.0, Kind::Play), step(1.0, 0.6, Kind::Tie), step(-1.0, 0.8, Kind::Play)];

const FIVE: [Step; 5] = [
    step(0.0, 1.0, Kind::Play),
    step(0.0, 0.5, Kind::Play),
    step(7.0, 0.8, Kind::Tie),
    step(-5.0, 0.7, Kind::Play),
    step(0.0, 0.0, Kind::Rest)
];

const NINE: [Step; 9] = [
    step(0.0, 1.0, Kind::Play),
    step(0.0, 0.0, Kind::Rest),
    step(3.0, 0.7, Kind::Tie),
    step(2.0, 0.5, Kind::Play),
    step(0.0, 0.0, Kind::Rest),
    step(-7.0, 0.9, Kind::Play),
    step(10.0, 0.6, Kind::Tie),
    step(11.0, 0.4, Kind::Play),
    step(0.0, 0.8, Kind::Play)
];

const ELEVEN: [Step; 11] = [
    step(0.0, 1.0, Kind::Play),
    step(14.0, 0.5, Kind::Play),
    step(-11.0, 0.9, Kind::Tie),
    step(-10.0, 0.6, Kind::Play),
    step(0.0, 0.0, Kind::Rest),
    step(6.0, 0.8, Kind::Play),
    step(0.0, 0.0, Kind::Rest),
    step(17.0, 0.4, Kind::Tie),
    step(4.0, 0.7, Kind::Play),
    step(-6.0, 1.0, Kind::Play),
    step(1.0, 0.5, Kind::Play)
];

const SIXTEEN: [Step; 16] = [
    step(0.0, 1.0, Kind::Play),
    step(0.0, 0.0, Kind::Rest),
    step(0.0, 0.6, Kind::Play),
    step(12.0, 0.8, Kind::Tie),
    step(1.0, 0.5, Kind::Play),
    step(0.0, 0.0, Kind::Rest),
    step(0.0, 0.9, Kind::Play),
    step(0.0, 0.4, Kind::Play),
    step(-12.0, 1.0, Kind::Tie),
    step(0.0, 0.7, Kind::Play),
    step(0.0, 0.0, Kind::Rest),
    step(8.0, 0.6, Kind::Play),
    step(0.0, 0.9, Kind::Play),
    step(13.0, 0.5, Kind::Tie),
    step(6.0, 0.7, Kind::Play),
    step(0.0, 0.0, Kind::Rest)
];

pub const FIGURES: [(&str, &[Step]); 6] = [
    ("three", &THREE),
    ("five", &FIVE),
    ("seven", &FIGURE),
    ("nine", &NINE),
    ("eleven", &ELEVEN),
    ("sixteen", &SIXTEEN)
];

pub const OVERSAMPLING: usize = 2;
const GATE_SHARE: f64 = 0.5;
const TIE_OVERLAP: f64 = 0.1;

/// Renders `steps` sixteenths of the looping figure, mono at `sample_rate`.
pub fn render(patch: Patch, figure: &[Step], centre: f32, tempo: f64, steps: usize, tail: f64, sample_rate: f64) -> Vec<f32> {
    let rate = sample_rate * OVERSAMPLING as f64;
    let step_samples = 60.0 / tempo / 4.0 * rate;
    let total = (steps as f64 * step_samples + tail * rate) as usize;
    let mut events: Vec<(usize, Option<(f32, f32)>)> = Vec::new();
    for index in 0..steps {
        let Step {offset, velocity, kind} = figure[index % figure.len()];
        if kind == Kind::Rest {continue;}
        let start = index as f64 * step_samples;
        let length = if kind == Kind::Tie {1.0 + TIE_OVERLAP} else {GATE_SHARE};
        events.push((start as usize, Some((centre + offset, velocity))));
        events.push(((start + length * step_samples) as usize, None));
    }
    events.sort_by_key(|(position, event)| (*position, event.is_none()));
    let mut voice = Voice::new(patch, rate as f32);
    let mut output = Vec::with_capacity(total);
    let mut cursor = 0;
    for position in 0..total {
        while cursor < events.len() && events[cursor].0 <= position {
            match events[cursor].1 {
                Some((pitch, velocity)) => voice.note_on(pitch, velocity),
                None => voice.note_off()
            }
            cursor += 1;
        }
        output.push(voice.next());
    }
    decimate(&output)
}

const TAPS: usize = 95;

/// Halves the rate through a windowed sinc low pass at a quarter of the input rate.
pub fn decimate(input: &[f32]) -> Vec<f32> {
    let centre = (TAPS / 2) as isize;
    let kernel: Vec<f64> = (0..TAPS as isize).map(|tap| {
        let distance = (tap - centre) as f64;
        let sinc = if distance == 0.0 {0.5} else {(std::f64::consts::PI * distance * 0.5).sin() / (std::f64::consts::PI * distance)};
        let window = 0.42 - 0.5 * (std::f64::consts::TAU * tap as f64 / (TAPS - 1) as f64).cos()
            + 0.08 * (2.0 * std::f64::consts::TAU * tap as f64 / (TAPS - 1) as f64).cos();
        sinc * window
    }).collect();
    (0..input.len() / 2).map(|frame| {
        let mut sum = 0.0;
        for (tap, weight) in kernel.iter().enumerate() {
            let position = (frame * 2) as isize + tap as isize - centre;
            if position >= 0 && (position as usize) < input.len() {sum += input[position as usize] as f64 * weight;}
        }
        sum as f32
    }).collect()
}
