
use stretch::{Analyzer, Tuning};
use stretch_lab::corpus;
use stretch_lab::metrics::envelope::rms;
use stretch_lab::render::{render_baseline, render_stretch, PlayMode, RenderSpec, ENGINE_RATE};

fn main() {
    let mut skipped = Vec::new();
    let entries = corpus::fixture_entries(&mut skipped);
    let entry = entries.iter().find(|entry| entry.id == "pad-derelict").unwrap();
    let markers = Analyzer::default().describe(&entry.left, &entry.right, entry.file_rate, &entry.transients);
    let spec = RenderSpec {left: &entry.left, right: &entry.right, file_rate: entry.file_rate, transients: &entry.transients, ratio: 1.5, mode: PlayMode::Repeat};
    let (base_left, _) = render_baseline(&spec);
    let (new_left, _) = render_stretch(&spec, &markers, Tuning::adaptive());
    let source_mono: Vec<f32> = entry.left.iter().zip(entry.right.iter()).map(|(l, r)| 0.5 * (l + r)).collect();
    println!("source rms {:.4}", rms(&source_mono));
    let slice = ENGINE_RATE as usize;
    for second in 0..(base_left.len() / slice) {
        let from = second * slice;
        let to = from + slice;
        let base = rms(&base_left[from..to]);
        let new = rms(&new_left[from..to]);
        println!("t={second:>2}s baseline {base:.4}  adaptive {new:.4}  delta {:+.2} dB", 20.0 * ((new + 1e-9) / (base + 1e-9)).log10());
    }
}
