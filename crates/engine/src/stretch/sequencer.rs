//! `ComplexStretchSequencer`: the real-time engine wrapper that drives the ported `ComplexStretch` from a
//! region's warp map, the COMPLEX-HQ counterpart to the granular `TimeStretchSequencer`. One lives per
//! playing region (persistent across blocks, keyed by region uuid in the player). Where the granular
//! sequencer re-triggers transient segments, this streams the source through the STFT stretcher, mapping
//! each block's OUTPUT pulse span to a SOURCE-sample span via the warp markers so tempo (and tempo
//! automation) drive the stretch ratio live, with pitch handled independently by the stretcher's transpose.
//!
//! Warp model (identical to the granular path and the offline HQ render): the warp markers are
//! `(content-ppqn, source-seconds)` anchors; `ppqn_to_seconds` interpolates them. The playback-rate
//! multiplier becomes a semitone transpose (pitch preserved across the time-stretch), NOT a faster read.
//!
//! Sample-rate: the stretcher is fed SOURCE samples and pulls ENGINE samples; when the file and engine
//! rates differ the resulting ratio is folded into the stretch, which (preserving pitch) yields correct-rate
//! output — implicit resampling, no separate SRC stage.
//!
//! KNOWN LIMITATION (documented, not yet addressed): STFT stretching is inherently latent (~one block),
//! and the engine has no per-region delay compensation yet, so COMPLEX playback lags the granular/native
//! modes by roughly `BLOCK_SAMPLES` samples. Fine for auditioning; a PDC pass is future work.

use alloc::vec::Vec;
use engine_env::audio_buffer::AudioBuffer;
use engine_env::block::Block;
use crate::time_stretch::{ppqn_to_seconds, Source};
use super::ComplexStretch;

// A moderate real-time block: ~43ms latency at 48k, a balance of quality vs. responsiveness. (Upstream's
// default preset is larger/higher-quality but too latent for live playback.)
const BLOCK_SAMPLES: usize = 2048;
const INTERVAL_SAMPLES: usize = 512;

pub(crate) struct ComplexStretchSequencer {
    stretch: ComplexStretch,
    configured_rate: f32, // engine rate the stretcher was configured for (0.0 = not yet configured)
    read_samples: f64,    // current SOURCE read position (source samples); advances by the consumed count
    last_semitones: f32,
    needs_seek: bool,
    input_left: Vec<f32>,
    input_right: Vec<f32>,
    output_left: Vec<f32>,
    output_right: Vec<f32>
}

impl ComplexStretchSequencer {
    pub(crate) fn new() -> Self {
        Self {
            stretch: ComplexStretch::new(), configured_rate: 0.0, read_samples: 0.0, last_semitones: 0.0,
            needs_seek: true, input_left: Vec::new(), input_right: Vec::new(), output_left: Vec::new(),
            output_right: Vec::new()
        }
    }

    /// Configure the stretcher for `engine_rate` up front (at pool pre-warm / reconcile) so the first render
    /// of a COMPLEX region never allocates the STFT buffers mid-quantum.
    pub(crate) fn prewarm(&mut self, engine_rate: f32) {
        if self.configured_rate != engine_rate {
            self.stretch.configure(2, BLOCK_SAMPLES, INTERVAL_SAMPLES);
            self.configured_rate = engine_rate;
            self.last_semitones = f32::NAN;
            self.needs_seek = true;
        }
    }

    /// Reset the stream state so the next `process` re-seeks from the warp map (region (re)entry, loop wrap,
    /// transport jump).
    pub(crate) fn reset(&mut self) {
        self.needs_seek = true;
    }

    /// Hard-clear for POOL reuse by another region: also drop the stretcher's internal STFT state.
    pub(crate) fn recycle(&mut self) {
        if self.configured_rate > 0.0 {
            self.stretch.reset();
        }
        self.needs_seek = true;
        self.read_samples = 0.0;
    }

    /// Render one loop cycle of a COMPLEX time-stretch region, summing into `output`. Mirrors the granular
    /// sequencer's per-cycle contract: `warp` are the region's `(content-ppqn, source-seconds)` markers,
    /// `playback_rate` the pitch multiplier, `fading_gain` the region fade for this cycle indexed by
    /// within-cycle sample, `file_rate`/`engine_rate` the source and output rates.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn process(
        &mut self,
        output: &mut AudioBuffer,
        source: &Source,
        file_rate: f32,
        warp: &[(f64, f64)],
        playback_rate: f32,
        waveform_offset: f64,
        block: &Block,
        cycle_raw_start: f64,
        cycle_result_start: f64,
        cycle_result_end: f64,
        fading_gain: &[f32],
        engine_rate: f32
    ) {
        if warp.len() < 2 {
            return;
        }
        if self.configured_rate != engine_rate {
            self.stretch.configure(2, BLOCK_SAMPLES, INTERVAL_SAMPLES);
            self.configured_rate = engine_rate;
            self.last_semitones = f32::NAN;
            self.needs_seek = true;
        }
        let semitones = math::log2(playback_rate.max(1e-6) as f64) as f32 * 12.0;
        if semitones != self.last_semitones {
            self.stretch.set_transpose_semitones(semitones, 0.0);
            self.last_semitones = semitones;
        }
        if block.flags.discontinuous() {
            self.needs_seek = true;
        }
        let pulse_span = block.p1 - block.p0;
        let sample_span = (block.s1 - block.s0) as f64;
        if pulse_span <= 0.0 {
            return;
        }
        let r0 = (cycle_result_start - block.p0) / pulse_span;
        let r1 = (cycle_result_end - block.p0) / pulse_span;
        let buffer_start = (block.s0 as f64 + sample_span * r0) as usize;
        let buffer_end = (block.s0 as f64 + sample_span * r1) as usize;
        let buffer_count = buffer_end.saturating_sub(buffer_start);
        if buffer_count == 0 {
            return;
        }
        let (first_pos, last_pos) = (warp[0].0, warp[warp.len() - 1].0);
        let content_ppqn = cycle_result_start - cycle_raw_start;
        if content_ppqn < first_pos || content_ppqn >= last_pos {
            return;
        }
        let content_ppqn_end = content_ppqn + (cycle_result_end - cycle_result_start);
        let file_seconds_start = match ppqn_to_seconds(warp, content_ppqn) {
            Some(seconds) => seconds + waveform_offset,
            None => return
        };
        let file_seconds_end = match ppqn_to_seconds(warp, content_ppqn_end.min(last_pos)) {
            Some(seconds) => seconds + waveform_offset,
            None => return
        };
        let source_span_seconds = (file_seconds_end - file_seconds_start).max(0.0);
        let input_count = math::round(source_span_seconds * file_rate as f64) as usize;
        if self.needs_seek {
            self.seek_to(source, file_seconds_start * file_rate as f64);
            self.needs_seek = false;
        }
        self.render(source, input_count, buffer_count);
        let out_left = &mut output.left;
        let out_right = &mut output.right;
        for index in 0..buffer_count {
            let gain = fading_gain.get(index).copied().unwrap_or(1.0);
            let destination = buffer_start + index;
            out_left[destination] += self.output_left[index] * gain;
            out_right[destination] += self.output_right[index] * gain;
        }
        self.read_samples += input_count as f64;
    }

    /// Reposition the stream to `read_position` source samples, feeding the stretcher `seek_length` frames of
    /// pre-roll ending there so the next output aligns without a discontinuity click.
    fn seek_to(&mut self, source: &Source, read_position: f64) {
        self.stretch.reset();
        let start = math::round(read_position).max(0.0);
        self.read_samples = start;
        let seek_length = self.stretch.seek_length();
        self.fill_input_window(source, start - seek_length as f64, seek_length);
        let inputs: [&[f32]; 2] = [&self.input_left, &self.input_right];
        self.stretch.seek(&inputs, seek_length, 1.0);
    }

    /// Consume `input_count` source samples (the window starting at `read_samples`) into `output_count`
    /// output samples via the stretcher.
    fn render(&mut self, source: &Source, input_count: usize, output_count: usize) {
        self.fill_input_window(source, self.read_samples, input_count);
        self.output_left.clear();
        self.output_left.resize(output_count, 0.0);
        self.output_right.clear();
        self.output_right.resize(output_count, 0.0);
        let inputs: [&[f32]; 2] = [&self.input_left, &self.input_right];
        // split the two owned output vecs into the &mut slice pair the stretcher wants
        let mut left = core::mem::take(&mut self.output_left);
        let mut right = core::mem::take(&mut self.output_right);
        {
            let mut outputs: [&mut [f32]; 2] = [&mut left, &mut right];
            self.stretch.process(Some(&inputs), input_count, &mut outputs, output_count);
        }
        self.output_left = left;
        self.output_right = right;
    }

    /// Copy `count` source frames starting at (possibly negative / out-of-range) `start` into the input
    /// buffers, zero-padding outside `[0, num_frames)`.
    fn fill_input_window(&mut self, source: &Source, start: f64, count: usize) {
        self.input_left.clear();
        self.input_left.resize(count, 0.0);
        self.input_right.clear();
        self.input_right.resize(count, 0.0);
        let base = math::round(start) as i64;
        let frames = source.num_frames as i64;
        for index in 0..count as i64 {
            let source_index = base + index;
            if source_index >= 0 && source_index < frames {
                let position = source_index as usize;
                self.input_left[index as usize] = source.left[position];
                self.input_right[index as usize] = source.right[position];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    use engine_env::block_flags::BlockFlags;

    fn make_block(index: u32, discontinuous: bool, p0: f64, p1: f64, s0: u32, s1: u32) -> Block {
        Block {index, flags: BlockFlags::create(true, discontinuous, true, false), p0, p1, s0, s1, bpm: 120.0}
    }

    #[test]
    fn unit_stretch_is_audible_and_pitch_preserving() {
        // A 1:1 warp: content 0..3840 ppqn (one bar at 120bpm = 2.0s) maps to 0..2.0s of source. Render a
        // stream of 128-sample blocks and confirm the middle (past the STFT latency) carries the source tone.
        let file_rate = 48_000.0f32;
        let engine_rate = 48_000.0f32;
        let freq = 220.0f32;
        let frames = 96_000usize; // 2.0s
        let source_data: vec::Vec<f32> = (0..frames)
            .map(|index| math::sin(index as f32 / file_rate * freq * math::TAU) * 0.5)
            .collect();
        let source = Source {left: &source_data, right: &source_data, num_frames: frames};
        let warp = [(0.0, 0.0), (3840.0, 2.0)];
        let fading_gain = [1.0f32; 128];
        let mut sequencer = ComplexStretchSequencer::new();
        // one bar (3840 ppqn) over 2.0s at 48k = 96000 output samples = 750 blocks of 128
        let blocks = 750usize;
        let ppqn_per_block = 3840.0 / blocks as f64;
        let mut captured: vec::Vec<f32> = vec::Vec::with_capacity(blocks * 128);
        for block_index in 0..blocks {
            let p0 = block_index as f64 * ppqn_per_block;
            let p1 = p0 + ppqn_per_block;
            let block = make_block(block_index as u32, block_index == 0, p0, p1, 0, 128);
            let mut output = AudioBuffer::new();
            sequencer.process(&mut output, &source, file_rate, &warp, 1.0, 0.0, &block, 0.0, p0, p1, &fading_gain, engine_rate);
            for index in 0..128 {
                captured.push(output.left[index]);
            }
        }
        // steady-state middle, past latency
        let middle = &captured[24_000..72_000];
        let peak = middle.iter().fold(0.0f32, |acc, value| acc.max(value.abs()));
        assert!(peak > 0.2, "complex stretch output is audible (peak {peak})");
        let mut crossings = 0usize;
        for index in 1..middle.len() {
            if middle[index - 1] < 0.0 && middle[index] >= 0.0 {
                crossings += 1;
            }
        }
        let measured_freq = crossings as f32 / (middle.len() as f32 / engine_rate);
        assert!((measured_freq - freq).abs() / freq < 0.08, "pitch preserved: {measured_freq} vs {freq}");
    }

    #[test]
    fn stretched_warp_preserves_pitch() {
        // A 2x SLOWDOWN: one bar (3840 ppqn = 2.0s output at 120bpm) maps to only 1.0s of source, so the
        // stretcher plays 1.0s of source over 2.0s of output. Pitch must still be preserved.
        let file_rate = 48_000.0f32;
        let engine_rate = 48_000.0f32;
        let freq = 330.0f32;
        let frames = 48_000usize; // 1.0s of source
        let source_data: vec::Vec<f32> = (0..frames)
            .map(|index| math::sin(index as f32 / file_rate * freq * math::TAU) * 0.5)
            .collect();
        let source = Source {left: &source_data, right: &source_data, num_frames: frames};
        let warp = [(0.0, 0.0), (3840.0, 1.0)];
        let fading_gain = [1.0f32; 128];
        let mut sequencer = ComplexStretchSequencer::new();
        let blocks = 750usize; // 2.0s of output at 48k / 128
        let ppqn_per_block = 3840.0 / blocks as f64;
        let mut captured: vec::Vec<f32> = vec::Vec::with_capacity(blocks * 128);
        for block_index in 0..blocks {
            let p0 = block_index as f64 * ppqn_per_block;
            let p1 = p0 + ppqn_per_block;
            let block = make_block(block_index as u32, block_index == 0, p0, p1, 0, 128);
            let mut output = AudioBuffer::new();
            sequencer.process(&mut output, &source, file_rate, &warp, 1.0, 0.0, &block, 0.0, p0, p1, &fading_gain, engine_rate);
            for index in 0..128 {
                captured.push(output.left[index]);
            }
        }
        let middle = &captured[24_000..72_000];
        let peak = middle.iter().fold(0.0f32, |acc, value| acc.max(value.abs()));
        assert!(peak > 0.2, "2x-stretched output is audible (peak {peak})");
        let mut crossings = 0usize;
        for index in 1..middle.len() {
            if middle[index - 1] < 0.0 && middle[index] >= 0.0 {
                crossings += 1;
            }
        }
        let measured_freq = crossings as f32 / (middle.len() as f32 / engine_rate);
        assert!((measured_freq - freq).abs() / freq < 0.08, "pitch preserved under 2x stretch: {measured_freq} vs {freq}");
    }

    #[test]
    fn out_of_warp_range_is_silent() {
        let source_data = vec![0.5f32; 48_000];
        let source = Source {left: &source_data, right: &source_data, num_frames: 48_000};
        let warp = [(0.0, 0.0), (100.0, 1.0)];
        let fading_gain = [1.0f32; 128];
        let mut sequencer = ComplexStretchSequencer::new();
        // content 200 ppqn is past the last warp marker (100) -> silent
        let block = make_block(0, true, 200.0, 240.0, 0, 128);
        let mut output = AudioBuffer::new();
        sequencer.process(&mut output, &source, 48_000.0, &warp, 1.0, 0.0, &block, 0.0, 200.0, 240.0, &fading_gain, 48_000.0);
        let peak = (0..128).map(|index| output.left[index].abs()).fold(0.0f32, f32::max);
        assert_eq!(peak, 0.0, "content past the warp range is silent");
    }
}
