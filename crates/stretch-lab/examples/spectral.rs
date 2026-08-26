
//! Spectral-tier quality probe: per-segment phase-vocoder stretch of the grain-floor material,
//! scored with the same masked-excess metric. Segments = detected markers; each segment stretched
//! independently (fresh phases = transient reset), joined with 5 ms equal-power crossfades.

use stretch::spectral::SpectralStretcher;
use stretch::Analyzer;
use stretch_lab::corpus;
use stretch_lab::metrics::envelope::smooth_envelope;
use stretch_lab::metrics::modulation::modulation_excess_rated;
use stretch_lab::render::ENGINE_RATE;

fn spectral_render(entry: &corpus::Entry, ratio: f64) -> Vec<f32> {
    let mono: Vec<f32> = entry.left.iter().zip(entry.right.iter()).map(|(l, r)| 0.5 * (l + r)).collect();
    let markers = Analyzer::default().analyze(&entry.left, &entry.right, entry.file_rate).markers;
    let resets: Vec<usize> = markers.iter().map(|m| (m.position * entry.file_rate as f64) as usize).collect();
    SpectralStretcher::new().stretch_with_resets(&mono, ratio, &resets)
}

fn main() {
    let mut skipped = Vec::new();
    let mut entries = corpus::synthetic_entries();
    entries.extend(corpus::fixture_entries(&mut skipped));
    println!("{:<14} {:>7} {:>10} {:>10}", "entry", "ratio", "grain dB", "spectral dB");
    let grain = [("padchord", 1.1, 4.8), ("padchord", 1.25, 10.3), ("guitar-chords", 1.25, 10.6),
                 ("pad-borealis", 1.1, 9.5), ("pad-derelict", 1.25, 11.8), ("pad-derelict", 1.1, 12.6)];
    for (id, ratio, grain_db) in grain {
        let Some(entry) = entries.iter().find(|entry| entry.id == id) else { continue };
        let rendered = spectral_render(entry, ratio);
        let reference: Vec<f32> = entry.ideal.as_ref().map(|ideal| ideal(ratio)).unwrap_or_else(|| {
            entry.left.iter().zip(entry.right.iter()).map(|(l, r)| 0.5 * (l + r)).collect()
        });
        let ref_rate = if entry.ideal.is_some() { ENGINE_RATE } else { entry.file_rate };
        let smooth_out = smooth_envelope(&rendered, entry.file_rate);
        let smooth_ref = smooth_envelope(&reference, ref_rate);
        let reference_ratio = if entry.ideal.is_some() { 1.0 } else { ratio };
        let score = modulation_excess_rated(&smooth_out, &smooth_ref, 0.0, reference_ratio).map(|s| s.band_peak_db).unwrap_or(f64::NAN);
        println!("{:<14} {:>7} {:>10.1} {:>10.1}", id, ratio, grain_db, score);
    }
}
