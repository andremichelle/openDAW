
//! Ear-bisect: the three condemned cases under four configurations peeling back recent changes.
//! A = current; B = read-through OFF; C = B + long soft fades (60 ms); D = C + annotation markers
//! (not detector). One letter per file from the user pinpoints the regression.

use stretch::{Analyzer, AnalyzerConfig, Tuning};
use stretch_lab::corpus;
use stretch_lab::render::{render_stretch, PlayMode, RenderSpec, ENGINE_RATE};
use stretch_lab::wav;
use std::path::Path;

fn render(entry: &corpus::Entry, ratio: f64, tuning: Tuning, detector_markers: bool, name: &str) {
    render_cfg(entry, ratio, tuning, detector_markers, AnalyzerConfig::default(), name)
}

fn render_cfg(entry: &corpus::Entry, ratio: f64, tuning: Tuning, detector_markers: bool, config: AnalyzerConfig, name: &str) {
    let analyzer = Analyzer::new(config);
    let markers = if detector_markers && entry.ideal.is_none() {
        analyzer.analyze(&entry.left, &entry.right, entry.file_rate).markers
    } else {
        analyzer.describe(&entry.left, &entry.right, entry.file_rate, &entry.transients)
    };
    let spec = RenderSpec {left: &entry.left, right: &entry.right, file_rate: entry.file_rate, transients: &entry.transients, ratio, mode: PlayMode::Repeat};
    let (l, r) = render_stretch(&spec, &markers, tuning);
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("out/bisect").join(name);
    wav::write_32f(&path, ENGINE_RATE, &l, &r).unwrap();
}

fn main() {
    let mut skipped = Vec::new();
    let mut entries = corpus::synthetic_entries();
    entries.extend(corpus::fixture_entries(&mut skipped));
    let cases = [("pad-derelict", 1.25), ("guitar-chords", 1.1), ("padchord", 1.25)];
    for (id, ratio) in cases {
        let entry = entries.iter().find(|entry| entry.id == id).unwrap();
        let a = Tuning::adaptive();
        render(entry, ratio, a, true, &format!("{id}-A-current.wav"));
        let mut b = a;
        b.read_through_max_fill = 0.0;
        render(entry, ratio, b, true, &format!("{id}-B-no-readthrough.wav"));
        let mut c = b;
        c.voice_fade_max_seconds = 0.060;
        render(entry, ratio, c, true, &format!("{id}-C-B-plus-soft-fades.wav"));
        render(entry, ratio, c, false, &format!("{id}-D-C-plus-annotation-markers.wav"));
        // E/F: Ableton-style SHORT TAIL loops — sustain the last bit before the next transient,
        // never wrap back and replay the phrase (the ghost-restart the ear caught).
        let mut tail = AnalyzerConfig::default();
        tail.full_region_strength_gate = -1.0;
        tail.loop_len_min_seconds = 0.045;
        tail.loop_len_max_seconds = 0.120;
        render_cfg(entry, ratio, c, false, tail, &format!("{id}-E-D-plus-short-tail-loops.wav"));
        let mut tiny = tail;
        tiny.loop_len_min_seconds = 0.025;
        tiny.loop_len_max_seconds = 0.060;
        render_cfg(entry, ratio, c, false, tiny, &format!("{id}-F-D-plus-tiny-tail-loops.wav"));
    }
    println!("bisect rendered");
}
