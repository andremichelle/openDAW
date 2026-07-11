//! Empirical tuning sweep for the pad frontier: renders key cases across a grid of loop-fade and
//! continuation settings, scores each with the same masked-excess metric the judge gates on, and
//! prints the grid — the harness answering what analysis alone couldn't.

use stretch::{Analyzer, AnalyzerConfig, Tuning};
use stretch_lab::corpus;
use stretch_lab::metrics::envelope::smooth_envelope;
use stretch_lab::metrics::modulation::modulation_excess;
use stretch_lab::render::{render_stretch, PlayMode, RenderSpec, ENGINE_RATE};

fn score(entry: &corpus::Entry, ratio: f64, tuning: Tuning, gate: f32) -> f64 {
    let mut config = AnalyzerConfig::default();
    config.full_region_strength_gate = gate;
    let markers = Analyzer::new(config).describe(&entry.left, &entry.right, entry.file_rate, &entry.transients);
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
    println!("baseline masked excess for reference: pad-derelict x1.5 = 12.8, x2 = 14.4, pad-drone x1.5 = 7.3");
    println!("{:<28} {:>9} {:>9} {:>9} {:>11} {:>11} {:>10}", "tuning", "chord x2", "chord x4", "sine1.25", "derelict1.5", "derelict2", "drone1.5");
    for &(fade_min, fade_max) in &[(0.010, 0.040), (0.010, 0.080)] {
      for &voice_max in &[0.020f64, 0.060] {
        let gate = 0.25f32;
        let mut tuning = Tuning::adaptive();
        tuning.loop_fade_min_seconds = fade_min;
        tuning.loop_fade_max_seconds = fade_max;
        tuning.voice_fade_max_seconds = voice_max;
        let label = format!("loopfade {:.0}-{:.0}ms voicemax {:.0}ms", fade_min * 1000.0, fade_max * 1000.0, voice_max * 1000.0);
        println!(
            "{:<28} {:>9.2} {:>9.2} {:>9.2} {:>11.2} {:>11.2} {:>10.2}",
            label,
            score(padchord, 2.0, tuning, gate),
            score(padchord, 4.0, tuning, gate),
            score(sine, 1.25, tuning, gate),
            derelict.map(|entry| score(entry, 1.5, tuning, gate)).unwrap_or(f64::NAN),
            derelict.map(|entry| score(entry, 2.0, tuning, gate)).unwrap_or(f64::NAN),
            drone.map(|entry| score(entry, 1.5, tuning, gate)).unwrap_or(f64::NAN)
        );
      }
    }
}
