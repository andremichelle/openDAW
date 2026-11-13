//! Renders the engine's own output for listening: the favourite and Random all patterns, 8 bars each, in blocks
//! like the studio. Run from `crates`: cargo run -p device-surgeon --release --example render -- [folder] [count]

use device_surgeon::engine::{Engine, MAX_FRAMES};
use device_surgeon::param::Param;
use device_surgeon::pattern::{Lane, Pattern, PitchLoop};
use std::env;
use std::path::PathBuf;
use std::process::ExitCode;
use surgeon_lab::wash::Wash;
use surgeon_lab::wav;

const SAMPLE_RATE: f64 = 48_000.0;
const TEMPO: f64 = 136.0;
const BARS: usize = 8;
const TAIL: f64 = 3.0;
const LEVEL: f32 = 0.1;

fn favourite() -> Pattern {
    let pitch = PitchLoop {steps: 7, seed: 1, mutate: 0.12, range: 13.0, density: 0.8, tie: 0.25, accent: 0.6, slide: 0.0};
    let lane = |steps: u32, seed: u32| Lane {steps, seed, mutate: 0.15};
    let mut pattern = Pattern::new(pitch, [lane(5, 21), lane(9, 22), lane(4, 23), lane(11, 24)]);
    pattern.set(Param::Wave, 2.0).set(Param::SineLevel, 0.6).set(Param::Depth2, 0.6).set(Param::HeldShare, 0.08)
        .map(Param::Feedback, 0, 0.0, 0.8).map(Param::Strike, 1, 1.0, 7.0).map(Param::Fold, 2, 0.0, 0.5).map(Param::Length, 3, 0.0, 1.0);
    pattern
}

fn render(pattern: Pattern) -> Vec<f32> {
    let mut engine = Engine::new(SAMPLE_RATE as f32);
    engine.patterns[0] = pattern;
    let pulses_per_frame = TEMPO / 60.0 * 960.0 / SAMPLE_RATE;
    let playing = (60.0 / TEMPO * 4.0 * SAMPLE_RATE) as usize * BARS;
    let total = playing + (TAIL * SAMPLE_RATE) as usize;
    let mut output = vec![0.0; total];
    let mut done = 0;
    while done < total {
        let length = MAX_FRAMES.min(total - done);
        let (p0, p1) = (done as f64 * pulses_per_frame, (done + length) as f64 * pulses_per_frame);
        engine.process(p0, p1, done < playing, false, &mut output[done..done + length]);
        done += length;
    }
    output
}

fn main() -> ExitCode {
    let arguments: Vec<String> = env::args().collect();
    let folder = arguments.get(1).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("target/surgeon-lab")).join("listen");
    let count: u32 = arguments.get(2).and_then(|text| text.parse().ok()).unwrap_or(6);
    let mut renders = vec![(String::from("engine-favourite"), favourite())];
    (1..=count).for_each(|seed| renders.push((format!("engine-random-{seed:02}"), Pattern::random(seed))));
    for (name, pattern) in renders {
        let dry = render(pattern);
        let [left, right] = Wash::DEFAULT.process(&dry, TEMPO, SAMPLE_RATE);
        let results = [
            wav::write(&folder.join(format!("{name}-dry.wav")), SAMPLE_RATE, &[&dry], LEVEL),
            wav::write(&folder.join(format!("{name}-wash.wav")), SAMPLE_RATE, &[&left, &right], LEVEL)
        ];
        for result in results {
            if let Err(error) = result {
                eprintln!("{error}");
                return ExitCode::FAILURE;
            }
        }
        println!("{name}");
    }
    ExitCode::SUCCESS
}
