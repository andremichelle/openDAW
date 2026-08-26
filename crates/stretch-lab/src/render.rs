//! The deterministic offline render driver: given a source, its transients, a stretch ratio and a
//! play mode, it renders through either the FROZEN baseline sequencer or the `stretch` crate using
//! the exact block mechanics of `audio_region_player.rs` — a uniform warp at 120 BPM (the ratio
//! encoded in the warp end), 128-frame blocks, exact expected output length. No clocks, no threads,
//! no randomness: same inputs, same samples, forever.

use engine_env::audio_buffer::AudioBuffer;
use engine_env::block::Block;
use engine_env::block_flags::BlockFlags;
use engine_env::RENDER_QUANTUM;
use dsp::ppqn::{samples_to_pulses, seconds_to_pulses};
use stretch::{BlockInfo, Stretcher, StretchConfig, TransientDescriptor, Tuning};
use crate::baseline::time_stretch_v1 as v1;

pub const ENGINE_RATE: f32 = 48_000.0;
pub const BPM: f32 = 120.0;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PlayMode {
    Once,
    Repeat,
    Pingpong
}

impl PlayMode {
    pub fn label(&self) -> &'static str {
        match self {
            PlayMode::Once => "once",
            PlayMode::Repeat => "repeat",
            PlayMode::Pingpong => "pingpong"
        }
    }

    fn v1(&self) -> v1::TransientPlayMode {
        match self {
            PlayMode::Once => v1::TransientPlayMode::Once,
            PlayMode::Repeat => v1::TransientPlayMode::Repeat,
            PlayMode::Pingpong => v1::TransientPlayMode::Pingpong
        }
    }

    fn v2(&self) -> stretch::TransientPlayMode {
        match self {
            PlayMode::Once => stretch::TransientPlayMode::Once,
            PlayMode::Repeat => stretch::TransientPlayMode::Repeat,
            PlayMode::Pingpong => stretch::TransientPlayMode::Pingpong
        }
    }
}

pub struct RenderSpec<'a> {
    pub left: &'a [f32],
    pub right: &'a [f32],
    pub file_rate: f32,
    pub transients: &'a [f64],
    /// Output duration / source duration: 2.0 = twice as long.
    pub ratio: f64,
    pub mode: PlayMode
}

impl RenderSpec<'_> {
    pub fn source_seconds(&self) -> f64 {
        self.left.len() as f64 / self.file_rate as f64
    }

    pub fn output_frames(&self) -> usize {
        (self.source_seconds() * self.ratio * ENGINE_RATE as f64).round() as usize
    }

    /// The uniform warp: the whole source spread over `source_seconds * ratio` of output timeline.
    pub fn warp(&self) -> Vec<(f64, f64)> {
        let source_seconds = self.source_seconds();
        let end_ppqn = seconds_to_pulses(source_seconds * self.ratio, BPM);
        vec![(0.0, 0.0), (end_ppqn, source_seconds)]
    }

    /// Where a source event at `seconds` lands on the output timeline, in seconds.
    pub fn map_time(&self, source_seconds: f64) -> f64 {
        source_seconds * self.ratio
    }
}

fn padded_len(frames: usize) -> usize {
    frames.div_ceil(RENDER_QUANTUM) * RENDER_QUANTUM
}

pub fn render_baseline(spec: &RenderSpec) -> (Vec<f32>, Vec<f32>) {
    let warp = spec.warp();
    let config = v1::TimeStretchConfig {warp: warp.clone(), transient_play_mode: spec.mode.v1(), playback_rate: 1.0};
    let output_frames = spec.output_frames();
    let padded = padded_len(output_frames);
    let mut out_left = vec![0.0f32; padded];
    let mut out_right = vec![0.0f32; padded];
    let mut sequencer = v1::TimeStretchSequencer::new();
    let mut buffer = AudioBuffer::new();
    let fading_gain = [1.0f32; RENDER_QUANTUM];
    let source = v1::Source {left: spec.left, right: spec.right, num_frames: spec.left.len()};
    let flags = BlockFlags::create(true, false, true, false);
    for block_index in 0..padded / RENDER_QUANTUM {
        let start = block_index * RENDER_QUANTUM;
        let p0 = samples_to_pulses(start as f64, BPM, ENGINE_RATE);
        let p1 = samples_to_pulses((start + RENDER_QUANTUM) as f64, BPM, ENGINE_RATE);
        let block = Block {index: block_index as u32, flags, p0, p1, s0: 0, s1: RENDER_QUANTUM as u32, bpm: BPM};
        buffer.clear();
        sequencer.process(&mut buffer, &source, spec.file_rate, spec.transients, &config, 0.0, &block, 0.0, p0, p1, &fading_gain, ENGINE_RATE);
        out_left[start..start + RENDER_QUANTUM].copy_from_slice(&buffer.left);
        out_right[start..start + RENDER_QUANTUM].copy_from_slice(&buffer.right);
    }
    out_left.truncate(output_frames);
    out_right.truncate(output_frames);
    (out_left, out_right)
}

pub fn render_stretch(spec: &RenderSpec, markers: &[TransientDescriptor], tuning: Tuning) -> (Vec<f32>, Vec<f32>) {
    let warp = spec.warp();
    let config = StretchConfig {warp: &warp, transient_play_mode: spec.mode.v2(), playback_rate: 1.0};
    let output_frames = spec.output_frames();
    let padded = padded_len(output_frames);
    let mut out_left = vec![0.0f32; padded];
    let mut out_right = vec![0.0f32; padded];
    let mut stretcher = Stretcher::with_tuning(tuning);
    let fading_gain = [1.0f32; RENDER_QUANTUM];
    let source = stretch::Source {left: spec.left, right: spec.right, num_frames: spec.left.len()};
    for block_index in 0..padded / RENDER_QUANTUM {
        let start = block_index * RENDER_QUANTUM;
        let p0 = samples_to_pulses(start as f64, BPM, ENGINE_RATE);
        let p1 = samples_to_pulses((start + RENDER_QUANTUM) as f64, BPM, ENGINE_RATE);
        let block = BlockInfo {p0, p1, s0: start as u32, s1: (start + RENDER_QUANTUM) as u32, bpm: BPM, discontinuous: false};
        stretcher.process(&mut out_left, &mut out_right, &source, spec.file_rate, markers, &config, 0.0, &block, 0.0, p0, p1, &fading_gain, ENGINE_RATE);
    }
    out_left.truncate(output_frames);
    out_right.truncate(output_frames);
    (out_left, out_right)
}
