use surgeon_lab::figure::{decimate, render, FIGURE};
use surgeon_lab::voice::{FoldPosition, Patch, Voice, Wave};

const RATE: f32 = 96_000.0;

// a plain two operator patch: no feedback, no fold, no strike, a long gate
const PLAIN: Patch = Patch {
    ratio: 2.0,
    depth: 1.0,
    strike: 0.0,
    strike_decay: 0.1,
    feedback: 0.0,
    wave: Wave::Sine,
    fold: 0.0,
    fold_position: FoldPosition::BeforeGate,
    decay: 20.0,
    glide: 0.0,
    velocity: 0.0,
    second_ratio: 0.0,
    second_depth: 0.0,
    sub: 0.0,
    sub_ratio: 0.5,
    sub_drive: 0.0,
    hold: false
};

fn run(voice: &mut Voice, samples: usize) -> Vec<f32> {(0..samples).map(|_| voice.next()).collect()}

// the magnitude of one frequency, by correlation over a whole number of its cycles
fn magnitude(signal: &[f32], frequency: f32) -> f32 {
    let (mut real, mut imaginary) = (0.0f64, 0.0f64);
    for (index, sample) in signal.iter().enumerate() {
        let angle = std::f64::consts::TAU * frequency as f64 * index as f64 / RATE as f64;
        real += *sample as f64 * angle.cos();
        imaginary += *sample as f64 * angle.sin();
    }
    (2.0 * (real * real + imaginary * imaginary).sqrt() / signal.len() as f64) as f32
}

fn rms(signal: &[f32]) -> f32 {(signal.iter().map(|sample| sample * sample).sum::<f32>() / signal.len() as f32).sqrt()}

#[test]
fn sidebands_sit_at_carrier_plus_multiples_of_the_modulator() {
    // MIDI 69 = 440 Hz, ratio 2.5: sidebands at 440 + n * 1100, the negative ones fold back to 660 and 1760
    let mut voice = Voice::new(Patch {ratio: 2.5, ..PLAIN}, RATE);
    voice.note_on(69.0, 1.0);
    run(&mut voice, 9600);
    let signal = run(&mut voice, 96_000);
    let carrier = magnitude(&signal, 440.0);
    for expected in [1540.0, 2640.0, 660.0, 1760.0] {
        assert!(magnitude(&signal, expected) > carrier * 0.05, "sideband at {expected} Hz");
    }
    for absent in [880.0, 1100.0, 1320.0, 2200.0] {
        assert!(magnitude(&signal, absent) < carrier * 0.01, "nothing at {absent} Hz");
    }
}

#[test]
fn depth_zero_is_a_pure_tone() {
    let mut voice = Voice::new(Patch {depth: 0.0, ..PLAIN}, RATE);
    voice.note_on(69.0, 1.0);
    run(&mut voice, 9600);
    let signal = run(&mut voice, 96_000);
    let carrier = magnitude(&signal, 440.0);
    assert!(carrier > 0.3);
    assert!(magnitude(&signal, 1320.0) < carrier * 0.001);
}

#[test]
fn the_sub_adds_the_octave_below_and_leaves_the_rest() {
    let spectrum = |sub: f32| {
        let mut voice = Voice::new(Patch {ratio: 2.5, sub, ..PLAIN}, RATE);
        voice.note_on(69.0, 1.0);
        run(&mut voice, 9600);
        let signal = run(&mut voice, 96_000);
        [magnitude(&signal, 220.0), magnitude(&signal, 440.0), magnitude(&signal, 1540.0)]
    };
    let (without, with) = (spectrum(0.0), spectrum(0.8));
    assert!(without[0] < 0.001 && with[0] > 0.3, "sub at 220 Hz");
    assert!((with[1] - without[1]).abs() < 0.01 && (with[2] - without[2]).abs() < 0.01, "carrier and sideband unchanged");
}

#[test]
fn an_overlapping_note_slides_and_keeps_the_envelopes() {
    let patch = Patch {depth: 0.0, decay: 0.5, glide: 0.05, ..PLAIN};
    let mut voice = Voice::new(patch, RATE);
    voice.note_on(69.0, 1.0);
    let before = rms(&run(&mut voice, 9600)[8640..]);
    voice.note_on(81.0, 1.0);
    let after = run(&mut voice, 48_000);
    assert!(rms(&after[..960]) < before, "no retrigger: the level keeps falling");
    let late = &after[38_400..];
    assert!(magnitude(late, 880.0) > magnitude(late, 440.0) * 20.0, "arrived an octave up");
    let early = &after[..960];
    assert!(magnitude(early, 880.0) < magnitude(early, 440.0), "still near the old pitch right after the note");
}

#[test]
fn a_note_after_a_release_retriggers() {
    let patch = Patch {depth: 0.0, decay: 0.2, ..PLAIN};
    let mut voice = Voice::new(patch, RATE);
    voice.note_on(69.0, 1.0);
    voice.note_off();
    let before = rms(&run(&mut voice, 9600)[8640..]);
    voice.note_on(69.0, 1.0);
    let after = rms(&run(&mut voice, 960)[480..]);
    assert!(after > before * 2.0, "{before} -> {after}");
}

#[test]
fn a_held_note_stays_at_full_level_until_the_key_is_released() {
    let mut voice = Voice::new(Patch {depth: 0.0, decay: 0.1, hold: true, ..PLAIN}, RATE);
    voice.note_on(69.0, 1.0);
    run(&mut voice, 48_000);
    let held = rms(&run(&mut voice, 9600));
    assert!(held > 0.6, "still loud after 0.5 s of a 0.1 s decay: {held}");
    voice.note_off();
    run(&mut voice, 9600);
    assert!(rms(&run(&mut voice, 960)) < held * 0.01, "gone 0.1 s after the release");
}

#[test]
fn velocity_adds_strike_depth() {
    let patch = Patch {depth: 0.0, strike: 4.0, strike_decay: 2.0, velocity: 1.0, ..PLAIN};
    let brightness = |velocity: f32| {
        let mut voice = Voice::new(patch, RATE);
        voice.note_on(69.0, velocity);
        let signal = run(&mut voice, 9600);
        magnitude(&signal, 440.0 + 880.0 * 3.0) / magnitude(&signal, 440.0).max(1e-6)
    };
    assert!(brightness(1.0) > brightness(0.3) * 4.0);
}

#[test]
fn the_render_is_deterministic_and_bounded() {
    let first = render(Patch::BASE, &FIGURE, 50.0, 136.0, 28, 1.0, 48_000.0);
    let second = render(Patch::BASE, &FIGURE, 50.0, 136.0, 28, 1.0, 48_000.0);
    assert_eq!(first, second);
    assert!(first.iter().all(|sample| sample.is_finite() && sample.abs() <= 1.5));
    assert!(rms(&first) > 0.01);
}

#[test]
fn decimate_keeps_the_band_and_removes_the_top() {
    let tone = |frequency: f32| -> Vec<f32> {
        (0..9600).map(|index| (std::f32::consts::TAU * frequency * index as f32 / RATE).sin()).collect()
    };
    assert!((rms(&decimate(&tone(1000.0))[100..4700]) - 0.7071).abs() < 0.01);
    assert!(rms(&decimate(&tone(40_000.0))[100..4700]) < 0.001);
}
