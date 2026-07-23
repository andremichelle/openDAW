//! Measurement lab for the autotune (run with `cargo test -p dsp --test autotune_lab -- --nocapture`):
//! renders a synthetic vocal (sawtooth, vibrato, detuned, with a note step) through the exact block
//! drive the device uses (feed -> set_period/ratio -> psola), tracks the OUTPUT pitch with a second
//! detector instance, and reports vibrato retention, correction depth and note-step response per
//! parameter set. Quantifies the "too aggressive" report before any DSP change.
use dsp::autotune::Autotune;
use dsp::psola::Psola;

const SR: f32 = 48_000.0;
const BLOCK: usize = 128;
const SECONDS: f64 = 3.0;
const VIBRATO_HZ: f64 = 5.5;
const VIBRATO_CENTS: f64 = 40.0;
const DETUNE_CENTS: f64 = 30.0;
const NOTE_A: f64 = 57.0; // A3
const NOTE_B: f64 = 60.0; // C4
const STEP_AT: f64 = 1.5;

fn midi_to_hz(midi: f64) -> f64 {
    440.0 * libm::pow(2.0, (midi - 69.0) / 12.0)
}

fn synth(total: usize) -> Vec<f32> {
    let mut phase = 0.0f64;
    (0..total)
        .map(|index| {
            let time = index as f64 / SR as f64;
            let base = if time < STEP_AT { NOTE_A } else { NOTE_B };
            let vibrato = VIBRATO_CENTS * libm::sin(core::f64::consts::TAU * VIBRATO_HZ * time);
            let midi = base + (DETUNE_CENTS + vibrato) / 100.0;
            phase += midi_to_hz(midi) / SR as f64;
            phase -= libm::floor(phase);
            (2.0 * phase - 1.0) as f32 * 0.5
        })
        .collect()
}

struct PitchTrack {
    times: Vec<f64>,
    midi: Vec<f64>,
}

fn track_pitch(samples: &[f32]) -> PitchTrack {
    let mut analyzer: Box<Autotune> = unsafe { Box::new(core::mem::zeroed()) };
    analyzer.prepare(SR);
    analyzer.set_amount(0.0);
    let mut times = Vec::new();
    let mut midi = Vec::new();
    for start in (0..samples.len()).step_by(BLOCK) {
        let end = (start + BLOCK).min(samples.len());
        analyzer.feed(samples, samples, start, end);
        if analyzer.is_voiced() {
            times.push(end as f64 / SR as f64);
            midi.push(analyzer.detected_midi() as f64);
        }
    }
    PitchTrack { times, midi }
}

// Standard deviation of the pitch (cents) within [from, to) — the vibrato depth of a steady note.
fn wobble_cents(track: &PitchTrack, from: f64, to: f64) -> f64 {
    let values: Vec<f64> = track
        .times
        .iter()
        .zip(&track.midi)
        .filter(|(time, _)| **time >= from && **time < to)
        .map(|(_, midi)| midi * 100.0)
        .collect();
    if values.is_empty() {
        return f64::NAN;
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    libm::sqrt(values.iter().map(|value| (value - mean) * (value - mean)).sum::<f64>() / values.len() as f64)
}

fn mean_cents_off(track: &PitchTrack, target_midi: f64, from: f64, to: f64) -> f64 {
    let values: Vec<f64> = track
        .times
        .iter()
        .zip(&track.midi)
        .filter(|(time, _)| **time >= from && **time < to)
        .map(|(_, midi)| (midi - target_midi) * 100.0)
        .collect();
    if values.is_empty() {
        return f64::NAN;
    }
    values.iter().sum::<f64>() / values.len() as f64
}

// Seconds after the step until the tracked pitch first comes within 30 cents of the new target.
fn step_response(track: &PitchTrack, target_midi: f64) -> f64 {
    track
        .times
        .iter()
        .zip(&track.midi)
        .find(|(time, midi)| **time > STEP_AT + 0.02 && (**midi - target_midi).abs() * 100.0 < 30.0)
        .map(|(time, _)| time - STEP_AT)
        .unwrap_or(f64::NAN)
}

fn render(input: &[f32], amount: f32, retune: f32, smooth: f32) -> Vec<f32> {
    let mut core: Box<Autotune> = unsafe { Box::new(core::mem::zeroed()) };
    core.prepare(SR);
    core.set_key(0); // C
    core.set_scale(1); // Major (A3/C4 both diatonic)
    core.set_amount(amount);
    core.set_retune(retune);
    core.set_smooth(smooth);
    let mut psola: Box<Psola> = unsafe { Box::new(core::mem::zeroed()) };
    psola.prepare(SR);
    let mut out = vec![0.0f32; input.len()];
    let mut scratch = vec![0.0f32; input.len()];
    for start in (0..input.len()).step_by(BLOCK) {
        let end = (start + BLOCK).min(input.len());
        core.feed(input, input, start, end);
        psola.set_period(core.current_period_samples());
        psola.set_ratio_semitones(core.current_semitones());
        let (left, right) = (&mut out, &mut scratch);
        psola.process(input, input, &mut left[..], &mut right[..], start, end);
    }
    out
}

#[test]
fn measure() {
    let input = synth((SECONDS * SR as f64) as usize);
    let reference = track_pitch(&input);
    let window = (0.6, 1.4);
    let vibrato_in = wobble_cents(&reference, window.0, window.1);
    println!();
    println!("input: vibrato {VIBRATO_CENTS:.0}c @ {VIBRATO_HZ}Hz, detune +{DETUNE_CENTS:.0}c, step A3->C4 @ {STEP_AT}s");
    println!("measured input wobble: {vibrato_in:.1}c rms");
    println!();
    println!("{:<28} {:>10} {:>12} {:>12} {:>10}", "params", "wobble", "vib kept", "cents off", "step");
    for (label, amount, retune, smooth) in [
        ("defaults (1.0/0.5/0.6)", 1.0f32, 0.5f32, 0.6f32),
        ("gentle (1.0/0.2/0.6)", 1.0, 0.2, 0.6),
        ("hard (1.0/1.0/0.6)", 1.0, 1.0, 0.6),
        ("half amount (0.5/0.5/0.6)", 0.5, 0.5, 0.6),
        ("no smooth (1.0/0.5/0.0)", 1.0, 0.5, 0.0),
    ] {
        let out = render(&input, amount, retune, smooth);
        let track = track_pitch(&out);
        let wobble = wobble_cents(&track, window.0, window.1);
        let kept = 100.0 * wobble / vibrato_in;
        let off = mean_cents_off(&track, NOTE_A, window.0, window.1);
        let step = step_response(&track, NOTE_B);
        println!("{label:<28} {wobble:>9.1}c {kept:>11.0}% {off:>11.1}c {step:>9.3}s");
    }
}

fn goertzel(samples: &[f32], hz: f64) -> f64 {
    let coeff = 2.0 * libm::cos(core::f64::consts::TAU * hz / SR as f64);
    let (mut s0, mut s1, mut s2) = (0.0f64, 0.0f64, 0.0f64);
    for &sample in samples {
        s0 = sample as f64 + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    libm::sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / samples.len() as f64
}

#[test]
fn replaces_not_adds() {
    let total = (2.0 * SR as f64) as usize;
    let input: Vec<f32> = (0..total)
        .map(|index| (2.0 * ((220.0 * index as f64 / SR as f64) % 1.0) - 1.0) as f32 * 0.5)
        .collect();
    let mut core: Box<Autotune> = unsafe { Box::new(core::mem::zeroed()) };
    core.prepare(SR);
    core.set_scale(0);
    core.set_retune(1.0);
    core.set_shift(3.0);
    let mut psola: Box<Psola> = unsafe { Box::new(core::mem::zeroed()) };
    psola.prepare(SR);
    let mut out = vec![0.0f32; total];
    let mut scratch = vec![0.0f32; total];
    for start in (0..total).step_by(BLOCK) {
        let end = (start + BLOCK).min(total);
        core.feed(&input, &input, start, end);
        psola.set_period(core.current_period_samples());
        psola.set_ratio_semitones(core.current_semitones());
        psola.process(&input, &input, &mut out[..], &mut scratch[..], start, end);
    }
    let steady = &out[SR as usize..];
    let original = goertzel(steady, 220.0);
    let shifted = goertzel(steady, 220.0 * libm::pow(2.0, 3.0 / 12.0));
    println!("original 220Hz: {original:.6}  shifted 261.6Hz: {shifted:.6}  ratio {:.1}dB",
        20.0 * libm::log10(shifted / original.max(1.0e-9)));
}
