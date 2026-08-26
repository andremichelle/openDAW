//! The judging loop driver. Always run with --release (the matrix renders + FFT metrics are slow in
//! debug):
//!
//!   cargo run -p stretch-lab --release --bin judge -- baseline   render matrix through the FROZEN v1, write snapshots/baseline.tsv
//!   cargo run -p stretch-lab --release --bin judge               render through `stretch`, print delta table + verdict
//!   cargo run -p stretch-lab --release --bin judge -- accept     promote the last run to snapshots/best.tsv (refuses unless Improved)
//!   cargo run -p stretch-lab --release --bin judge -- listen     write out/LISTEN.md + playlist of worst source->baseline->current triples
//!   cargo run -p stretch-lab --release --bin judge -- annotate   bootstrap fixtures/<id>.onsets.txt (machine-generated, review by ear!)
//!
//! One iteration = edit `crates/stretch` -> `judge` -> read deltas -> `accept` or revert.

use std::path::{Path, PathBuf};
use stretch::{Analyzer, Tuning};
use stretch_lab::corpus::{self, Entry};
use stretch_lab::metrics::{self, MetricValue};
use stretch_lab::render::{self, PlayMode, RenderSpec};
use stretch_lab::report;
use stretch_lab::scores::{read_tsv, CaseScore, Scores};
use stretch_lab::thresholds;
use stretch_lab::wav;

fn manifest_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn out_dir() -> PathBuf {
    manifest_dir().join("out")
}

fn snapshots_dir() -> PathBuf {
    manifest_dir().join("snapshots")
}

struct Case<'a> {
    entry: &'a Entry,
    ratio: f64,
    mode: PlayMode
}

fn matrix(entries: &[Entry]) -> Vec<Case<'_>> {
    let mut cases = Vec::new();
    for entry in entries {
        for &ratio in corpus::RATIOS {
            cases.push(Case {entry, ratio, mode: PlayMode::Repeat});
        }
        for &ratio in corpus::EXTREME_RATIOS {
            cases.push(Case {entry, ratio, mode: PlayMode::Repeat});
        }
        for &ratio in &[1.1, 1.25] {
            cases.push(Case {entry, ratio, mode: PlayMode::Once});
            cases.push(Case {entry, ratio, mode: PlayMode::Pingpong});
        }
    }
    cases
}

fn load_corpus() -> Vec<Entry> {
    let mut skipped = Vec::new();
    let mut entries = corpus::synthetic_entries();
    entries.extend(corpus::fixture_entries(&mut skipped));
    for line in &skipped {
        println!("SKIPPED: {line}");
    }
    if !skipped.is_empty() {
        println!("({} corpus entries skipped — coverage is NOT complete)", skipped.len());
    }
    entries
}

enum Engine {
    Baseline,
    Stretch(Tuning)
}

impl Engine {
    fn label(&self) -> &'static str {
        match self {
            Engine::Baseline => "baseline-v1",
            Engine::Stretch(_) => "stretch"
        }
    }
}

fn render_case(case: &Case, engine: &Engine) -> (Vec<f32>, Vec<f32>, Vec<MetricValue>) {
    let entry = case.entry;
    let spec = RenderSpec {
        left: &entry.left, right: &entry.right, file_rate: entry.file_rate,
        transients: &entry.transients, ratio: case.ratio, mode: case.mode
    };
    let mut playback: Option<Vec<stretch::TransientDescriptor>> = None;
    let (out_left, out_right) = match engine {
        Engine::Baseline => render::render_baseline(&spec),
        Engine::Stretch(tuning) => {
            // THE DETECTOR IS THE ENTRY POINT: real fixtures play from the new detector's markers
            // (the system judged end-to-end); synthetic grids stay recipe-defined (they exist to
            // force specific looping behavior with controlled inputs).
            let markers = if entry.ideal.is_some() {
                Analyzer::default().describe(&entry.left, &entry.right, entry.file_rate, &entry.transients)
            } else {
                Analyzer::default().analyze(&entry.left, &entry.right, entry.file_rate).markers
            };
            let rendered = render::render_stretch(&spec, &markers, *tuning);
            playback = Some(markers);
            rendered
        }
    };
    let measured = metrics::measure_case(entry, &spec, &out_left, &out_right, playback.as_deref());
    (out_left, out_right, measured)
}

fn run_matrix(entries: &[Entry], engine: &Engine, write_wavs: bool) -> Scores {
    let cases = matrix(entries);
    let total = cases.len();
    let mut scores = Scores {engine: engine.label().into(), cases: Vec::with_capacity(total)};
    for (index, case) in cases.iter().enumerate() {
        let (out_left, out_right, measured) = render_case(case, engine);
        if write_wavs {
            let path = out_dir().join(engine.label()).join(format!("{}_x{}_{}.wav", case.entry.id, case.ratio, case.mode.label()));
            if let Err(error) = wav::write_32f(&path, render::ENGINE_RATE, &out_left, &out_right) {
                println!("wav write failed: {error}");
            }
        }
        scores.cases.push(CaseScore {entry: case.entry.id.clone(), ratio: case.ratio, mode: case.mode.label().into(), metrics: measured});
        if (index + 1) % 20 == 0 {
            println!("  {}/{total} cases", index + 1);
        }
    }
    scores
}

fn write(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(path, text).unwrap_or_else(|error| panic!("write {}: {error}", path.display()));
}

fn cmd_baseline() {
    let entries = load_corpus();
    println!("rendering baseline matrix ({} entries)...", entries.len());
    let scores = run_matrix(&entries, &Engine::Baseline, true);
    write(&snapshots_dir().join("baseline.tsv"), &scores.to_tsv());
    write(&out_dir().join("baseline-scores.json"), &scores.to_json());
    println!("wrote snapshots/baseline.tsv ({} cases)", scores.cases.len());
    verify_pain_gate(&scores);
}

/// Phase 0 gate: the baseline must ENCODE THE PAIN or the metrics are wrong.
fn verify_pain_gate(scores: &Scores) {
    let mut pad_mod: Vec<f64> = Vec::new();
    let mut sideband: Vec<f64> = Vec::new();
    let mut smear: Vec<String> = Vec::new();
    let mut drums_measured = 0usize;
    for case in &scores.cases {
        let is_drums = matches!(case.entry.as_str(), "drums-attack" | "drums-top" | "clicks");
        for metric in &case.metrics {
            match (case.entry.as_str(), metric.name) {
                ("padchord", "mod_band_peak_db") => pad_mod.push(metric.value),
                (entry, "sine_sideband_db") if entry.starts_with("sine") => sideband.push(metric.value),
                _ => {}
            }
            if is_drums && metric.name == "attack_rise_ratio" {
                drums_measured += 1;
                if metric.value > thresholds::ATTACK_RISE_MAX {
                    smear.push(format!("{} x{} rise {:.2}", case.entry, case.ratio, metric.value));
                }
            }
            if is_drums && case.entry != "clicks" && metric.name == "attack_crest_ratio" && metric.value < thresholds::ATTACK_CREST_MIN {
                smear.push(format!("{} x{} crest {:.2}", case.entry, case.ratio, metric.value));
            }
        }
    }
    let max = |values: &[f64]| values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    println!("\n== Phase 0 pain gate ==");
    println!("padchord mod_band_peak_db (worst): {:.1} dB (gate: >= {} to prove the symptom)", max(&pad_mod), thresholds::BASELINE_PAD_MOD_MIN_DB);
    println!("sine sideband_db (worst):          {:.1} dB (gate: >= {})", max(&sideband), thresholds::BASELINE_SINE_SIDEBAND_MIN_DB);
    println!("percussive smear (rise > {} or crest < {}): {} of {} measurements", thresholds::ATTACK_RISE_MAX, thresholds::ATTACK_CREST_MIN, smear.len(), drums_measured);
    for line in &smear {
        println!("  smeared: {line}");
    }
    let pain_shown = max(&pad_mod) >= thresholds::BASELINE_PAD_MOD_MIN_DB && max(&sideband) >= thresholds::BASELINE_SINE_SIDEBAND_MIN_DB;
    let drums_good = smear.is_empty() && drums_measured > 0;
    println!("pain encoded (pads bad): {}", if pain_shown {"YES"} else {"NO — fix the metric, not the gate"});
    println!("drums preserved (no smear): {}", if drums_good {"YES — baseline is the committed yardstick"} else {"NO — investigate before trusting the yardstick"});
}

fn cmd_run() {
    let entries = load_corpus();
    let baseline = read_tsv(&snapshots_dir().join("baseline.tsv")).unwrap_or_else(|| panic!("no snapshots/baseline.tsv — run `judge baseline` first"));
    let best = read_tsv(&snapshots_dir().join("best.tsv"));
    println!("rendering stretch matrix ({} entries, adaptive tuning)...", entries.len());
    let scores = run_matrix(&entries, &Engine::Stretch(Tuning::adaptive()), true);
    for entry in &entries {
        let path = out_dir().join("sources").join(format!("{}.wav", entry.id));
        let _ = wav::write_32f(&path, entry.file_rate, &entry.left, &entry.right);
    }
    write(&out_dir().join("scores.json"), &scores.to_json());
    write(&out_dir().join("current.tsv"), &scores.to_tsv());
    let judgement = report::judge(&scores, &baseline, best.as_ref());
    println!("\n{}", judgement.report);
    if !judgement.improvements.is_empty() {
        println!("IMPROVED ({}):", judgement.improvements.len());
        for line in judgement.improvements.iter().take(20) {
            println!("  + {line}");
        }
    }
    if !judgement.regressions.is_empty() {
        println!("REGRESSED ({}):", judgement.regressions.len());
        for line in judgement.regressions.iter().take(20) {
            println!("  - {line}");
        }
    }
    if !judgement.guard_violations.is_empty() {
        println!("GUARD VIOLATIONS ({}):", judgement.guard_violations.len());
        for line in judgement.guard_violations.iter().take(20) {
            println!("  ! {line}");
        }
    }
    let verdict_text = match &judgement.verdict {
        report::Verdict::Improved => "IMPROVED".to_string(),
        report::Verdict::Mixed {..} => "MIXED".to_string(),
        report::Verdict::Regressed => "REGRESSED".to_string()
    };
    println!("\nVERDICT: {verdict_text}");
    write(&out_dir().join("verdict.txt"), &verdict_text);
}

fn cmd_accept() {
    let verdict = std::fs::read_to_string(out_dir().join("verdict.txt")).unwrap_or_default();
    if verdict.trim() != "IMPROVED" {
        println!("REFUSED: last run's verdict was '{}', accept requires IMPROVED", verdict.trim());
        std::process::exit(1);
    }
    let current = std::fs::read_to_string(out_dir().join("current.tsv")).unwrap_or_else(|error| panic!("no out/current.tsv — run `judge` first: {error}"));
    write(&snapshots_dir().join("best.tsv"), &current);
    println!("accepted: snapshots/best.tsv updated — commit it with the change that earned it");
}

fn cmd_listen() {
    let entries = load_corpus();
    let baseline = read_tsv(&snapshots_dir().join("baseline.tsv"));
    if baseline.is_none() {
        println!("note: no baseline snapshot yet");
    }
    let current_text = std::fs::read_to_string(out_dir().join("current.tsv"));
    if current_text.is_err() {
        println!("no out/current.tsv — run `judge` first");
        std::process::exit(1);
    }
    println!("rendering current for the playlist...");
    let scores = run_matrix(&entries, &Engine::Stretch(Tuning::default()), true);
    let worst = report::worst_cases(&scores, 8);
    let mut listen = String::from("# Listening playlist — worst target-metric cases first\n\nEach triple: source -> baseline -> current. Every phase-gate accept requires this by ear.\n\n");
    let mut playlist = String::new();
    for case in worst {
        let source_path = format!("sources/{}.wav", case.entry);
        let baseline_path = format!("baseline-v1/{}_x{}_{}.wav", case.entry, case.ratio, case.mode);
        let current_path = format!("stretch/{}_x{}_{}.wav", case.entry, case.ratio, case.mode);
        listen.push_str(&format!("- **{} x{} {}**: `{source_path}` -> `{baseline_path}` -> `{current_path}`\n", case.entry, case.ratio, case.mode));
        playlist.push_str(&format!("{source_path}\n{baseline_path}\n{current_path}\n"));
    }
    for entry in &entries {
        let path = out_dir().join("sources").join(format!("{}.wav", entry.id));
        let _ = wav::write_32f(&path, entry.file_rate, &entry.left, &entry.right);
    }
    write(&out_dir().join("LISTEN.md"), &listen);
    write(&out_dir().join("playlist.m3u"), &playlist);
    println!("wrote out/LISTEN.md + out/playlist.m3u");
}

fn cmd_annotate() {
    let mut skipped = Vec::new();
    let dir = corpus::samples_dir();
    let listing: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map(|read_dir| read_dir.filter_map(|item| item.ok().map(|item| item.path())).collect())
        .unwrap_or_default();
    for (prefix, id, _class) in corpus::FIXTURES {
        let Some(path) = listing.iter().find(|path| path.file_name().map(|name| name.to_string_lossy().starts_with(prefix)).unwrap_or(false)) else {
            skipped.push(format!("{id}: no file matching {prefix}*"));
            continue;
        };
        let data = match wav::read(path) {
            Ok(data) => data,
            Err(error) => {
                skipped.push(format!("{id}: {error}"));
                continue;
            }
        };
        let (left, right) = data.stereo();
        let mono = stretch_lab::metrics::envelope::mono(&left, &right);
        let onsets = stretch_lab::metrics::annotate::annotate(&mono, data.sample_rate);
        let mut text = String::from("# machine-generated by `judge annotate` — REVIEW BY EAR before trusting as ground truth\n");
        for onset in &onsets {
            text.push_str(&format!("{onset:.4}\n"));
        }
        let out_path = corpus::annotations_dir().join(format!("{id}.onsets.txt"));
        write(&out_path, &text);
        println!("{id}: {} onsets -> {}", onsets.len(), out_path.display());
    }
    for line in &skipped {
        println!("SKIPPED: {line}");
    }
}

/// Extract the string value of a top-level `"field": "..."` from a JSON blob (minimal, no dep — the
/// `.transients.json` shape is fixed).
fn json_string(json: &str, field: &str) -> Option<String> {
    let key = format!("\"{field}\"");
    let after = &json[json.find(&key)? + key.len()..];
    let after = &after[after.find(':')? + 1..];
    let start = after.find('"')? + 1;
    let rest = &after[start..];
    Some(rest[..rest.find('"')?].to_string())
}

/// Extract every marker's `"seconds"` value. In `.transients.json` only markers carry a `seconds` field.
fn json_marker_seconds(json: &str) -> Vec<f64> {
    let mut out = Vec::new();
    let mut rest = json;
    while let Some(pos) = rest.find("\"seconds\"") {
        rest = &rest[pos + "\"seconds\"".len()..];
        let Some(colon) = rest.find(':') else { break };
        let value = rest[colon + 1..].trim_start();
        let end = value.find(|c: char| !(c.is_ascii_digit() || matches!(c, '.' | '-' | '+' | 'e' | 'E'))).unwrap_or(value.len());
        if let Ok(parsed) = value[..end].parse::<f64>() {
            out.push(parsed);
        }
        rest = value;
    }
    out
}

/// `judge import <file.transients.json | dir>` — write hand-corrected Transient Lab labels into
/// `fixtures/<id>.onsets.txt` with a `# trusted:` header so they GATE the detector (unlike machine
/// `annotate` output). Maps each JSON to a fixture by matching its `"file"` against the fixture prefixes.
fn cmd_import() {
    let arg = std::env::args().nth(2).unwrap_or_else(|| {
        eprintln!("usage: judge import <file.transients.json | dir-of-them>");
        std::process::exit(1);
    });
    let path = PathBuf::from(&arg);
    let files: Vec<PathBuf> = if path.is_dir() {
        std::fs::read_dir(&path)
            .map(|read_dir| read_dir.filter_map(|item| item.ok().map(|item| item.path()))
                .filter(|path| path.to_string_lossy().ends_with(".transients.json")).collect())
            .unwrap_or_default()
    } else {
        vec![path]
    };
    if files.is_empty() {
        println!("no .transients.json files at {arg}");
        return;
    }
    for file in files {
        let json = match std::fs::read_to_string(&file) {
            Ok(text) => text,
            Err(error) => { println!("SKIPPED {}: {error}", file.display()); continue; }
        };
        let Some(wav_name) = json_string(&json, "file") else {
            println!("SKIPPED {}: no \"file\" field", file.display()); continue;
        };
        let Some((_, id, _)) = corpus::FIXTURES.iter().find(|(prefix, _, _)| wav_name.starts_with(prefix)) else {
            println!("SKIPPED {}: file '{wav_name}' matches no fixture prefix", file.display()); continue;
        };
        let mut seconds = json_marker_seconds(&json);
        seconds.sort_by(|a, b| a.partial_cmp(b).unwrap());
        seconds.dedup_by(|next, prev| (*next - *prev).abs() < 1e-6);
        if seconds.len() < 2 {
            println!("SKIPPED {}: fewer than 2 markers", file.display()); continue;
        }
        let mut text = String::from("# trusted: hand-corrected in the Transient Lab, imported via `judge import`\n");
        for onset in &seconds {
            text.push_str(&format!("{onset:.6}\n"));
        }
        let out_path = corpus::annotations_dir().join(format!("{id}.onsets.txt"));
        write(&out_path, &text);
        println!("{id}: imported {} onsets from {} -> {}", seconds.len(), file.display(), out_path.display());
    }
}

fn main() {
    let command = std::env::args().nth(1).unwrap_or_else(|| "run".into());
    match command.as_str() {
        "baseline" => cmd_baseline(),
        "run" => cmd_run(),
        "accept" => cmd_accept(),
        "listen" => cmd_listen(),
        "annotate" => cmd_annotate(),
        "import" => cmd_import(),
        other => {
            println!("unknown command '{other}' — use: baseline | run | accept | listen | annotate | import");
            std::process::exit(1);
        }
    }
}
