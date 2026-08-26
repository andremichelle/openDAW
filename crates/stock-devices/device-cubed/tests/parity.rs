//! Sample-by-sample parity against the ar-303 JS reference model.
//!
//! The 52 constants were fitted against the reference on top of the JS model's exact arithmetic, so the port
//! is only worth anything if it reproduces that arithmetic. This compares raw samples, not a
//! spectral or perceptual summary: those hide exactly the small state divergences (a stale accent
//! cap, an envelope one block late) that this session spent its time hunting by ear.
//!
//! Fixtures are not committed. Generate them first:
//!     cd ~/Repositories/others/ar-303 && node scripts/export_parity_vectors.mjs
//! Without them the test SKIPS rather than fails, so a fresh checkout is not red for the wrong
//! reason - but a skip is not a pass, and CI must generate them.

use device_cubed::merger::PATTERN_NOTE_ID;
use device_cubed::{ensure_tables, NoteMerger, Params, Source, VoiceCommand, Voice303};

include!("fixtures/cases.rs");

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");

fn read_f32(path: &str) -> Option<Vec<f32>> {
    let bytes = std::fs::read(path).ok()?;
    assert_eq!(bytes.len() % 4, 0, "{path}: not a whole number of f32");
    Some(bytes.chunks_exact(4).map(|word| f32::from_le_bytes([word[0], word[1], word[2], word[3]])).collect())
}

fn render(case: &Case) -> Vec<f32> {
    let tables = unsafe {ensure_tables()};
    let mut voice = Voice303::new(SAMPLE_RATE);
    voice.params = case.params;
    let total = case.blocks * BLOCK;
    let mut output = vec![0.0f32; total];
    for block in 0..case.blocks {
        if let Some(event) = case.events.iter().find(|event| event.at == block) {
            if event.off {
                voice.note_off();
            } else {
                voice.note_on(event.note, event.accent, event.slide);
            }
        }
        voice.process_block(tables, &mut output, block * BLOCK, BLOCK);
    }
    output
}

/// Same cases, but every event routed through the merger instead of straight at the voice. The
/// merger sits between the pattern and the calibrated model, so it has to be provably TRANSPARENT
/// for pattern playback: if it perturbs ordering, accent bits or slide by even one step, the
/// calibration stops being worth anything. Compared against the same JS fixtures, so this is
/// parity, not self-consistency.
#[test]
fn merger_is_transparent_for_pattern_playback() {
    let manifest = format!("{FIXTURES}/manifest.json");
    if !std::path::Path::new(&manifest).exists() {
        eprintln!("SKIP: no fixtures (see the parity test)");
        return;
    }
    for case in CASES {
        let Some(expected) = read_f32(&format!("{FIXTURES}/{}.f32", case.name)) else {continue};
        let tables = unsafe {ensure_tables()};
    let mut voice = Voice303::new(SAMPLE_RATE);
        let mut merger = NoteMerger::new();
        voice.params = case.params;
        let mut output = vec![0.0f32; case.blocks * BLOCK];
        for block in 0..case.blocks {
            if let Some(event) = case.events.iter().find(|event| event.at == block) {
                let command = if event.off {
                    merger.note_off(PATTERN_NOTE_ID)
                } else {
                    Some(merger.note_on(PATTERN_NOTE_ID, event.note, 0.0, Source::Pattern,
                                        Some(event.accent), Some(event.slide)))
                };
                match command {
                    Some(VoiceCommand::NoteOn {pitch, accent, slide}) => voice.note_on(pitch, accent, slide),
                    Some(VoiceCommand::NoteOff) => voice.note_off(),
                    None => {}
                }
            }
            voice.process_block(tables, &mut output, block * BLOCK, BLOCK);
        }
        let worst = output.iter().zip(expected.iter())
            .map(|(got, want)| (*got as f64 - *want as f64).abs())
            .fold(0.0f64, f64::max);
        assert!(worst <= 1e-6, "{}: merger changed the render, worst {worst:.3e}", case.name);
        eprintln!("  ok   {:<18} merger transparent (worst {worst:.3e})", case.name);
    }
}

#[test]
fn matches_js_reference_sample_for_sample() {
    let manifest = format!("{FIXTURES}/manifest.json");
    if !std::path::Path::new(&manifest).exists() {
        eprintln!("SKIP: no fixtures. Run: cd ~/Repositories/others/ar-303 && node scripts/export_parity_vectors.mjs");
        return;
    }
    // A wrong-model fixture would produce a mismatch that looks like a port bug.
    eprintln!("parity against model {MODEL}");
    let mut failures = Vec::new();
    for case in CASES {
        let expected = match read_f32(&format!("{FIXTURES}/{}.f32", case.name)) {
            Some(samples) => samples,
            None => {failures.push(format!("{}: fixture missing", case.name)); continue}
        };
        let actual = render(case);
        assert_eq!(actual.len(), expected.len(), "{}: length", case.name);
        assert!(actual.iter().all(|sample| sample.is_finite()), "{}: non-finite output", case.name);
        let mut worst = 0.0f64;
        let mut worst_at = 0usize;
        let mut first_bad = None;
        for (index, (got, want)) in actual.iter().zip(expected.iter()).enumerate() {
            let delta = (*got as f64 - *want as f64).abs();
            if delta > worst {worst = delta; worst_at = index;}
            // Tolerance is far below audibility but far above nothing: f64 transcendentals
            // (exp/tanh/powf) are not bit-identical between V8 and Rust's libm, so bit-parity is
            // not achievable. Divergence from a STATE bug grows; rounding noise does not.
            if delta > 1e-6 && first_bad.is_none() {first_bad = Some(index);}
        }
        let summary = format!("{:<18} worst {:.3e} at sample {} ({:.1} ms)",
                              case.name, worst, worst_at, worst_at as f64 / SAMPLE_RATE * 1000.0);
        if let Some(index) = first_bad {
            failures.push(format!("{summary}  first divergence at sample {index} \
                                   (got {:e}, want {:e})", actual[index], expected[index]));
        } else {
            eprintln!("  ok   {summary}");
        }
    }
    assert!(failures.is_empty(), "parity failures:\n{}", failures.join("\n"));
}
