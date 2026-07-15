
use stretch::Analyzer;
use stretch_lab::corpus;

fn main() {
    let mut skipped = Vec::new();
    let entries = corpus::fixture_entries(&mut skipped);
    for id in ["pad-derelict", "pad-drone", "pad-borealis"] {
        let Some(entry) = entries.iter().find(|entry| entry.id == id) else { continue };
        let markers = Analyzer::default().describe(&entry.left, &entry.right, entry.file_rate, &entry.transients);
        let loops = markers.iter().filter(|marker| marker.has_loop()).count();
        let mean = |values: Vec<f32>| values.iter().sum::<f32>() / values.len().max(1) as f32;
        println!("{id}: {} markers, {} with loops, mean strength {:.2}, mean harmonicity {:.2}, mean period {:.0}",
            markers.len(), loops,
            mean(markers.iter().map(|m| m.strength).collect()),
            mean(markers.iter().map(|m| m.harmonicity).collect()),
            mean(markers.iter().map(|m| m.period).collect()));
    }
}
