//! Prints reference values for the TypeScript port of the loops (the editor draws what the engine plays).
//! Run from `crates`: cargo run -p device-surgeon --example vectors

use device_surgeon::hash::{generation, unit};
use device_surgeon::param::Param;
use device_surgeon::pattern::{Kind, Pattern};

fn main() {
    let units: Vec<String> = [(1u32, 0u32, 0u32, 1u32), (21, 3, 2, 1), (99_999, 31, 300, 7), (4_294_967_295, 7, 1, 4)].iter()
        .map(|(seed, first, second, third)| format!("{}", unit(*seed, *first, *second, *third))).collect();
    println!("units: [{}]", units.join(", "));
    println!("generations: [{}, {}, {}]", generation(21, 3, 300, 0.15), generation(1, 0, 40, 0.12), generation(7, 5, 1000, 0.5));
    for seed in [1u32, 5, 12] {
        let pattern = Pattern::random(seed);
        let steps: Vec<String> = (0..20).map(|position| {
            let step = pattern.pitch.step(position);
            format!("[{}, {}, {}]", step.offset, step.velocity, match step.kind {Kind::Play => 0, Kind::Tie => 1, Kind::Rest => 2})
        }).collect();
        let lanes: Vec<String> = (0..4).map(|lane| format!("[{}, {}, {}, {}]", pattern.lanes[lane].steps, pattern.lanes[lane].seed, pattern.lanes[lane].mutate, pattern.lanes[lane].value(37))).collect();
        let bases: Vec<String> = pattern.base.iter().map(|value| format!("{value}")).collect();
        let amounts: Vec<String> = pattern.amounts.iter().map(|row| format!("[{}, {}, {}, {}]", row[0], row[1], row[2], row[3])).collect();
        println!("random {seed}: pitch [{}, {}, {}, {}, {}, {}, {}]", pattern.pitch.steps, pattern.pitch.seed, pattern.pitch.mutate, pattern.pitch.range, pattern.pitch.density, pattern.pitch.tie, pattern.pitch.accent);
        println!("  steps: [{}]", steps.join(", "));
        println!("  lanes: [{}]", lanes.join(", "));
        println!("  base: [{}]", bases.join(", "));
        println!("  amounts: [{}]", amounts.join(", "));
        println!("  feedback at 37: {}", pattern.unit(Param::Feedback, 37));
        println!("  slide of the All button: {}", Pattern::default().roll_all(seed).pitch.slide);
    }
}
