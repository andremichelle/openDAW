// A groove hands the engine the straight range of each block: steps, bars and lanes follow it.

use device_surgeon::engine::{Engine, Slot, MAX_FRAMES};
use device_surgeon::pattern::Pattern;

const RATE: f32 = 48_000.0;
const BLOCK_PULSES: f64 = 4.0; // 93.75 bpm, exact so a shift by whole blocks has no rounding

fn engine(slot: Slot) -> Engine {
    let mut engine = Engine::new(RATE);
    for (index, pattern) in engine.patterns.iter_mut().enumerate() {*pattern = Pattern::random(index as u32 + 1);}
    engine.select(slot);
    engine
}

// renders `blocks` blocks from pulse zero, `straight` maps a timeline pulse to its straight pulse
fn render(engine: &mut Engine, blocks: usize, straight: impl Fn(f64) -> f64) -> Vec<f32> {
    let mut output = vec![0.0; blocks * MAX_FRAMES];
    for block in 0..blocks {
        let p0 = block as f64 * BLOCK_PULSES;
        let (s0, s1) = (straight(p0), straight(p0 + BLOCK_PULSES));
        engine.process_straight(s0, s1, true, false, 0.0, 3840.0, &mut output[block * MAX_FRAMES..(block + 1) * MAX_FRAMES]);
    }
    output
}

fn bits(samples: &[f32]) -> Vec<u32> {samples.iter().map(|sample| sample.to_bits()).collect()}

#[test]
fn a_straight_range_equal_to_the_block_plays_as_without_a_groove() {
    for slot in [Slot::Pattern(0), Slot::Pattern(5)] {
        let mut plain = engine(slot);
        let mut output = vec![0.0; 600 * MAX_FRAMES];
        for block in 0..600 {
            let p0 = block as f64 * BLOCK_PULSES;
            plain.process(p0, p0 + BLOCK_PULSES, true, false, &mut output[block * MAX_FRAMES..(block + 1) * MAX_FRAMES]);
        }
        assert_eq!(bits(&output), bits(&render(&mut engine(slot), 600, |pulse| pulse)));
    }
}

#[test]
fn a_late_groove_moves_every_sample_later_by_its_offset() {
    // the reference waits the same blocks with the transport stopped, the oscillators run on in silence
    let shift = 7;
    let mut waiting = engine(Slot::Pattern(3));
    let mut plain = vec![0.0; 900 * MAX_FRAMES];
    for block in 0..900 {
        let p0 = (block as f64 - shift as f64) * BLOCK_PULSES;
        waiting.process(p0, p0 + BLOCK_PULSES, block >= shift, false, &mut plain[block * MAX_FRAMES..(block + 1) * MAX_FRAMES]);
    }
    let late = render(&mut engine(Slot::Pattern(3)), 900, |pulse| pulse - shift as f64 * BLOCK_PULSES);
    assert!(late[..shift * MAX_FRAMES].iter().all(|sample| *sample == 0.0), "nothing before the first step");
    assert!(late.iter().any(|sample| *sample != 0.0));
    assert_eq!(bits(&late), bits(&plain));
}

#[test]
fn a_swing_changes_the_timing_and_stays_finite() {
    // every second sixteenth half a step late, the straight grid lines stay where they are
    let swing = |pulse: f64| {
        let (pair, inside) = ((pulse / 480.0).floor() * 480.0, pulse.rem_euclid(480.0));
        pair + if inside < 360.0 {inside * 240.0 / 360.0} else {240.0 + (inside - 360.0) * 2.0}
    };
    let plain = render(&mut engine(Slot::Pattern(1)), 900, |pulse| pulse);
    let swung = render(&mut engine(Slot::Pattern(1)), 900, swing);
    assert!(swung.iter().all(|sample| sample.is_finite()));
    assert_ne!(bits(&plain), bits(&swung));
}

#[test]
fn a_range_that_does_not_move_starts_no_step() {
    let mut held = engine(Slot::Pattern(2));
    let output = render(&mut held, 400, |_| -1.0);
    assert!(output.iter().all(|sample| *sample == 0.0));
}
