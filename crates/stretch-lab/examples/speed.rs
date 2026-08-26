
use std::time::Instant;
use stretch::Analyzer;
use stretch_lab::corpus;

fn main() {
    let mut skipped = Vec::new();
    let entries = corpus::fixture_entries(&mut skipped);
    for entry in &entries {
        let start = Instant::now();
        let analyzed = Analyzer::default().analyze(&entry.left, &entry.right, entry.file_rate);
        let took = start.elapsed().as_secs_f64() * 1000.0;
        let duration = entry.left.len() as f64 / entry.file_rate as f64;
        println!("{:<14} {:>5.1}s audio -> {:>3} markers in {:>6.1} ms ({:.1}% of realtime)",
            entry.id, duration, analyzed.markers.len(), took, took / (duration * 1000.0) * 100.0);
    }
}
