//! The judging corpus: synthetic probes generated from recipes (so the mathematically ideal
//! stretched output can be generated from the same recipe on the stretched timeline) plus the real
//! fixtures in `test-files/samples/`. Deterministic throughout (seeded xorshift for noise).
//!
//! The ideal-stretch convention: the macro timeline scales (envelope times, event positions), the
//! micro transient shape does not (a click keeps its 5 ms attack) — that asymmetry IS the musical
//! definition of good stretching.

use std::path::{Path, PathBuf};
use crate::render::ENGINE_RATE;
use crate::wav;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Class {
    Percussive,
    Sustained,
    Tonal,
    Mixed,
    Sine,
    Sweep
}

impl Class {
    pub fn label(&self) -> &'static str {
        match self {
            Class::Percussive => "percussive",
            Class::Sustained => "sustained",
            Class::Tonal => "tonal",
            Class::Mixed => "mixed",
            Class::Sine => "sine",
            Class::Sweep => "sweep"
        }
    }
}

pub struct Entry {
    pub id: String,
    pub class: Class,
    pub file_rate: f32,
    pub left: Vec<f32>,
    pub right: Vec<f32>,
    pub transients: Vec<f64>,
    /// Recipe positions are exact by construction; machine-annotated fixtures are NOT trusted
    /// until reviewed by ear — untrusted onsets must not gate (they measure annotation noise).
    pub trusted_onsets: bool,
    /// Sine probes carry their fundamental for the sideband metric.
    pub sine_f0: Option<f64>,
    /// Recipe-based entries can generate the perfect stretched output for any ratio.
    pub ideal: Option<Box<dyn Fn(f64) -> Vec<f32> + Send + Sync>>
}

impl Entry {
    pub fn duration_seconds(&self) -> f64 {
        self.left.len() as f64 / self.file_rate as f64
    }

    /// Median segment length in seconds — the expected baseline loop period driver.
    pub fn median_segment_seconds(&self) -> f64 {
        let mut lengths: Vec<f64> = Vec::new();
        for window in self.transients.windows(2) {
            lengths.push(window[1] - window[0]);
        }
        lengths.push(self.duration_seconds() - self.transients.last().copied().unwrap_or(0.0));
        lengths.sort_by(|a, b| a.partial_cmp(b).unwrap());
        lengths[lengths.len() / 2]
    }
}

struct XorShift(u64);

impl XorShift {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        ((self.0 >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0) as f32
    }
}

fn seconds(frames: f64) -> usize {
    (frames * ENGINE_RATE as f64).round() as usize
}

fn mono_entry(id: &str, class: Class, samples: Vec<f32>, transients: Vec<f64>, sine_f0: Option<f64>, ideal: Option<Box<dyn Fn(f64) -> Vec<f32> + Send + Sync>>) -> Entry {
    Entry {id: id.into(), class, file_rate: ENGINE_RATE, left: samples.clone(), right: samples, transients, trusted_onsets: true, sine_f0, ideal}
}

fn sine_wave(frequency: f64, duration: f64) -> Vec<f32> {
    let count = seconds(duration);
    (0..count).map(|index| (0.5 * (2.0 * std::f64::consts::PI * frequency * index as f64 / ENGINE_RATE as f64).sin()) as f32).collect()
}

fn sweep_wave(duration: f64) -> Vec<f32> {
    let count = seconds(duration);
    let (start_hz, end_hz) = (100.0f64, 4000.0f64);
    let octaves = (end_hz / start_hz).ln();
    let mut phase = 0.0f64;
    let mut samples = Vec::with_capacity(count);
    for index in 0..count {
        let t = index as f64 / count as f64;
        let frequency = start_hz * (octaves * t).exp();
        phase += 2.0 * std::f64::consts::PI * frequency / ENGINE_RATE as f64;
        samples.push((0.5 * phase.sin()) as f32);
    }
    samples
}

/// A detuned-partial minor chord under a slow envelope: the isolated pad symptom. The envelope's
/// macro times scale with the ratio in the ideal render; the partials do not.
fn padchord_wave(duration: f64) -> Vec<f32> {
    let count = seconds(duration);
    let notes = [220.0f64, 261.63, 329.63];
    let detune_cents = [3.0f64, -2.0, 1.0, -3.0, 2.0, -1.0, 3.0, -2.0, 1.0, -3.0, 2.0, -1.0];
    let attack = 0.2 * duration / 4.0;
    let release = 0.2 * duration / 4.0;
    let mut samples = vec![0.0f32; count];
    let mut voice_index = 0;
    for note in notes {
        for partial in 1..=4u32 {
            let cents = detune_cents[voice_index % detune_cents.len()];
            let frequency = note * partial as f64 * (2.0f64).powf(cents / 1200.0);
            let amplitude = 0.5 / (partial as f64 * notes.len() as f64);
            for (index, sample) in samples.iter_mut().enumerate() {
                let t = index as f64 / ENGINE_RATE as f64;
                let envelope = (t / attack).min(1.0).min(((duration - t) / release).max(0.0)).min(1.0);
                *sample += (amplitude * envelope * (2.0 * std::f64::consts::PI * frequency * t).sin()) as f32;
            }
            voice_index += 1;
        }
    }
    samples
}

/// A 1 kHz ping with a 5 ms exponential decay — the transient probe. Shape never scales.
fn click_at(samples: &mut [f32], position_seconds: f64) {
    let start = seconds(position_seconds);
    let length = seconds(0.030);
    for offset in 0..length {
        let index = start + offset;
        if index >= samples.len() {
            break;
        }
        let t = offset as f64 / ENGINE_RATE as f64;
        samples[index] += (0.9 * (-t / 0.005).exp() * (2.0 * std::f64::consts::PI * 1000.0 * t).sin()) as f32;
    }
}

fn clicks_wave(duration: f64, positions: &[f64]) -> Vec<f32> {
    let mut samples = vec![0.0f32; seconds(duration)];
    for &position in positions {
        click_at(&mut samples, position);
    }
    samples
}

/// White-noise bursts with a sharp attack; each burst re-seeds from its index so the burst content
/// is identical across ratios.
fn noiseburst_wave(duration: f64, positions: &[f64]) -> Vec<f32> {
    let mut samples = vec![0.0f32; seconds(duration)];
    for (burst_index, &position) in positions.iter().enumerate() {
        let mut noise = XorShift(0x9E3779B97F4A7C15u64.wrapping_add(burst_index as u64 * 0x2545F4914F6CDD1D));
        let start = seconds(position);
        let length = seconds(0.060);
        for offset in 0..length {
            let index = start + offset;
            if index >= samples.len() {
                break;
            }
            let t = offset as f64 / ENGINE_RATE as f64;
            let envelope = (t / 0.002).min(1.0) * (-t / 0.025).exp();
            samples[index] += (0.7 * envelope as f64 * noise.next() as f64) as f32;
        }
    }
    samples
}

pub fn synthetic_entries() -> Vec<Entry> {
    let grid = vec![0.0, 0.5, 1.0, 1.5];
    let mut entries = Vec::new();
    for frequency in [220.0f64, 440.0, 1000.0] {
        let id = format!("sine{}", frequency as u32);
        entries.push(mono_entry(&id, Class::Sine, sine_wave(frequency, 2.0), grid.clone(), Some(frequency),
            Some(Box::new(move |ratio| sine_wave(frequency, 2.0 * ratio)))));
    }
    entries.push(mono_entry("sweep", Class::Sweep, sweep_wave(2.0), grid.clone(), None,
        Some(Box::new(|ratio| sweep_wave(2.0 * ratio)))));
    entries.push(mono_entry("padchord", Class::Sustained, padchord_wave(4.0), vec![0.0, 1.0, 2.0, 3.0], None,
        Some(Box::new(|ratio| padchord_wave(4.0 * ratio)))));
    let click_grid = grid.clone();
    entries.push(mono_entry("clicks", Class::Percussive, clicks_wave(2.0, &click_grid), grid.clone(), None,
        Some(Box::new(move |ratio| {
            let positions: Vec<f64> = click_grid.iter().map(|&p| p * ratio).collect();
            clicks_wave(2.0 * ratio, &positions)
        }))));
    let burst_grid = grid.clone();
    entries.push(mono_entry("noiseburst", Class::Percussive, noiseburst_wave(2.0, &burst_grid), grid, None,
        Some(Box::new(move |ratio| {
            let positions: Vec<f64> = burst_grid.iter().map(|&p| p * ratio).collect();
            noiseburst_wave(2.0 * ratio, &positions)
        }))));
    entries
}

pub fn samples_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-files/samples")
}

pub fn annotations_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

/// (filename stem prefix used for matching, short id, class)
pub const FIXTURES: &[(&str, &str, Class)] = &[
    ("175_F_AttackHitLoop", "drums-attack", Class::Percussive),
    ("RK_Techno_Top_Loop1", "drums-top", Class::Percussive),
    ("332740__mseq__derelict-pad", "pad-derelict", Class::Sustained),
    ("861020__formaudioworks__fa_free_85_pad_loop_borealis", "pad-borealis", Class::Sustained),
    ("543732__nnaudio__alien-drone-sine-pad", "pad-drone", Class::Sustained),
    ("568315__valentinsosnitskiy__classical-loop-guitar", "guitar-chords", Class::Tonal),
    ("RK_DTC1_Dub_Chord", "dub-chords", Class::Tonal),
    ("TKNVLT_FREE_HT_STORY", "story", Class::Mixed)
];

pub fn read_onsets(path: &Path) -> Option<Vec<f64>> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut onsets: Vec<f64> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        onsets.push(trimmed.parse().ok()?);
    }
    onsets.sort_by(|a, b| a.partial_cmp(b).unwrap());
    Some(onsets)
}

/// Load the real fixtures. Missing files or annotations are reported in `skipped`, never silent.
pub fn fixture_entries(skipped: &mut Vec<String>) -> Vec<Entry> {
    let dir = samples_dir();
    let mut entries = Vec::new();
    let listing: Vec<PathBuf> = match std::fs::read_dir(&dir) {
        Ok(read_dir) => read_dir.filter_map(|item| item.ok().map(|item| item.path())).collect(),
        Err(error) => {
            skipped.push(format!("samples dir {}: {error}", dir.display()));
            return entries;
        }
    };
    for (prefix, id, class) in FIXTURES {
        let Some(path) = listing.iter().find(|path| {
            path.file_name().map(|name| name.to_string_lossy().starts_with(prefix)).unwrap_or(false)
        }) else {
            skipped.push(format!("fixture {id}: no file matching {prefix}* in {}", dir.display()));
            continue;
        };
        let data = match wav::read(path) {
            Ok(data) => data,
            Err(error) => {
                skipped.push(format!("fixture {id}: {error}"));
                continue;
            }
        };
        let onsets_path = annotations_dir().join(format!("{id}.onsets.txt"));
        let Some(transients) = read_onsets(&onsets_path) else {
            skipped.push(format!("fixture {id}: missing annotations {} (run `judge annotate`)", onsets_path.display()));
            continue;
        };
        if transients.len() < 2 {
            skipped.push(format!("fixture {id}: fewer than 2 annotated onsets"));
            continue;
        }
        let (left, right) = data.stereo();
        entries.push(Entry {id: (*id).into(), class: *class, file_rate: data.sample_rate, left, right, transients, trusted_onsets: false, sine_f0: None, ideal: None});
    }
    entries
}

/// The GATED quality band: nobody rides a stretcher past ~25%, so quality is judged where music
/// lives. Extremes render for information only.
pub const RATIOS: &[f64] = &[0.8, 0.9, 1.1, 1.25];
pub const EXTREME_RATIOS: &[f64] = &[1.5, 2.0, 4.0];
