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
use crate::audio_unit::{AudioRegion, SignalsmithConfig, BoundAudioClip, SharedAudioTrackSets};
use crate::time_stretch::{Source, TimeStretchSequencer};
use signalsmith::SignalsmithStretch;
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
    // EFFECTS-mode input monitoring: the armed tape's staged live-input channels, summed into the player's
    // OWN output so the tape device (its meter + any side-chain tapping it) carries the live input — the tape
    // IS the source. `None` when the unit is not monitoring. Re-set on rebuild (the map change rewires).
    monitor: Option<(i32, i32)>,
    meter: engine_env::meter::Meter, // peaks/RMS of the tape output (a broadcast slot)
    // Recycled sequencers: a pruned region's sequencer parks here (voices cleared, capacity kept) and the
    // next stretch region reuses it. `prepare` (reconcile) pre-warms the pool for every BOUND stretch region,
    // so the render-path `pop()` never misses; without the pre-warm each new concurrency high-water would
    // still call `TimeStretchSequencer::new` mid-render.
    sequencer_pool: Vec<TimeStretchSequencer>,
    // Signalsmith spectral players, one stereo pair per playing Signalsmith region (keyed by uuid),
    // plus a recycle pool (pre-warmed at prepare, like the sequencers) so region entry never allocates.
    signalsmith_players: Vec<(Uuid, SignalsmithStretch)>,
    signalsmith_pool: Vec<SignalsmithStretch>,
    // Active fade-out tails (native regions): a region-end seam crossfade or a transport-stop release. Rendered
    // every block until each ramp expires, independent of the region iteration (the region is no longer played).
    release_tails: Vec<ReleaseTail>,
    // Active granular (time-stretch) releases: a region whose sequencer is ringing its voices out past its end or
    // a stop. Each keeps its sequencer alive in `sequencers`; driven every block until the voices finish.
    granular_releases: Vec<GranularRelease>,
    // region_uuid -> file for every LIVE granular sequencer, so a transport stop can seed a release (resolve the
    // source) without the region, which is no longer iterated. Updated as each granular region renders.
    granular_files: Vec<(Uuid, Uuid)>,
    // Active Signalsmith releases + a per-region READY release template (its stream params from the last render),
    // so a transport stop can seed a release without the region (which is no longer iterated).
    signalsmith_releases: Vec<SignalsmithRelease>,
    signalsmith_templates: Vec<(Uuid, SignalsmithRelease)>,
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
    raw_start: f64,
    // The last rendered region's source / gain / native read rate, mirrored here so a transport STOP can seed a
    // release tail from the pause point without the region (which is no longer being iterated). `rate` stays 0
    // until the first render, marking a cursor that has never sounded (no release to seed).
    file: Uuid,
    gain_db: f32,
    rate: f64
}

impl NativeCursor {
    fn new() -> Self {
        Self {read_frame: 0.0, next_pulse: f64::NAN, raw_start: f64::NAN, file: [0u8; 16], gain_db: 0.0, rate: 0.0}
    }
}

/// A native region's fade-OUT rendered as a source-reading TAIL past the region end (or from a pause point):
/// the read continues forward from `read_frame` at the native `rate` while a linear `remaining / window` ramp
/// falls to 0. At a cut this tail overlaps the next region's fade-in reading the SAME source frames, so the two
/// sum to the original (a transparent self-crossfade) instead of both dipping toward the seam. It also releases
/// a voice cleanly when transport stops. Keyed by `region_uuid` so a region re-entry drops its stale tail.
#[derive(Clone, Copy)]
struct ReleaseTail {
    region_uuid: Uuid,
    file: Uuid,
    read_frame: f64,
    rate: f64,
    gain_db: f32,
    remaining: f64,
    window: f64
}

/// A time-stretch region's fade-out driven by ringing its own granular sequencer's voices out (kept alive past
/// the region end or a transport stop). `file` resolves the source each block; `remaining` is a safety cap in
/// output samples (the voices also self-terminate). The sequencer stays in `sequencers`, keyed by `region_uuid`.
#[derive(Clone, Copy)]
struct GranularRelease {
    region_uuid: Uuid,
    file: Uuid,
    remaining: f64
}

/// A Signalsmith (spectral) region's fade-out driven by continuing its player's STREAM past the region end or a
/// stop, with the stream params frozen at the end so the pitch stays correct (a resampled tail would not). The
/// player stays in `signalsmith_players`, keyed by `region_uuid`; `file` resolves the source each block.
#[derive(Clone, Copy)]
struct SignalsmithRelease {
    region_uuid: Uuid,
    file: Uuid,
    time_factor: f64,
    pitch: f32,
    resample: f64,
    gain_db: f32,
    remaining: f64,
    window: f64
}

impl AudioRegionPlayer {
    pub(crate) fn new(tracks: SharedAudioTrackSets, sample_rate: f32, tempo_map: SharedTempoMap,
                      clips: Rc<RefCell<ClipSequencer>>) -> Self {
        Self {tracks, sample_rate, tempo_map, output: shared_audio_buffer(), events: EventBuffer::new(),
            sequencers: Vec::with_capacity(8), native_cursors: Vec::with_capacity(16), visited: Vec::with_capacity(32),
            sequencer_pool: Vec::with_capacity(8),
            signalsmith_players: Vec::with_capacity(4), signalsmith_pool: Vec::with_capacity(4),
            release_tails: Vec::with_capacity(16), granular_releases: Vec::with_capacity(8),
            granular_files: Vec::with_capacity(8), signalsmith_releases: Vec::with_capacity(4),
            signalsmith_templates: Vec::with_capacity(4), enabled: true,
            monitor: None, meter: engine_env::meter::Meter::new(sample_rate), clips}
    }

    /// Set the staged live-input channels summed into the output (EFFECTS monitoring), or `None`. The
    /// monitoring-map change that alters this rewires the unit, so it is set at each (re)build.
    pub(crate) fn set_monitor(&mut self, monitor: Option<(i32, i32)>) {
        self.monitor = monitor;
    }

    /// Pre-warm at RECONCILE (region bind / edit), so region entry during playback never allocates: park a
    /// pooled sequencer for every bound time-stretch region and reserve the per-region bookkeeping for the
    /// total region count. Growth beyond these bounds (e.g. `visited` on many-block quanta) is the accepted
    /// one-time high-water category.
    pub(crate) fn prepare(&mut self, stretch_regions: usize, total_regions: usize) {
        while self.sequencer_pool.len() + self.sequencers.len() < stretch_regions {
            self.sequencer_pool.push(TimeStretchSequencer::new());
        }
        let rate = self.sample_rate;
        while self.signalsmith_pool.len() + self.signalsmith_players.len() < stretch_regions {
            self.signalsmith_pool.push(SignalsmithStretch::preset_default(2, rate));
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
            self.release_tails.clear();
            self.granular_releases.clear();
            self.granular_files.clear();
            self.signalsmith_releases.clear();
            self.signalsmith_templates.clear();
            self.meter.clear();
        }
    }

    /// The peak/RMS broadcast slot of the tape output.
    pub(crate) fn meter_slot(&self) -> engine_env::telemetry::BroadcastSlot {
        self.meter.slot()
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
            sequencer_pool, signalsmith_players, signalsmith_pool, release_tails, granular_releases, granular_files,
            signalsmith_releases, signalsmith_templates, clips, enabled, monitor, meter, ..
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
            // Fade-out tails ring out on EVERY block, including non-playing ones: a transport stop releases the
            // voice over ~20 ms instead of hard-cutting it (the pause click), and a seam tail keeps summing with
            // the next region's fade-in across block boundaries. Runs BEFORE the playing gate for the stop case.
            let stopped = !block.flags.transporting() || !block.flags.playing();
            if stopped {
                // Transport STOP: release every voice that was sounding by seeding a fade-out tail from its last
                // read position, so a sample does not hard-cut to silence (the pause click). Seeded BEFORE the
                // tail render below so it rings out from the pause sample IN THIS block (block.s0 == the stop
                // point). Drain the cursors so this fires once; a resume re-primes fresh cursors. A cursor that
                // never rendered (rate 0) or whose sample is gone is skipped.
                let window = (VOICE_FADE_DURATION * sample_rate as f64).max(1.0);
                for (uuid, cursor) in native_cursors.drain(..) {
                    if cursor.rate <= 0.0 { continue; }
                    release_tails.retain(|tail| tail.region_uuid != uuid);
                    release_tails.push(ReleaseTail {
                        region_uuid: uuid, file: cursor.file, read_frame: cursor.read_frame,
                        rate: cursor.rate, gain_db: cursor.gain_db, remaining: window, window
                    });
                }
                // Granular voices ring out on stop too (their pause click): seed a release for each live sequencer
                // not already releasing, resolving its source via the region->file map.
                for (uuid, sequencer) in sequencers.iter() {
                    if !sequencer.has_voices() || granular_releases.iter().any(|release| release.region_uuid == *uuid) { continue; }
                    if let Some((_, file)) = granular_files.iter().find(|(key, _)| key == uuid) {
                        granular_releases.push(GranularRelease {region_uuid: *uuid, file: *file, remaining: window});
                    }
                }
                // Signalsmith streams keep flowing out on stop too: seed a fresh release from each live player's
                // template (only for players that still exist), unless one is already ringing.
                for (uuid, _) in signalsmith_players.iter() {
                    if signalsmith_releases.iter().any(|release| release.region_uuid == *uuid) { continue; }
                    if let Some((_, template)) = signalsmith_templates.iter().find(|(key, _)| key == uuid) {
                        signalsmith_releases.push(*template);
                    }
                }
            }
            render_release_tails(release_tails, &mut output, block);
            render_granular_releases(granular_releases, sequencers, sequencer_pool, granular_files, &mut output, block);
            render_signalsmith_releases(signalsmith_releases, signalsmith_players, signalsmith_templates, &mut output, block);
            if stopped {
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
                                sequencers, sequencer_pool, signalsmith_players, signalsmith_pool, native_cursors, release_tails,
                                granular_releases, granular_files, signalsmith_releases, signalsmith_templates, visited, &tempo_map, sample_rate);
                        },
                        Some(clip) => {
                            if let Some(bound) = content.clips.iter().find(|bound| bound.clip_uuid == clip) {
                                play_region(&bound.region, section.from, section.to, block, &mut output, &mut fading_gain,
                                    sequencers, sequencer_pool, signalsmith_players, signalsmith_pool, native_cursors, release_tails,
                                    granular_releases, granular_files, signalsmith_releases, signalsmith_templates, visited, &tempo_map, sample_rate);
                            }
                        }
                    }
                });
            }
        }
        // Sum the staged live input into the player output (post regions, pre meter): the tape device is the
        // monitored source, so its meter and any side-chain tapping it carry the live signal. Runs regardless
        // of transport (monitoring works while stopped); mirrors the channel resolution of `MonitorMix`.
        if let Some((left, right)) = *monitor {
            let staging = unsafe { crate::MONITOR_INPUT.get() };
            let left_channel = left as usize;
            if left >= 0 && left_channel < crate::monitor::MONITOR_CHANNELS {
                let right_channel = if (0..crate::monitor::MONITOR_CHANNELS as i32).contains(&right) {
                    right as usize
                } else {
                    left_channel
                };
                for index in 0..engine_env::RENDER_QUANTUM {
                    output.left[index] += staging[left_channel * engine_env::RENDER_QUANTUM + index];
                    output.right[index] += staging[right_channel * engine_env::RENDER_QUANTUM + index];
                }
            }
        }
        meter.process(&output.left, &output.right);
        // Prune per-region state for regions that stopped playing: cursors are plain Copy structs (retain frees
        // nothing), sequencers park in the pool for reuse instead of dropping their voice buffers mid-render.
        let mut index = 0;
        while index < sequencers.len() {
            let uuid = sequencers[index].0;
            // Keep a sequencer that is still visited OR ringing out a granular release (its voices are fading past
            // the region end / a stop); render_granular_releases recycles it when the ring-out finishes.
            if visited.contains(&uuid) || granular_releases.iter().any(|release| release.region_uuid == uuid) {
                index += 1;
            } else {
                let (_, mut sequencer) = sequencers.swap_remove(index);
                sequencer.recycle();
                sequencer_pool.push(sequencer);
                granular_files.retain(|(key, _)| *key != uuid);
            }
        }
        native_cursors.retain(|(uuid, _)| visited.contains(uuid));
        reset_idle_signalsmith_players(signalsmith_players, visited, signalsmith_releases);
    }
}

/// Signalsmith players persist (their stream buffers are expensive to rebuild), but a STOP seeds a release that
/// drives the player's stream FORWARD to ring out (`render_signalsmith_releases`), leaving the read head advanced.
/// Unlike the sequencers/cursors pruned alongside, the player is not recycled — so mark an idle player (not visited
/// this quantum, not ringing a release) for a fresh entry re-prime by clearing its cycle_id. Without this the next
/// play free-runs from the release-advanced position, and each stop advances it further: "a different section of
/// the sample every time I start playing".
fn reset_idle_signalsmith_players(players: &mut [(Uuid, SignalsmithStretch)], visited: &[Uuid],
                                  releases: &[SignalsmithRelease]) {
    for (uuid, player) in players.iter_mut() {
        if !visited.contains(uuid) && !releases.iter().any(|release| release.region_uuid == *uuid) {
            player.set_cycle_id(f64::NAN);
        }
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
               signalsmith_players: &mut Vec<(Uuid, SignalsmithStretch)>, signalsmith_pool: &mut Vec<SignalsmithStretch>,
               native_cursors: &mut Vec<(Uuid, NativeCursor)>, release_tails: &mut Vec<ReleaseTail>,
               granular_releases: &mut Vec<GranularRelease>, granular_files: &mut Vec<(Uuid, Uuid)>,
               signalsmith_releases: &mut Vec<SignalsmithRelease>, signalsmith_templates: &mut Vec<(Uuid, SignalsmithRelease)>,
               visited: &mut Vec<Uuid>, tempo_map: &TempoMap, sample_rate: f32) {
    if region.mute {
        return;
    }
    let Some(sample) = crate::resolve_sample(region.file) else { return };
    let left = sample.plane(0);
    let right = if sample.channel_count >= 2 { sample.plane(1) } else { left };
    if let Some(config) = &region.signalsmith {
        let index = match signalsmith_players.iter().position(|(uuid, _)| *uuid == region.region_uuid) {
            Some(index) => index,
            None => {
                let mut player = signalsmith_pool.pop().unwrap_or_else(|| SignalsmithStretch::preset_default(2, sample_rate));
                // Stagger each voice's FFT-burst phase so concurrent voices don't all synthesize in the SAME
                // render quantum (each voice runs one heavy FFT every `interval` samples = every `quanta`
                // render quanta; phase-locked voices stack their peak cost). Players are per-audio-unit, so the
                // slot must come from a GLOBAL key, not this player's index: derive it from the region uuid, so
                // it is stable across loop-wraps/re-primes and spread over the cycle. Costs a fixed sub-cycle
                // output latency on the voice (a pure delay; a few ms), inaudible for independent material.
                let quanta = (player.interval_samples() / engine_env::RENDER_QUANTUM).max(1);
                let slot = region.region_uuid.iter().fold(0usize, |acc, byte| acc.wrapping_add(*byte as usize)) % quanta;
                player.set_phase_offset(slot * engine_env::RENDER_QUANTUM);
                signalsmith_players.push((region.region_uuid, player));
                signalsmith_players.len() - 1
            }
        };
        visited.push(region.region_uuid);
        play_signalsmith(&mut signalsmith_players[index].1, region, config, left, right, sample.sample_rate, from, to, block, sample_rate, tempo_map,
            signalsmith_releases, signalsmith_templates, output);
        return;
    }
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
            upsert(granular_files, region.region_uuid, region.file);
            // A re-entry (transport looped back in) plays fresh, so drop any release seeded at a previous end.
            granular_releases.retain(|release| release.region_uuid != region.region_uuid);
            let source = Source {left, right, num_frames: sample.frame_count as usize};
            let complete = region.position + region.duration;
            for cycle in locate_loops(region.position, complete, region.loop_offset, region.loop_duration, from, to) {
                fill_fading_gain(fading_gain, region, cycle.result_start, cycle.result_end, block);
                sequencers[index].1.process(
                    output, &source, sample.sample_rate, &region.transients, config,
                    region.waveform_offset, block, cycle.raw_start, cycle.result_start, cycle.result_end,
                    fading_gain, sample_rate);
            }
            // The region ENDS within this block (no authored fade-out): ring its voices out past `complete` so the
            // seam crossfades with the next region's fade-in. Render the in-block portion now (it overlaps the next
            // region rendered after this in the same block); the remainder rides the block loop's release driver.
            let pulses = block.p1 - block.p0;
            if region.fade_out <= 0.0 && complete > from && complete <= to && pulses > 0.0 {
                let samples = (block.s1 - block.s0) as f64;
                let complete_sample = sample_of(block, complete, pulses, samples);
                let block_end = block.s1 as usize;
                let window = (VOICE_FADE_DURATION * sample_rate as f64).max(1.0);
                let unity = [1.0f32; engine_env::RENDER_QUANTUM];
                let count = block_end.saturating_sub(complete_sample);
                sequencers[index].1.render_release(&source, output, complete_sample, count, &unity[..count]);
                granular_releases.retain(|release| release.region_uuid != region.region_uuid);
                granular_releases.push(GranularRelease {region_uuid: region.region_uuid, file: region.file, remaining: window - count as f64});
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
            // Drop a stale tail for this region before rendering: a re-entry (transport looped back into the
            // region) plays fresh, so the previous end's tail must not double up. A tail seeded THIS block is
            // pushed AFTER, so it survives.
            release_tails.retain(|tail| tail.region_uuid != region.region_uuid);
            if let Some(tail) = render_region(output, region, left, right, sample.sample_rate, from, to, block, sample_rate, tempo_map, &mut native_cursors[index].1) {
                release_tails.push(tail);
            }
        }
    }
}

/// Drive the Signalsmith spectral players for one region/block: follow the warp (time) and
/// transpose (pitch), summing into `output` with gain + fade envelope. Streams continuously; only
/// re-primes at a discontinuity. Pitch compensates the source-vs-engine sample-rate ratio.
#[allow(clippy::too_many_arguments)]
fn play_signalsmith(player: &mut SignalsmithStretch, region: &AudioRegion, config: &SignalsmithConfig,
                    left: &[f32], right: &[f32], source_rate: f32, from: f64, to: f64, block: &Block, engine_rate: f32, tempo_map: &TempoMap,
                    signalsmith_releases: &mut Vec<SignalsmithRelease>, signalsmith_templates: &mut Vec<(Uuid, SignalsmithRelease)>, output: &mut AudioBuffer) {
    let pulses = block.p1 - block.p0;
    if pulses <= 0.0 { return; }
    let samples = (block.s1 - block.s0) as f64;
    let complete = region.position + region.duration;
    let gain = db_to_gain(region.gain_db);
    let warp = &config.warp;
    // Pitch is the MUSICAL transpose only. The source-vs-engine sample-rate difference is handled by a
    // time-domain `resample` read inside the processor (transparent), NOT by a spectral shift (which smears
    // transients). So at transpose 0 the spectral pitch is exactly 1.0 and native playback is bit-transparent
    // at any engine rate. Positions/rates below are in ENGINE-rate source samples to match.
    let pitch = math::pow(2.0, config.transpose as f64 / 12.0) as f32;
    let resample = source_rate as f64 / engine_rate as f64; // actual source samples per engine-rate sample
    let source_frames = left.len();
    let declick_pulses = seconds_to_pulses(VOICE_FADE_DURATION, block.bpm) as f64;
    // The region starts partway INTO its source (so a fade-in is needed to avoid an onset click) when the read
    // begins past frame 0. A CUT expresses that mid-file start via loop_offset (RegionEditing.cut moves
    // loop_offset, never waveform_offset), so both must be consulted — guarding on waveform_offset alone left a
    // cut's second region with no fade-in, hard-starting at full gain against the first region's declicked end.
    let declick_in = region.waveform_offset > 0.0 || region.loop_offset > 0.0;
    let mut scratch_l = [0.0f32; engine_env::RENDER_QUANTUM];
    let mut scratch_r = [0.0f32; engine_env::RENDER_QUANTUM];
    // A re-entry plays fresh (re-primes below), so drop any release seeded at a previous end.
    signalsmith_releases.retain(|release| release.region_uuid != region.region_uuid);
    let mut last_time_factor = 1.0f64;
    for cycle in locate_loops(region.position, complete, region.loop_offset, region.loop_duration, from, to) {
        let begin = sample_of(block, cycle.result_start, pulses, samples);
        let end = sample_of(block, cycle.result_end, pulses, samples);
        let count = end.saturating_sub(begin);
        if count == 0 { continue; }
        let (source_pos, time_factor) = if warp.is_empty() {
            let read = (tempo_map.interval_to_seconds(cycle.raw_start, cycle.result_start) + region.waveform_offset) * engine_rate as f64;
            (read, 1.0f64)
        } else {
            let content_ppqn = cycle.result_start - cycle.raw_start;
            let (first, last) = (warp[0].0, warp[warp.len()-1].0);
            if content_ppqn < first || content_ppqn >= last { continue; }
            let seconds = warp_seconds(warp, content_ppqn, cycle.result_start_value as f64);
            let warp_rate = warp_playback_rate(warp, content_ppqn, source_rate, pulses, samples);
            let source_pos = (seconds + region.waveform_offset) * engine_rate as f64;
            // time_factor = MUSICAL stretch = 1/(engine-rate source samples per output sample) = resample/warp_rate.
            (source_pos, if warp_rate > 1e-9 { resample / warp_rate } else { 1.0 })
        };
        if source_pos < 0.0 || (source_pos * resample) as usize >= source_frames { continue; }
        // Re-prime at a discontinuity: a transport jump (block flag), a region loop WRAP (the cycle's
        // `raw_start` jumps by loop_duration), or region entry (cycle_id still NaN). Otherwise the stream flows
        // across marker boundaries. Without the raw_start check a looped region reads straight past the source
        // end after the first cycle instead of wrapping — the loop goes silent.
        // A re-prime is needed on region ENTRY (first play), a region LOOP wrap (raw_start jumped), or any
        // transport DISCONTINUITY (an arrangement/transport loop jumping back, or a seek). All but the first
        // entry re-prime to a position we may already have primed — a region loop and a transport loop both
        // repeat the SAME source position deterministically — so try the cached primed snapshot (a memcpy)
        // instead of recomputing the multi-frame priming burst. A cache miss (new position / changed tempo or
        // pitch) falls back to reset+prime, and `arm_capture` snapshots that prime for next time.
        let entry = player.cycle_id().is_nan();
        let reprime = entry || block.flags.discontinuous()
            || (player.cycle_id() - cycle.raw_start).abs() >= 1e-6;
        let restored = reprime && !entry && player.try_restore(time_factor, pitch, resample, source_pos);
        if reprime && !restored {
            player.reset_stream(source_pos);
            player.arm_capture(time_factor, pitch, resample, source_pos);
        }
        player.set_cycle_id(cycle.raw_start);
        player.process_stream_stereo(left, right, &mut scratch_l[..count], &mut scratch_r[..count], time_factor, pitch, resample);
        last_time_factor = time_factor;
        for i in 0..count {
            let index = begin + i;
            let pulse = block.p0 + (index as f64 - block.s0 as f64) / samples * pulses;
            // declick_out = false: the fade-OUT is the stream continuing PAST the region end (the SignalsmithRelease
            // below), so a cut seam crossfades with the next region's fade-in instead of both dipping.
            let envelope = fade_gain(pulse - region.position, region.duration, region, declick_pulses, declick_in, false);
            let scale = gain * envelope;
            output.left[index] += scratch_l[i]*scale;
            output.right[index] += scratch_r[i]*scale;
        }
    }
    // Remember this region's stream params so a transport stop can seed a release from the frozen state.
    let template = SignalsmithRelease {
        region_uuid: region.region_uuid, file: region.file, time_factor: last_time_factor, pitch, resample,
        gain_db: region.gain_db, remaining: (VOICE_FADE_DURATION * engine_rate as f64).max(1.0), window: (VOICE_FADE_DURATION * engine_rate as f64).max(1.0)
    };
    match signalsmith_templates.iter_mut().find(|(uuid, _)| *uuid == region.region_uuid) {
        Some(entry) => entry.1 = template,
        None => signalsmith_templates.push((region.region_uuid, template))
    }
    // The region ENDS within this block (no authored fade-out): keep streaming the player PAST `complete` with a
    // fade-out (its params frozen at the end so the pitch stays correct), overlapping the next region's fade-in.
    // Render the in-block portion now; the remainder rides the block loop's Signalsmith release driver.
    if region.fade_out <= 0.0 && complete > from && complete <= to {
        let complete_sample = sample_of(block, complete, pulses, samples);
        let block_end = block.s1 as usize;
        let window = (VOICE_FADE_DURATION * engine_rate as f64).max(1.0);
        let count = block_end.saturating_sub(complete_sample);
        if count > 0 {
            player.process_stream_stereo(left, right, &mut scratch_l[..count], &mut scratch_r[..count], last_time_factor, pitch, resample);
            for i in 0..count {
                let scale = gain * ((window - i as f64) / window) as f32;
                output.left[complete_sample + i] += scratch_l[i]*scale;
                output.right[complete_sample + i] += scratch_r[i]*scale;
            }
        }
        signalsmith_releases.retain(|release| release.region_uuid != region.region_uuid);
        signalsmith_releases.push(SignalsmithRelease {
            region_uuid: region.region_uuid, file: region.file, time_factor: last_time_factor, pitch, resample,
            gain_db: region.gain_db, remaining: window - count as f64, window
        });
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
    // Boundary declick at the region's OWN start/end (not internal grain boundaries, which the granular voices
    // already crossfade). A CUT splits a time-stretch region into two abutting regions with SEPARATE granular
    // sequencers, so their grains do not stitch across the seam: without this fade region A hard-cuts into region
    // B = a loud high-pitch click. The fade-in guard consults loop_offset because a cut expresses the second
    // region's mid-file start there (mirrors render_region / play_signalsmith).
    let declick_pulses = seconds_to_pulses(VOICE_FADE_DURATION, block.bpm) as f64;
    let declick_in = region.waveform_offset > 0.0 || region.loop_offset > 0.0;
    for (index, slot) in buffer.iter_mut().enumerate().take(count) {
        let ppqn = start_ppqn + if count > 0 { index as f64 / count as f64 * span_ppqn } else { 0.0 };
        // declick_out = false: the granular path fades OUT by ringing its voices out PAST the region end (the
        // GranularRelease), not by carving its own last 20 ms — so a cut seam crossfades instead of dipping.
        *slot = fade_gain(ppqn, region.duration, region, declick_pulses, declick_in, false);
    }
    count
}

/// Render ONE fade-out tail into `[block.s0, block.s1)` over the given source planes, advancing its read + ramp.
/// Returns whether the tail survives (gain not yet 0 and not run off the source end) — the testable core.
fn render_one_tail(tail: &mut ReleaseTail, left: &[f32], right: &[f32], output: &mut AudioBuffer, block: &Block) -> bool {
    let frames = left.len();
    let gain = db_to_gain(tail.gain_db);
    for index in block.s0 as usize..block.s1 as usize {
        if tail.remaining <= 0.0 { return false; }
        let base = tail.read_frame as usize;
        if base >= frames { return false; }
        let frac = (tail.read_frame - base as f64) as f32;
        let scale = gain * (tail.remaining / tail.window) as f32;
        output.left[index] += interpolate(left, base, frac) * scale;
        output.right[index] += interpolate(right, base, frac) * scale;
        tail.read_frame += tail.rate;
        tail.remaining -= 1.0;
    }
    tail.remaining > 0.0
}

/// Insert-or-update `key -> value` in a small assoc vec (region_uuid -> file for live granular sequencers).
fn upsert(map: &mut Vec<(Uuid, Uuid)>, key: Uuid, value: Uuid) {
    match map.iter_mut().find(|(existing, _)| *existing == key) {
        Some(entry) => entry.1 = value,
        None => map.push((key, value))
    }
}

/// Render each active fade-out tail, dropping the ones that reach 0 gain or run off the source end. Runs every
/// block (including non-playing ones, so a stop release keeps ringing). Resolves each tail's own source from the
/// registry directly — the region it came from is no longer being played.
fn render_release_tails(tails: &mut Vec<ReleaseTail>, output: &mut AudioBuffer, block: &Block) {
    tails.retain_mut(|tail| match crate::resolve_sample(tail.file) {
        Some(sample) => {
            let left = sample.plane(0);
            let right = if sample.channel_count >= 2 { sample.plane(1) } else { left };
            render_one_tail(tail, left, right, output, block)
        }
        None => false
    });
}

/// Drive each active granular release: ring its sequencer's voices out for this block, dropping (and recycling
/// the sequencer of) the ones whose voices finished or whose safety window elapsed. The sequencer stays in
/// `sequencers` while releasing; its source is resolved by `file`.
fn render_granular_releases(
    releases: &mut Vec<GranularRelease>,
    sequencers: &mut Vec<(Uuid, TimeStretchSequencer)>,
    sequencer_pool: &mut Vec<TimeStretchSequencer>,
    granular_files: &mut Vec<(Uuid, Uuid)>,
    output: &mut AudioBuffer,
    block: &Block
) {
    let buffer_start = block.s0 as usize;
    let count = (block.s1 - block.s0) as usize;
    let unity = [1.0f32; engine_env::RENDER_QUANTUM];
    releases.retain_mut(|release| {
        let Some(seq_index) = sequencers.iter().position(|(uuid, _)| *uuid == release.region_uuid) else { return false };
        let active = match crate::resolve_sample(release.file) {
            Some(sample) => {
                let source = Source {
                    left: sample.plane(0),
                    right: if sample.channel_count >= 2 { sample.plane(1) } else { sample.plane(0) },
                    num_frames: sample.frame_count as usize
                };
                sequencers[seq_index].1.render_release(&source, output, buffer_start, count, &unity[..count])
            }
            None => false
        };
        release.remaining -= count as f64;
        let keep = active && release.remaining > 0.0;
        if !keep {
            let (_, mut sequencer) = sequencers.swap_remove(seq_index);
            sequencer.recycle();
            sequencer_pool.push(sequencer);
            granular_files.retain(|(uuid, _)| *uuid != release.region_uuid);
        }
        keep
    });
}

/// Drive each active Signalsmith release: continue its player's spectral stream for this block with a fade-out
/// (params frozen at the region end, so the pitch is right), dropping releases whose window elapsed or whose
/// player/source is gone. The player stays in `players` (Signalsmith players are keyed by uuid, not pruned here).
fn render_signalsmith_releases(
    releases: &mut Vec<SignalsmithRelease>,
    players: &mut Vec<(Uuid, SignalsmithStretch)>,
    templates: &mut Vec<(Uuid, SignalsmithRelease)>,
    output: &mut AudioBuffer,
    block: &Block
) {
    let buffer_start = block.s0 as usize;
    let count = (block.s1 - block.s0) as usize;
    let mut scratch_l = [0.0f32; engine_env::RENDER_QUANTUM];
    let mut scratch_r = [0.0f32; engine_env::RENDER_QUANTUM];
    releases.retain_mut(|release| {
        let Some(pi) = players.iter().position(|(uuid, _)| *uuid == release.region_uuid) else { return false };
        match crate::resolve_sample(release.file) {
            Some(sample) => {
                let left = sample.plane(0);
                let right = if sample.channel_count >= 2 { sample.plane(1) } else { left };
                players[pi].1.process_stream_stereo(left, right, &mut scratch_l[..count], &mut scratch_r[..count], release.time_factor, release.pitch, release.resample);
                let gain = db_to_gain(release.gain_db);
                for i in 0..count {
                    let scale = gain * ((release.remaining - i as f64) / release.window).clamp(0.0, 1.0) as f32;
                    output.left[buffer_start + i] += scratch_l[i] * scale;
                    output.right[buffer_start + i] += scratch_r[i] * scale;
                }
            }
            None => return false
        }
        release.remaining -= count as f64;
        let keep = release.remaining > 0.0;
        if !keep {
            // Drop the template so the stop-seeding does NOT re-seed this finished release next block (which would
            // stream on forever, pulsing — the "does not pause" bug). A resume re-creates the template.
            templates.retain(|(uuid, _)| *uuid != release.region_uuid);
        }
        keep
    });
}

/// Render one region's contribution for one block, summing into `output` (the testable core — takes the source
/// planes as slices, so a test feeds synthetic frames without the shared-memory `SampleRef`). Returns a fade-out
/// TAIL when the region's content ENDS within this block with no authored fade-out: the native fade happens by
/// reading PAST the region end (seeded here, rendered by `render_release_tails`), so a cut seam self-crossfades.
#[allow(clippy::too_many_arguments)] // positional source planes / rates / block / tempo map / cursor; a struct adds no clarity
fn render_region(output: &mut AudioBuffer, region: &AudioRegion, left: &[f32], right: &[f32], source_rate: f32, from: f64, to: f64, block: &Block, engine_rate: f32, tempo_map: &TempoMap, cursor: &mut NativeCursor) -> Option<ReleaseTail> {
    let pulses = block.p1 - block.p0;
    if pulses <= 0.0 {
        return None;
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
    // The region starts partway INTO its source (so a fade-in is needed to avoid an onset click) when the read
    // begins past frame 0. A CUT expresses that mid-file start via loop_offset (RegionEditing.cut moves
    // loop_offset, never waveform_offset), so both must be consulted — guarding on waveform_offset alone left a
    // cut's second region with no fade-in, hard-starting at full gain against the first region's declicked end.
    let declick_in = region.waveform_offset > 0.0 || region.loop_offset > 0.0;
    // The source frame + rate at the last rendered cycle's end, for seeding a fade-out tail past `complete`.
    let (mut end_frame, mut end_rate) = (0.0f64, 0.0f64);
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
            // declick_out = false: the native path fades OUT by reading PAST the region end (the release tail
            // seeded below), not by carving its own last 20 ms — so at a cut A's tail overlaps B's fade-in into a
            // transparent self-crossfade instead of both dipping toward the seam.
            let envelope = fade_gain(pulse - region.position, region.duration, region, declick_pulses, declick_in, false);
            let scale = gain * envelope;
            output.left[index] += interpolate(left, base, frac) * scale;
            output.right[index] += interpolate(right, base, frac) * scale;
        }
        // The source frame + rate at this cycle's END, captured for BOTH the native and the pitch-warp path so a
        // fade-out tail can continue the read past the region end. The warp rate varies, but over the ~20 ms tail
        // holding the last cycle's rate is a faithful approximation.
        end_frame = read_start + (end - begin) as f64 * rate;
        end_rate = rate;
        // Mirror the end read position / rate / source into the cursor for a transport-stop release (both native
        // and pitch-warp regions release this way). The native free-run CONTINUATION fields (next_pulse, raw_start)
        // are set only for the no-stretch path, which reads through the cursor; the warp path reseats each cycle.
        cursor.read_frame = end_frame;
        cursor.file = region.file;
        cursor.gain_db = region.gain_db;
        cursor.rate = end_rate;
        if region.warp.is_empty() {
            cursor.next_pulse = cycle.result_end;
            cursor.raw_start = cycle.raw_start;
        }
    }
    // Seed a fade-out tail when the region's content ENDS within this block (no authored fade-out), for native AND
    // pitch-warp regions. The read continues PAST `complete` from the end frame at the end rate, so the fade
    // overlaps the next region's fade-in reading the same source frames — a transparent self-crossfade at a cut, or
    // a clean read-through fade into silence at a free edge. `complete > from` guards against re-seeding on a later
    // block where the region already ended. The in-block portion renders here so it overlaps a following region in
    // the SAME block; the remainder rides `render_release_tails` across later blocks.
    if region.fade_out <= 0.0 && end_rate > 0.0 && complete > from && complete <= to {
        let complete_sample = sample_of(block, complete, pulses, samples);
        let block_end = block.s1 as usize;
        let window = (VOICE_FADE_DURATION * engine_rate as f64).max(1.0);
        let mut read_frame = end_frame;
        let mut elapsed = 0.0f64;
        for index in complete_sample..block_end {
            let base = read_frame as usize;
            if elapsed >= window || base >= source_frames { break; }
            let frac = (read_frame - base as f64) as f32;
            let scale = gain * ((window - elapsed) / window) as f32;
            output.left[index] += interpolate(left, base, frac) * scale;
            output.right[index] += interpolate(right, base, frac) * scale;
            read_frame += end_rate;
            elapsed += 1.0;
        }
        let remaining = window - elapsed;
        if remaining > 0.0 && (read_frame as usize) < source_frames {
            return Some(ReleaseTail {
                region_uuid: region.region_uuid, file: region.file,
                read_frame, rate: end_rate, gain_db: region.gain_db, remaining, window
            });
        }
    }
    None
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
fn fade_gain(position: f64, duration: f64, region: &AudioRegion, declick_pulses: f64, declick_in: bool, declick_out: bool) -> f32 {
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
    } else if declick_out && declick_pulses > 0.0 && position > duration - declick_pulses {
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
            fade_in_slope: 0.5, fade_out_slope: 0.5, warp: Vec::new(), time_stretch: None, signalsmith: None, transients: Vec::new()
        }
    }

    // A playing block covering the first 64 samples from transport 0 at 120 bpm.
    fn block() -> Block {
        Block {index: 0, flags: BlockFlags::create(true, false, true, false), p0: 0.0, p1: 240.0, s0: 0, s1: 64, bpm: 120.0}
    }

    fn empty_player() -> AudioRegionPlayer {
        AudioRegionPlayer::new(
            Rc::new(RefCell::new(Vec::new())), 48_000.0,
            Rc::new(RefCell::new(TempoMap::fixed(120.0))),
            Rc::new(RefCell::new(ClipSequencer::new())))
    }

    // Drive the native render head over `blocks` REALISTIC 128-sample quanta (25 samples/ppqn at 120 bpm / 48 k,
    // so a pulse-based fade-in and the sample-based tail span the SAME number of samples — unlike the compressed
    // single-block helpers). Mirrors the player: render pending fade tails, then each overlapping region (drop its
    // stale tail, render, keep any seeded tail). Returns the mono output. `stop_after` stops the transport after
    // that many blocks (a non-playing tail-only remainder), to exercise the pause release.
    fn run_native(regions: &[AudioRegion], source: &[f32], blocks: usize, stop_after: usize) -> Vec<f32> {
        let tempo = TempoMap::fixed(120.0);
        let spp = 25.0f64; // 48000 / (120/60 * 960)
        let mut cursors: Vec<(Uuid, NativeCursor)> = regions.iter().map(|r| (r.region_uuid, NativeCursor::new())).collect();
        let mut tails: Vec<ReleaseTail> = Vec::new();
        let mut out = Vec::with_capacity(blocks * 128);
        for k in 0..blocks {
            let playing = k < stop_after;
            let p0 = (k * 128) as f64 / spp;
            let p1 = ((k + 1) * 128) as f64 / spp;
            let block = Block {index: k as u32, flags: BlockFlags::create(playing, k == 0, playing, false), p0, p1, s0: 0, s1: 128, bpm: 120.0};
            let mut output = AudioBuffer::new();
            if !playing {
                // Mirror the player's transport-stop release: seed a tail from each live cursor BEFORE rendering.
                let window = (VOICE_FADE_DURATION * 48_000.0f64).max(1.0);
                for (uuid, cursor) in cursors.drain(..) {
                    if cursor.rate <= 0.0 { continue; }
                    tails.retain(|tail| tail.region_uuid != uuid);
                    tails.push(ReleaseTail {region_uuid: uuid, file: cursor.file,
                        read_frame: cursor.read_frame, rate: cursor.rate, gain_db: cursor.gain_db, remaining: window, window});
                }
            }
            tails.retain_mut(|tail| render_one_tail(tail, source, source, &mut output, &block));
            if playing {
                for (ri, region) in regions.iter().enumerate() {
                    let complete = region.position + region.duration;
                    if region.position >= p1 || complete <= p0 { continue; } // mimic iterate_range overlap
                    tails.retain(|tail| tail.region_uuid != region.region_uuid);
                    if let Some(tail) = render_region(&mut output, region, source, source, 48_000.0, p0, p1, &block, 48_000.0, &tempo, &mut cursors[ri].1) {
                        tails.push(tail);
                    }
                }
            }
            out.extend_from_slice(&output.left[..128]);
        }
        out
    }

    // The fix for "monitoring-with-effects gives the tape device no signal": the armed tape sums the staged
    // live input into its OWN output (no separate downstream node), so the tape device — its meter and any
    // side-chain tapping it (e.g. a vocoder modulator) — carries the live input. No regions, transport idle.
    #[test]
    fn monitoring_sums_the_staged_input_into_the_tape_output() {
        let quantum = engine_env::RENDER_QUANTUM;
        {
            let staging = unsafe { crate::MONITOR_INPUT.get() };
            for sample in staging.iter_mut() {*sample = 0.0;}
            for index in 0..quantum {
                staging[index] = 0.5; // channel 0 -> left
                staging[quantum + index] = -0.5; // channel 1 -> right
            }
        }
        let mut player = empty_player();
        player.set_monitor(Some((0, 1)));
        player.process(&ProcessInfo {blocks: &[]});
        let output = player.audio_output();
        let buffer = output.borrow();
        assert!((0..quantum).all(|index| (buffer.left[index] - 0.5).abs() < 1e-6),
            "the staged left channel is summed into the tape output");
        assert!((0..quantum).all(|index| (buffer.right[index] + 0.5).abs() < 1e-6),
            "the staged right channel is summed into the tape output");
        let slot = player.meter_slot();
        assert!(slot.borrow()[0] > 0.0, "the tape device meters the live input (peak L)");
        drop(buffer);
        // Without a monitor mapping the tape output stays silent (the map change rewires and re-sets this).
        player.set_monitor(None);
        player.process(&ProcessInfo {blocks: &[]});
        let output = player.audio_output();
        let buffer = output.borrow();
        assert!((0..quantum).all(|index| buffer.left[index] == 0.0 && buffer.right[index] == 0.0),
            "no monitor mapping leaves the tape output silent");
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
    fn region_end_fades_out_as_a_tail() {
        // A native region with no following region and no authored fade-out plays at FULL right up to its end,
        // then fades out over ~20 ms (960 samples @ 48 k) by reading the source PAST the region end — not a hard
        // cut (click), and not a dip carved from its own content (the old before-end declick).
        let source = vec![0.5f32; 40_000];
        let mut r = region(0.0, 0.0, 0.0); r.position = 0.0; r.duration = 250.0; r.loop_offset = 0.0; r.loop_duration = 1000.0;
        let out = run_native(&[r], &source, 120, 120);
        let end = 6250usize; // 250 ppqn * 25 samples/ppqn
        assert!(out[end - 200] > 0.45, "plays full right up to its end, no before-end dip: {}", out[end - 200]);
        assert!(out[end + 200] > out[end + 800], "the tail ramps DOWN past the end: {} vs {}", out[end + 200], out[end + 800]);
        assert!(out[end + 960] < 0.05, "faded out ~20 ms (960 samples) past the end: {}", out[end + 960]);
    }

    #[test]
    fn native_cut_seam_is_transparent() {
        // A center cut into two abutting native regions must play back IDENTICALLY to the uncut region: A's
        // fade-out tail reads the source forward past its end while B fades in over the SAME frames, the two linear
        // ramps summing to unity. Realistic tempo (25 samples/ppqn) so the tail window and B's pulse-based fade-in
        // span the same samples. Compared sample-for-sample against the uncut reference across the seam window.
        let source = vec![0.5f32; 40_000];
        let mut a = region(0.0, 0.0, 0.0); a.region_uuid = [1u8; 16]; a.position = 0.0;   a.duration = 250.0; a.loop_offset = 0.0;   a.loop_duration = 1000.0;
        let mut b = region(0.0, 0.0, 0.0); b.region_uuid = [2u8; 16]; b.position = 250.0; b.duration = 250.0; b.loop_offset = 250.0; b.loop_duration = 1000.0;
        let mut whole = region(0.0, 0.0, 0.0); whole.region_uuid = [3u8; 16]; whole.position = 0.0; whole.duration = 500.0; whole.loop_offset = 0.0; whole.loop_duration = 1000.0;
        let cut = run_native(&[a, b], &source, 120, 120);
        let reference = run_native(&[whole], &source, 120, 120);
        let seam = 6250usize; // 250 ppqn * 25
        let (mut max_dev, mut min_cut) = (0.0f32, 1.0f32);
        for i in (seam - 1200)..(seam + 1200) {
            max_dev = max_dev.max((cut[i] - reference[i]).abs());
            min_cut = min_cut.min(cut[i].abs());
        }
        assert!(min_cut > 0.45, "no dip at the seam (source is 0.5 throughout): min {min_cut}");
        assert!(max_dev < 0.02, "cut plays back like the uncut region across the seam: max deviation {max_dev}");
    }

    #[test]
    fn transport_stop_releases_the_voice_with_a_tail() {
        // Pausing must not hard-cut the sample voice (the pause click). After the transport stops mid-region the
        // read continues from the pause point, fading out over ~20 ms instead of dropping straight to silence.
        let source = vec![0.5f32; 40_000];
        let mut r = region(0.0, 0.0, 0.0); r.position = 0.0; r.duration = 1000.0; r.loop_offset = 0.0; r.loop_duration = 2000.0;
        let out = run_native(&[r], &source, 40, 20); // stop after 20 blocks (sample 2560)
        let stop = 20 * 128; // 2560
        assert!(out[stop - 50] > 0.45, "plays full up to the stop: {}", out[stop - 50]);
        assert!(out[stop + 100] > 0.2, "the voice keeps sounding just after the stop (a release, not a hard cut): {}", out[stop + 100]);
        assert!(out[stop + 960] < 0.05, "released to silence ~20 ms after the stop: {}", out[stop + 960]);
    }

    #[test]
    fn real_cut_seam_does_not_click() {
        // Faithful to RegionEditing.cut: the SECOND region expresses its mid-file start via loop_offset
        // (mod(loopOffset + (cut-position), loopDuration)), NOT waveform_offset (which stays 0). Before the
        // fade-in guard consulted loop_offset, B hard-started at full gain while A declicked its end to ~0, a
        // ~0.9 one-sample step at the seam = the reported high-pitch click. B now fades in symmetrically with
        // A's end declick, so the seam is continuous (no step). Full transparency (no dip at all) comes with
        // the read-past-the-end tail in the next step; here we only assert the discontinuity is gone.
        let source = vec![1.0f32; 200_000];
        let full = Block {index: 0, flags: BlockFlags::create(true, false, true, false), p0: 0.0, p1: 480.0, s0: 0, s1: 128, bpm: 120.0};
        let mut a = region(0.0, 0.0, 0.0); a.position = 0.0;   a.duration = 240.0; a.loop_offset = 0.0;   a.loop_duration = 480.0;
        let mut b = region(0.0, 0.0, 0.0); b.position = 240.0; b.duration = 240.0; b.loop_offset = 240.0; b.loop_duration = 480.0;
        let mut output = AudioBuffer::new();
        render_region(&mut output, &a, &source, &source, 48_000.0, full.p0, full.p1, &full, 48_000.0, &TempoMap::fixed(120.0), &mut NativeCursor::new());
        render_region(&mut output, &b, &source, &source, 48_000.0, full.p0, full.p1, &full, 48_000.0, &TempoMap::fixed(120.0), &mut NativeCursor::new());
        assert!(output.left[20] > 0.9, "region A plays at full inside its half: {}", output.left[20]);
        assert!(output.left[108] > 0.9, "region B plays at full inside its half: {}", output.left[108]);
        let mut max_delta = 0.0f32;
        for i in 1..128 { max_delta = max_delta.max((output.left[i]-output.left[i-1]).abs()); }
        assert!(max_delta < 0.2, "no hard step at the cut seam (the click was ~0.9): max delta {max_delta}");
    }

    #[test]
    fn time_stretch_seam_envelope_is_full_out_and_fades_in() {
        // The granular envelope (`fill_fading_gain`) now plays region A at FULL through its end (declick_out=false):
        // the fade-OUT is the voice ring-out (GranularRelease), not a before-end dip, so A's tail overlaps B's
        // fade-in into a crossfade instead of both dipping. B still fades IN from its mid-file start (loop_offset).
        let block = Block {index: 0, flags: BlockFlags::create(true, false, true, false), p0: 0.0, p1: 480.0, s0: 0, s1: 128, bpm: 120.0};
        let mut a = region(0.0, 0.0, 0.0); a.position = 0.0;   a.duration = 240.0; a.loop_offset = 0.0;   a.loop_duration = 480.0;
        let mut b = region(0.0, 0.0, 0.0); b.position = 240.0; b.duration = 240.0; b.loop_offset = 240.0; b.loop_duration = 480.0;
        let mut buf_a = [1.0f32; engine_env::RENDER_QUANTUM];
        let count_a = fill_fading_gain(&mut buf_a, &a, 0.0, 240.0, &block);
        assert!(buf_a[10] > 0.9, "region A envelope is full inside its half: {}", buf_a[10]);
        assert!(buf_a[count_a - 1] > 0.9, "region A envelope is FULL at its end (fade-out is the voice ring-out): {}", buf_a[count_a - 1]);
        let mut buf_b = [1.0f32; engine_env::RENDER_QUANTUM];
        let count_b = fill_fading_gain(&mut buf_b, &b, 240.0, 480.0, &block);
        assert!(buf_b[0] < 0.2, "region B envelope fades in from ~0 at the seam start: {}", buf_b[0]);
        assert!(buf_b[count_b / 2] > 0.9, "region B envelope reaches full past its fade-in: {}", buf_b[count_b / 2]);
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

    fn sine48k(freq: f64, n: usize) -> Vec<f32> {
        (0..n).map(|i| (0.5*(2.0*core::f64::consts::PI*freq*i as f64/48000.0).sin()) as f32).collect()
    }
    fn dominant48k(x: &[f32]) -> f64 {
        let s = x.len()/2 - 4096; let seg = &x[s..s+8192]; let (mut bp,mut bf)=(0.0f64,0.0f64); let mut f=200.0;
        while f<1500.0 { let w=2.0*core::f64::consts::PI*f/48000.0; let c=2.0*w.cos(); let (mut a,mut b)=(0.0f64,0.0f64);
            for (i,v) in seg.iter().enumerate(){let win=0.5-0.5*(2.0*core::f64::consts::PI*i as f64/seg.len() as f64).cos(); let ss=*v as f64*win+c*a-b; b=a; a=ss;}
            let pw=a*a+b*b-c*a*b; if pw>bp{bp=pw;bf=f;} f+=1.0; } bf
    }
    // Drive play_signalsmith across `blocks` 128-sample quanta, collecting mono output.
    fn run_signalsmith(region: &AudioRegion, config: &SignalsmithConfig, source: &[f32], blocks: usize) -> Vec<f32> {
        let mut player = SignalsmithStretch::preset_default(2, 48000.0);
        let tempo = TempoMap::fixed(120.0);
        let mut out = Vec::with_capacity(blocks*128);
        for k in 0..blocks {
            // each quantum: s0..s1 local (0..128), transport p0/p1 advances by the block's pulse span
            let (p0, p1) = ((k*128) as f64*0.04, ((k+1)*128) as f64*0.04); // 120bpm@48k: 0.04 ppqn/sample
            let block = Block {index: k as u32, flags: BlockFlags::create(true, k==0, true, false), p0, p1, s0: 0, s1: 128, bpm: 120.0};
            let mut output = AudioBuffer::new();
            play_signalsmith(&mut player, region, config, source, source, 48_000.0, p0, p1, &block, 48_000.0, &tempo, &mut Vec::new(), &mut Vec::new(), &mut output);
            out.extend_from_slice(&output.left[..128]);
        }
        out
    }

    #[test]
    fn signalsmith_short_loop_tiles_to_fill_the_region() {
        // drum-like: a 3.75s source, warp 2 bars(7680ppqn)->3.75s, region 4 bars(15360) looping every 2 bars.
        // The loop WRAP must re-prime the stream so bars 3-4 replay the source instead of reading past its end.
        let source = sine48k(220.0, 190_000);
        let mut region = region(0.0, 0.0, 0.0);
        region.position = 0.0; region.duration = 15_360.0; region.loop_offset = 0.0; region.loop_duration = 7_680.0;
        let config = SignalsmithConfig { warp: vec![(0.0, 0.0), (7_680.0, 3.75)], transpose: 0.0 };
        region.signalsmith = Some(config.clone());
        let out = run_signalsmith(&region, &config, &source, 3000); // 8s = 4 bars @120bpm = 4 bars @120bpm
        let rms = |seg: &[f32]| -> f64 { (seg.iter().map(|v| (*v as f64).powi(2)).sum::<f64>()/seg.len() as f64).sqrt() };
        let bars12 = rms(&out[10_000..190_000]);
        let bars34 = rms(&out[200_000..380_000]);
        std::eprintln!("bars 1-2 rms {bars12:.4}   bars 3-4 rms {bars34:.4}");
        assert!(bars12 > 0.05, "bars 1-2 audible");
        assert!(bars34 > 0.05, "bars 3-4 audible (loop tiled the 2-bar source): {bars34:.4}");
        // The loop wrap restores the cached prime instead of re-priming; iteration 2 must reproduce iteration 1
        // sample-for-sample (2-bar loop = 192000 output samples @120bpm/48k), proving restore == reset+prime.
        let mut max_diff = 0.0f32;
        for i in 10_000..180_000 { max_diff = max_diff.max((out[i] - out[i + 192_000]).abs()); }
        std::eprintln!("iteration 1 vs 2 (restore) max abs diff {max_diff:.2e}");
        assert!(max_diff < 1e-5, "cached-prime restore must reproduce the real prime: iterations differ by {max_diff:.2e}");
    }

    #[test]
    fn signalsmith_loop_wrap_does_not_bleed_post_loop_content() {
        // Loop content [0, 3.75s) is 220 Hz; the source CONTINUES past the loop end at 880 Hz. A correct loop
        // wrap must re-read the loop's start (220 Hz), never leak the 880 Hz that lives just past the loop end.
        // Guards the soft-seek path: its synthesis lookahead has already read past the loop end at the wrap.
        let source: Vec<f32> = (0..190_000).map(|i| {
            let freq = if i < 180_000 { 220.0 } else { 880.0 };
            (0.5 * (2.0 * core::f64::consts::PI * freq * i as f64 / 48000.0).sin()) as f32
        }).collect();
        let mut region = region(0.0, 0.0, 0.0);
        region.position = 0.0; region.duration = 15_360.0; region.loop_offset = 0.0; region.loop_duration = 7_680.0;
        let config = SignalsmithConfig { warp: vec![(0.0, 0.0), (7_680.0, 3.75)], transpose: 0.0 };
        region.signalsmith = Some(config.clone());
        let out = run_signalsmith(&region, &config, &source, 3000);
        // Goertzel power at a frequency over an 8192-sample window.
        let power = |start: usize, freq: f64| -> f64 {
            let seg = &out[start..start + 8192];
            let w = 2.0 * core::f64::consts::PI * freq / 48000.0; let c = 2.0 * w.cos();
            let (mut a, mut b) = (0.0f64, 0.0f64);
            for value in seg { let s = *value as f64 + c*a - b; b = a; a = s; }
            a*a + b*b - c*a*b
        };
        // The wrap lands at result 2 bars = 4 s = sample 192000. Check the window straddling it.
        let wrap = 192_000usize;
        let (loop_220, bleed_880) = (power(wrap, 220.0), power(wrap, 880.0));
        std::eprintln!("at wrap: 220Hz power {loop_220:.3e}  880Hz power {bleed_880:.3e}  ratio {:.4}", bleed_880 / loop_220.max(1e-12));
        assert!(bleed_880 < loop_220 * 0.01, "post-loop 880 Hz must not bleed at the wrap (got {:.3} of the 220 Hz)", bleed_880 / loop_220.max(1e-12));
    }

    #[test]
    fn signalsmith_loop_wrap_cache_survives_pulse_jitter() {
        // `time_factor` jitters by ULPs as the transport advances (pulses = p1 - p0 of GROWING positions), so an
        // exact cache-key compare misses most wraps deep into playback and the re-prime burst returns (the
        // studio's 80% loop-restart spike). The tolerant match must keep serving wraps from the memcpy fast path.
        let source = sine48k(220.0, 190_000);
        let mut region = region(0.0, 0.0, 0.0);
        region.position = 0.0; region.duration = 3_000_000.0; region.loop_offset = 0.0; region.loop_duration = 7_680.0;
        let config = SignalsmithConfig { warp: vec![(0.0, 0.0), (7_680.0, 3.75)], transpose: 0.0 };
        region.signalsmith = Some(config.clone());
        let mut player = SignalsmithStretch::preset_default(2, 48000.0);
        let tempo = TempoMap::fixed(120.0);
        let blocks = 40_000usize; // ~26 loop wraps, reaching pulse positions where the jitter is well past ULP
        for k in 0..blocks {
            let (p0, p1) = ((k*128) as f64*0.04, ((k+1)*128) as f64*0.04);
            let block = Block {index: k as u32, flags: BlockFlags::create(true, k==0, true, false), p0, p1, s0: 0, s1: 128, bpm: 120.0};
            let mut output = AudioBuffer::new();
            play_signalsmith(&mut player, &region, &config, &source, &source, 48_000.0, p0, p1, &block, 48_000.0, &tempo, &mut Vec::new(), &mut Vec::new(), &mut output);
        }
        let restores = player.cache_restores();
        std::eprintln!("cache restores over {blocks} blocks: {restores} (exact-match compare only managed 19)");
        assert!(restores >= 24, "cache must survive pulse jitter; only {restores} of ~26 wraps hit the fast path");
    }

    #[test]
    fn signalsmith_transport_loop_cache_hits() {
        // An arrangement/transport loop jumps the playhead back to the loop start — a DISCONTINUITY, not a
        // region loop wrap — re-priming the region at the same source position every pass. The cache must serve
        // these too (they are just as deterministic), else a looped section re-primes (bursts) on every pass.
        let source = sine48k(220.0, 190_000);
        let mut region = region(0.0, 0.0, 0.0);
        region.position = 0.0; region.duration = 3_000_000.0; region.loop_offset = 0.0; region.loop_duration = 3_000_000.0; // region itself never wraps
        let config = SignalsmithConfig { warp: vec![(0.0, 0.0), (7_680.0, 3.75)], transpose: 0.0 };
        region.signalsmith = Some(config.clone());
        let mut player = SignalsmithStretch::preset_default(2, 48000.0);
        let tempo = TempoMap::fixed(120.0);
        let loop_blocks = 300usize; // ~1 bar of transport per pass
        for iteration in 0..20 {
            for b in 0..loop_blocks {
                let (p0, p1) = ((b*128) as f64*0.04, ((b+1)*128) as f64*0.04);
                let disc = b == 0; // transport jumps back to the loop start at the top of every pass
                let block = Block {index: (iteration*loop_blocks+b) as u32, flags: BlockFlags::create(true, disc, true, false), p0, p1, s0: 0, s1: 128, bpm: 120.0};
                let mut output = AudioBuffer::new();
                play_signalsmith(&mut player, &region, &config, &source, &source, 48_000.0, p0, p1, &block, 48_000.0, &tempo, &mut Vec::new(), &mut Vec::new(), &mut output);
            }
        }
        let restores = player.cache_restores();
        std::eprintln!("transport-loop cache restores: {restores} of ~19 passes");
        assert!(restores >= 18, "transport loop must hit the cache; only {restores} passes did");
    }

    #[test]
    fn signalsmith_replay_after_stop_reprimes_to_region_start() {
        // Reported bug: after cutting a Signalsmith region, EVERY start plays a DIFFERENT section of the sample.
        // Cause: a STOP seeds a release that drives the persisted player's stream forward to ring out the tail
        // (advancing the read head); the player is never recycled, so on the next play — from the same transport
        // position, so no discontinuity and cycle_id already equals raw_start — reprime does NOT fire and the
        // stream free-runs from the advanced head. `reset_idle_signalsmith_players` clears the idle player's
        // cycle_id so the next play is a fresh entry that re-primes to the region start. Source is a chirp so a
        // free-run's advanced read head lands on an audibly different frequency than a correct re-prime.
        let source: Vec<f32> = (0..600_000)
            .map(|i| {let t = i as f32 / 48_000.0; (2.0 * core::f32::consts::PI * (110.0 + t * 200.0) * t).sin()})
            .collect();
        let mut region = region(0.0, 0.0, 0.0);
        region.duration = 96_000.0; region.loop_duration = 3_000_000.0; // long: the region never wraps in this test
        let config = SignalsmithConfig {warp: Vec::new(), transpose: 0.0}; // native rate: source advances ~1:1
        region.signalsmith = Some(config.clone());
        let tempo = TempoMap::fixed(120.0);
        // One play pass from transport 0 with NO discontinuity flag (a plain play-from-stop, the head does not jump).
        let play_pass = |player: &mut SignalsmithStretch, templates: &mut Vec<(Uuid, SignalsmithRelease)>| -> Vec<f32> {
            let mut out = Vec::with_capacity(40 * 128);
            for b in 0..40 {
                let (p0, p1) = ((b * 128) as f64 * 0.04, ((b + 1) * 128) as f64 * 0.04);
                let block = Block {index: b as u32, flags: BlockFlags::create(true, false, true, false), p0, p1, s0: 0, s1: 128, bpm: 120.0};
                let mut output = AudioBuffer::new();
                play_signalsmith(player, &region, &config, &source, &source, 48_000.0, p0, p1, &block, 48_000.0, &tempo,
                    &mut Vec::new(), templates, &mut output);
                out.extend_from_slice(&output.left[..128]);
            }
            out
        };
        // Reference: a fresh player's first pass (the correct, re-primed-at-start output).
        let reference = play_pass(&mut SignalsmithStretch::preset_default(2, 48_000.0), &mut Vec::new());
        // Under test: play once, STOP (drive the release to advance the read head), idle-reset, then replay.
        let mut players: Vec<(Uuid, SignalsmithStretch)> = vec![(region.region_uuid, SignalsmithStretch::preset_default(2, 48_000.0))];
        let mut templates: Vec<(Uuid, SignalsmithRelease)> = Vec::new();
        let _first = play_pass(&mut players[0].1, &mut templates);
        let mut releases: Vec<SignalsmithRelease> = Vec::new();
        if let Some((_, template)) = templates.iter().find(|(uuid, _)| *uuid == region.region_uuid) {
            releases.push(*template);
        }
        for b in 0..8 { // ring out the stop tail — this is what advances the persisted player's read head
            let block = Block {index: 100 + b, flags: BlockFlags::create(false, false, false, false), p0: 0.0, p1: 0.0, s0: 0, s1: 128, bpm: 120.0};
            let mut output = AudioBuffer::new();
            render_signalsmith_releases(&mut releases, &mut players, &mut templates, &mut output, &block);
        }
        reset_idle_signalsmith_players(&mut players, &[], &releases); // THE FIX: no region visited, release done
        let replay = play_pass(&mut players[0].1, &mut templates);
        let diff: f64 = reference.iter().zip(&replay).map(|(a, b)| (*a as f64 - *b as f64).powi(2)).sum::<f64>()
            / reference.len() as f64;
        assert!(diff < 1e-3, "replay after stop must re-prime to the region start, not free-run (rms^2 diff {diff:.6})");
    }

    #[test]
    fn signalsmith_transpose_up_an_octave() {
        let source = sine48k(440.0, 48000);
        let mut region = region(0.0, 0.0, 0.0);
        region.duration = 96_000.0;
        let config = SignalsmithConfig { warp: Vec::new(), transpose: 12.0 };
        region.signalsmith = Some(SignalsmithConfig { warp: Vec::new(), transpose: 12.0 });
        let out = run_signalsmith(&region, &config, &source, 300); // ~38k samples
        let f = dominant48k(&out);
        assert!((f-880.0).abs() < 20.0, "transpose +12 -> ~880 Hz, got {f:.0}");
    }

    #[test]
    fn signalsmith_native_reproduces_pitch() {
        let source = sine48k(440.0, 48000);
        let mut region = region(0.0, 0.0, 0.0);
        let config = SignalsmithConfig { warp: Vec::new(), transpose: 0.0 };
        region.signalsmith = Some(SignalsmithConfig { warp: Vec::new(), transpose: 0.0 });
        let out = run_signalsmith(&region, &config, &source, 300);
        let f = dominant48k(&out);
        assert!((f-440.0).abs() < 12.0, "no transpose -> ~440 Hz preserved, got {f:.0}");
    }

    #[test]
    fn signalsmith_phase_offset_delays_through_play_signalsmith() {
        let source = sine48k(220.0, 190_000);
        let mut region = region(0.0, 0.0, 0.0);
        region.duration = 96_000.0;
        let config = SignalsmithConfig { warp: Vec::new(), transpose: 0.0 };
        region.signalsmith = Some(config.clone());
        let render = |off: usize| -> Vec<f32> {
            let mut player = SignalsmithStretch::preset_default(2, 48000.0);
            player.set_phase_offset(off);
            let tempo = TempoMap::fixed(120.0);
            let mut out = Vec::new();
            for k in 0..80 {
                let (p0, p1) = ((k*128) as f64*0.04, ((k+1)*128) as f64*0.04);
                let block = Block {index: k as u32, flags: BlockFlags::create(true, k==0, true, false), p0, p1, s0: 0, s1: 128, bpm: 120.0};
                let mut output = AudioBuffer::new();
                play_signalsmith(&mut player, &region, &config, &source, &source, 48_000.0, p0, p1, &block, 48_000.0, &tempo, &mut Vec::new(), &mut Vec::new(), &mut output);
                out.extend_from_slice(&output.left[..128]);
            }
            out
        };
        let a = render(0); let b = render(400);
        let (mut diff, mut energy) = (0.0f64, 0.0f64);
        for i in 20*128..60*128 { diff += ((a[i]-b[i]) as f64).abs(); energy += (a[i] as f64).abs(); }
        let rel = diff / energy.max(1e-9);
        std::eprintln!("play_signalsmith offset 0 vs 400 rel diff: {rel:.3}");
        assert!(rel > 0.05, "play_signalsmith must honor phase_offset (rel diff {rel:.3})");
    }


    #[test]
    fn signalsmith_warp_stretch_preserves_pitch() {
        // warp maps 1536 ppqn (~0.8s timeline @120bpm) to 0.533s of source = 1.5x slower.
        // A time-stretch must keep the pitch at 440 while playing back slower.
        let source = sine48k(440.0, 48000);
        let mut region = region(0.0, 0.0, 0.0);
        let warp = vec![(0.0, 0.0), (1536.0, 0.533)];
        let config = SignalsmithConfig { warp: warp.clone(), transpose: 0.0 };
        region.signalsmith = Some(SignalsmithConfig { warp, transpose: 0.0 });
        let out = run_signalsmith(&region, &config, &source, 300);
        let f = dominant48k(&out);
        assert!((f-440.0).abs() < 12.0, "1.5x time-stretch keeps pitch at 440, got {f:.0}");
    }

    #[test]
    fn signalsmith_variable_warp_stays_stable() {
        // multi-segment warp (accelerating tempo across the region) — variable time_factor mid-play.
        let source = sine48k(330.0, 48000);
        let mut region = region(0.0, 0.0, 0.0);
        // three segments with different slopes (source seconds per ppqn changes at each marker)
        let warp = vec![(0.0, 0.0), (512.0, 0.15), (1024.0, 0.35), (1536.0, 0.45)];
        let config = SignalsmithConfig { warp: warp.clone(), transpose: 0.0 };
        region.signalsmith = Some(SignalsmithConfig { warp, transpose: 0.0 });
        let out = run_signalsmith(&region, &config, &source, 300);
        let peak = out.iter().fold(0.0f32, |m,v| m.max(v.abs()));
        let rms = (out.iter().map(|v| (*v as f64).powi(2)).sum::<f64>()/out.len() as f64).sqrt();
        assert!(peak < 2.0 && rms > 0.02, "stable under variable warp: peak {peak:.2} rms {rms:.3}");
    }

}
