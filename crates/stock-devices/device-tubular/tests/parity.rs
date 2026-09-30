//! Sample-exact parity with Dexed's engine: every bundled cartridge voice and the host-layer edge cases
//! (chords, stealing, retrigger, mono legato, velocity / pitch edges, transpose wrap, tune, LFO waves, fixed
//! mode, key scaling, other sample rates, release tails) hash to a render of Dexed's own msfa engine driven
//! by a verbatim copy of the plugin's voice allocation (Dexed commit 2e182b3d, 2026-09-25). The output
//! filter is float DSP whose libm differs by an ulp, so its two cases compare with a tolerance.
//! `parity.txt` lines: label|file|voice|sr|frames|args|fnv1a64|peak, FNV-1a over the f32 sample bytes.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use device_tubular::harness::{fnv1a64, parse_note, render_case, Note};

fn cartridges_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/app/studio/public/tubular/cartridges")
}

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn split_args(args: &str) -> (Vec<(String, String)>, Vec<Note>) {
    let mut settings = Vec::new();
    let mut notes = Vec::new();
    for argument in args.split_whitespace() {
        match argument.split_once('=') {
            Some((key, value)) => settings.push((key.to_string(), value.to_string())),
            None => notes.push(parse_note(argument))
        }
    }
    (settings, notes)
}

fn render_line(file: &str, voice: usize, sample_rate: f32, frames: usize, args: &str) -> Vec<f32> {
    let bank = fs::read(cartridges_dir().join(file)).unwrap_or_else(|error| panic!("cartridge {file}: {error}"));
    let (settings, notes) = split_args(args);
    let borrowed: Vec<(&str, &str)> = settings.iter().map(|(key, value)| (key.as_str(), value.as_str())).collect();
    render_case(&bank, voice, sample_rate, frames, &borrowed, &notes)
}

#[test]
fn every_exact_case_hashes_to_the_dexed_render() {
    let manifest = fs::read_to_string(fixtures_dir().join("parity.txt")).expect("tests/fixtures/parity.txt");
    let mut banks: HashMap<String, Vec<u8>> = HashMap::new();
    let mut failures: Vec<String> = Vec::new();
    let mut count = 0;
    for line in manifest.lines().filter(|line| !line.trim().is_empty()) {
        let fields: Vec<&str> = line.split('|').collect();
        assert_eq!(fields.len(), 8, "manifest line: {line}");
        let (label, file, voice, sample_rate, frames, args, hash, peak) = (
            fields[0], fields[1], fields[2].parse::<usize>().unwrap(), fields[3].parse::<f32>().unwrap(),
            fields[4].parse::<usize>().unwrap(), fields[5], u64::from_str_radix(fields[6], 16).unwrap(), fields[7].parse::<f32>().unwrap()
        );
        let bank = banks.entry(file.to_string()).or_insert_with(|| fs::read(cartridges_dir().join(file)).expect(file)).clone();
        let (settings, notes) = split_args(args);
        let borrowed: Vec<(&str, &str)> = settings.iter().map(|(key, value)| (key.as_str(), value.as_str())).collect();
        let samples = render_case(&bank, voice, sample_rate, frames, &borrowed, &notes);
        let rendered_peak = samples.iter().fold(0.0f32, |acc, value| acc.max(value.abs()));
        if fnv1a64(&samples) != hash {
            failures.push(format!("{label}: hash mismatch (peak {rendered_peak:.6} vs Dexed {peak:.6})"));
        }
        count += 1;
    }
    assert!(count > 1000, "manifest holds the cartridge battery, got {count} cases");
    assert!(failures.is_empty(), "{} of {count} cases diverge from Dexed:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn the_output_filter_matches_within_an_ulp() {
    for (label, args) in [
        ("filter", "cutoff=0.3 reso=0.5 60,100,0,4096"),
        ("filter-hot", "cutoff=0.8 reso=0.95 48,127,0,4096 55,127,0,4096")
    ] {
        let reference = fs::read(fixtures_dir().join(format!("{label}.f32"))).expect(label);
        let expected: Vec<f32> = reference.chunks(4).map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])).collect();
        let samples = render_line("Dexed_01.syx", 13, 48000.0, expected.len(), args);
        let max_diff = samples.iter().zip(&expected).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(max_diff <= 1.0e-6, "{label}: max diff {max_diff:e}");
    }
}
