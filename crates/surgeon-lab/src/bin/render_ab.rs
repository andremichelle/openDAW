//! Renders the A/B listening files for phase 1 of `plans/surgeon.md`, each dry (mono) and washed (stereo).
//! Run: cargo run -p surgeon-lab --release --bin render_ab -- [output folder]

use std::env;
use std::path::PathBuf;
use std::process::ExitCode;
use surgeon_lab::figure::{render, Step, FIGURE, FIGURES};
use surgeon_lab::pattern::{GenericLane, Param, Pattern, Performance};
use surgeon_lab::sequencer::{Lane, Notes, Pitch, Program, Seeded, Target, Window};
use surgeon_lab::voice::{FoldPosition, Patch, Wave};
use surgeon_lab::wash::Wash;
use surgeon_lab::wav;

const SAMPLE_RATE: f64 = 48_000.0;
const TEMPO: f64 = 136.0;
const CENTRE: f32 = 50.0;
const STEPS: usize = 16 * 8;
const TAIL: f64 = 4.0;
const LEVEL: f32 = 0.1;
const LONG_STEPS: u32 = 16 * 16;

const FEEDBACK: Lane = Lane {target: Target::Feedback, steps: 5, seed: 21, mutate: 0.0, low: 0.0, high: 0.8, window: Window::Always};
const STRIKE: Lane = Lane {target: Target::Strike, steps: 9, seed: 22, mutate: 0.0, low: 1.0, high: 7.0, window: Window::Always};
const FOLD: Lane = Lane {target: Target::Fold, steps: 4, seed: 23, mutate: 0.0, low: 0.0, high: 0.5, window: Window::Always};
const DECAY: Lane = Lane {target: Target::Decay, steps: 11, seed: 24, mutate: 0.0, low: 0.15, high: 0.9, window: Window::Always};
const RATIO: Lane = Lane::ratio(2.41, 1.0, 3, 25);
const SECOND: Lane = Lane {target: Target::SecondDepth, steps: 6, seed: 26, mutate: 0.0, low: 0.0, high: 1.0, window: Window::Always};
const LENGTH: Lane = Lane {target: Target::Length {held: 0.25}, steps: 11, seed: 24, mutate: 0.0, low: 0.0, high: 1.0, window: Window::Always};
const BREAK: Window = Window::Break {period: 64, length: 16};
const NOTES: Seeded = Seeded {steps: 7, seed: 1, mutate: 0.0, range: 13.0, density: 0.8, tie: 0.25, accent: 0.6, pitch: Pitch::Semitones};

fn mutating(lanes: &[Lane], mutate: f32) -> Vec<Lane> {lanes.iter().map(|lane| Lane {mutate, ..*lane}).collect()}

fn write_program(folder: &PathBuf, name: &str, program: Program) -> Result<(), String> {
    let dry = program.render(LONG_STEPS, TAIL, SAMPLE_RATE);
    let [left, right] = Wash::DEFAULT.process(&dry, TEMPO, SAMPLE_RATE);
    wav::write(&folder.join(format!("{name}-dry.wav")), SAMPLE_RATE, &[&dry], LEVEL)?;
    wav::write(&folder.join(format!("{name}-wash.wav")), SAMPLE_RATE, &[&left, &right], LEVEL)?;
    println!("{}/{name}", folder.display());
    Ok(())
}

fn write(folder: &PathBuf, name: &str, patch: Patch, figure: &[Step], centre: f32) -> Result<(), String> {
    let dry = render(patch, figure, centre, TEMPO, STEPS, TAIL, SAMPLE_RATE);
    let [left, right] = Wash::DEFAULT.process(&dry, TEMPO, SAMPLE_RATE);
    wav::write(&folder.join(format!("{name}-dry.wav")), SAMPLE_RATE, &[&dry], LEVEL)?;
    wav::write(&folder.join(format!("{name}-wash.wav")), SAMPLE_RATE, &[&left, &right], LEVEL)?;
    println!("{}/{name}", folder.display());
    Ok(())
}

fn run(root: &PathBuf) -> Result<(), String> {
    let folder = &root.join("archive");
    let base = Patch::BASE;
    let variants: [(&str, Patch); 9] = [
        ("01-one-modulator", base),
        ("02-two-modulators", Patch {second_ratio: 5.19, second_depth: 0.6, ..base}),
        ("03-one-modulator-more-feedback", Patch {feedback: 0.7, ..base}),
        ("04-wave-half", Patch {wave: Wave::Half, ..base}),
        ("05-wave-rectified", Patch {wave: Wave::Rectified, ..base}),
        ("06-wave-burst", Patch {wave: Wave::Burst, ..base}),
        ("07-fold-before-gate", Patch {fold: 0.4, ..base}),
        ("08-fold-after-gate", Patch {fold: 0.4, fold_position: FoldPosition::AfterGate, ..base}),
        ("09-two-modulators-fold", Patch {second_ratio: 5.19, second_depth: 0.6, fold: 0.4, ..base})
    ];
    for (name, patch) in variants {write(folder, name, patch, &FIGURE, CENTRE)?;}
    let low = folder.join("low-end");
    let bodies: [(&str, Patch); 6] = [
        ("01-sub-octave-below", Patch {sub: 0.6, ..base}),
        ("02-sub-octave-below-loud", Patch {sub: 1.2, ..base}),
        ("03-sub-octave-below-driven", Patch {sub: 0.6, sub_drive: 0.6, ..base}),
        ("04-sub-at-note", Patch {sub: 0.6, sub_ratio: 1.0, ..base}),
        ("05-sub-fifth-below", Patch {sub: 0.6, sub_ratio: 0.75, ..base}),
        ("06-sub-two-octaves-below-driven", Patch {sub: 0.8, sub_ratio: 0.25, sub_drive: 0.8, ..base})
    ];
    for (name, patch) in bodies {write(&low, name, patch, &FIGURE, CENTRE)?;}
    let sequences = folder.join("sequences");
    for (name, figure) in FIGURES {
        write(&sequences, &format!("{name}-no-sub"), base, figure, CENTRE)?;
        write(&sequences, &format!("{name}-sub"), Patch {sub: 0.6, sub_drive: 0.6, ..base}, figure, CENTRE)?;
    }
    let variations = folder.join("variations");
    let patch = Patch {sub: 0.6, sub_drive: 0.6, ..base};
    let fixed = Program {patch, notes: Notes::Fixed(&FIGURE), lanes: &[], centre: CENTRE, tempo: TEMPO};
    let four = [FEEDBACK, STRIKE, FOLD, DECAY];
    let five = [FEEDBACK, STRIKE, FOLD, DECAY, RATIO];
    write_program(&variations, "01-no-lanes", Program {..fixed})?;
    write_program(&variations, "02-feedback-lane", Program {lanes: &[FEEDBACK], ..fixed})?;
    write_program(&variations, "03-feedback-strike-lanes", Program {lanes: &[FEEDBACK, STRIKE], ..fixed})?;
    write_program(&variations, "04-feedback-strike-fold-decay-lanes", Program {lanes: &four, ..fixed})?;
    write_program(&variations, "05-all-lanes-with-ratio", Program {lanes: &five, ..fixed})?;
    write_program(&variations, "06-four-lanes-mutating", Program {lanes: &mutating(&four, 0.15), ..fixed})?;
    for seed in 1..=4 {
        let locked = Notes::Seeded(Seeded {seed, ..NOTES});
        let drifting = Notes::Seeded(Seeded {seed, mutate: 0.12, ..NOTES});
        write_program(&variations, &format!("07-seed-{seed}-locked-notes-four-lanes"), Program {notes: locked, lanes: &four, ..fixed})?;
        write_program(&variations, &format!("08-seed-{seed}-all-mutating"), Program {notes: drifting, lanes: &mutating(&four, 0.15), ..fixed})?;
    }
    let examples = folder.join("examples");
    let sine = Patch {sub: 0.6, ..base};
    let two = Patch {second_ratio: 5.19, second_depth: 0.6, ..sine};
    let lanes = mutating(&four, 0.15);
    let with = |extra: Lane| -> Vec<Lane> {lanes.iter().copied().chain([Lane {mutate: 0.15, ..extra}]).collect()};
    for seed in [1, 3] {
        let notes = Notes::Seeded(Seeded {seed, mutate: 0.12, ..NOTES});
        let program = Program {patch: sine, notes, lanes: &lanes, centre: CENTRE, tempo: TEMPO};
        let name = |label: &str| format!("seed-{seed}-{label}");
        write_program(&examples, &name("01-no-sub"), Program {patch: base, ..program})?;
        write_program(&examples, &name("02-sub-sine"), Program {..program})?;
        write_program(&examples, &name("03-sub-sine-loud"), Program {patch: Patch {sub: 1.0, ..base}, ..program})?;
        write_program(&examples, &name("04-two-modulators"), Program {patch: two, ..program})?;
        write_program(&examples, &name("05-two-modulators-second-on-a-lane"), Program {patch: two, lanes: &with(SECOND), ..program})?;
        write_program(&examples, &name("06-wave-half"), Program {patch: Patch {wave: Wave::Half, ..sine}, ..program})?;
        write_program(&examples, &name("07-wave-rectified"), Program {patch: Patch {wave: Wave::Rectified, ..sine}, ..program})?;
        write_program(&examples, &name("08-wave-burst"), Program {patch: Patch {wave: Wave::Burst, ..sine}, ..program})?;
        write_program(&examples, &name("09-ratio-lane-narrow"), Program {lanes: &with(Lane::ratio(2.41, 0.3, 3, 25)), ..program})?;
        write_program(&examples, &name("10-ratio-lane-wide"), Program {lanes: &with(RATIO), ..program})?;
        write_program(&examples, &name("11-ratio-break-every-fourth-bar"), Program {lanes: &with(Lane {window: BREAK, ..RATIO}), ..program})?;
        write_program(&examples, &name("12-two-modulators-ratio-break"), Program {patch: two, lanes: &with(Lane {window: BREAK, ..RATIO}), ..program})?;
    }
    let close = folder.join("close");
    let lengths = mutating(&[FEEDBACK, STRIKE, FOLD, LENGTH], 0.15);
    for (seed, wave, label) in [(1, Wave::Half, "half"), (1, Wave::Rectified, "rectified"), (3, Wave::Half, "half")] {
        let one = Patch {wave, sub: 0.6, ..base};
        let two = Patch {second_ratio: 5.19, second_depth: 0.6, ..one};
        let seeded = Seeded {seed, mutate: 0.12, ..NOTES};
        let free = Notes::Seeded(Seeded {pitch: Pitch::Free, ..seeded});
        let program = Program {patch: two, notes: free, lanes: &lengths, centre: CENTRE, tempo: TEMPO};
        let name = |text: &str| format!("seed-{seed}-{label}-{text}");
        write_program(&close, &name("01-as-before"), Program {patch: one, notes: Notes::Seeded(seeded), lanes: &lanes, ..program})?;
        write_program(&close, &name("02-free-pitch"), Program {patch: one, lanes: &lanes, ..program})?;
        write_program(&close, &name("03-free-two-modulators"), Program {lanes: &lanes, ..program})?;
        write_program(&close, &name("04-free-two-modulators-length-lane"), Program {..program})?;
        write_program(&close, &name("05-as-04-parallel-sine-at-pitch"), Program {patch: Patch {sub_ratio: 1.0, ..two}, ..program})?;
    }
    let parameters = folder.join("parameters");
    let one = Patch {wave: Wave::Rectified, sub: 0.6, ..base};
    let notes = Notes::Seeded(Seeded {seed: 1, mutate: 0.12, ..NOTES});
    let program = Program {patch: one, notes, lanes: &lanes, centre: CENTRE, tempo: TEMPO};
    let held = |share: f32| mutating(&[FEEDBACK, STRIKE, FOLD, Lane {target: Target::Length {held: share}, ..LENGTH}], 0.15);
    let ratio = |amount: f32, window: Window| with(Lane {window, ..Lane::ratio(2.41, amount, 3, 25)});
    write_program(&parameters, "01-reference", Program {..program})?;
    write_program(&parameters, "02-sine-off", Program {patch: Patch {sub: 0.0, ..one}, ..program})?;
    write_program(&parameters, "03-sine-at-pitch", Program {patch: Patch {sub_ratio: 1.0, ..one}, ..program})?;
    write_program(&parameters, "04-length-lane-none-held", Program {lanes: &held(0.0), ..program})?;
    write_program(&parameters, "05-length-lane-quarter-held", Program {lanes: &held(0.25), ..program})?;
    write_program(&parameters, "06-length-lane-most-held", Program {lanes: &held(0.6), ..program})?;
    write_program(&parameters, "07-ratio-amount-low", Program {lanes: &ratio(0.3, Window::Always), ..program})?;
    write_program(&parameters, "08-ratio-amount-full-in-breaks", Program {lanes: &ratio(1.0, BREAK), ..program})?;
    let fold = folder.join("fold");
    let free = Notes::Seeded(Seeded {seed: 1, mutate: 0.12, pitch: Pitch::Free, ..NOTES});
    let after = Patch {fold_position: FoldPosition::AfterGate, ..one};
    write_program(&fold, "01-fold-before-gate", Program {notes: free, ..program})?;
    write_program(&fold, "02-fold-after-gate", Program {patch: after, notes: free, ..program})?;
    let listen = root.join("listen");
    let lane = |steps: u32, seed: u32| GenericLane {steps, seed, mutate: 0.15};
    let seeded = |seed: u32| Seeded {seed, mutate: 0.12, pitch: Pitch::Free, ..NOTES};
    let mut favourite = Pattern::new(seeded(1), [lane(5, 21), lane(9, 22), lane(4, 23), lane(11, 24)]);
    favourite.set(Param::Wave, 2.0).set(Param::SineLevel, 0.6).set(Param::Depth2, 0.6).set(Param::HeldShare, 0.08)
        .map(Param::Feedback, 0, 0.0, 0.8).map(Param::Strike, 1, 1.0, 7.0).map(Param::Fold, 2, 0.0, 0.5).map(Param::Length, 3, 0.0, 1.0);
    let mut shared = favourite;
    shared.map(Param::SineLevel, 0, 0.2, 1.0).map(Param::Depth2, 1, 0.1, 1.1).map(Param::StrikeDecay, 2, 0.06, 0.3);
    shared.amounts[Param::Feedback as usize][3] = 0.3;
    shared.amounts[Param::Fold as usize][1] = 0.3;
    let mut second = Pattern::new(seeded(3), [lane(3, 31), lane(7, 32), lane(10, 33), lane(13, 34)]);
    second.set(Param::Wave, 1.0).set(Param::SineLevel, 0.6).set(Param::Depth2, 0.3).set(Param::HeldShare, 0.08)
        .map(Param::Feedback, 1, 0.1, 0.9).map(Param::Strike, 0, 2.0, 6.0).map(Param::Fold, 3, 0.0, 0.4).map(Param::Length, 2, 0.1, 1.0);
    let mut third = Pattern::new(Seeded {steps: 5, ..seeded(2)}, [lane(4, 41), lane(6, 42), lane(9, 43), lane(15, 44)]);
    third.set(Param::Wave, 3.0).set(Param::SineLevel, 0.8).set(Param::Depth2, 0.8).set(Param::FoldPlace, 1.0)
        .map(Param::Ratio1, 0, 1.4, 4.2).map(Param::Feedback, 1, 0.0, 0.6).map(Param::Length, 2, 0.0, 0.5).map(Param::Fold, 3, 0.1, 0.6);
    let write_performance = |name: &str, patterns: &[Pattern], schedule: &[(u32, Option<usize>)]| -> Result<(), String> {
        let dry = Performance {patterns, schedule, tempo: TEMPO}.render(16, TAIL, SAMPLE_RATE);
        let [left, right] = Wash::DEFAULT.process(&dry, TEMPO, SAMPLE_RATE);
        wav::write(&listen.join(format!("{name}-dry.wav")), SAMPLE_RATE, &[&dry], LEVEL)?;
        wav::write(&listen.join(format!("{name}-wash.wav")), SAMPLE_RATE, &[&left, &right], LEVEL)?;
        println!("{}/{name}", listen.display());
        Ok(())
    };
    write_performance("1-favourite-as-pattern", &[favourite], &[(0, Some(0))])?;
    write_performance("2-favourite-lanes-moving-more-parameters", &[shared], &[(0, Some(0))])?;
    let schedule = [(0, Some(0)), (4, Some(1)), (8, None), (9, Some(2)), (11, Some(0)), (14, Some(1))];
    write_performance("3-three-patterns-switching-with-an-off-bar", &[favourite, second, third], &schedule)?;
    Ok(())
}

fn main() -> ExitCode {
    let folder = env::args().nth(1).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("target/surgeon-lab"));
    match run(&folder) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
