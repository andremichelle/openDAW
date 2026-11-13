//! Renders Random all patterns for listening, 8 bars each, into `<folder>/listen`. It never touches the archive.
//! Run from `crates/surgeon-lab`: cargo run --release --bin render_random -- ../target/surgeon-lab [first seed] [count]

use std::env;
use std::path::PathBuf;
use std::process::ExitCode;
use surgeon_lab::pattern::{Pattern, Performance};
use surgeon_lab::wash::Wash;
use surgeon_lab::wav;

const SAMPLE_RATE: f64 = 48_000.0;
const TEMPO: f64 = 136.0;
const BARS: u32 = 8;
const TAIL: f64 = 3.0;
const LEVEL: f32 = 0.1;

fn main() -> ExitCode {
    let arguments: Vec<String> = env::args().collect();
    let folder = arguments.get(1).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("../target/surgeon-lab")).join("listen");
    let first: u32 = arguments.get(2).and_then(|text| text.parse().ok()).unwrap_or(1);
    let count: u32 = arguments.get(3).and_then(|text| text.parse().ok()).unwrap_or(12);
    for seed in first..first + count {
        let patterns = [Pattern::random(seed)];
        let dry = Performance {patterns: &patterns, schedule: &[(0, Some(0))], tempo: TEMPO}.render(BARS, TAIL, SAMPLE_RATE);
        let [left, right] = Wash::DEFAULT.process(&dry, TEMPO, SAMPLE_RATE);
        let name = format!("random-{seed:02}");
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
