use surgeon_lab::pattern::{GenericLane, Param, Pattern, Performance, LANES, STEPS_PER_BAR};
use surgeon_lab::sequencer::{Lane, Pitch, Seeded, Target, Window};
use surgeon_lab::voice::{FoldPosition, Patch, Wave};

const NOTES: Seeded = Seeded {steps: 7, seed: 1, mutate: 0.12, range: 13.0, density: 0.8, tie: 0.25, accent: 0.6, pitch: Pitch::Free};
const LANE: GenericLane = GenericLane {steps: 5, seed: 21, mutate: 0.15};

fn lanes() -> [GenericLane; LANES] {
    [LANE, GenericLane {steps: 9, seed: 22, ..LANE}, GenericLane {steps: 4, seed: 23, ..LANE}, GenericLane {steps: 11, seed: 24, ..LANE}]
}

// the favourite from the listening rounds, written as a pattern
fn favourite() -> Pattern {
    let mut pattern = Pattern::new(NOTES, lanes());
    pattern.set(Param::Wave, 2.0).set(Param::SineLevel, 0.6).set(Param::Depth2, 0.6).set(Param::HeldShare, 0.08)
        .map(Param::Feedback, 0, 0.0, 0.8).map(Param::Strike, 1, 1.0, 7.0).map(Param::Fold, 2, 0.0, 0.5).map(Param::Length, 3, 0.0, 1.0);
    pattern
}

fn rms(signal: &[f32]) -> f32 {(signal.iter().map(|sample| sample * sample).sum::<f32>() / signal.len() as f32).sqrt()}

#[test]
fn ranges_convert_both_ways() {
    for param in [Param::Tune, Param::Ratio1, Param::Ratio2, Param::StrikeDecay, Param::Strike, Param::Glide] {
        let range = param.range();
        for unit in [0.0, 0.25, 0.5, 1.0] {
            assert!((range.unit(range.value(unit)) - unit).abs() < 1e-5, "{param:?} at {unit}");
        }
    }
}

#[test]
fn a_pattern_without_mapping_holds_its_base_sound() {
    let mut pattern = Pattern::new(NOTES, lanes());
    pattern.set(Param::Wave, 3.0).set(Param::FoldPlace, 1.0).set(Param::SinePitch, 1.0).set(Param::Ratio1, 3.3);
    for position in [0, 7, 500] {
        let sound = pattern.sound(position);
        assert_eq!(sound.patch.wave, Wave::Burst);
        assert_eq!(sound.patch.fold_position, FoldPosition::AfterGate);
        assert_eq!(sound.patch.sub_ratio, 1.0);
        assert!((sound.patch.ratio - 3.3).abs() < 1e-4);
        assert!((sound.patch.strike - Patch::BASE.strike).abs() < 1e-4);
        assert_eq!(sound.tune, 50.0);
    }
}

#[test]
fn a_mapped_parameter_follows_its_lane_inside_the_range() {
    let pattern = favourite();
    let feedback: Vec<f32> = (0..200).map(|position| pattern.sound(position).patch.feedback).collect();
    assert!(feedback.iter().all(|value| (0.0..=0.8).contains(value)));
    assert!(feedback.iter().any(|value| *value < 0.2) && feedback.iter().any(|value| *value > 0.6));
    for position in 0..40 {
        assert!((feedback[position] - 0.8 * LANE.value(position as u32)).abs() < 1e-6);
    }
}

#[test]
fn lanes_add_up_on_one_parameter_and_one_lane_moves_several() {
    let mut pattern = Pattern::new(NOTES, lanes());
    pattern.set(Param::Feedback, 0.1);
    pattern.amounts[Param::Feedback as usize] = [0.3, 0.2, 0.0, 0.0];
    pattern.amounts[Param::Fold as usize][0] = 0.5;
    for position in 0..60 {
        let [first, second, ..] = pattern.lanes.map(|lane| lane.value(position));
        let sound = pattern.sound(position);
        assert!((sound.patch.feedback - (0.1 + 0.3 * first + 0.2 * second)).abs() < 1e-6);
        assert!((sound.patch.fold - 0.5 * first).abs() < 1e-6);
    }
}

#[test]
fn the_sum_is_clamped_to_the_parameter_range() {
    let mut pattern = Pattern::new(NOTES, lanes());
    pattern.set(Param::Feedback, 0.9);
    pattern.amounts[Param::Feedback as usize] = [1.0, 1.0, 1.0, 1.0];
    pattern.amounts[Param::Strike as usize] = [-5.0, 0.0, 0.0, 0.0];
    for position in 0..60 {
        let sound = pattern.sound(position);
        assert!(sound.patch.feedback <= 1.0);
        assert!(sound.patch.strike >= 0.0);
    }
}

#[test]
fn a_lane_steps_a_switch_through_its_settings() {
    let mut pattern = Pattern::new(NOTES, lanes());
    pattern.map(Param::Wave, 0, 0.0, 4.0);
    let waves: Vec<Wave> = (0..200).map(|position| pattern.sound(position).patch.wave).collect();
    for wave in [Wave::Sine, Wave::Half, Wave::Rectified, Wave::Burst] {
        assert!(waves.contains(&wave), "{wave:?}");
    }
}

// compared as parameter streams, not audio: with feedback the voice amplifies rounding, so two renders that differ
// in the last bit of a ratio drift apart audibly unchanged but far in samples
#[test]
fn the_favourite_as_a_pattern_matches_the_earlier_lane_model() {
    let mutating = |target: Target, steps: u32, seed: u32, low: f32, high: f32| Lane {target, steps, seed, mutate: 0.15, low, high, window: Window::Always};
    let old_lanes = [
        mutating(Target::Feedback, 5, 21, 0.0, 0.8),
        mutating(Target::Strike, 9, 22, 1.0, 7.0),
        mutating(Target::Fold, 4, 23, 0.0, 0.5),
        mutating(Target::Length {held: 0.08}, 11, 24, 0.0, 1.0)
    ];
    let base = Patch {wave: Wave::Rectified, sub: 0.6, second_ratio: 5.19, second_depth: 0.6, ..Patch::BASE};
    let pattern = favourite();
    let close = |first: f32, second: f32| (first - second).abs() <= 1e-4 * first.abs().max(1.0);
    for position in 0..2000 {
        let mut old = base;
        old_lanes.iter().for_each(|lane| lane.apply(&mut old, position));
        let new = pattern.sound(position).patch;
        assert!(close(old.feedback, new.feedback) && close(old.strike, new.strike) && close(old.fold, new.fold), "lanes at {position}");
        assert!(close(old.decay, new.decay) && old.hold == new.hold, "length at {position}");
        assert!(close(old.ratio, new.ratio) && close(old.second_ratio, new.second_ratio) && close(old.second_depth, new.second_depth));
        assert!(close(old.depth, new.depth) && close(old.strike_decay, new.strike_decay) && close(old.sub, new.sub));
        assert!(old.wave == new.wave && old.sub_ratio == new.sub_ratio && old.fold_position == new.fold_position);
        assert!(close(old.glide, new.glide) && close(old.velocity, new.velocity));
    }
}

#[test]
fn patterns_switch_on_the_bar_and_off_goes_silent() {
    let mut second = favourite();
    second.notes.seed = 3;
    second.set(Param::Tune, 62.0);
    let patterns = [favourite(), second];
    let schedule = [(0, Some(0)), (2, None), (4, Some(1))];
    let performance = Performance {patterns: &patterns, schedule: &schedule, tempo: 136.0};
    assert!(performance.active(0).is_some() && performance.active(2 * STEPS_PER_BAR - 1).is_some());
    assert!(performance.active(2 * STEPS_PER_BAR).is_none() && performance.active(4 * STEPS_PER_BAR - 1).is_none());
    assert_eq!(performance.active(4 * STEPS_PER_BAR).unwrap().notes.seed, 3);
    let output = performance.render(6, 0.5, 48_000.0);
    let bar = (60.0 / 136.0 * 4.0 * 48_000.0) as usize;
    assert!(rms(&output[..2 * bar]) > 0.02);
    assert!(rms(&output[3 * bar..4 * bar]) < 0.0005, "silent in the second off bar: {}", rms(&output[3 * bar..4 * bar]));
    assert!(rms(&output[4 * bar..6 * bar]) > 0.02);
    assert_eq!(output, performance.render(6, 0.5, 48_000.0));
}

#[test]
fn a_fired_pattern_joins_in_phase_with_the_song_position() {
    let patterns = [favourite()];
    let always = Performance {patterns: &patterns, schedule: &[(0, Some(0))], tempo: 136.0};
    let late = Performance {patterns: &patterns, schedule: &[(0, None), (3, Some(0))], tempo: 136.0};
    for position in 3 * STEPS_PER_BAR..5 * STEPS_PER_BAR {
        let (first, second) = (always.active(position).unwrap(), late.active(position).unwrap());
        assert_eq!(first.notes.step(position).offset, second.notes.step(position).offset);
        assert_eq!(first.sound(position).patch.feedback, second.sound(position).patch.feedback);
    }
}

#[test]
fn random_patterns_differ_repeat_for_a_seed_and_stay_in_range() {
    let first = Pattern::random(1);
    assert_eq!(first.base, Pattern::random(1).base);
    assert_eq!(first.amounts, Pattern::random(1).amounts);
    assert_ne!(first.base, Pattern::random(2).base);
    for seed in 0..200 {
        let pattern = Pattern::random(seed);
        assert!((3..=16).contains(&pattern.notes.steps), "pitch steps {}", pattern.notes.steps);
        assert!(pattern.lanes.iter().all(|lane| (2..=16).contains(&lane.steps)));
        assert!(pattern.base.iter().all(|value| (0.0..=1.0).contains(value)), "seed {seed}");
        let sound = pattern.sound(seed);
        assert_eq!(sound.tune, 50.0);
        assert_eq!(sound.volume, 1.0);
        assert!((0.5..=6.0).contains(&sound.patch.ratio) && sound.patch.decay > 0.0);
    }
}
