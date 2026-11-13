// Notes from the track: they sound while the slot is Off and change nothing while a pattern plays.

use device_surgeon::engine::{Engine, Slot, BAR_PULSES, MAX_FRAMES};
use device_surgeon::pattern::Pattern;

const RATE: f32 = 48_000.0;
const BLOCK_PULSES: f64 = MAX_FRAMES as f64 * 960.0 * 2.0 / RATE as f64; // 120 bpm

fn engine(slot: Slot) -> Engine {
    let mut engine = Engine::new(RATE);
    for (index, pattern) in engine.patterns.iter_mut().enumerate() {*pattern = Pattern::random(index as u32 + 1);}
    engine.select(slot);
    engine
}

// renders `blocks` blocks from pulse zero, `before` runs ahead of each block
fn render(engine: &mut Engine, blocks: usize, playing: bool, mut before: impl FnMut(&mut Engine, usize)) -> Vec<f32> {
    let mut output = vec![0.0; blocks * MAX_FRAMES];
    for block in 0..blocks {
        before(engine, block);
        let p0 = block as f64 * BLOCK_PULSES;
        engine.process(p0, p0 + BLOCK_PULSES, playing, false, &mut output[block * MAX_FRAMES..(block + 1) * MAX_FRAMES]);
    }
    output
}

fn rms(samples: &[f32]) -> f32 {(samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt()}

fn bits(samples: &[f32]) -> Vec<u32> {samples.iter().map(|sample| sample.to_bits()).collect()}

#[test]
fn off_is_silent_without_notes() {
    for playing in [false, true] {
        let output = render(&mut engine(Slot::Off), 400, playing, |_, _| {});
        assert!(output.iter().all(|sample| *sample == 0.0));
    }
}

#[test]
fn a_note_sounds_while_off_with_the_transport_running_or_stopped() {
    for playing in [false, true] {
        let output = render(&mut engine(Slot::Off), 200, playing, |engine, block| if block == 10 {engine.note_on(1, 50.0, 0.8);});
        assert!(output[..10 * MAX_FRAMES].iter().all(|sample| *sample == 0.0), "silent before the note");
        assert!(rms(&output[10 * MAX_FRAMES..40 * MAX_FRAMES]) > 0.01, "the note sounds, playing {playing}");
        assert!(output.iter().all(|sample| sample.is_finite()));
    }
}

#[test]
fn notes_change_nothing_while_a_pattern_plays() {
    let plain = render(&mut engine(Slot::Pattern(2)), 800, true, |_, _| {});
    let with_notes = render(&mut engine(Slot::Pattern(2)), 800, true, |engine, block| {
        if block % 37 == 5 {engine.note_on(block as u32, 40.0 + (block % 24) as f32, 0.9);}
        if block % 37 == 20 {engine.note_off(block as u32 - 15);}
    });
    assert_eq!(bits(&plain), bits(&with_notes));
}

#[test]
fn the_pitch_is_the_note_and_tune_does_not_move_it() {
    let mut low = engine(Slot::Off);
    let mut high = engine(Slot::Off);
    high.tune = 80.0;
    let first = render(&mut low, 100, false, |engine, block| if block == 0 {engine.note_on(1, 57.0, 0.8);});
    let second = render(&mut high, 100, false, |engine, block| if block == 0 {engine.note_on(1, 57.0, 0.8);});
    assert_eq!(bits(&first), bits(&second));
    let other = render(&mut engine(Slot::Off), 100, false, |engine, block| if block == 0 {engine.note_on(1, 64.0, 0.8);});
    assert_ne!(bits(&first), bits(&other));
}

#[test]
fn a_released_note_rings_out_and_ends() {
    let mut held = engine(Slot::Off);
    for pattern in held.patterns.iter_mut() {
        pattern.base[device_surgeon::param::Param::HeldShare as usize] = 1.0;
        pattern.base[device_surgeon::param::Param::Length as usize] = 1.0;
    }
    let output = render(&mut held, 3000, false, |engine, block| {
        if block == 0 {engine.note_on(7, 50.0, 0.8);}
        if block == 1000 {engine.note_off(7);}
    });
    assert!(rms(&output[900 * MAX_FRAMES..1000 * MAX_FRAMES]) > 0.01, "a held note sounds until it is released");
    assert!(output[2900 * MAX_FRAMES..].iter().all(|sample| *sample == 0.0), "silent after the release");
}

#[test]
fn the_sound_is_the_one_of_the_selected_pattern() {
    let play = |sound: usize| {
        let mut engine = engine(Slot::Off);
        engine.sound = sound;
        render(&mut engine, 100, false, |engine, block| if block == 0 {engine.note_on(1, 50.0, 0.8);})
    };
    assert_eq!(bits(&play(1)), bits(&play(1)));
    assert_ne!(bits(&play(1)), bits(&play(4)));
}

#[test]
fn the_lanes_move_the_sound_only_while_the_transport_runs() {
    let play = |playing: bool, amount: f32| {
        let mut engine = engine(Slot::Off);
        for row in engine.patterns[0].amounts.iter_mut() {row[0] = amount;}
        render(&mut engine, 400, playing, |engine, block| if block == 0 {engine.note_on(1, 50.0, 0.8);})
    };
    assert_eq!(bits(&play(false, 0.0)), bits(&play(false, 0.7)), "stopped: the lanes add nothing");
    assert_ne!(bits(&play(true, 0.0)), bits(&play(true, 0.7)), "running: the lanes move the sound");
}

#[test]
fn a_pattern_taking_over_ends_the_played_notes() {
    let mut engine = engine(Slot::Off);
    let blocks = (2.0 * BAR_PULSES / BLOCK_PULSES) as usize;
    let output = render(&mut engine, blocks, true, |engine, block| {
        if block == 2 {engine.note_on(1, 50.0, 0.8);}
        if block == 20 {engine.fire(Slot::Pattern(3));}
        if block == 30 {engine.note_off(1);}
    });
    let reference = {
        let mut engine = self::engine(Slot::Off);
        render(&mut engine, blocks, true, |engine, block| if block == 20 {engine.fire(Slot::Pattern(3));})
    };
    assert_eq!(engine.active(), Slot::Pattern(3));
    assert!(rms(&output[blocks / 2 * MAX_FRAMES + MAX_FRAMES * 200..]) > 0.01, "the pattern plays after the bar");
    assert!(rms(&reference[blocks / 2 * MAX_FRAMES + MAX_FRAMES * 200..]) > 0.01);
    assert!(output.iter().all(|sample| sample.is_finite()));
}

#[test]
fn more_notes_than_fit_do_not_stick() {
    let mut engine = engine(Slot::Off);
    let output = render(&mut engine, 4000, false, |engine, block| {
        if block < 40 {engine.note_on(block as u32, 40.0 + block as f32, 0.8);}
        if (1000..1040).contains(&block) {engine.note_off(block as u32 - 1000);}
    });
    assert!(output[3900 * MAX_FRAMES..].iter().all(|sample| *sample == 0.0), "silent after every note is released");
}
