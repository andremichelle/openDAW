//! The audio-region player: an engine-side processor (the AUDIO-track analog of the note `NoteSequencer`) that
//! turns an audio unit's `TrackType.Audio` regions into sound. It IS the unit's source — per quantum it clears
//! its output, then for each enabled audio track range-queries its sorted `AudioRegion` collection, resolves
//! each region's source sample, and renders it NO-STRETCH (native pitch, the basic Tape play-mode):
//!
//! - a read head whose SOURCE frame is recomputed from the ABSOLUTE transport each block
//!   (`(elapsedSeconds + waveformOffset) * sourceRate`), so it is stateless -> drift-free and never reads a
//!   wrong transient at a mid-file start (the TS "breathless pop");
//! - linear interpolation when the source / engine sample rates differ;
//! - scaled by the region gain and ONE slope-shaped fade envelope (the `lib-dsp` `FadingEnvelope`), applied a
//!   single time -- never the doubled voice x clip fade product the TS app hit.
//!
//! Time-stretch, pitch/warp, and clip sequencing (the advanced Tape play-modes) are not ported; this is the
//! basic timeline audio playback. Voices/anti-click-on-seek are unnecessary because the read is stateless.

use dsp::ppqn::pulses_to_seconds;
use engine_env::audio_buffer::{shared_audio_buffer, AudioBuffer, SharedAudioBuffer};
use engine_env::audio_generator::AudioGenerator;
use engine_env::block::Block;
use engine_env::event_buffer::EventBuffer;
use engine_env::event_receiver::EventReceiver;
use engine_env::process_info::ProcessInfo;
use engine_env::processor::Processor;
use math::curve::normalized_at;
use math::db_to_gain;
use value::region::locate_loops;
use crate::audio_unit::{AudioRegion, SharedAudioTrackSets};

pub(crate) struct AudioRegionPlayer {
    tracks: SharedAudioTrackSets,
    sample_rate: f32,
    output: SharedAudioBuffer,
    events: EventBuffer
}

impl AudioRegionPlayer {
    pub(crate) fn new(tracks: SharedAudioTrackSets, sample_rate: f32) -> Self {
        Self {tracks, sample_rate, output: shared_audio_buffer(), events: EventBuffer::new()}
    }
}

impl EventReceiver for AudioRegionPlayer {
    fn event_input(&mut self) -> &mut EventBuffer {
        &mut self.events
    }
}

impl AudioGenerator for AudioRegionPlayer {
    fn audio_output(&self) -> SharedAudioBuffer {
        self.output.clone()
    }
}

impl Processor for AudioRegionPlayer {
    fn reset(&mut self) {
        self.output.borrow_mut().clear();
    }

    fn process(&mut self, info: &ProcessInfo) {
        let mut output = self.output.borrow_mut();
        output.clear(); // the player is a source: it fills its own output each quantum (silence when not playing)
        let sample_rate = self.sample_rate;
        let tracks = self.tracks.clone();
        for block in info.blocks {
            if !block.flags.transporting() || !block.flags.playing() {
                continue;
            }
            for track in tracks.borrow().iter() {
                for region in track.borrow().iterate_range(block.p0, block.p1) {
                    if region.mute {
                        continue;
                    }
                    if let Some(sample) = crate::resolve_sample(region.file) {
                        let left = sample.plane(0);
                        let right = if sample.channel_count >= 2 { sample.plane(1) } else { left };
                        render_region(&mut output, region, left, right, sample.sample_rate, block, sample_rate);
                    }
                }
            }
        }
    }
}

/// Render one region's contribution for one block, summing into `output` (the testable core — takes the source
/// planes as slices, so a test feeds synthetic frames without the shared-memory `SampleRef`).
fn render_region(output: &mut AudioBuffer, region: &AudioRegion, left: &[f32], right: &[f32], source_rate: f32, block: &Block, engine_rate: f32) {
    let pulses = block.p1 - block.p0;
    if pulses <= 0.0 {
        return;
    }
    let samples = (block.s1 - block.s0) as f64;
    let complete = region.position + region.duration;
    let gain = db_to_gain(region.gain_db);
    let rate = (source_rate / engine_rate) as f64; // source frames advanced per output sample (native pitch)
    let source_frames = left.len();
    for cycle in locate_loops(region.position, complete, region.loop_offset, region.loop_duration, block.p0, block.p1) {
        let begin = sample_of(block, cycle.result_start, pulses, samples);
        let end = sample_of(block, cycle.result_end, pulses, samples);
        // The source frame at the cycle's start: elapsed real time since this loop cycle began, plus the offset.
        let elapsed_seconds = pulses_to_seconds(cycle.result_start - cycle.raw_start, block.bpm);
        let read_start = (elapsed_seconds + region.waveform_offset) * source_rate as f64;
        for index in begin..end {
            let frame = read_start + (index - begin) as f64 * rate;
            let base = frame as usize; // frame >= 0 (read_start, rate both non-negative), so this floors
            if base >= source_frames {
                break; // ran past the end of the source
            }
            let frac = (frame - base as f64) as f32;
            let pulse = block.p0 + (index as f64 - block.s0 as f64) / samples * pulses;
            let envelope = fade_gain(pulse - region.position, region.duration, region);
            let scale = gain * envelope;
            output.left[index] += interpolate(left, base, frac) * scale;
            output.right[index] += interpolate(right, base, frac) * scale;
        }
    }
}

/// The output sample index of a pulse position within a block, clamped to the block's sample window (truncated
/// to a sample boundary, matching the TS `| 0`; `clamp` + `as usize` are core, so this stays `no_std`).
fn sample_of(block: &Block, pulse: f64, pulses: f64, samples: f64) -> usize {
    let ratio = (pulse - block.p0) / pulses;
    (block.s0 as f64 + samples * ratio).clamp(block.s0 as f64, block.s1 as f64) as usize
}

/// Linear interpolation of a planar source at a fractional frame; reads 0.0 past the end (TS `inp[i + 1] ?? 0`).
fn interpolate(buffer: &[f32], index: usize, frac: f32) -> f32 {
    let here = buffer.get(index).copied().unwrap_or(0.0);
    let next = buffer.get(index + 1).copied().unwrap_or(0.0);
    here * (1.0 - frac) + next * frac
}

/// The region's fade gain at `position` pulses into it (TS `FadingEnvelope.gainAt`): one slope-shaped fade in
/// and one fade out, the lesser of the two. No fade -> 1.0.
fn fade_gain(position: f64, duration: f64, region: &AudioRegion) -> f32 {
    let mut fade_in = 1.0f32;
    let mut fade_out = 1.0f32;
    if region.fade_in > 0.0 && position < region.fade_in {
        fade_in = normalized_at((position / region.fade_in) as f32, region.fade_in_slope);
    }
    let fade_out_start = duration - region.fade_out;
    if region.fade_out > 0.0 && position > fade_out_start {
        let progress = ((position - fade_out_start) / region.fade_out) as f32;
        fade_out = 1.0 - normalized_at(progress, region.fade_out_slope);
    }
    fade_in.min(fade_out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    use alloc::vec::Vec;
    use engine_env::block_flags::BlockFlags;

    fn region(gain_db: f32, fade_in: f64, fade_out: f64) -> AudioRegion {
        AudioRegion {
            region_uuid: [1u8; 16], position: 0.0, duration: 96_000.0, loop_offset: 0.0, loop_duration: 96_000.0,
            file: [9u8; 16], gain_db, mute: false, waveform_offset: 0.0, fade_in, fade_out,
            fade_in_slope: 0.5, fade_out_slope: 0.5
        }
    }

    // A playing block covering the first 64 samples from transport 0 at 120 bpm.
    fn block() -> Block {
        Block {index: 0, flags: BlockFlags::create(true, false, true, false), p0: 0.0, p1: 240.0, s0: 0, s1: 64, bpm: 120.0}
    }

    #[test]
    fn reads_the_source_at_native_rate_with_unity_gain() {
        let source: Vec<f32> = (0..128).map(|i| i as f32).collect(); // a ramp, so the read offset is checkable
        let mut output = AudioBuffer::new();
        render_region(&mut output, &region(0.0, 0.0, 0.0), &source, &source, 48_000.0, &block(), 48_000.0);
        for i in 0..64 {
            assert!((output.left[i] - i as f32).abs() < 1e-3, "sample {i}: {} != {}", output.left[i], i);
        }
    }

    #[test]
    fn applies_region_gain_in_decibels() {
        let source = vec![1.0f32; 128];
        let mut output = AudioBuffer::new();
        render_region(&mut output, &region(-6.0, 0.0, 0.0), &source, &source, 48_000.0, &block(), 48_000.0);
        let expected = db_to_gain(-6.0);
        for i in 0..64 {
            assert!((output.left[i] - expected).abs() < 1e-4, "sample {i}");
        }
    }

    #[test]
    fn applies_a_single_linear_fade_in() {
        let source = vec![1.0f32; 128];
        let mut output = AudioBuffer::new();
        // fade-in over 240 ppqn (the whole block), linear slope: gain ramps 0 -> ~1 across the block.
        render_region(&mut output, &region(0.0, 240.0, 0.0), &source, &source, 48_000.0, &block(), 48_000.0);
        assert!(output.left[0].abs() < 1e-3, "starts silent: {}", output.left[0]);
        assert!(output.left[63] > 0.9, "ramps to ~unity: {}", output.left[63]);
        assert!(output.left[32] > output.left[0] && output.left[32] < output.left[63], "monotonic ramp");
    }

    #[test]
    fn mid_file_start_reads_the_correct_offset_no_pop() {
        // Start playback at pulse 240 (0.125 s at 120 bpm) -> source frame 0.125 * 48000 = 6000. The first
        // output sample must be source[6000], not source[0] (the pop was reading the wrong frame).
        let source: Vec<f32> = (0..12_000).map(|i| (i % 100) as f32 * 0.01).collect();
        let mut output = AudioBuffer::new();
        let started = Block {index: 0, flags: BlockFlags::create(true, false, true, false), p0: 240.0, p1: 480.0, s0: 0, s1: 64, bpm: 120.0};
        render_region(&mut output, &region(0.0, 0.0, 0.0), &source, &source, 48_000.0, &started, 48_000.0);
        assert!((output.left[0] - source[6000]).abs() < 1e-3, "first sample is the correct mid-file frame: {} vs {}", output.left[0], source[6000]);
    }
}
