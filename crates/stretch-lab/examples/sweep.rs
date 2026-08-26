//! Empirical tuning sweep for the pad frontier: renders key cases across a grid of loop-fade and
//! continuation settings, scores each with the same masked-excess metric the judge gates on, and
//! prints the grid — the harness answering what analysis alone couldn't.

use stretch::{Analyzer, AnalyzerConfig, Tuning};
use stretch_lab::corpus;
use stretch_lab::metrics::envelope::{rms, smooth_envelope};
use stretch_lab::metrics::modulation::modulation_excess;
use stretch_lab::metrics::spectral::level_delta_db;
use stretch_lab::render::{render_stretch, PlayMode, RenderSpec, ENGINE_RATE};

fn score(entry: &corpus::Entry, ratio: f64, tuning: Tuning, alpha: f32, delta: f32) -> f64 {
    let mut config = AnalyzerConfig::default();
    config.onset.median_alpha = alpha;
    config.onset.delta = delta;
    // End-to-end: the detector's own markers drive playback for real fixtures.
    let markers = if entry.ideal.is_some() {
        Analyzer::new(config).describe(&entry.left, &entry.right, entry.file_rate, &entry.transients)
    } else {
        Analyzer::new(config).analyze(&entry.left, &entry.right, entry.file_rate).markers
    };
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

fn level(entry: &corpus::Entry, ratio: f64, tuning: Tuning) -> f64 {
    let markers = Analyzer::default().describe(&entry.left, &entry.right, entry.file_rate, &entry.transients);
    let spec = RenderSpec {left: &entry.left, right: &entry.right, file_rate: entry.file_rate, transients: &entry.transients, ratio, mode: PlayMode::Repeat};
    let (out_left, out_right) = render_stretch(&spec, &markers, tuning);
    let output_mono: Vec<f32> = out_left.iter().zip(out_right.iter()).map(|(l, r)| 0.5 * (l + r)).collect();
    let source_mono: Vec<f32> = entry.left.iter().zip(entry.right.iter()).map(|(l, r)| 0.5 * (l + r)).collect();
    level_delta_db(rms(&source_mono), rms(&output_mono))
}

fn main() {
    let mut entries = corpus::synthetic_entries();
    let mut skipped = Vec::new();
    entries.extend(corpus::fixture_entries(&mut skipped));
    for line in &skipped {
        println!("SKIPPED: {line}");
    }
    let padchord = entries.iter().find(|entry| entry.id == "padchord").unwrap();
    let sine = entries.iter().find(|entry| entry.id == "sine220").unwrap();
    let derelict = entries.iter().find(|entry| entry.id == "pad-derelict");
    let drone = entries.iter().find(|entry| entry.id == "pad-drone");
    println!("{:<28} {:>9} {:>9} {:>11} {:>11} {:>9} {:>10}", "tuning", "chord1.1", "chord1.25", "derelict1.1", "derelict1.25", "drone1.1", "guitar1.25");
    let guitar = entries.iter().find(|entry| entry.id == "guitar-chords");
    for &(fade_min, fade_max) in &[(0.010, 0.080)] {
      for &(alpha, delta) in &[(1.3f32, 0.01f32), (1.6, 0.02), (2.0, 0.03), (2.5, 0.05)] {
        let read_through = 1.12f64;
        let voice_max = 0.020f64;
        let mut tuning = Tuning::adaptive();
        tuning.loop_fade_min_seconds = fade_min;
        tuning.loop_fade_max_seconds = fade_max;
        tuning.voice_fade_max_seconds = voice_max;
        tuning.read_through_max_fill = read_through;
        let label = format!("alpha {:.1} delta {:.2}", alpha, delta);
        println!(
            "{:<28} {:>9.2} {:>9.2} {:>9.2} {:>11.2} {:>11.2} {:>10.2}",
            label,
            score(padchord, 1.1, tuning, alpha, delta),
            score(padchord, 1.25, tuning, alpha, delta),
            derelict.map(|entry| score(entry, 1.1, tuning, alpha, delta)).unwrap_or(f64::NAN),
            derelict.map(|entry| score(entry, 1.25, tuning, alpha, delta)).unwrap_or(f64::NAN),
            drone.map(|entry| score(entry, 1.1, tuning, alpha, delta)).unwrap_or(f64::NAN),
            guitar.map(|entry| score(entry, 1.25, tuning, alpha, delta)).unwrap_or(f64::NAN)
        );

      }
    }
}
