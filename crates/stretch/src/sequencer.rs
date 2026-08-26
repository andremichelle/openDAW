//! The transient-aligned granular sequencer, ported from `engine/src/time_stretch.rs` and evolved.
//! The control logic — transient-shift lookahead, drift continuation, the 0.99..1.01 unity window,
//! the once-voice maintenance pass, the pre-roll rule and the START-POSITION-POP clamp — is kept
//! verbatim (each encodes a fixed bug). What changed: markers carry `TransientDescriptor`s instead of
//! bare positions, all constants come from `Tuning`, output is two plain slices and block timing is
//! the engine-agnostic `BlockInfo`, so the engine adapter later maps `abi::Block`/`AudioBuffer` onto
//! this in a few lines. With `Tuning::legacy()` the output is sample-identical to the shipped engine.

use alloc::vec::Vec;
use dsp::ppqn::pulses_to_seconds;
use math::round;
use crate::descriptor::TransientDescriptor;
use crate::tuning::Tuning;
use crate::voice::{OnceVoice, PingpongVoice, RepeatVoice, Voice, VoiceParams};
use crate::warp::{floor_last_index_by, ppqn_to_seconds, seconds_to_ppqn};

pub use crate::voice::Source;

/// How a transient segment is filled when the timeline asks for MORE output than the segment has
/// source (WASM CONTRACT: mirror the TS `TransientPlayMode` enum order).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TransientPlayMode {
    Once,
    Repeat,
    Pingpong
}

impl TransientPlayMode {
    pub fn from_i32(value: i32) -> Self {
        match value {
            1 => Self::Repeat,
            2 => Self::Pingpong,
            _ => Self::Once
        }
    }
}

/// The `AudioTimeStretchBox` config: warp markers (content ppqn -> source seconds, sorted), the
/// transient fill mode, and the user playback-rate multiplier.
pub struct StretchConfig<'a> {
    pub warp: &'a [(f64, f64)],
    pub transient_play_mode: TransientPlayMode,
    pub playback_rate: f32
}

/// Engine-agnostic block timing; the engine adapter fills this from `abi::Block`. `s0`/`s1` are
/// sample indices into the output slices passed to `process` (the engine passes quantum buffers with
/// within-quantum indices; the lab passes the whole output with absolute indices — same math).
#[derive(Clone, Copy, Debug)]
pub struct BlockInfo {
    pub p0: f64,
    pub p1: f64,
    pub s0: u32,
    pub s1: u32,
    pub bpm: f32,
    pub discontinuous: bool
}

/// One transient segment's bounds, in source SAMPLES, plus whether a next transient exists and where.
struct SegmentInfo {
    start_samples: f64,
    end_samples: f64,
    has_next: bool,
    next_transient_seconds: f64
}

pub struct Stretcher {
    voices: Vec<Voice>,
    spawn: Vec<Voice>,
    current_transient_index: i32,
    accumulated_drift: f64,
    continued_boundaries: u32,
    /// RMS of the loop window the ACTIVE voice sustains — continuation must compare the incoming
    /// segment's level against what would keep playing, not against the loop's own segment.
    active_loop_rms: f32,
    tuning: Tuning
}

impl Default for Stretcher {
    fn default() -> Self {
        Self::new()
    }
}

impl Stretcher {
    pub fn new() -> Self {
        Self::with_tuning(Tuning::default())
    }

    pub fn with_tuning(tuning: Tuning) -> Self {
        // pre-reserve so steady-state spawns never grow the heap on the render path
        Self {voices: Vec::with_capacity(8), spawn: Vec::with_capacity(4), current_transient_index: -1, accumulated_drift: 0.0, continued_boundaries: 0, active_loop_rms: 0.0, tuning}
    }

    pub fn tuning(&self) -> &Tuning {
        &self.tuning
    }

    pub fn set_tuning(&mut self, tuning: Tuning) {
        self.tuning = tuning;
    }

    pub fn reset(&mut self) {
        for voice in &mut self.voices {
            voice.start_fade_out(0);
        }
        self.current_transient_index = -1;
        self.accumulated_drift = 0.0;
    }

    /// Hard-clear for POOL reuse: drop all voices outright but keep the Vec capacities.
    pub fn recycle(&mut self) {
        self.voices.clear();
        self.spawn.clear();
        self.current_transient_index = -1;
        self.accumulated_drift = 0.0;
    }

    /// Render one loop cycle of a time-stretch region. `out_left`/`out_right` are summed into;
    /// `markers` are the file's transient descriptors (positions in SECONDS, sorted); `fading_gain`
    /// is the region fade envelope for this cycle, indexed by the within-cycle sample.
    #[allow(clippy::too_many_arguments)]
    pub fn process(
        &mut self,
        out_left: &mut [f32],
        out_right: &mut [f32],
        source: &Source,
        file_rate: f32,
        markers: &[TransientDescriptor],
        config: &StretchConfig,
        waveform_offset: f64,
        block: &BlockInfo,
        cycle_raw_start: f64,
        cycle_result_start: f64,
        cycle_result_end: f64,
        fading_gain: &[f32],
        engine_rate: f32
    ) {
        let warp = config.warp;
        let playback_rate = config.playback_rate as f64;
        let effective_playback_rate = playback_rate * file_rate as f64 / engine_rate as f64;
        let file_duration_seconds = source.num_frames as f64 / file_rate as f64;
        if block.discontinuous {
            self.reset();
        }
        let pn = block.p1 - block.p0;
        let sn = (block.s1 - block.s0) as f64;
        let r0 = (cycle_result_start - block.p0) / pn;
        let r1 = (cycle_result_end - block.p0) / pn;
        let buffer_start = (block.s0 as f64 + sn * r0) as usize;
        let buffer_end = (block.s0 as f64 + sn * r1) as usize;
        let buffer_count = buffer_end.saturating_sub(buffer_start);
        if warp.len() < 2 {
            return;
        }
        let (first_pos, last_pos) = (warp[0].0, warp[warp.len() - 1].0);
        let content_ppqn = cycle_result_start - cycle_raw_start;
        if content_ppqn < first_pos || content_ppqn >= last_pos {
            return;
        }
        let content_ppqn_end = content_ppqn + pn;
        let warp_seconds_end = match ppqn_to_seconds(warp, content_ppqn_end) {
            Some(seconds) => seconds,
            None => return
        };
        let file_seconds_end = warp_seconds_end + waveform_offset;
        if file_seconds_end < 0.0 || file_seconds_end >= file_duration_seconds {
            return;
        }
        let warp_seconds_start = ppqn_to_seconds(warp, content_ppqn).unwrap_or(0.0);
        let file_seconds_start = warp_seconds_start + waveform_offset;
        let file_seconds_span = warp_seconds_end - warp_seconds_start;
        let output_seconds_span = pulses_to_seconds(pn, block.bpm);
        let file_to_output_ratio = if output_seconds_span > 0.0 {file_seconds_span / output_seconds_span} else {1.0};
        let transient_shift_seconds = self.tuning.transient_shift_seconds * file_to_output_ratio * playback_rate * (file_rate as f64 / engine_rate as f64);
        let shifted_file_seconds = file_seconds_end + transient_shift_seconds;
        let transient_index_shifted = floor_last_index_by(markers, shifted_file_seconds, |marker| marker.position);
        if transient_index_shifted < self.current_transient_index {
            self.reset();
        }
        if transient_index_shifted > self.current_transient_index && transient_index_shifted >= 0 {
            if let Some(marker) = markers.get(transient_index_shifted as usize) {
                let transient_seconds = marker.position;
                self.handle_transient_boundary(
                    source, markers, warp, config.transient_play_mode, effective_playback_rate, waveform_offset,
                    block.bpm, engine_rate, file_rate, transient_index_shifted, transient_seconds, file_seconds_start
                );
                self.current_transient_index = transient_index_shifted;
            }
        }
        self.maintain_once_voices(source, markers, warp, config.transient_play_mode, effective_playback_rate, waveform_offset, block.bpm, engine_rate, file_rate, buffer_count);
        for voice in &mut self.voices {
            voice.process(source, out_left, out_right, buffer_start, buffer_count, fading_gain);
        }
        self.voices.retain(|voice| !voice.done());
    }

    /// The OnceVoice maintenance pass: fade out voices that reached their segment end, and, when
    /// looping is needed to fill the remaining output, replace them with a looping voice.
    #[allow(clippy::too_many_arguments)]
    fn maintain_once_voices(
        &mut self, source: &Source, markers: &[TransientDescriptor], warp: &[(f64, f64)], mode: TransientPlayMode,
        effective_playback_rate: f64, waveform_offset: f64, bpm: f32, engine_rate: f32, file_rate: f32, buffer_count: usize
    ) {
        self.spawn.clear();
        let mut index = 0;
        while index < self.voices.len() {
            if !self.voices[index].is_once() || self.voices[index].done() || self.voices[index].is_fading_out() {
                index += 1;
                continue;
            }
            let read_pos = self.voices[index].read_position();
            let seg_end = self.voices[index].segment_end();
            if read_pos >= seg_end {
                self.voices[index].start_fade_out(0);
                index += 1;
                continue;
            }
            if mode != TransientPlayMode::Once {
                if let Some(info) = segment_info(markers, self.current_transient_index, source.num_frames, file_rate) {
                    let segment_length = info.end_samples - info.start_samples;
                    let output_samples_until_next = self.output_samples_until_next(&info, markers, warp, waveform_offset, bpm, engine_rate);
                    let audio_samples_needed = output_samples_until_next * effective_playback_rate;
                    let speed_ratio = segment_length / audio_samples_needed;
                    let close_to_unity = (0.99..=1.01).contains(&speed_ratio);
                    let fill_factor = audio_samples_needed / segment_length;
                    let read_through = self.tuning.adaptive && marker_prefers_read_through(&markers[self.current_transient_index.max(0) as usize]) && fill_factor > 1.01 && fill_factor <= self.tuning.read_through_max_fill;
                    let needs_looping = !close_to_unity && audio_samples_needed > segment_length && !read_through;
                    if needs_looping {
                        self.voices[index].start_fade_out(0);
                        let marker = &markers[self.current_transient_index as usize];
                        spawn_voices(&mut self.spawn, info.start_samples, info.end_samples, effective_playback_rate, engine_rate, mode, true, Some(read_pos), marker, &self.tuning);
                        index += 1;
                        continue;
                    }
                }
            }
            let samples_to_end = (seg_end - read_pos) / effective_playback_rate;
            if samples_to_end < buffer_count as f64 {
                let fade_out_offset = math::clamp(math::floor(samples_to_end), 0.0, f64::MAX) as usize;
                self.voices[index].start_fade_out(fade_out_offset);
            }
            index += 1;
        }
        self.voices.append(&mut self.spawn);
    }

    /// Continue a voice across the boundary when drift is small (so transients already in flight
    /// aren't re-attacked), else fade everything and spawn a fresh voice at the new segment.
    #[allow(clippy::too_many_arguments)]
    fn handle_transient_boundary(
        &mut self, source: &Source, markers: &[TransientDescriptor], warp: &[(f64, f64)], mode: TransientPlayMode,
        playback_rate: f64, waveform_offset: f64, bpm: f32, engine_rate: f32, file_rate: f32,
        transient_index: i32, transient_seconds: f64, file_seconds_start: f64
    ) {
        let info = match segment_info(markers, transient_index, source.num_frames, file_rate) {
            Some(info) => info,
            None => return
        };
        // WEAK-BOUNDARY CONTINUATION (adaptive): a low-strength onset means nothing new happened in
        // the material — extend the playing voices across the boundary instead of crossfading into
        // a fresh spawn. Every avoided crossfade is an avoided audible grain start (the probe's
        // variant matrix showed the boundary crossfades, not the loop splices, dominate the sine
        // and pad modulation).
        if self.tuning.adaptive {
            let marker = &markers[transient_index as usize];
            // Weak alone is not continuable: a sweep's boundaries are weak yet its content drifts —
            // continuing there loops stale material while the timeline moves on (the spectral guard
            // caught exactly that). `has_loop()` already encodes "tonal AND stationary", which is
            // precisely the license continuation needs.
            // Capped: chaining continuations lets one loop go stale while slowly-evolving material
            // (a real pad) moves on — after two extensions the next boundary re-anchors content.
            let same_period = self.current_transient_index >= 0 && marker.period > 0.0 && markers
                .get(self.current_transient_index as usize)
                .map(|previous| previous.period > 0.0 && ((marker.period - previous.period) / previous.period).abs() < 0.02)
                .unwrap_or(false);
            // Sweep-proven: continuation needs a MEASURED period. Periodic material splices perfectly,
            // so continuing avoids needless crossfades (sine -47 dB); beating polyphony has a residual
            // wrap comb that boundary re-anchors BREAK UP — continuing there keeps the comb coherent
            // and audible (pads read 6 dB worse with continuation).
            // Continuation gates on MEASURED splice cleanliness, not period existence: a real pad can
            // have a YIN fundamental yet still beat in its upper partials (loop_score ~0.6) — its wrap
            // comb needs boundary re-anchors just like a chord's. Only near-perfect splices
            // (score > 0.9: sines, clean monophony) earn uninterrupted continuation.
            let sustained = if self.active_loop_rms > 1e-6 { self.active_loop_rms } else { marker.loop_rms };
            let level_representative = marker.rms > 1e-6 && sustained > 1e-6 && libm::log((sustained / marker.rms) as f64).abs() < 0.12;
            if marker.strength < self.tuning.weak_boundary_threshold && marker.loop_score > 0.9 && level_representative && (self.continued_boundaries < 2 || same_period) {
                let mut continued = false;
                for voice in &mut self.voices {
                    // Continuation means "the LOOP keeps sustaining" — Once voices (including
                    // read-through) must fade at their end and let the boundary re-sync, or they
                    // read linearly to EOF and leave a silence step.
                    if !voice.done() && !voice.is_fading_out() && !voice.is_once() {
                        voice.set_segment_end(info.end_samples);
                        continued = true;
                    }
                }
                if continued {
                    self.accumulated_drift = 0.0;
                    self.continued_boundaries += 1;
                    return;
                }
            }
        }
        let segment_length = info.end_samples - info.start_samples;
        let output_samples_until_next = if info.has_next {
            let transient_warp_seconds = transient_seconds - waveform_offset;
            let transient_ppqn = seconds_to_ppqn(warp, transient_warp_seconds);
            let next_warp_seconds = info.next_transient_seconds - waveform_offset;
            let next_ppqn = seconds_to_ppqn(warp, next_warp_seconds);
            pulses_to_seconds(next_ppqn - transient_ppqn, bpm) * engine_rate as f64
        } else {
            f64::INFINITY
        };
        let drift_threshold = self.tuning.drift_threshold_seconds * file_rate as f64;
        let lookahead_samples = self.tuning.boundary_lookahead_seconds * engine_rate as f64 * playback_rate;
        let mut continued_index: Option<usize> = None;
        for (index, voice) in self.voices.iter_mut().enumerate() {
            if voice.done() || !voice.is_once() {
                continue;
            }
            let projected_read_pos = voice.read_position() + lookahead_samples;
            let drift = projected_read_pos - info.start_samples;
            if math::fabs(drift as f32) as f64 >= drift_threshold {
                continue;
            }
            self.accumulated_drift += drift;
            if math::fabs(self.accumulated_drift as f32) as f64 >= drift_threshold {
                self.accumulated_drift = 0.0;
            } else {
                continued_index = Some(index);
                voice.set_segment_end(info.end_samples);
            }
            break;
        }
        if let Some(continued) = continued_index {
            for (index, voice) in self.voices.iter_mut().enumerate() {
                if index != continued && !voice.done() {
                    voice.start_fade_out(0);
                }
            }
            return;
        }
        for voice in &mut self.voices {
            if !voice.done() {
                voice.start_fade_out(0);
            }
        }
        let audio_samples_needed = output_samples_until_next * playback_rate;
        let speed_ratio = segment_length / audio_samples_needed;
        let close_to_unity = (0.99..=1.01).contains(&speed_ratio);
        let fill_factor = audio_samples_needed / segment_length;
        // READ-THROUGH: mild fills play once past the segment into the neighboring material
        // instead of wrapping next to the boundary; the next boundary re-syncs with an aligned
        // crossfade. The voice's end extends by exactly the deficit.
        // A segment whose loop splices cleanly and sustains representatively (the continuation
        // license) loops better than it reads through — read-through is for material that cannot
        // splice cleanly (beating chords, dense texture, drift).
        let read_through = self.tuning.adaptive && marker_prefers_read_through(&markers[transient_index.max(0) as usize]) && fill_factor > 1.01 && fill_factor <= self.tuning.read_through_max_fill;
        let needs_looping = !close_to_unity && audio_samples_needed > segment_length && !read_through;
        let fade_samples_in_file = self.tuning.preroll_seconds * engine_rate as f64 * playback_rate;
        let pre_roll_start = if transient_index == 0 {
            info.start_samples
        } else {
            (info.start_samples - fade_samples_in_file).max(0.0)
        };
        // START-POSITION POP FIX: never read EARLIER in the file than the current playhead. Starting
        // playback inside a silent gap makes `floor_last_index` pick the PRECEDING phrase's transient;
        // without this clamp the voice would replay that phrase (the "breathless pop").
        let playhead_file_samples = file_seconds_start * file_rate as f64;
        let mut voice_start_samples = pre_roll_start.max(playhead_file_samples);
        let marker = &markers[transient_index as usize];
        // PSOLA-style spawn alignment (adaptive, periodic material only): same-frequency crossfades
        // are phase-coherent, and an opposite-phase overlap dips regardless of fade law. Shifting
        // the new voice's read start by the mod-period residual (<= half a period — inaudible
        // micro-timing) phase-matches it to the loudest outgoing voice, so the boundary crossfade
        // sums cleanly.
        // Only weak boundaries get phase-aligned: a REAL onset (a chord stab) needs exact timing —
        // shifting it half a period (5 ms at a 100 Hz root) reads as smear at high ratios; phase
        // coherence only matters where content continues.
        if self.tuning.adaptive && marker.period > 0.0 && marker.strength < self.tuning.weak_boundary_threshold {
            if let Some(old_read) = self.voices.iter().find(|voice| !voice.done()).map(|voice| voice.read_position()) {
                let period = marker.period as f64;
                let mut residual = (old_read - voice_start_samples) % period;
                if residual < 0.0 {
                    residual += period;
                }
                if residual > period * 0.5 {
                    residual -= period;
                }
                voice_start_samples = (voice_start_samples + residual).max(playhead_file_samples);
            }
        }
        let voice_end_samples = if read_through {
            (info.start_samples + audio_samples_needed).min(source.num_frames as f64)
        } else {
            info.end_samples
        };
        spawn_voices(&mut self.voices, voice_start_samples, voice_end_samples, playback_rate, engine_rate, mode, needs_looping, None, marker, &self.tuning);
        self.active_loop_rms = marker.loop_rms;
        self.accumulated_drift = 0.0;
        self.continued_boundaries = 0;
    }

    fn output_samples_until_next(&self, info: &SegmentInfo, markers: &[TransientDescriptor], warp: &[(f64, f64)], waveform_offset: f64, bpm: f32, engine_rate: f32) -> f64 {
        if !info.has_next {
            return f64::INFINITY;
        }
        let Some(marker) = markers.get(self.current_transient_index.max(0) as usize) else {
            return f64::INFINITY;
        };
        let transient_ppqn = seconds_to_ppqn(warp, marker.position - waveform_offset);
        let next_ppqn = seconds_to_ppqn(warp, info.next_transient_seconds - waveform_offset);
        pulses_to_seconds(next_ppqn - transient_ppqn, bpm) * engine_rate as f64
    }

    pub fn voice_count(&self) -> usize {
        self.voices.len()
    }
}


/// A loop that splices near-perfectly and sustains at its segment's level — the same license that
/// authorizes boundary continuation.
fn marker_clean_loop(marker: &TransientDescriptor) -> bool {
    marker.loop_score > 0.9 && marker.rms > 1e-6 && libm::log((marker.loop_rms / marker.rms) as f64).abs() < 0.12
}

/// Read-through preference: beating material (no splice point is clean) or material without any
/// precomputed loop reads through at mild fills; quasi-stationary sustains keep their loops.
fn marker_prefers_read_through(marker: &TransientDescriptor) -> bool {
    !marker_clean_loop(marker) && (marker.beat_seconds > 0.0 || !marker.has_loop())
}

/// Resolve the spawn-time voice parameters from `Tuning` + the segment's descriptor. Legacy: the
/// fixed constants (margins computed with the ENGINE rate — the shipped behavior, preserved).
/// Adaptive: strength-scaled fade, descriptor loop points, harmonicity-scaled and period-snapped
/// loop crossfade.
fn voice_params(segment_start: f64, segment_end: f64, playback_rate: f64, sample_rate: f32, marker: &TransientDescriptor, tuning: &Tuning) -> VoiceParams {
    let legacy_loop_start = segment_start + tuning.loop_margin_start_seconds * sample_rate as f64;
    let legacy_loop_end = segment_end - tuning.loop_margin_end_seconds * sample_rate as f64;
    if !tuning.adaptive {
        return VoiceParams {
            fade_seconds: tuning.voice_fade_seconds,
            equal_power: tuning.equal_power_fades,
            splice_equal_power: tuning.equal_power_fades,
            splice_rho: -1.0,
            loop_start: legacy_loop_start,
            loop_end: legacy_loop_end,
            loop_fade_samples: round(tuning.loop_fade_seconds * sample_rate as f64),
            gain: 1.0
        };
    }
    let strength = math::clamp(marker.strength, 0.0, 1.0) as f64;
    let segment_output_seconds = (segment_end - segment_start) / playback_rate / sample_rate as f64;
    // Long fades are for weak TONAL boundaries; a weak-but-percussive hit (ghost note over a
    // ring-out) still wants a short fade or its attack slows past the source's. And a boundary
    // WITHOUT a loop license (non-stationary or noisy — sweeps) crossfades DIFFERENT frequencies,
    // where a long fade is a long beat-burst: keep those short too.
    let mut softness = (1.0 - strength) * (0.3 + 0.7 * math::clamp(marker.harmonicity, 0.0, 1.0) as f64);
    if !marker.has_loop() {
        softness *= 0.25;
    }
    let fade_raw = tuning.voice_fade_min_seconds + softness * (tuning.voice_fade_max_seconds - tuning.voice_fade_min_seconds);
    let fade_seconds = fade_raw.min(tuning.voice_fade_segment_cap * segment_output_seconds).max(0.001);
    let (loop_start, loop_end) = if marker.has_loop() {
        (marker.loop_start.max(segment_start), marker.loop_end.min(segment_end))
    } else {
        (legacy_loop_start, legacy_loop_end)
    };
    let harmonicity = math::clamp(marker.harmonicity, 0.0, 1.0) as f64;
    let loop_fade_raw = tuning.loop_fade_min_seconds + harmonicity * (tuning.loop_fade_max_seconds - tuning.loop_fade_min_seconds);
    let loop_length_output = (loop_end - loop_start) / playback_rate;
    // Cap FIRST, then snap DOWN to integer periods: snapping before capping let the 25%-of-loop
    // cap truncate a period-snapped fade to a half-period count, breaking the splice phase at
    // every wrap (an audible comb tick at the wrap rate — the probe's 16 Hz line).
    let fade_cap = 0.25 * loop_length_output;
    let mut loop_fade_samples = round(loop_fade_raw * sample_rate as f64).min(fade_cap);
    if marker.period > 0.0 {
        let period_output = marker.period as f64 / playback_rate;
        let cycles = math::floor(loop_fade_samples / period_output);
        if cycles >= 1.0 {
            loop_fade_samples = cycles * period_output;
        }
    }
    loop_fade_samples = loop_fade_samples.max(1.0);
    // Fade law follows coherence: periodic material gets phase-aligned spawns, so its boundary
    // crossfades are coherent and must be LINEAR (equal-power would bump +3 dB); everything else
    // is uncorrelated and wants equal-power. Same rule for the loop splice via alignment.
    let coherent = marker.period > 0.0;
    VoiceParams {
        fade_seconds, equal_power: tuning.equal_power_fades && !coherent,
        splice_equal_power: false,
        splice_rho: if marker.has_loop() {math::clamp(marker.loop_score, 0.0, 1.0) as f64} else {0.0},
        loop_start, loop_end, loop_fade_samples, gain: 1.0
    }
}

/// Pick the voice type for the transient play-mode + whether the segment must loop to fill.
#[allow(clippy::too_many_arguments)]
fn spawn_voices(out: &mut Vec<Voice>, start_samples: f64, end_samples: f64, playback_rate: f64, sample_rate: f32, mode: TransientPlayMode, needs_looping: bool, initial_read_position: Option<f64>, marker: &TransientDescriptor, tuning: &Tuning) {
    if start_samples >= end_samples {
        return;
    }
    let mut params = voice_params(start_samples, end_samples, playback_rate, sample_rate, marker, tuning);
    if mode == TransientPlayMode::Once || !needs_looping {
        out.push(Voice::Once(OnceVoice::new(start_samples, end_samples, playback_rate, 0, sample_rate, &params)));
        return;
    }
    if mode == TransientPlayMode::Repeat {
        // Staggered dual read heads for textures without a clean splice: interleaved wraps
        // decorrelate the comb. Constant-power pair at 1/sqrt(2) each.
        let dual = tuning.adaptive && tuning.texture_dual_loop && !marker_clean_loop(marker)
            && params.loop_end - params.loop_start > 4.0 * params.loop_fade_samples;
        if dual {
            params.gain = core::f32::consts::FRAC_1_SQRT_2;
            out.push(Voice::Repeat(RepeatVoice::new(start_samples, end_samples, playback_rate, 0, sample_rate, initial_read_position, &params)));
            // Second head on a GOLDEN-RATIO loop length: incommensurate wrap rates never phase-lock,
            // so the two combs smear each other instead of stacking (a half-loop stagger with equal
            // lengths merely octaves the comb).
            let mut partner = params;
            let length = params.loop_end - params.loop_start;
            partner.loop_start = params.loop_end - 0.618 * length;
            let midpoint = 0.5 * (partner.loop_start + partner.loop_end);
            out.push(Voice::Repeat(RepeatVoice::new(start_samples, end_samples, playback_rate, 0, sample_rate, Some(midpoint), &partner)));
        } else {
            out.push(Voice::Repeat(RepeatVoice::new(start_samples, end_samples, playback_rate, 0, sample_rate, initial_read_position, &params)));
        }
        return;
    }
    // On a stationary tonal segment a phase-aligned Repeat splice is strictly cleaner than any
    // bounce (time-reversal breaks phase coherence no matter the alignment); Pingpong is a fill
    // strategy, not a chosen sound, so adaptive substitutes the better fill where it provably wins.
    if tuning.adaptive && marker.loop_score > 0.9 {
        out.push(Voice::Repeat(RepeatVoice::new(start_samples, end_samples, playback_rate, 0, sample_rate, initial_read_position, &params)));
        return;
    }
    // Pingpong reverses direction at each bounce — time-reversal breaks phase coherence no matter
    // how well the points align, and a SHORT descriptor loop just bounces faster (audibly worse).
    // Keep the full-segment margin region for pingpong.
    let mut pingpong_params = params;
    pingpong_params.loop_start = start_samples + tuning.loop_margin_start_seconds * sample_rate as f64;
    pingpong_params.loop_end = end_samples - tuning.loop_margin_end_seconds * sample_rate as f64;
    // Shipped bounce fades: the sweep showed no benefit from adaptive fade lengths at a reversal
    // (time-reversal is incoherent regardless), and five pingpong cases regressed with them.
    pingpong_params.loop_fade_samples = round(tuning.loop_fade_seconds * sample_rate as f64);
    let initial = initial_read_position.map(|position| (position, 1.0));
    out.push(Voice::Pingpong(PingpongVoice::new(start_samples, end_samples, playback_rate, 0, sample_rate, initial, &pingpong_params)));
}

/// The sample bounds of transient `index`'s segment (to the next transient, or EOF).
fn segment_info(markers: &[TransientDescriptor], index: i32, num_frames: usize, file_rate: f32) -> Option<SegmentInfo> {
    if index < 0 {
        return None;
    }
    let current = markers.get(index as usize)?.position;
    let next = markers.get(index as usize + 1).map(|marker| marker.position);
    Some(SegmentInfo {
        start_samples: current * file_rate as f64,
        end_samples: next.map(|seconds| seconds * file_rate as f64).unwrap_or(num_frames as f64),
        has_next: next.is_some(),
        next_transient_seconds: next.unwrap_or(f64::INFINITY)
    })
}
