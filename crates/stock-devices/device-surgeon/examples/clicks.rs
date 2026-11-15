//! Looks for clicks: plays Random all patterns through the voice like the engine does and measures, at every step
//! start, how far the first sample after the change lands from where the sound was heading. Each change is also
//! applied alone to a copy of the voice to see which one causes the jump.
//! Run from `crates`: cargo run -p device-surgeon --release --example clicks

use device_surgeon::pattern::Pattern;
use device_surgeon::voice::{Patch, Voice};

const RATE: f32 = 96_000.0;
const STEP: f64 = 60.0 / 136.0 / 4.0 * 96_000.0;
const STEPS: u32 = 16 * 16;
const AUDIBLE: f32 = 0.01;

// how far the next sample lands from the straight continuation of the last two
fn jump(mut voice: Voice, history: [f32; 2]) -> f32 {(voice.next() - (2.0 * history[1] - history[0])).abs()}

fn main() {
    println!("seed | steps with a jump above {AUDIBLE} | caused by: velocity step, strike, sine gain step, other sound steps | largest");
    for seed in 1..=12 {
        let pattern = Pattern::random(seed);
        let mut voice = Voice::default();
        voice.init(RATE);
        let (mut history, mut offs, mut velocity, mut patch) = ([0.0f32; 2], Vec::<usize>::new(), 0.0f32, Patch::default());
        let (mut clicks, mut by_velocity, mut by_strike, mut by_sine, mut by_sound, mut largest) = (0, 0, 0, 0, 0, 0.0f32);
        let (mut ends, mut end_clicks) = (0, 0);
        let mut next_step = 0u32;
        for sample in 0..(STEPS as f64 * STEP) as usize {
            if next_step < STEPS && sample >= (next_step as f64 * STEP) as usize {
                let event = pattern.event(next_step);
                let quiet = jump(voice, history);
                let mut full = voice;
                full.set_patch(event.patch);
                if let Some(note) = event.note {full.note_on(50.0 + note.offset, note.velocity, 0);}
                let size = jump(full, history) - quiet;
                if size > AUDIBLE {
                    clicks += 1;
                    largest = largest.max(size);
                    let mut sound = voice;
                    sound.set_patch(event.patch);
                    let mut sine = voice;
                    sine.set_patch(Patch {sine: event.patch.sine, ..patch});
                    let (mut same_velocity, mut struck) = (voice, voice);
                    if let Some(note) = event.note {
                        same_velocity.note_on(50.0 + note.offset, velocity, 0);
                        struck.note_on(50.0 + note.offset, note.velocity, 0);
                    }
                    let parts = [jump(struck, history) - jump(same_velocity, history), jump(same_velocity, history) - quiet, jump(sine, history) - quiet, jump(sound, history) - jump(sine, history)];
                    let cause = (0..4).max_by(|first, second| parts[*first].total_cmp(&parts[*second])).unwrap();
                    match cause {0 => by_velocity += 1, 1 => by_strike += 1, 2 => by_sine += 1, _ => by_sound += 1}
                }
                voice.set_patch(event.patch);
                patch = event.patch;
                if let Some(note) = event.note {
                    voice.note_on(50.0 + note.offset, note.velocity, 0);
                    velocity = note.velocity;
                    offs.push(sample + (note.length * STEP) as usize);
                }
                next_step += 1;
            }
            for at in offs.iter() {
                if *at <= sample {
                    let quiet = jump(voice, history);
                    voice.note_off();
                    ends += 1;
                    if jump(voice, history) - quiet > AUDIBLE {end_clicks += 1;}
                }
            }
            offs.retain(|at| *at > sample);
            history = [history[1], voice.next()];
        }
        println!("{seed:4} | {clicks:3} of {STEPS} | {by_velocity:3} {by_strike:3} {by_sine:3} {by_sound:3} | {largest:.3} | note ends with a jump: {end_clicks} of {ends}");
    }
}
