//! Empirical tuning sweep for the pad frontier: renders key cases across a grid of loop-fade and
//! continuation settings, scores each with the same masked-excess metric the judge gates on, and
//! prints the grid — the harness answering what analysis alone couldn't.

use stretch::{Analyzer, Tuning};
use stretch_lab::corpus;
use stretch_lab::metrics::envelope::smooth_envelope;
use stretch_lab::metrics::modulation::modulation_excess;
use stretch_lab::render::{render_stretch, PlayMode, RenderSpec, ENGINE_RATE};

fn score(entry: &corpus::Entry, ratio: f64, tuning: Tuning) -> f64 {
    let markers = Analyzer::default().describe(&entry.left, &entry.right, entry.file_rate, &entry.transients);
    let spec = RenderSpec {left: &entry.left, right: &entry.right, file_rate: entry.file_rate, transients: &entry.transients, ratio, mode: PlayMode::Repeat};
    let (out_left, out_right) = render_stretch(&spec, &markers, tuning);
    let output_mono: Vec<f32> = out_left.iter().zip(out_right.iter()).map(|(l, r)| 0.5 * (l + r)).collect();
    let reference = entry.ideal.as_ref().map(|ideal| ideal(ratio)).unwrap_or_else(|| {
        entry.left.iter().zip(entry.right.iter()).map(|(l, r)| 0.5 * (l + r)).collect()
    });
    let smooth_out = smooth_envelope(&output_mono, ENGINE_RATE);
    let smooth_ref = smooth_envelope(&reference, if entry.ideal.is_some() {ENGINE_RATE} else {entry.file_rate});
    modulation_excess(&smooth_out, &smooth_ref, 0.0).map(|scores| scores.band_peak_db).unwrap_or(f64::NAN)
}

fn main() {
    let entries = corpus::synthetic_entries();
    let padchord = entries.iter().find(|entry| entry.id == "padchord").unwrap();
    let sine = entries.iter().find(|entry| entry.id == "sine220").unwrap();
    println!("{:<44} {:>10} {:>10} {:>10}", "tuning", "pad x2", "pad x4", "sine x1.25");
    for &(fade_min, fade_max) in &[(0.005, 0.040), (0.010, 0.080), (0.020, 0.160), (0.040, 0.320)] {
        for &weak in &[0.0f32, 0.15] {
            let mut tuning = Tuning::adaptive();
            tuning.loop_fade_min_seconds = fade_min;
            tuning.loop_fade_max_seconds = fade_max;
            tuning.weak_boundary_threshold = weak;
            let label = format!("fade {:.0}-{:.0}ms weak {:.2}", fade_min * 1000.0, fade_max * 1000.0, weak);
            println!(
                "{:<44} {:>10.2} {:>10.2} {:>10.2}",
                label,
                score(padchord, 2.0, tuning),
                score(padchord, 4.0, tuning),
                score(sine, 1.25, tuning)
            );
        }
    }
}
