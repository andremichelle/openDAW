// A groove hands the engine the straight range of each block: steps, bars and lanes follow it.

use device_surgeon::engine::{Engine, Slot, MAX_FRAMES, PATTERNS};
use device_surgeon::pattern::Pattern;

const RATE: f32 = 48_000.0;
const BLOCK_PULSES: f64 = 4.0; // 93.75 bpm, exact so a shift by whole blocks has no rounding
const BAR: f64 = 3840.0;

fn engine(slot: Slot) -> Engine {
    let mut engine = Engine::new(RATE);
    for (index, pattern) in engine.patterns.iter_mut().enumerate() {*pattern = Pattern::random(index as u32 + 1);}
    engine.select(slot);
    engine
}

// renders `blocks` blocks from pulse zero, `straight` maps a timeline pulse to its straight pulse and `warp` back
fn render(engine: &mut Engine, blocks: usize, straight: impl Fn(f64) -> f64, warp: impl Fn(f64) -> f64) -> Vec<f32> {
    render_frames(engine, blocks, MAX_FRAMES, false, straight, warp)
}

fn render_frames(engine: &mut Engine, blocks: usize, frames: usize, wrapped: bool, straight: impl Fn(f64) -> f64,
                 warp: impl Fn(f64) -> f64) -> Vec<f32> {
    let mut output = vec![0.0; blocks * frames];
    let pulses = BLOCK_PULSES * frames as f64 / MAX_FRAMES as f64;
    for block in 0..blocks {
        let t0 = block as f64 * pulses;
        grooved(engine, t0, t0 + pulses, (straight(t0), straight(t0 + pulses)), &warp, wrapped && block == 0,
                &mut output[block * frames..(block + 1) * frames]);
    }
    output
}

// one block with the same groove for every pattern
fn grooved(engine: &mut Engine, t0: f64, t1: f64, range: (f64, f64), warp: &impl Fn(f64) -> f64, discontinuous: bool,
           output: &mut [f32]) {
    engine.process_grooved(t0, t1, &[range; PATTERNS], |_, pulse| warp(pulse), |_| (0.0, BAR), true, discontinuous, output);
}

fn plain(engine: &mut Engine, blocks: usize, wait: usize) -> Vec<f32> {
    let mut output = vec![0.0; blocks * MAX_FRAMES];
    for block in 0..blocks {
        let p0 = (block as f64 - wait as f64) * BLOCK_PULSES;
        engine.process(p0, p0 + BLOCK_PULSES, block >= wait, false, &mut output[block * MAX_FRAMES..(block + 1) * MAX_FRAMES]);
    }
    output
}

fn bits(samples: &[f32]) -> Vec<u32> {samples.iter().map(|sample| sample.to_bits()).collect()}

// every second sixteenth half a step late, the straight grid lines stay where they are
fn swing(pulse: f64) -> f64 {
    let (pair, inside) = ((pulse / 480.0).floor() * 480.0, pulse.rem_euclid(480.0));
    pair + if inside < 360.0 {inside * 240.0 / 360.0} else {240.0 + (inside - 360.0) * 2.0}
}

fn swing_warp(pulse: f64) -> f64 {
    let (pair, inside) = ((pulse / 480.0).floor() * 480.0, pulse.rem_euclid(480.0));
    pair + if inside < 240.0 {inside * 360.0 / 240.0} else {360.0 + (inside - 240.0) * 0.5}
}

#[test]
fn a_straight_range_equal_to_the_block_plays_as_without_a_groove() {
    for slot in [Slot::Pattern(0), Slot::Pattern(5)] {
        assert_eq!(bits(&plain(&mut engine(slot), 600, 0)), bits(&render(&mut engine(slot), 600, |pulse| pulse, |pulse| pulse)));
    }
}

#[test]
fn a_late_groove_moves_every_sample_later_by_its_offset() {
    // the reference waits the same blocks with the transport stopped, the oscillators run on in silence
    let shift = 7;
    let offset = shift as f64 * BLOCK_PULSES;
    let reference = plain(&mut engine(Slot::Pattern(3)), 900, shift);
    let late = render(&mut engine(Slot::Pattern(3)), 900, |pulse| pulse - offset, |pulse| pulse + offset);
    assert!(late[..shift * MAX_FRAMES].iter().all(|sample| *sample == 0.0), "nothing before the first step");
    assert!(late.iter().any(|sample| *sample != 0.0));
    assert_eq!(bits(&late), bits(&reference));
}

#[test]
fn a_late_groove_after_a_loop_wrap_starts_the_first_step_late_as_well() {
    // after the wrap the straight range waits on the loop start until the groove has caught up
    let shift = 10;
    let offset = shift as f64 * BLOCK_PULSES;
    let reference = plain(&mut engine(Slot::Pattern(3)), 900, shift);
    let wrapped = render_frames(&mut engine(Slot::Pattern(3)), 900, MAX_FRAMES, true, |pulse| (pulse - offset).max(0.0),
                                |pulse| pulse + offset);
    assert!(wrapped[..shift * MAX_FRAMES].iter().all(|sample| *sample == 0.0), "nothing while the range waits");
    assert_eq!(bits(&wrapped), bits(&reference));
}

#[test]
fn a_range_waiting_on_the_loop_end_plays_nothing_from_behind_it() {
    // an early groove reaches the loop end before the block does: the step and the bar on that line belong to the wrap
    let every_step = |slot: Slot| {
        let mut engine = engine(slot);
        for pattern in engine.patterns.iter_mut() {
            pattern.pitch.density = 1.0;
            pattern.pitch.tie = 0.0;
        }
        engine
    };
    let reach = (BAR / BLOCK_PULSES) as usize;
    let run = |hold: f64| {
        let mut engine = every_step(Slot::Pattern(1));
        let straight = move |pulse: f64| if pulse >= BAR {hold} else {pulse};
        let output = render(&mut engine, reach + 40, straight, |pulse| pulse);
        (output, engine)
    };
    let (on_the_line, mut engine) = run(BAR);
    let (below_the_line, _) = run(BAR - 1e-6);
    assert_eq!(bits(&on_the_line), bits(&below_the_line));
    engine.fire(Slot::Pattern(2));
    let mut output = [0.0; MAX_FRAMES];
    grooved(&mut engine, BAR + 160.0, BAR + 164.0, (BAR, BAR), &|pulse| pulse, false, &mut output);
    assert_eq!(engine.active(), Slot::Pattern(1), "the pattern waits for the bar to be crossed");
    grooved(&mut engine, BAR + 164.0, BAR + 168.0, (BAR, BAR + 4.0), &|pulse| pulse, false, &mut output);
    assert_eq!(engine.active(), Slot::Pattern(2));
}

#[test]
fn a_swing_changes_the_timing_and_stays_finite() {
    let straight = render(&mut engine(Slot::Pattern(1)), 900, |pulse| pulse, |pulse| pulse);
    let swung = render(&mut engine(Slot::Pattern(1)), 900, swing, swing_warp);
    assert!(swung.iter().all(|sample| sample.is_finite()));
    assert_ne!(bits(&straight), bits(&swung));
}

#[test]
fn a_step_between_two_blocks_sounds_exactly_where_the_groove_puts_it() {
    // late by a part of a block: the same samples as a timeline that runs that much behind
    let offset = 1.3;
    let mut behind = engine(Slot::Pattern(3));
    let mut reference = vec![0.0; 900 * MAX_FRAMES];
    for block in 0..900 {
        let p0 = block as f64 * BLOCK_PULSES - offset;
        behind.process(p0, p0 + BLOCK_PULSES, true, false, &mut reference[block * MAX_FRAMES..(block + 1) * MAX_FRAMES]);
    }
    let late = render(&mut engine(Slot::Pattern(3)), 900, |pulse| pulse - offset, |pulse| pulse + offset);
    assert_eq!(bits(&late), bits(&reference));
}

#[test]
fn a_swing_sounds_the_same_whatever_the_block_size() {
    // moved off the block borders, so every step starts inside a block
    let (straight, warp) = (|pulse: f64| swing(pulse - 1.3), |pulse: f64| swing_warp(pulse) + 1.3);
    let whole = render_frames(&mut engine(Slot::Pattern(1)), 900, MAX_FRAMES, false, straight, warp);
    for frames in [64, 32, 16] {
        let split = render_frames(&mut engine(Slot::Pattern(1)), 900 * MAX_FRAMES / frames, frames, false, straight, warp);
        assert_eq!(bits(&whole), bits(&split), "{frames} frames");
    }
}

#[test]
fn a_range_that_does_not_move_starts_no_step() {
    let output = render(&mut engine(Slot::Pattern(2)), 400, |_| -1.0, |pulse| pulse);
    assert!(output.iter().all(|sample| *sample == 0.0));
}

#[test]
fn a_groove_that_moves_the_range_back_a_little_plays_no_step_twice() {
    // a changed groove: from `turn` on the range is 100 pulses behind. Holding the range still for that long is the same
    let turn = 5.0 * 240.0 + 12.0;
    let back = |pulse: f64| if pulse < turn {pulse} else {pulse - 100.0};
    let held = |pulse: f64| if pulse < turn {pulse} else {(pulse - 100.0).max(turn)};
    let moved = render(&mut engine(Slot::Pattern(4)), 900, back, |pulse| pulse);
    let reference = render(&mut engine(Slot::Pattern(4)), 900, held, |pulse| pulse);
    assert_eq!(bits(&moved), bits(&reference));
}

#[test]
fn a_groove_that_moves_the_range_far_plays_on_from_there() {
    // two bars back without a jump of the transport: the steps there play again, as after a jump
    let turn = 3.0 * BAR;
    let moved = render(&mut engine(Slot::Pattern(4)), 4 * 960, |pulse| if pulse < turn {pulse} else {pulse - 2.0 * BAR},
                       |pulse| pulse);
    let from = (turn / BLOCK_PULSES) as usize * MAX_FRAMES;
    let peak = moved[from..from + 240 * MAX_FRAMES].iter().fold(0.0f32, |max, sample| max.max(sample.abs()));
    assert!(peak > 0.01, "silent after the move: {peak}");
}

#[test]
fn a_slide_lasts_as_long_as_its_step_sounds() {
    // the step from 240 on sounds 120 pulses long, whatever the groove does inside it
    let warp = |pulse: f64| if pulse < 300.0 {pulse} else if pulse < 480.0 {300.0 + (pulse - 300.0) / 3.0} else {pulse - 120.0};
    assert_eq!(Engine::step_samples(&warp, 240.0, 240.0, 0.5), 240.0);
    assert_eq!(Engine::step_samples(&warp, 0.0, 240.0, 0.5), 480.0);
    assert_eq!(Engine::step_samples(&warp, 240.0, 240.0, 0.0), 0.0);
}

// pattern 1 rests, pattern 2 strikes on every step. Fired before the second bar, pattern 2 takes over at its line
fn takeover(late: [f64; PATTERNS]) -> Vec<f32> {
    let mut engine = engine(Slot::Pattern(1));
    engine.patterns[1].pitch.density = 0.0;
    engine.patterns[2].pitch.density = 1.0;
    engine.patterns[2].pitch.tie = 0.0;
    let blocks = (2.0 * BAR / BLOCK_PULSES) as usize;
    let mut output = vec![0.0; blocks * MAX_FRAMES];
    for block in 0..blocks {
        if block == 100 {engine.fire(Slot::Pattern(2));}
        let t0 = block as f64 * BLOCK_PULSES;
        let ranges: [(f64, f64); PATTERNS] = core::array::from_fn(|index| (t0 - late[index], t0 + BLOCK_PULSES - late[index]));
        engine.process_grooved(t0, t0 + BLOCK_PULSES, &ranges, |index, pulse| pulse + late[index], |_| (0.0, BAR), true, false,
                               &mut output[block * MAX_FRAMES..(block + 1) * MAX_FRAMES]);
    }
    output
}

fn first_sound(output: &[f32]) -> usize {output.iter().position(|sample| *sample != 0.0).unwrap_or(output.len())}

#[test]
fn every_pattern_plays_through_its_own_groove() {
    let block_of = |sample: usize| sample / MAX_FRAMES;
    let straight = block_of(first_sound(&takeover([0.0; PATTERNS])));
    let mut late = [0.0; PATTERNS];
    late[2] = 40.0;
    let moved = block_of(first_sound(&takeover(late)));
    assert_eq!(straight, (BAR / BLOCK_PULSES) as usize, "pattern 2 starts on the bar line");
    assert_eq!(moved, straight + 10, "pattern 2 starts later by its own groove");
    let mut others = [40.0; PATTERNS];
    others[2] = 0.0;
    assert_eq!(block_of(first_sound(&takeover(others))), straight + 10, "it takes over where the groove of pattern 1 puts the bar");
    others[1] = 0.0;
    assert_eq!(block_of(first_sound(&takeover(others))), straight, "the grooves of the patterns that do not play change nothing");
}

#[test]
fn a_pattern_with_an_early_groove_takes_over_on_the_bar_line_of_the_one_before() {
    // pattern 2 is a step early: its first step is not pulled before the bar line, it starts there with the second
    let mut early = [0.0; PATTERNS];
    early[2] = -240.0;
    let output = takeover(early);
    assert_eq!(first_sound(&output) / MAX_FRAMES, (BAR / BLOCK_PULSES) as usize);
    assert!(output.iter().all(|sample| sample.is_finite()));
}

#[test]
fn a_groove_on_a_pattern_that_does_not_play_keeps_every_sample() {
    // swing on every pattern but the playing one: the same samples as without any groove, at an uneven block length
    let blocks = 700;
    let pulses = 3.7;
    let mut plain_engine = engine(Slot::Pattern(4));
    let mut grooved_engine = engine(Slot::Pattern(4));
    let (mut plain, mut grooved) = (vec![0.0; blocks * MAX_FRAMES], vec![0.0; blocks * MAX_FRAMES]);
    for block in 0..blocks {
        let (t0, t1) = (block as f64 * pulses, (block + 1) as f64 * pulses);
        let range = block * MAX_FRAMES..(block + 1) * MAX_FRAMES;
        plain_engine.process(t0, t1, true, false, &mut plain[range.clone()]);
        let ranges: [(f64, f64); PATTERNS] = core::array::from_fn(|index| if index == 4 {(t0, t1)} else {(swing(t0), swing(t1))});
        grooved_engine.process_grooved(t0, t1, &ranges, |index, pulse| if index == 4 {pulse} else {swing_warp(pulse)},
                                       |_| (0.0, BAR), true, false, &mut grooved[range]);
    }
    assert_eq!(bits(&plain), bits(&grooved));
}
