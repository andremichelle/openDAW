//! The three behavioral tests ported from `engine/src/time_stretch.rs`, driving the slice API with
//! `Tuning::legacy()`. Full sample-for-sample parity against the frozen baseline lives in
//! `stretch-lab/tests` (golden-buffer test); these guard the port's basic behaviors standalone.

use stretch::{BlockInfo, Source, StretchConfig, Stretcher, TransientDescriptor, TransientPlayMode, Tuning};

fn playing_block() -> BlockInfo {
    BlockInfo {p0: 0.0, p1: 240.0, s0: 0, s1: 64, bpm: 120.0, discontinuous: false}
}

#[test]
fn a_time_stretch_segment_is_audible() {
    let source: Vec<f32> = vec![1.0; 48_000];
    let markers = TransientDescriptor::bare_all(&[0.0, 0.5]);
    let warp = [(0.0, 0.0), (3840.0, 1.0)];
    let config = StretchConfig {warp: &warp, transient_play_mode: TransientPlayMode::Once, playback_rate: 1.0};
    let mut stretcher = Stretcher::with_tuning(Tuning::legacy());
    let mut out_left = vec![0.0f32; 128];
    let mut out_right = vec![0.0f32; 128];
    let fading_gain = [1.0f32; 128];
    let block = playing_block();
    let src = Source {left: &source, right: &source, num_frames: source.len()};
    stretcher.process(&mut out_left, &mut out_right, &src, 48_000.0, &markers, &config, 0.0, &block, 0.0, 0.0, 240.0, &fading_gain, 48_000.0);
    assert!(stretcher.voice_count() >= 1, "a voice spawned at the transient boundary");
    let peak = (0..64).map(|index| out_left[index].abs()).fold(0.0f32, f32::max);
    assert!(peak > 0.5, "the time-stretch segment is audible (peak {peak})");
}

#[test]
fn starting_in_a_silent_gap_stays_silent_no_phrase_replay() {
    let mut source: Vec<f32> = vec![0.0; 48_000];
    for frame in source.iter_mut().take(24_000) {*frame = 1.0;}
    let markers = TransientDescriptor::bare_all(&[0.0, 0.5]);
    let warp = [(0.0, 0.6), (3840.0, 1.0)];
    let config = StretchConfig {warp: &warp, transient_play_mode: TransientPlayMode::Once, playback_rate: 1.0};
    let mut stretcher = Stretcher::with_tuning(Tuning::legacy());
    let mut out_left = vec![0.0f32; 128];
    let mut out_right = vec![0.0f32; 128];
    let fading_gain = [1.0f32; 128];
    let block = playing_block();
    let src = Source {left: &source, right: &source, num_frames: source.len()};
    stretcher.process(&mut out_left, &mut out_right, &src, 48_000.0, &markers, &config, 0.0, &block, 0.0, 0.0, 240.0, &fading_gain, 48_000.0);
    let peak = (0..64).map(|index| out_left[index].abs()).fold(0.0f32, f32::max);
    assert!(peak < 1e-6, "starting inside the silent gap plays silence, not a replayed phrase (peak {peak})");
}

#[test]
fn out_of_warp_range_renders_nothing() {
    let source: Vec<f32> = vec![1.0; 48_000];
    let markers = TransientDescriptor::bare_all(&[0.0, 0.5]);
    let warp = [(0.0, 0.0), (10.0, 1.0)];
    let config = StretchConfig {warp: &warp, transient_play_mode: TransientPlayMode::Once, playback_rate: 1.0};
    let mut stretcher = Stretcher::with_tuning(Tuning::legacy());
    let mut out_left = vec![0.0f32; 128];
    let mut out_right = vec![0.0f32; 128];
    let fading_gain = [1.0f32; 128];
    let block = BlockInfo {p0: 100.0, p1: 340.0, s0: 0, s1: 64, bpm: 120.0, discontinuous: false};
    let src = Source {left: &source, right: &source, num_frames: source.len()};
    stretcher.process(&mut out_left, &mut out_right, &src, 48_000.0, &markers, &config, 0.0, &block, 100.0, 100.0, 340.0, &fading_gain, 48_000.0);
    assert_eq!(out_left[0], 0.0, "content past the warp range is silent");
}
