//! Measures how much of real time the engine needs: renders patterns in blocks like the studio and prints the
//! share of real time. Run from `crates`: cargo run -p device-surgeon --release --example bench

use device_surgeon::engine::{Engine, MAX_FRAMES};
use device_surgeon::pattern::Pattern;
use std::time::Instant;

const SAMPLE_RATE: f64 = 48_000.0;
const TEMPO: f64 = 136.0;
const SECONDS: f64 = 60.0;

fn main() {
    let pulses_per_frame = TEMPO / 60.0 * 960.0 / SAMPLE_RATE;
    let total = (SECONDS * SAMPLE_RATE) as usize;
    for (name, seed, mutate) in [("random 1", 1, None), ("random 9", 9, None), ("random 9, short loops, Mutate 100 %", 9, Some(1.0))] {
        let mut pattern = Pattern::random(seed);
        if let Some(mutate) = mutate {
            pattern.pitch.steps = 1;
            pattern.pitch.mutate = mutate;
            pattern.lanes.iter_mut().for_each(|lane| {
                lane.steps = 1;
                lane.mutate = mutate;
            });
        }
        let mut engine = Engine::new(SAMPLE_RATE as f32);
        engine.patterns[0] = pattern;
        let mut output = [0.0f32; MAX_FRAMES];
        let (mut done, mut checksum) = (0, 0.0f64);
        let start = Instant::now();
        while done < total {
            let (p0, p1) = (done as f64 * pulses_per_frame, (done + MAX_FRAMES) as f64 * pulses_per_frame);
            engine.process(p0, p1, true, false, &mut output);
            checksum += output[0] as f64;
            done += MAX_FRAMES;
        }
        let elapsed = start.elapsed().as_secs_f64();
        println!("{name}: {:.2} % of real time ({:.0} ns per sample, checksum {checksum:.6})", elapsed / SECONDS * 100.0, elapsed / total as f64 * 1e9);
    }
}
