use surgeon_lab::figure::{render, Kind, FIGURE};
use surgeon_lab::sequencer::{generation, unit, Lane, Notes, Pitch, Program, Seeded, Target, Window};
use surgeon_lab::voice::Patch;

const LANE: Lane = Lane {target: Target::Feedback, steps: 5, seed: 7, mutate: 0.0, low: 0.1, high: 0.7, window: Window::Always};
const SEEDED: Seeded = Seeded {steps: 7, seed: 3, mutate: 0.0, range: 12.0, density: 0.8, tie: 0.25, accent: 0.6, pitch: Pitch::Semitones};

#[test]
fn unit_is_spread_between_zero_and_one() {
    let values: Vec<f32> = (0..10_000).map(|index| unit(1, index, 0, 0)).collect();
    assert!(values.iter().all(|value| (0.0..1.0).contains(value)));
    let mean = values.iter().sum::<f32>() / values.len() as f32;
    assert!((mean - 0.5).abs() < 0.02, "{mean}");
    assert!(values.iter().filter(|value| **value < 0.1).count() > 800);
}

#[test]
fn a_locked_lane_repeats_every_pass_within_its_range() {
    for position in 0..5 {
        let value = LANE.value(position);
        assert!((0.1..=0.7).contains(&value));
        assert_eq!(value, LANE.value(position + 5 * 40));
    }
    assert!((0..5).any(|position| LANE.value(position) != LANE.value(0)), "not one constant");
}

#[test]
fn mutation_only_ever_moves_forward() {
    let counts: Vec<u32> = (0..200).map(|pass| generation(9, 2, pass, 0.1)).collect();
    assert!(counts.windows(2).all(|pair| pair[1] == pair[0] || pair[1] == pair[0] + 1));
    assert!((10..=35).contains(counts.last().unwrap()), "about 10 % of 200 passes: {}", counts.last().unwrap());
    assert_eq!(generation(9, 2, 200, 0.0), 0);
    assert_eq!(generation(9, 2, 200, 1.0), 200);
}

#[test]
fn a_mutating_lane_is_a_pure_function_of_the_position() {
    let lane = Lane {mutate: 0.3, ..LANE};
    let forward: Vec<f32> = (0..300).map(|position| lane.value(position)).collect();
    let backward: Vec<f32> = (0..300).rev().map(|position| lane.value(position)).collect();
    assert!(forward.iter().eq(backward.iter().rev()));
    assert!((0..5).any(|step| lane.value(step) != lane.value(step + 5 * 30)), "it drifted");
}

#[test]
fn seeded_notes_respect_range_density_and_ties() {
    let seeded = Seeded {steps: 32, mutate: 1.0, ..SEEDED};
    let steps: Vec<_> = (0..3200).map(|position| seeded.step(position)).collect();
    assert!(steps.iter().all(|step| step.offset.abs() <= 12.0 && step.offset.fract() == 0.0));
    assert!(steps.iter().all(|step| (0.4..=1.0).contains(&step.velocity)));
    let rests = steps.iter().filter(|step| step.kind == Kind::Rest).count() as f32 / 3200.0;
    let ties = steps.iter().filter(|step| step.kind == Kind::Tie).count() as f32 / 3200.0;
    assert!((rests - 0.2).abs() < 0.04, "rests {rests}");
    assert!((ties - 0.2).abs() < 0.04, "ties {ties}");
}

#[test]
fn a_program_without_lanes_equals_the_plain_figure_render() {
    let program = Program {patch: Patch::BASE, notes: Notes::Fixed(&FIGURE), lanes: &[], centre: 50.0, tempo: 136.0};
    assert_eq!(program.render(28, 1.0, 48_000.0), render(Patch::BASE, &FIGURE, 50.0, 136.0, 28, 1.0, 48_000.0));
}

#[test]
fn lanes_change_the_sound_and_stay_deterministic_and_bounded() {
    let lanes = [LANE, Lane {target: Target::Strike, steps: 9, seed: 11, mutate: 0.2, low: 1.0, high: 7.0, window: Window::Always}];
    let program = Program {patch: Patch::BASE, notes: Notes::Seeded(SEEDED), lanes: &lanes, centre: 50.0, tempo: 136.0};
    let first = program.render(64, 1.0, 48_000.0);
    assert_eq!(first, program.render(64, 1.0, 48_000.0));
    assert!(first.iter().all(|sample| sample.is_finite() && sample.abs() <= 2.0));
    let plain = Program {lanes: &[], ..program}.render(64, 1.0, 48_000.0);
    assert_ne!(first, plain);
}

#[test]
fn a_break_window_leaves_the_patch_alone_outside_the_break() {
    let lane = Lane {window: Window::Break {period: 64, length: 16}, ..Lane::ratio(5.0, 1.0, 5, 7)};
    for position in 0..128 {
        let mut patch = Patch::BASE;
        lane.apply(&mut patch, position);
        let inside = position % 64 >= 48;
        assert_eq!(patch.ratio != Patch::BASE.ratio, inside, "position {position}");
    }
}

#[test]
fn free_pitches_keep_the_loop() {
    let at = |pitch: Pitch, position: u32| Seeded {pitch, ..SEEDED}.step(position);
    for position in 0..7 {
        let (semitones, free) = (at(Pitch::Semitones, position), at(Pitch::Free, position));
        assert_eq!(semitones.kind, free.kind);
        assert_eq!(semitones.velocity, free.velocity);
        assert_eq!(semitones.offset, free.offset.round(), "the same loop, only unrounded");
    }
    assert!((0..7).any(|position| at(Pitch::Free, position).offset.fract() != 0.0));
}

#[test]
fn the_length_lane_reaches_short_hits_and_holds_the_asked_share() {
    let share = |held: f32| {
        let lane = Lane {target: Target::Length {held}, steps: 400, low: 0.0, high: 1.0, ..LANE};
        let patches: Vec<Patch> = (0..400).map(|position| {
            let mut patch = Patch::BASE;
            lane.apply(&mut patch, position);
            patch
        }).collect();
        assert!(patches.iter().filter(|patch| !patch.hold).all(|patch| (0.05..=0.9).contains(&patch.decay)));
        assert!(held >= 1.0 || patches.iter().any(|patch| !patch.hold && patch.decay < 0.1), "a punchy one");
        patches.iter().filter(|patch| patch.hold).count() as f32 / 400.0
    };
    assert_eq!(share(0.0), 0.0);
    assert!((share(0.25) - 0.25).abs() < 0.06);
    assert!((share(0.6) - 0.6).abs() < 0.06);
    assert_eq!(share(1.0), 1.0);
}

#[test]
fn the_ratio_amount_at_zero_leaves_the_ratio_and_spreads_around_it_otherwise() {
    let ratios = |amount: f32| -> Vec<f32> {
        (0..64).map(|position| {
            let mut patch = Patch::BASE;
            Lane::ratio(Patch::BASE.ratio, amount, 64, 5).apply(&mut patch, position);
            patch.ratio
        }).collect()
    };
    assert!(ratios(0.0).iter().all(|ratio| *ratio == Patch::BASE.ratio));
    let wide = ratios(1.0);
    assert!(wide.iter().all(|ratio| (Patch::BASE.ratio / 1.69..=Patch::BASE.ratio * 1.69).contains(ratio)));
    assert!(wide.iter().any(|ratio| *ratio < 2.0) && wide.iter().any(|ratio| *ratio > 3.0));
}
