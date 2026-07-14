//! The audio-region player: an engine-side processor (the AUDIO-track analog of the note `NoteSequencer`) that
//! turns an audio unit's `TrackType.Audio` regions into sound. It IS the unit's source — per quantum it clears
//! its output, then for each enabled audio track range-queries its sorted `AudioRegion` collection, resolves
//! each region's source sample, and renders it NO-STRETCH (native pitch, the basic Tape play-mode):
//!
//! - a read head that FREE-RUNS at native speed (`read += sourceRate/engineRate` per output sample) and persists
//!   across blocks, locked to the output clock, so a tempo ramp can't make the read rate jitter per block (which
//!   is an audible ring-mod). It is reseated from the tempo map ONLY at a discontinuity (region entry, loop wrap,
//!   transport jump), where the absolute file offset is `(intervalToSeconds(loopOrigin, now) + waveformOffset) *
//!   sourceRate` — exact even at a mid-file start (no "breathless pop");
//! - linear interpolation when the source / engine sample rates differ;
//! - scaled by the region gain and a fade envelope (`lib-dsp` `FadingEnvelope`), plus a short boundary declick at
//!   un-faded region edges so adjacent regions do not click; the two never multiply into a doubled fade.
//!
//! Time-stretch (the granular play-mode) lives in `time_stretch`; pitch/warp is handled inline here. CLIP
//! LAUNCHING: per block, each track's pulse range is split into sections by the shared `ClipSequencer` (TS
//! `clipSequencing.iterate` in the Tape) — a clip section plays the clip's VIRTUAL region (position 0,
//! infinite completion, looping at the clip duration) through the same passes; the timeline regions play
//! only in the clip-free sections.

use dsp::ppqn::seconds_to_pulses;
use engine_env::audio_buffer::{shared_audio_buffer, AudioBuffer, SharedAudioBuffer};
use engine_env::audio_generator::AudioGenerator;
use engine_env::block::Block;
use engine_env::event_buffer::EventBuffer;
use engine_env::event_receiver::EventReceiver;
use engine_env::process_info::ProcessInfo;
use engine_env::processor::Processor;
use math::curve::normalized_at;
use math::db_to_gain;
use alloc::vec::Vec;
use value::region::locate_loops;
use boxgraph::address::Uuid;
use alloc::rc::Rc;
use core::cell::RefCell;
use engine_env::clip_sequencer::{ClipInfo, ClipSequencer};
use crate::audio_unit::{AudioRegion, BoundAudioClip, SharedAudioTrackSets};
use crate::time_stretch::{Source, TimeStretchSequencer};
use crate::tempo_map::{SharedTempoMap, TempoMap};

/// The boundary declick window in seconds (matches the TS tape `VOICE_FADE_DURATION`): a region edge with no
/// authored fade gets this short anti-click ramp so an adjacent-region seam does not hard-cut into a click.
const VOICE_FADE_DURATION: f64 = 0.020;

pub(crate) struct AudioRegionPlayer {
    tracks: SharedAudioTrackSets,
    sample_rate: f32,
    tempo_map: SharedTempoMap, // ppqn -> real-seconds (tempo-automation aware), for the NO-STRETCH read offset
    output: SharedAudioBuffer,
    events: EventBuffer,
    // Persistent transient-aligned granular sequencers, one per time-stretch region (keyed by region uuid). The
    // native / pitch play-modes are stateless and need no per-region state; only time-stretch carries voices.
    sequencers: Vec<(Uuid, TimeStretchSequencer)>,
    // The FREE-RUNNING read position of each NO-STRETCH region (keyed by region uuid): the read advances per
    // output sample and persists across blocks, recomputed from the tempo map ONLY at a discontinuity. Without
    // this the read offset is recomputed every block from a grid-stepped tempo integral that disagrees with the
    // transport's per-quantum time, so the read RATE jitters each quantum — an audible ring-mod under a fast
    // tempo change. Free-running locks the read to the output clock (true native real-time playback).
    native_cursors: Vec<(Uuid, NativeCursor)>,
    // Region uuids touched this quantum, to prune per-region state for regions that stopped playing (a re-entry
    // starts on a discontinuous block and resets anyway).
    visited: Vec<Uuid>,
    // TapeDeviceBox `enabled` (TS observes it, resets on disable, and renders silence while off).
    enabled: bool,
    meter: engine_env::meter::Meter, // peaks/RMS of the tape output (a broadcast slot)
    // Recycled sequencers: a pruned region's sequencer parks here (voices cleared, capacity kept) and the
    // next stretch region reuses it. `prepare` (reconcile) pre-warms the pool for every BOUND stretch region,
    // so the render-path `pop()` never misses; without the pre-warm each new concurrency high-water would
    // still call `TimeStretchSequencer::new` mid-render.
    sequencer_pool: Vec<TimeStretchSequencer>,
    // The engine's clip-launch state machine, shared with the note sequencers (sections per track).
    clips: Rc<RefCell<ClipSequencer>>
}

/// The clip sequencer's live `(duration, looped)` lookup over one track's bound audio clips.
struct BoundClipInfo<'a> {
    clips: &'a [BoundAudioClip]
}

impl ClipInfo for BoundClipInfo<'_> {
    fn resolve(&self, clip: &[u8; 16]) -> Option<(f64, bool)> {
        self.clips.iter().find(|bound| &bound.clip_uuid == clip)
            .map(|bound| (bound.region.loop_duration, bound.looped))
    }
}

/// The free-running read state of one no-stretch region: the current source-frame read position, and the pulse
/// the last rendered cycle ended at (so the next cycle knows whether it CONTINUES — advance the read — or jumped
/// — reseat the read from the tempo map). `next_pulse` is NaN until the first render, forcing an initial seat.
struct NativeCursor {
    read_frame: f64,
    next_pulse: f64,
    // The `raw_start` of the loop cycle the read is currently in. A continuation stays in the SAME cycle; a loop
    // WRAP starts a new cycle (`raw_start` jumps by `loop_duration`), which is a source-read discontinuity (jump
    // back to the loop content) even though the timeline is contiguous — so the read must reseat, not free-run.
    // NaN until the first render, forcing an initial seat.
    raw_start: f64
}

impl NativeCursor {
    fn new() -> Self {
        Self {read_frame: 0.0, next_pulse: f64::NAN, raw_start: f64::NAN}
    }
}

impl AudioRegionPlayer {
    pub(crate) fn new(tracks: SharedAudioTrackSets, sample_rate: f32, tempo_map: SharedTempoMap,
                      clips: Rc<RefCell<ClipSequencer>>) -> Self {
        Self {tracks, sample_rate, tempo_map, output: shared_audio_buffer(), events: EventBuffer::new(),
            sequencers: Vec::with_capacity(8), native_cursors: Vec::with_capacity(16), visited: Vec::with_capacity(32),
            sequencer_pool: Vec::with_capacity(8), enabled: true,
            meter: engine_env::meter::Meter::new(sample_rate), clips}
    }

    /// Pre-warm at RECONCILE (region bind / edit), so region entry during playback never allocates: park a
    /// pooled sequencer for every bound time-stretch region and reserve the per-region bookkeeping for the
    /// total region count. Growth beyond these bounds (e.g. `visited` on many-block quanta) is the accepted
    /// one-time high-water category.
    pub(crate) fn prepare(&mut self, stretch_regions: usize, total_regions: usize) {
        while self.sequencer_pool.len() + self.sequencers.len() < stretch_regions {
            self.sequencer_pool.push(TimeStretchSequencer::new());
        }
        self.sequencers.reserve(stretch_regions.saturating_sub(self.sequencers.len()));
        self.native_cursors.reserve(total_regions.saturating_sub(self.native_cursors.len()));
        self.visited.reserve((total_regions * 2).saturating_sub(self.visited.len()));
    }

    /// The TapeDeviceBox `enabled` gate (TS `TapeDeviceProcessor`): disabling RESETS the playback state
    /// (voices dropped, cursors reseat on re-enable) and the player renders silence while off.
    pub(crate) fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
        if !enabled {
            self.output.borrow_mut().clear();
            while let Some((_, mut sequencer)) = self.sequencers.pop() {
                sequencer.recycle();
                self.sequencer_pool.push(sequencer);
            }
            self.native_cursors.clear();
            self.meter.clear();
        }
    }

    /// The peak/RMS broadcast slot of the tape output.
    pub(crate) fn meter_slot(&self) -> engine_env::telemetry::BroadcastSlot {
        self.meter.slot()
    }

    #[cfg(test)]
    pub(crate) fn pooled_sequencers(&self) -> usize {
        self.sequencer_pool.len()
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
        self.meter.clear();
    }

    fn process(&mut self, info: &ProcessInfo) {
        let AudioRegionPlayer {
            tracks, sample_rate, tempo_map, output, sequencers, native_cursors, visited,
            sequencer_pool, clips, enabled, meter, ..
        } = self;
        let mut output = output.borrow_mut();
        output.clear(); // the player is a source: it fills its own output each quantum (silence when not playing)
        if !*enabled {
            return; // TapeDeviceBox disabled: silence (TS returns before reading any region)
        }
        let sample_rate = *sample_rate;
        let tempo_map = tempo_map.borrow();
        let mut fading_gain = [1.0f32; engine_env::RENDER_QUANTUM]; // per-cycle region fade, reused on the stack
        visited.clear();
        for block in info.blocks {
            if !block.flags.transporting() || !block.flags.playing() {
                continue;
            }
            for track in tracks.borrow().iter() {
                let content = track.borrow();
                let clip_info = BoundClipInfo {clips: &content.clips};
                clips.borrow_mut().iterate(&content.uuid, block.p0, block.p1, &clip_info, &mut |section| {
                    match section.clip {
                        // Timeline regions play only in the clip-free sections (TS Tape `optClip: none`).
                        None => for region in content.regions.iterate_range(section.from, section.to) {
                            play_region(region, section.from, section.to, block, &mut output, &mut fading_gain,
                                sequencers, sequencer_pool, native_cursors, visited, &tempo_map, sample_rate);
                        },
                        Some(clip) => {
                            if let Some(bound) = content.clips.iter().find(|bound| bound.clip_uuid == clip) {
                                play_region(&bound.region, section.from, section.to, block, &mut output, &mut fading_gain,
                                    sequencers, sequencer_pool, native_cursors, visited, &tempo_map, sample_rate);
                            }
                        }
                    }
                });
            }
        }
        meter.process(&output.left, &output.right);
        // Prune per-region state for regions that stopped playing: cursors are plain Copy structs (retain frees
        // nothing), sequencers park in the pool for reuse instead of dropping their voice buffers mid-render.
        let mut index = 0;
        while index < sequencers.len() {
            if visited.contains(&sequencers[index].0) {
                index += 1;
            } else {
                let (_, mut sequencer) = sequencers.swap_remove(index);
                sequencer.recycle();
                sequencer_pool.push(sequencer);
            }
        }
        native_cursors.retain(|(uuid, _)| visited.contains(uuid));
    }
}

/// Play one region (a timeline region, or a launched clip's VIRTUAL region) for the pulse range
/// `[from, to)` of `block`, routing by play strategy: a time-stretch region (with >= 2 transients to
/// bracket a segment) goes through its persistent granular sequencer; everything else (native / pitch)
/// is the stateless read head in `render_region`.
#[allow(clippy::too_many_arguments)] // the player's split fields; a struct adds no clarity
fn play_region(region: &AudioRegion, from: f64, to: f64, block: &Block,
               output: &mut AudioBuffer, fading_gain: &mut [f32; engine_env::RENDER_QUANTUM],
               sequencers: &mut Vec<(Uuid, TimeStretchSequencer)>, sequencer_pool: &mut Vec<TimeStretchSequencer>,
               native_cursors: &mut Vec<(Uuid, NativeCursor)>, visited: &mut Vec<Uuid>,
               tempo_map: &TempoMap, sample_rate: f32) {
    if region.mute {
        return;
    }
    let Some(sample) = crate::resolve_sample(region.file) else { return };
    let left = sample.plane(0);
    let right = if sample.channel_count >= 2 { sample.plane(1) } else { left };
    match &region.time_stretch {
        Some(config) if region.transients.len() >= 2 => {
            let index = match sequencers.iter().position(|(uuid, _)| *uuid == region.region_uuid) {
                Some(index) => index,
                None => {
                    let sequencer = sequencer_pool.pop().unwrap_or_else(TimeStretchSequencer::new);
                    sequencers.push((region.region_uuid, sequencer));
                    sequencers.len() - 1
                }
            };
            visited.push(region.region_uuid);
            let source = Source {left, right, num_frames: sample.frame_count as usize};
            let complete = region.position + region.duration;
            for cycle in locate_loops(region.position, complete, region.loop_offset, region.loop_duration, from, to) {
                fill_fading_gain(fading_gain, region, cycle.result_start, cycle.result_end, block);
                sequencers[index].1.process(
                    output, &source, sample.sample_rate, &region.transients, config,
                    region.waveform_offset, block, cycle.raw_start, cycle.result_start, cycle.result_end,
                    fading_gain, sample_rate);
            }
        }
        _ => {
            let index = match native_cursors.iter().position(|(uuid, _)| *uuid == region.region_uuid) {
                Some(index) => index,
                None => {
                    native_cursors.push((region.region_uuid, NativeCursor::new()));
                    native_cursors.len() - 1
                }
            };
            visited.push(region.region_uuid);
            render_region(output, region, left, right, sample.sample_rate, from, to, block, sample_rate, tempo_map, &mut native_cursors[index].1);
        }
    }
}

/// Fill `buffer[0..count)` with the region's fade envelope/// Fill `buffer[0..count)` with the region's fade envelope across one loop cycle (TS `FadingEnvelope.fillGainBuffer`):
/// the fade gain is linear in ppqn from `result_start` to `result_end`. Returns the sample count filled.
fn fill_fading_gain(buffer: &mut [f32], region: &AudioRegion, result_start: f64, result_end: f64, block: &Block) -> usize {
    let pulses = block.p1 - block.p0;
    let samples = (block.s1 - block.s0) as f64;
    let buffer_start = sample_of(block, result_start, pulses, samples);
    let buffer_end = sample_of(block, result_end, pulses, samples);
    let count = buffer_end.saturating_sub(buffer_start).min(buffer.len());
    let start_ppqn = result_start - region.position;
    let span_ppqn = result_end - result_start;
    for (index, slot) in buffer.iter_mut().enumerate().take(count) {
        let ppqn = start_ppqn + if count > 0 { index as f64 / count as f64 * span_ppqn } else { 0.0 };
        // no boundary declick here: the time-stretch granular voices already crossfade at their own boundaries.
        *slot = fade_gain(ppqn, region.duration, region, 0.0, false);
    }
    count
}

/// Render one region's contribution for one block, summing into `output` (the testable core — takes the source
/// planes as slices, so a test feeds synthetic frames without the shared-memory `SampleRef`).
#[allow(clippy::too_many_arguments)] // positional source planes / rates / block / tempo map / cursor; a struct adds no clarity
fn render_region(output: &mut AudioBuffer, region: &AudioRegion, left: &[f32], right: &[f32], source_rate: f32, from: f64, to: f64, block: &Block, engine_rate: f32, tempo_map: &TempoMap, cursor: &mut NativeCursor) {
    let pulses = block.p1 - block.p0;
    if pulses <= 0.0 {
        return;
    }
    let samples = (block.s1 - block.s0) as f64;
    let complete = region.position + region.duration;
    let gain = db_to_gain(region.gain_db);
    let rate = (source_rate / engine_rate) as f64; // source frames advanced per output sample (native pitch)
    let source_frames = left.len();
    // Boundary declick window in pulses (~20 ms at the block tempo): a short fade applied at a region edge that
    // has no authored fade, so an adjacent-region seam does not click. The start edge is declicked only when the
    // read cuts into the file (waveform offset > 0); a frame-0 onset (song start / loop start) is left alone.
    let declick_pulses = seconds_to_pulses(VOICE_FADE_DURATION, block.bpm) as f64;
    let declick_in = region.waveform_offset > 0.0;
    for cycle in locate_loops(region.position, complete, region.loop_offset, region.loop_duration, from, to) {
        let begin = sample_of(block, cycle.result_start, pulses, samples);
        let end = sample_of(block, cycle.result_end, pulses, samples);
        // The play STRATEGY decides the source read start (frames) + the per-sample advance:
        //  - native (no play-mode): the source plays at native real-time speed. The read FREE-RUNS — it continues
        //    from where the previous block left off (locked to the output clock, so a tempo ramp can't make the
        //    read rate jitter per block), and is reseated from the tempo map ONLY at a discontinuity (region
        //    entry, loop wrap, transport jump);
        //  - PitchStretch: warp markers map content ppqn -> source seconds; the read start + advance come from the
        //    warp segment, so the audio follows the warped tempo.
        let (read_start, rate) = if region.warp.is_empty() {
            // Continue the free-running read ONLY within the SAME loop cycle (pulse-contiguous AND same
            // `raw_start`). A loop wrap yields a new cycle whose `raw_start` jumped, so `continues` is false and
            // the read reseats to the loop content start below (else it would run off the sample end and go silent).
            let continues = !block.flags.discontinuous()
                && (cursor.next_pulse - cycle.result_start).abs() < 1e-6
                && (cursor.raw_start - cycle.raw_start).abs() < 1e-6;
            let read_start = if continues {
                cursor.read_frame
            } else {
                (tempo_map.interval_to_seconds(cycle.raw_start, cycle.result_start) + region.waveform_offset) * source_rate as f64
            };
            (read_start, rate)
        } else {
            let content_ppqn = cycle.result_start - cycle.raw_start;
            // Out of the warp range -> the content is silent here (no source frame maps to it); skip the cycle.
            let (first, last) = (region.warp[0].0, region.warp[region.warp.len() - 1].0);
            if content_ppqn < first || content_ppqn >= last {
                continue;
            }
            let seconds = warp_seconds(&region.warp, content_ppqn, cycle.result_start_value as f64);
            let warp_rate = warp_playback_rate(&region.warp, content_ppqn, source_rate, pulses, samples);
            ((seconds + region.waveform_offset) * source_rate as f64, warp_rate)
        };
        for index in begin..end {
            let frame = read_start + (index - begin) as f64 * rate;
            let base = frame as usize; // frame >= 0 (read_start, rate both non-negative), so this floors
            if base >= source_frames {
                break; // ran past the end of the source
            }
            let frac = (frame - base as f64) as f32;
            let pulse = block.p0 + (index as f64 - block.s0 as f64) / samples * pulses;
            let envelope = fade_gain(pulse - region.position, region.duration, region, declick_pulses, declick_in);
            let scale = gain * envelope;
            output.left[index] += interpolate(left, base, frac) * scale;
            output.right[index] += interpolate(right, base, frac) * scale;
        }
        // Advance the free-running cursor by this cycle's FULL span (even if the render broke early at EOF), so a
        // continuation next block reads from the right place. Only the no-stretch path uses the cursor.
        if region.warp.is_empty() {
            cursor.read_frame = read_start + (end - begin) as f64 * rate;
            cursor.next_pulse = cycle.result_end;
            cursor.raw_start = cycle.raw_start;
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

/// The region's fade gain at `position` pulses into it: the lesser of the start- and end-edge envelopes. Each
/// edge uses the AUTHORED fade when present (TS `FadingEnvelope.gainAt`, slope-shaped), else a short boundary
/// DECLICK of `declick_pulses` (~20 ms) so a region boundary does not hard-cut into a click — the engine analog
/// of TS fading the evicted/incoming voice over `VOICE_FADE_DURATION`. The two are never multiplied (no
/// fade-product doubling): an authored fade replaces the declick on its edge. `declick_in` gates the START
/// declick to reads that CUT into the file (a frame-0 onset, e.g. the song start, is left untouched); the END
/// declick is always applied (the outgoing hard cut is the click TS removes).
fn fade_gain(position: f64, duration: f64, region: &AudioRegion, declick_pulses: f64, declick_in: bool) -> f32 {
    let mut fade_in = 1.0f32;
    let mut fade_out = 1.0f32;
    if region.fade_in > 0.0 {
        if position < region.fade_in {
            fade_in = normalized_at((position / region.fade_in) as f32, region.fade_in_slope);
        }
    } else if declick_in && declick_pulses > 0.0 && position < declick_pulses {
        fade_in = (position / declick_pulses).clamp(0.0, 1.0) as f32;
    }
    if region.fade_out > 0.0 {
        let fade_out_start = duration - region.fade_out;
        if position > fade_out_start {
            let progress = ((position - fade_out_start) / region.fade_out) as f32;
            fade_out = 1.0 - normalized_at(progress, region.fade_out_slope);
        }
    } else if declick_pulses > 0.0 && position > duration - declick_pulses {
        fade_out = ((duration - position) / declick_pulses).clamp(0.0, 1.0) as f32;
    }
    fade_in.min(fade_out)
}

/// The last warp-marker index with position <= `ppqn` (warp sorted by position, non-empty; `partition_point` is
/// core, so this stays no_std).
fn warp_floor_index(warp: &[(f64, f64)], ppqn: f64) -> usize {
    warp.partition_point(|(position, _)| *position <= ppqn).saturating_sub(1)
}

/// Source seconds at content `ppqn`, linearly interpolated between the bracketing warp markers (TS
/// `#ppqnToSeconds`); `fallback` when the markers do not bracket it.
fn warp_seconds(warp: &[(f64, f64)], ppqn: f64, fallback: f64) -> f64 {
    let index = warp_floor_index(warp, ppqn);
    match (warp.get(index), warp.get(index + 1)) {
        (Some(&(left_p, left_s)), Some(&(right_p, right_s))) => left_s + (ppqn - left_p) / (right_p - left_p) * (right_s - left_s),
        _ => fallback
    }
}

/// Source frames advanced per output sample in the warp segment at content `ppqn` (TS `#getPlaybackRateFromWarp`):
/// (source samples per ppqn) / (timeline samples per ppqn).
fn warp_playback_rate(warp: &[(f64, f64)], ppqn: f64, source_rate: f32, pulses: f64, samples: f64) -> f64 {
    let index = warp_floor_index(warp, ppqn);
    match (warp.get(index), warp.get(index + 1)) {
        (Some(&(left_p, left_s)), Some(&(right_p, right_s))) => {
            let audio_samples_per_ppqn = ((right_s - left_s) * source_rate as f64) / (right_p - left_p);
            audio_samples_per_ppqn / (samples / pulses)
        }
        _ => 1.0
    }
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
            fade_in_slope: 0.5, fade_out_slope: 0.5, warp: Vec::new(), time_stretch: None, transients: Vec::new()
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
        render_region(&mut output, &region(0.0, 0.0, 0.0), &source, &source, 48_000.0, block().p0, block().p1, &block(), 48_000.0, &TempoMap::fixed(120.0), &mut NativeCursor::new());
        for i in 0..64 {
            assert!((output.left[i] - i as f32).abs() < 1e-3, "sample {i}: {} != {}", output.left[i], i);
        }
    }

    #[test]
    fn applies_region_gain_in_decibels() {
        let source = vec![1.0f32; 128];
        let mut output = AudioBuffer::new();
        render_region(&mut output, &region(-6.0, 0.0, 0.0), &source, &source, 48_000.0, block().p0, block().p1, &block(), 48_000.0, &TempoMap::fixed(120.0), &mut NativeCursor::new());
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
        render_region(&mut output, &region(0.0, 240.0, 0.0), &source, &source, 48_000.0, block().p0, block().p1, &block(), 48_000.0, &TempoMap::fixed(120.0), &mut NativeCursor::new());
        assert!(output.left[0].abs() < 1e-3, "starts silent: {}", output.left[0]);
        assert!(output.left[63] > 0.9, "ramps to ~unity: {}", output.left[63]);
        assert!(output.left[32] > output.left[0] && output.left[32] < output.left[63], "monotonic ramp");
    }

    #[test]
    fn pitch_stretch_reads_at_the_warp_rate() {
        // Warp markers map 24000 ppqn -> 1.0 s of source. With a block whose samples == pulses, that is a 2x read
        // rate (the source is consumed twice as fast as the timeline), so a ramp source is read at frames 0,2,4...
        let source: Vec<f32> = (0..128).map(|frame| frame as f32).collect();
        let mut output = AudioBuffer::new();
        let mut warped = region(0.0, 0.0, 0.0);
        warped.warp = vec![(0.0, 0.0), (24_000.0, 1.0)];
        let block = Block {index: 0, flags: BlockFlags::create(true, false, true, false), p0: 0.0, p1: 32.0, s0: 0, s1: 32, bpm: 120.0};
        render_region(&mut output, &warped, &source, &source, 48_000.0, block.p0, block.p1, &block, 48_000.0, &TempoMap::fixed(120.0), &mut NativeCursor::new());
        for i in 0..32 {
            assert!((output.left[i] - (2 * i) as f32).abs() < 1e-3, "sample {i}: {} != {}", output.left[i], 2 * i);
        }
    }

    #[test]
    fn pitch_stretch_outside_the_warp_range_is_silent() {
        // A region whose content starts past the last warp marker has no source mapping -> silence (not a pop).
        let source = vec![1.0f32; 128];
        let mut output = AudioBuffer::new();
        let mut warped = region(0.0, 0.0, 0.0);
        warped.warp = vec![(0.0, 0.0), (10.0, 1.0)]; // warp range is only [0, 10) ppqn
        let block = Block {index: 0, flags: BlockFlags::create(true, false, true, false), p0: 100.0, p1: 132.0, s0: 0, s1: 32, bpm: 120.0};
        render_region(&mut output, &warped, &source, &source, 48_000.0, block.p0, block.p1, &block, 48_000.0, &TempoMap::fixed(120.0), &mut NativeCursor::new());
        assert_eq!(output.left[0], 0.0, "content past the warp range is silent");
    }

    #[test]
    fn region_end_declicks_to_avoid_a_seam_click() {
        // A region that ENDS within the block, reading a CONSTANT non-zero source with NO authored fade. Without
        // the boundary declick this hard-cut to a full-amplitude sample at the seam (the click against the next
        // region); now the last ~20 ms ramps down to ~0, so the waveform is continuous across the boundary.
        let source = vec![1.0f32; 128];
        let mut output = AudioBuffer::new();
        let mut short = region(0.0, 0.0, 0.0);
        short.duration = 240.0; // ends exactly at the block end (pulse 240)
        short.loop_duration = 240.0;
        render_region(&mut output, &short, &source, &source, 48_000.0, block().p0, block().p1, &block(), 48_000.0, &TempoMap::fixed(120.0), &mut NativeCursor::new());
        assert!((output.left[20] - 1.0).abs() < 1e-3, "full gain well inside the region: {}", output.left[20]);
        assert!(output.left[63] < 0.2, "the region end ramps down (declick), not a hard cut: {}", output.left[63]);
        assert!(output.left[63] < output.left[40], "monotonic fall into the boundary");
    }

    #[test]
    fn mid_file_start_reads_the_correct_offset_no_pop() {
        // Start playback at pulse 240 (0.125 s at 120 bpm) -> source frame 0.125 * 48000 = 6000. The first
        // output sample must be source[6000], not source[0] (the pop was reading the wrong frame).
        let source: Vec<f32> = (0..12_000).map(|i| (i % 100) as f32 * 0.01).collect();
        let mut output = AudioBuffer::new();
        let started = Block {index: 0, flags: BlockFlags::create(true, false, true, false), p0: 240.0, p1: 480.0, s0: 0, s1: 64, bpm: 120.0};
        render_region(&mut output, &region(0.0, 0.0, 0.0), &source, &source, 48_000.0, started.p0, started.p1, &started, 48_000.0, &TempoMap::fixed(120.0), &mut NativeCursor::new());
        assert!((output.left[0] - source[6000]).abs() < 1e-3, "first sample is the correct mid-file frame: {} vs {}", output.left[0], source[6000]);
    }
}
