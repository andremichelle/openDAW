// The engine against the listening lab (`surgeon-lab`), whose sound was approved by ear. Compared by rolls, notes
// and parameter values, and by levels for audio: with feedback the voice amplifies rounding, so samples differ.

use device_surgeon::engine::{Engine, Slot, MAX_FRAMES, STEP_PULSES};
use device_surgeon::hash;
use device_surgeon::param::Param;
use device_surgeon::pattern::{Kind, Lane, Pattern, PitchLoop};
use device_surgeon::voice::{FoldPlace, Patch, Voice, Wave};
use surgeon_lab::figure::Kind as LabKind;
use surgeon_lab::pattern::{GenericLane, Param as LabParam, Pattern as LabPattern, Performance};
use surgeon_lab::sequencer::{self, Pitch, Seeded};
use surgeon_lab::voice::{FoldPosition, Patch as LabPatch, Voice as LabVoice, Wave as LabWave};

const RATE: f32 = 48_000.0;
const TEMPO: f64 = 136.0;

fn close(first: f32, second: f32) -> bool {(first - second).abs() <= 2e-5 * first.abs().max(1.0)}

fn same_patch(lab: &LabPatch, engine: &Patch) -> bool {
    let wave = match lab.wave {LabWave::Sine => Wave::Sine, LabWave::Half => Wave::Half, LabWave::Rectified => Wave::Rectified, LabWave::Burst => Wave::Burst};
    let place = if lab.fold_position == FoldPosition::BeforeGate {FoldPlace::BeforeGate} else {FoldPlace::AfterGate};
    close(lab.ratio, engine.ratio) && close(lab.depth, engine.depth) && close(lab.strike, engine.strike)
        && close(lab.strike_decay, engine.strike_decay) && close(lab.feedback, engine.feedback) && wave == engine.wave
        && close(lab.fold, engine.fold) && place == engine.fold_place && close(lab.decay, engine.decay)
        && close(lab.glide, engine.glide) && close(lab.velocity, engine.velocity) && close(lab.second_ratio, engine.second_ratio)
        && close(lab.second_depth, engine.second_depth) && close(lab.sub, engine.sine) && lab.sub_ratio == engine.sine_ratio
        && lab.hold == engine.hold
}

fn assert_same_pattern(lab: &LabPattern, engine: &Pattern, positions: u32, label: &str) {
    for position in 0..positions {
        let (lab_step, engine_step) = (lab.notes.step(position), engine.pitch.step(position));
        let kind = match lab_step.kind {LabKind::Play => Kind::Play, LabKind::Tie => Kind::Tie, LabKind::Rest => Kind::Rest};
        assert!(kind == engine_step.kind && lab_step.offset == engine_step.offset && lab_step.velocity == engine_step.velocity, "{label}: note at {position}");
        let (lab_patch, engine_patch) = (lab.sound(position).patch, engine.patch(position));
        assert!(same_patch(&lab_patch, &engine_patch), "{label}: sound at {position}\n{lab_patch:?}\n{engine_patch:?}");
    }
}

fn lab_favourite() -> LabPattern {
    let notes = Seeded {steps: 7, seed: 1, mutate: 0.12, range: 13.0, density: 0.8, tie: 0.25, accent: 0.6, pitch: Pitch::Free};
    let lane = |steps: u32, seed: u32| GenericLane {steps, seed, mutate: 0.15};
    let mut pattern = LabPattern::new(notes, [lane(5, 21), lane(9, 22), lane(4, 23), lane(11, 24)]);
    pattern.set(LabParam::Wave, 2.0).set(LabParam::SineLevel, 0.6).set(LabParam::Depth2, 0.6).set(LabParam::HeldShare, 0.08)
        .map(LabParam::Feedback, 0, 0.0, 0.8).map(LabParam::Strike, 1, 1.0, 7.0).map(LabParam::Fold, 2, 0.0, 0.5).map(LabParam::Length, 3, 0.0, 1.0);
    pattern
}

fn favourite() -> Pattern {
    let pitch = PitchLoop {steps: 7, seed: 1, mutate: 0.12, range: 13.0, density: 0.8, tie: 0.25, accent: 0.6};
    let lane = |steps: u32, seed: u32| Lane {steps, seed, mutate: 0.15};
    let mut pattern = Pattern::new(pitch, [lane(5, 21), lane(9, 22), lane(4, 23), lane(11, 24)]);
    pattern.set(Param::Wave, 2.0).set(Param::SineLevel, 0.6).set(Param::Depth2, 0.6).set(Param::HeldShare, 0.08)
        .map(Param::Feedback, 0, 0.0, 0.8).map(Param::Strike, 1, 1.0, 7.0).map(Param::Fold, 2, 0.0, 0.5).map(Param::Length, 3, 0.0, 1.0);
    pattern
}

fn rms(signal: &[f32]) -> f32 {(signal.iter().map(|sample| sample * sample).sum::<f32>() / signal.len().max(1) as f32).sqrt()}

fn decibel(value: f32) -> f32 {20.0 * value.max(1e-9).log10()}

fn bar_frames() -> usize {(60.0 / TEMPO * 4.0 * RATE as f64) as usize}

// plays `frames` frames from the pulse `start` in blocks of `block` frames
fn play(engine: &mut Engine, start: f64, frames: usize, block: usize, playing: bool, jump: bool) -> Vec<f32> {
    let pulses_per_frame = TEMPO / 60.0 * 960.0 / RATE as f64;
    let mut output = vec![0.0; frames];
    let mut done = 0;
    while done < frames {
        let length = block.min(frames - done);
        let (p0, p1) = (start + done as f64 * pulses_per_frame, start + (done + length) as f64 * pulses_per_frame);
        engine.process(p0, p1, playing, jump && done == 0, &mut output[done..done + length]);
        done += length;
    }
    output
}

fn engine_with(patterns: &[Pattern]) -> Engine {
    let mut engine = Engine::new(RATE);
    patterns.iter().enumerate().for_each(|(index, pattern)| engine.patterns[index] = *pattern);
    engine
}

#[test]
fn the_rolls_are_the_labs_rolls() {
    for seed in [0, 1, 7, 21, 99_999, u32::MAX] {
        for first in 0..40 {
            for second in 0..12 {
                assert_eq!(hash::unit(seed, first, second, 1), sequencer::unit(seed, first, second, 1));
                assert_eq!(hash::unit(seed, first, second, 7), sequencer::unit(seed, first, second, 7));
            }
            assert_eq!(hash::generation(seed, first, 300, 0.15), sequencer::generation(seed, first, 300, 0.15));
        }
    }
}

#[test]
fn the_favourite_plays_the_labs_notes_and_sound() {
    assert_same_pattern(&lab_favourite(), &favourite(), 4000, "favourite");
}

#[test]
fn random_all_draws_exactly_like_the_lab() {
    for seed in 0..300 {
        let (lab, engine) = (LabPattern::random(seed), Pattern::random(seed));
        assert_eq!((lab.notes.steps, lab.notes.seed), (engine.pitch.steps, engine.pitch.seed), "seed {seed}");
        assert_eq!((lab.notes.mutate, lab.notes.range, lab.notes.density), (engine.pitch.mutate, engine.pitch.range, engine.pitch.density));
        assert_eq!((lab.notes.tie, lab.notes.accent), (engine.pitch.tie, engine.pitch.accent));
        for lane in 0..4 {
            assert_eq!((lab.lanes[lane].steps, lab.lanes[lane].seed, lab.lanes[lane].mutate), (engine.lanes[lane].steps, engine.lanes[lane].seed, engine.lanes[lane].mutate));
        }
        assert_same_pattern(&lab, &engine, 96, &format!("random {seed}"));
    }
}

#[test]
fn the_voice_matches_the_labs_voice_without_feedback() {
    let lab_patch = LabPatch {feedback: 0.0, fold: 0.3, sub: 0.6, second_ratio: 5.19, second_depth: 0.6, wave: LabWave::Rectified, ..LabPatch::BASE};
    let patch = Patch {
        ratio: lab_patch.ratio, depth: lab_patch.depth, strike: lab_patch.strike, strike_decay: lab_patch.strike_decay, feedback: 0.0,
        wave: Wave::Rectified, fold: 0.3, fold_place: FoldPlace::BeforeGate, decay: lab_patch.decay, glide: lab_patch.glide,
        velocity: lab_patch.velocity, second_ratio: 5.19, second_depth: 0.6, sine: 0.6, sine_ratio: 0.5, hold: false
    };
    let mut lab = LabVoice::new(lab_patch, RATE * 2.0);
    let mut voice = Voice::default();
    voice.init(RATE * 2.0);
    voice.set_patch(patch);
    let (mut first, mut second) = (Vec::new(), Vec::new());
    for index in 0..48_000 {
        if index == 0 {
            lab.note_on(50.3, 0.9);
            voice.note_on(50.3, 0.9);
        }
        if index == 9_000 {
            lab.note_on(57.8, 0.5);
            voice.note_on(57.8, 0.5);
        }
        if index == 12_000 || index == 14_000 {
            lab.note_off();
            voice.note_off();
        }
        if index == 30_000 {
            lab.note_on(44.1, 1.0);
            voice.note_on(44.1, 1.0);
        }
        first.push(lab.next());
        second.push(voice.next());
    }
    // tight while the phases have not drifted, by level afterwards: one ulp in a frequency grows into a phase
    // offset over time, which the strike depth of a later note turns into different samples at the same level
    let difference: Vec<f32> = first[..9_000].iter().zip(second.iter()).map(|(first, second)| first - second).collect();
    assert!(rms(&first[..9_000]) > 0.05);
    assert!(rms(&difference) < rms(&first[..9_000]) * 0.001, "difference {} against {}", rms(&difference), rms(&first[..9_000]));
    for window in 0..12 {
        let range = window * 4_000..(window + 1) * 4_000;
        let (expected, actual) = (decibel(rms(&first[range.clone()])), decibel(rms(&second[range])));
        assert!((expected - actual).abs() < 0.2, "window {window}: lab {expected:.2} dB, engine {actual:.2} dB");
    }
}

#[test]
fn the_engine_plays_the_favourite_at_the_labs_levels() {
    let lab_patterns = [lab_favourite()];
    let lab = Performance {patterns: &lab_patterns, schedule: &[(0, Some(0))], tempo: TEMPO}.render(8, 0.0, RATE as f64);
    let mut engine = engine_with(&[favourite()]);
    let output = play(&mut engine, 0.0, bar_frames() * 8, MAX_FRAMES, true, false);
    assert!(output.iter().all(|sample| sample.is_finite()));
    for bar in 0..8 {
        let range = bar * bar_frames()..(bar + 1) * bar_frames();
        let (expected, actual) = (decibel(rms(&lab[range.clone()])), decibel(rms(&output[range])));
        assert!((expected - actual).abs() < 1.5, "bar {bar}: lab {expected:.1} dB, engine {actual:.1} dB");
    }
}

#[test]
fn a_fired_slot_waits_for_the_bar() {
    let mut second = favourite();
    second.pitch.seed = 3;
    let mut engine = engine_with(&[favourite(), second]);
    let bar = bar_frames();
    play(&mut engine, 0.0, bar / 2, MAX_FRAMES, true, false);
    engine.fire(Slot::Off);
    assert_eq!((engine.active(), engine.fired()), (Slot::Pattern(0), Some(Slot::Off)));
    let rest_of_bar = play(&mut engine, 1920.0, bar / 2, MAX_FRAMES, true, false);
    assert!(rms(&rest_of_bar) > 0.01, "still plays until the bar ends");
    assert_eq!(engine.active(), Slot::Pattern(0));
    let off = play(&mut engine, 3840.0, bar * 2, MAX_FRAMES, true, false);
    assert_eq!((engine.active(), engine.fired()), (Slot::Off, None));
    assert!(rms(&off[bar..]) < 0.0005, "silent in the second off bar: {}", rms(&off[bar..]));
    play(&mut engine, 3840.0 * 3.0, bar / 4, MAX_FRAMES, true, false);
    engine.fire(Slot::Pattern(1));
    let waiting = play(&mut engine, 3840.0 * 3.25, bar / 2, MAX_FRAMES, true, false);
    assert!(rms(&waiting) < 0.0005 && engine.active() == Slot::Off && engine.fired() == Some(Slot::Pattern(1)));
    play(&mut engine, 3840.0 * 3.75, bar / 4, MAX_FRAMES, true, false);
    let playing = play(&mut engine, 3840.0 * 4.0, bar, MAX_FRAMES, true, false);
    assert_eq!(engine.active(), Slot::Pattern(1));
    assert!(rms(&playing) > 0.01);
}

#[test]
fn firing_the_active_slot_again_clears_a_pending_switch() {
    let mut engine = engine_with(&[favourite()]);
    engine.fire(Slot::Off);
    engine.fire(Slot::Pattern(0));
    assert_eq!(engine.fired(), None);
}

#[test]
fn a_stopped_transport_lets_the_tail_ring_out_and_starts_nothing() {
    let mut engine = engine_with(&[favourite()]);
    let playing = play(&mut engine, 0.0, bar_frames(), MAX_FRAMES, true, false);
    assert!(rms(&playing) > 0.01);
    let stopped = play(&mut engine, 3840.0, RATE as usize * 3, MAX_FRAMES, false, false);
    assert!(rms(&stopped[RATE as usize * 2..]) < 1e-5, "silent 2 s after the stop");
}

#[test]
fn a_start_on_a_step_plays_it_and_a_start_inside_a_step_waits_for_the_next() {
    let first_sounding = (0..64).find(|step| favourite().event(*step).note.is_some()).unwrap();
    let pulse = first_sounding as f64 * STEP_PULSES;
    let mut engine = engine_with(&[favourite()]);
    let on_step = play(&mut engine, pulse, 960, MAX_FRAMES, true, false);
    assert!(rms(&on_step) > 0.005, "sounds within 20 ms");
    let mut engine = engine_with(&[favourite()]);
    let inside = play(&mut engine, pulse + STEP_PULSES * 0.3, 960, MAX_FRAMES, true, false);
    assert!(rms(&inside) < 1e-6, "nothing until the next step");
}

#[test]
fn a_locate_replays_the_same_bars() {
    let mut whole = engine_with(&[favourite()]);
    let reference = play(&mut whole, 0.0, bar_frames() * 6, MAX_FRAMES, true, false);
    let mut located = engine_with(&[favourite()]);
    play(&mut located, 3840.0 * 9.0, bar_frames(), MAX_FRAMES, true, false);
    let replay = play(&mut located, 3840.0 * 3.0, bar_frames() * 3, MAX_FRAMES, true, true);
    for bar in 1..3 {
        let expected = decibel(rms(&reference[(3 + bar) * bar_frames()..(4 + bar) * bar_frames()]));
        let actual = decibel(rms(&replay[bar * bar_frames()..(bar + 1) * bar_frames()]));
        assert!((expected - actual).abs() < 1.0, "bar {}: {expected:.1} dB against {actual:.1} dB", 3 + bar);
    }
}

#[test]
fn the_block_size_does_not_change_what_plays() {
    let mut pattern = favourite();
    pattern.amounts[Param::Feedback as usize] = [0.0; 4];
    pattern.set(Param::Feedback, 0.0);
    let mut large = engine_with(&[pattern]);
    let mut small = engine_with(&[pattern]);
    let first = play(&mut large, 0.0, bar_frames() * 2, MAX_FRAMES, true, false);
    let second = play(&mut small, 0.0, bar_frames() * 2, 37, true, false);
    let difference: Vec<f32> = first.iter().zip(second.iter()).map(|(first, second)| first - second).collect();
    assert!(rms(&difference) < rms(&first) * 0.02, "difference {} against {}", rms(&difference), rms(&first));
}

#[test]
fn the_same_calls_give_the_same_samples() {
    let render = || {
        let mut engine = engine_with(&[favourite(), Pattern::random(5)]);
        engine.fire(Slot::Pattern(1));
        play(&mut engine, 0.0, bar_frames() * 3, MAX_FRAMES, true, false)
    };
    assert_eq!(render(), render());
}

#[test]
fn every_random_pattern_stays_finite_and_bounded() {
    for seed in 0..40 {
        let mut engine = engine_with(&[Pattern::random(seed)]);
        let output = play(&mut engine, 0.0, bar_frames() * 2, MAX_FRAMES, true, false);
        assert!(output.iter().all(|sample| sample.is_finite() && sample.abs() < 4.0), "seed {seed}");
    }
}

#[test]
fn positions_before_zero_are_silent() {
    let mut engine = engine_with(&[favourite()]);
    let output = play(&mut engine, -3840.0, bar_frames() / 2, MAX_FRAMES, true, false);
    assert!(rms(&output) < 1e-9);
}
