
use dsp::ppqn::{samples_to_pulses, seconds_to_pulses};
use stretch::{Analyzer, BlockInfo, Source, StretchConfig, Stretcher, TransientPlayMode, Tuning};
use stretch_lab::corpus;
use stretch_lab::metrics::envelope::rms;
use stretch_lab::render::{BPM, ENGINE_RATE};

fn main() {
    let mut skipped = Vec::new();
    let entries = corpus::fixture_entries(&mut skipped);
    let entry = entries.iter().find(|entry| entry.id == "pad-derelict").unwrap();
    let markers = Analyzer::default().describe(&entry.left, &entry.right, entry.file_rate, &entry.transients);
    let ratio = 1.5;
    let source_seconds = entry.left.len() as f64 / entry.file_rate as f64;
    let end_ppqn = seconds_to_pulses(source_seconds * ratio, BPM);
    let warp = vec![(0.0, 0.0), (end_ppqn, source_seconds)];
    let config = StretchConfig {warp: &warp, transient_play_mode: TransientPlayMode::Repeat, playback_rate: 1.0};
    let output_frames = (source_seconds * ratio * ENGINE_RATE as f64).round() as usize;
    let padded = output_frames.div_ceil(128) * 128;
    let mut out_left = vec![0.0f32; padded];
    let mut out_right = vec![0.0f32; padded];
    let mut stretcher = Stretcher::with_tuning(Tuning::adaptive());
    let fading_gain = [1.0f32; 128];
    let source = Source {left: &entry.left, right: &entry.right, num_frames: entry.left.len()};
    let mut last_report = 0usize;
    for block_index in 0..padded / 128 {
        let start = block_index * 128;
        let p0 = samples_to_pulses(start as f64, BPM, ENGINE_RATE);
        let p1 = samples_to_pulses((start + 128) as f64, BPM, ENGINE_RATE);
        let block = BlockInfo {p0, p1, s0: start as u32, s1: (start + 128) as u32, bpm: BPM, discontinuous: false};
        stretcher.process(&mut out_left, &mut out_right, &source, entry.file_rate, &markers, &config, 0.0, &block, 0.0, p0, p1, &fading_gain, ENGINE_RATE);
        if start >= last_report + 12000 {
            last_report = start;
            let slice_rms = rms(&out_left[start.saturating_sub(12000)..start]);
            println!("t={:>5.2}s voices={} rms={:.4}", start as f64 / ENGINE_RATE as f64, stretcher.voice_count(), slice_rms);
        }
    }
}
