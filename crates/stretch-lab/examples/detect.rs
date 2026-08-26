
use stretch::Analyzer;
use stretch_lab::corpus;

fn note_name(period: f32, rate: f32) -> String {
    if period <= 0.0 { return "-".into(); }
    let freq = rate as f64 / period as f64;
    let midi = 69.0 + 12.0 * (freq / 440.0).log2();
    let names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
    let rounded = midi.round() as i64;
    format!("{}{} ({:.0}Hz)", names[(rounded.rem_euclid(12)) as usize], rounded / 12 - 1, freq)
}

fn main() {
    let mut skipped = Vec::new();
    let entries = corpus::fixture_entries(&mut skipped);
    for id in ["drums-attack", "pad-derelict", "dub-chords"] {
        let Some(entry) = entries.iter().find(|entry| entry.id == id) else { continue };
        let analyzed = Analyzer::default().analyze(&entry.left, &entry.right, entry.file_rate);
        let duration = entry.left.len() as f64 / entry.file_rate as f64;
        println!("\n== {id} ({duration:.1}s, {} markers = {:.1}/s) ==", analyzed.markers.len(), analyzed.markers.len() as f64 / duration);
        println!("{:>7} {:>6} {:>5} {:>16} {:>5} {:>8}", "pos", "gap ms", "str", "pitch", "harm", "loop ms");
        let mut previous = 0.0f64;
        for marker in analyzed.markers.iter().take(14) {
            println!("{:>6.2}s {:>6.0} {:>5.2} {:>16} {:>5.2} {:>8.0}",
                marker.position, (marker.position - previous) * 1000.0, marker.strength,
                note_name(marker.period, entry.file_rate), marker.harmonicity,
                if marker.has_loop() {(marker.loop_end - marker.loop_start) / entry.file_rate as f64 * 1000.0} else {0.0});
            previous = marker.position;
        }
        if analyzed.markers.len() > 14 { println!("   ... {} more", analyzed.markers.len() - 14); }
    }
}
