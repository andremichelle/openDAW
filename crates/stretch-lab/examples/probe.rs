//! Diagnostic probe: render one case through both engines, print the descriptors and the top
//! envelope-modulation lines, so a regression can be traced to a mechanism instead of a theory.
//! Usage: cargo run -p stretch-lab --release --example probe [entry] [ratio]

use stretch::{Analyzer, Tuning};
use stretch_lab::corpus;
use stretch_lab::metrics::envelope::{detrend, mean, smooth_envelope, ENVELOPE_RATE};
use stretch_lab::metrics::goertzel;
use stretch_lab::render::{render_baseline, render_stretch, PlayMode, RenderSpec, ENGINE_RATE};

fn top_lines(mono: &[f32], label: &str) {
    let smooth = smooth_envelope(mono, ENGINE_RATE);
    let skip = 250usize;
    if smooth.len() <= skip * 2 + 100 {
        println!("{label}: too short");
        return;
    }
    let region = &smooth[skip..smooth.len() - skip];
    let level = mean(region);
    let residual = detrend(region, 250.0);
    let mut lines: Vec<(f64, f64)> = Vec::new();
    let mut frequency = 0.5;
    while frequency <= 60.0 {
        let magnitude = goertzel::magnitude(&residual, ENVELOPE_RATE, frequency);
        lines.push((frequency, goertzel::db(magnitude / level)));
        frequency += 0.25;
    }
    lines.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    let text: Vec<String> = lines.iter().take(5).map(|(freq, db)| format!("{freq:.2}Hz {db:.1}dB")).collect();
    println!("{label}: {}", text.join("  "));
}

fn main() {
    let entry_id = std::env::args().nth(1).unwrap_or_else(|| "sine440".into());
    let ratio: f64 = std::env::args().nth(2).and_then(|text| text.parse().ok()).unwrap_or(1.5);
    let entries = corpus::synthetic_entries();
    let entry = entries.iter().find(|entry| entry.id == entry_id).expect("known synthetic entry");
    let markers = Analyzer::default().describe(&entry.left, &entry.right, entry.file_rate, &entry.transients);
    println!("descriptors for {entry_id}:");
    for marker in &markers {
        println!(
            "  pos {:.3}s strength {:.2} period {:.1} harm {:.2} loop {} len {:.1}ms",
            marker.position, marker.strength, marker.period, marker.harmonicity,
            if marker.has_loop() {"yes"} else {"no"},
            if marker.has_loop() {(marker.loop_end - marker.loop_start) / entry.file_rate as f64 * 1000.0} else {0.0}
        );
    }
    let spec = RenderSpec {left: &entry.left, right: &entry.right, file_rate: entry.file_rate, transients: &entry.transients, ratio, mode: PlayMode::Repeat};
    let (base_left, _) = render_baseline(&spec);
    println!("case {entry_id} x{ratio} repeat — top envelope-modulation lines per variant:");
    top_lines(&base_left, "  baseline (frozen)");
    let mut no_loops = markers.clone();
    for marker in &mut no_loops {
        marker.loop_start = 0.0;
        marker.loop_end = -1.0;
    }
    let mut no_period = markers.clone();
    for marker in &mut no_period {
        marker.period = 0.0;
    }
    let bare: Vec<stretch::TransientDescriptor> = entry.transients.iter().map(|&position| stretch::TransientDescriptor::bare(position)).collect();
    let (variant, _) = render_stretch(&spec, &bare, Tuning::legacy());
    top_lines(&variant, "  legacy tuning, bare markers  (parity ref)");
    let (variant, _) = render_stretch(&spec, &bare, Tuning::adaptive());
    top_lines(&variant, "  adaptive, bare markers       (fades only: strength=1 -> short fades)");
    let (variant, _) = render_stretch(&spec, &no_loops, Tuning::adaptive());
    top_lines(&variant, "  adaptive, loops stripped     (real strength/period, margin loops)");
    let (variant, _) = render_stretch(&spec, &no_period, Tuning::adaptive());
    top_lines(&variant, "  adaptive, period stripped    (loops yes, no PSOLA/coherent-linear)");
    let (variant, _) = render_stretch(&spec, &markers, Tuning::adaptive());
    top_lines(&variant, "  adaptive, full descriptors");
    let boundary = 0.5 * ratio;
    println!("  (boundaries every {boundary:.3}s -> {:.2} Hz)", 1.0 / boundary);
}
