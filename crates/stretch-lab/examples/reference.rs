
//! The Signalsmith Stretch reference column: the best-regarded MIT stretcher rendered through the
//! same masked-excess metric — the "realistically excellent" bar the plan always wanted measured.

use signalsmith_stretch::Stretch;
use stretch_lab::corpus;
use stretch_lab::metrics::envelope::smooth_envelope;
use stretch_lab::metrics::modulation::modulation_excess_rated;
use stretch_lab::render::ENGINE_RATE;

fn signalsmith_render(mono: &[f32], sample_rate: f32, ratio: f64) -> Vec<f32> {
    let mut stretch = Stretch::preset_default(1, sample_rate as u32);
    let out_len = (mono.len() as f64 * ratio) as usize;
    let mut out = vec![0.0f32; out_len];
    stretch.exact(mono, &mut out[..]);
    out
}

fn main() {
    let mut skipped = Vec::new();
    let mut entries = corpus::synthetic_entries();
    entries.extend(corpus::fixture_entries(&mut skipped));
    println!("{:<14} {:>6} {:>9} {:>12}", "entry", "ratio", "ours dB", "signalsmith");
    let ours = [("padchord", 1.1, 4.8), ("padchord", 1.25, 10.3), ("guitar-chords", 1.1, 11.0),
                ("pad-derelict", 1.1, 11.7), ("pad-derelict", 1.25, 17.2), ("pad-drone", 1.1, 7.7),
                ("sine220", 1.25, -43.3), ("story", 1.1, 8.4)];
    for (id, ratio, ours_db) in ours {
        let Some(entry) = entries.iter().find(|entry| entry.id == id) else { continue };
        let mono: Vec<f32> = entry.left.iter().zip(entry.right.iter()).map(|(l, r)| 0.5 * (l + r)).collect();
        let rendered = signalsmith_render(&mono, entry.file_rate, ratio);
        let reference: Vec<f32> = entry.ideal.as_ref().map(|ideal| ideal(ratio)).unwrap_or_else(|| mono.clone());
        let ref_rate = if entry.ideal.is_some() { ENGINE_RATE } else { entry.file_rate };
        let reference_ratio = if entry.ideal.is_some() { 1.0 } else { ratio };
        let smooth_out = smooth_envelope(&rendered, entry.file_rate);
        let smooth_ref = smooth_envelope(&reference, ref_rate);
        let score = modulation_excess_rated(&smooth_out, &smooth_ref, 0.0, reference_ratio)
            .map(|s| s.band_peak_db).unwrap_or(f64::NAN);
        println!("{:<14} {:>6} {:>9.1} {:>12.1}", id, ratio, ours_db, score);
        let out_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("out/reference").join(format!("{id}_x{ratio}_signalsmith.wav"));
        let _ = stretch_lab::wav::write_32f(&out_path, entry.file_rate, &rendered, &rendered);
    }
}
