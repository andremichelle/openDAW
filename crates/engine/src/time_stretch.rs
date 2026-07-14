//! The TIME-STRETCH play-mode: a transient-aligned granular sequencer, the engine port of the TS
//! `TimeStretchSequencer` + its three granular voices (`OnceVoice` / `RepeatVoice` / `PingpongVoice`). Where the
//! native + pitch play-modes are a STATELESS read head, time-stretch is stateful: it walks the source's transient
//! markers and, at each transient boundary the timeline crosses, spawns a short granular voice that reads that
//! segment at the (warp-derived) playback rate, crossfading voices so transients stay sharp while the overall
//! tempo is decoupled from pitch. One sequencer lives per playing region (mirrors the TS per-lane sequencer).
//!
//! Faithful to the TS behaviour, with TWO deliberate, documented deviations:
//!  - the START-POSITION POP fix (open.md / time-pitch-start-position-pop): a new voice never reads EARLIER in
//!    the file than the current playhead, so starting playback inside a silent gap plays silence instead of
//!    replaying the preceding phrase. See `voice_start_samples` below.
//!  - voices do not hold the output / source buffers (Rust ownership): those are threaded into `process` per call.
//!
//! `no_std`; voice spawning allocates only by pushing into pre-reserved `Vec`s (a handful of voices), never grows
//! the heap on the steady-state render path.

// The granular voices read/write multiple buffers (output[buffer_start+i], fading_gain[i]) by a shared sample
// index while advancing read state, so the index loops are intentional (not iterable as a single `.iter()`).
#![allow(clippy::needless_range_loop)]

use alloc::vec::Vec;
use dsp::ppqn::pulses_to_seconds;
use engine_env::audio_buffer::AudioBuffer;
use engine_env::block::Block;
use math::round;

const VOICE_FADE_DURATION: f64 = 0.020;
const LOOP_FADE_DURATION: f64 = 0.010;
const LOOP_MARGIN_START: f64 = 0.010;
const LOOP_MARGIN_END: f64 = 0.020;

/// How a transient segment is filled when the timeline asks for MORE output than the segment has source: replay
/// it once (gap), forward-loop it, or bounce it (WASM CONTRACT: mirror the TS `TransientPlayMode` enum order).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum TransientPlayMode {
    Once,
    Repeat,
    Pingpong
}

impl TransientPlayMode {
    pub(crate) fn from_i32(value: i32) -> Self {
        match value {
            1 => Self::Repeat,
            2 => Self::Pingpong,
            _ => Self::Once
        }
    }
}

/// Which stretch engine a time-stretch region uses: the transient-aligned GRANULAR sequencer (this module),
/// or the STFT phase-vocoder COMPLEX sequencer (`stretch`). Mirrors the `AudioTimeStretchBox.algorithm` enum
/// (0 granular, 1 complex); an absent/old field defaults to granular.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum StretchAlgorithm {
    Granular,
    Complex
}

impl StretchAlgorithm {
    pub(crate) fn from_i32(value: i32) -> Self {
        match value {
            1 => Self::Complex,
            _ => Self::Granular
        }
    }
}

/// The `AudioTimeStretchBox` config: warp markers (content ppqn -> source seconds, sorted), the transient
/// fill mode, the user playback-rate multiplier, and the stretch algorithm.
#[derive(Clone)]
pub(crate) struct TimeStretchConfig {
    pub(crate) warp: Vec<(f64, f64)>,
    pub(crate) transient_play_mode: TransientPlayMode,
    pub(crate) playback_rate: f32,
    pub(crate) algorithm: StretchAlgorithm
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum VoiceState {
    Fading,
    Active,
    Done
}

/// A granular voice. All three variants share the fade-in/out amplitude envelope and a read head; Repeat/Pingpong
/// add a loop region (with its own crossfade) inside `[start+margin, end-margin]`.
enum Voice {
    Once(OnceVoice),
    Repeat(RepeatVoice),
    Pingpong(PingpongVoice)
}

impl Voice {
    fn done(&self) -> bool {
        self.fade().state == VoiceState::Done
    }

    fn is_once(&self) -> bool {
        matches!(self, Voice::Once(_))
    }

    fn is_fading_out(&self) -> bool {
        let fade = self.fade();
        fade.state == VoiceState::Fading && fade.fade_direction < 0.0
    }

    fn fade(&self) -> &Fade {
        match self {
            Voice::Once(voice) => &voice.fade,
            Voice::Repeat(voice) => &voice.fade,
            Voice::Pingpong(voice) => &voice.fade
        }
    }

    fn read_position(&self) -> f64 {
        match self {
            Voice::Once(voice) => voice.read_position,
            Voice::Repeat(voice) => voice.read_position,
            Voice::Pingpong(voice) => voice.read_position
        }
    }

    fn segment_end(&self) -> f64 {
        match self {
            Voice::Once(voice) => voice.segment_end,
            Voice::Repeat(voice) => voice.segment_end,
            Voice::Pingpong(voice) => voice.segment_end
        }
    }

    fn set_segment_end(&mut self, end: f64) {
        match self {
            Voice::Once(voice) => voice.segment_end = end,
            Voice::Repeat(voice) => voice.segment_end = end,
            Voice::Pingpong(voice) => voice.segment_end = end
        }
    }

    fn start_fade_out(&mut self, block_offset: usize) {
        match self {
            Voice::Once(voice) => voice.start_fade_out(block_offset),
            Voice::Repeat(voice) => voice.start_fade_out(block_offset),
            Voice::Pingpong(voice) => voice.start_fade_out(block_offset)
        }
    }

    fn process(&mut self, source: &Source, output: &mut AudioBuffer, buffer_start: usize, buffer_count: usize, fading_gain: &[f32]) {
        match self {
            Voice::Once(voice) => voice.process(source, output, buffer_start, buffer_count, fading_gain),
            Voice::Repeat(voice) => voice.process(source, output, buffer_start, buffer_count, fading_gain),
            Voice::Pingpong(voice) => voice.process(source, output, buffer_start, buffer_count, fading_gain)
        }
    }
}

/// The source planes a voice reads, threaded in per call (the voices are stateless about the buffer identity).
pub(crate) struct Source<'a> {
    pub(crate) left: &'a [f32],
    pub(crate) right: &'a [f32],
    pub(crate) num_frames: usize
}

/// The shared fade-in/out amplitude state machine (identical across all three voices). Returns `None` when the
/// voice has just transitioned to `Done` for this sample (the caller breaks), else the gain for this sample.
struct Fade {
    state: VoiceState,
    fade_direction: f64,
    fade_progress: f64,
    length_samples: f64,
    length_inverse: f64,
    fade_out_block_offset: usize
}

impl Fade {
    fn new(segment_start: f64, fade_in_forced: bool, sample_rate: f32) -> Self {
        let length_samples = round(VOICE_FADE_DURATION * sample_rate as f64);
        let (state, fade_direction) = if fade_in_forced || segment_start > 0.0 {
            (VoiceState::Fading, 1.0)
        } else {
            (VoiceState::Active, 0.0)
        };
        Self {state, fade_direction, fade_progress: 0.0, length_samples, length_inverse: 1.0 / length_samples, fade_out_block_offset: 0}
    }

    fn start_fade_out(&mut self, block_offset: usize) {
        if self.state == VoiceState::Done {
            return;
        }
        if self.state == VoiceState::Fading && self.fade_direction < 0.0 {
            return;
        }
        if self.state == VoiceState::Fading && self.fade_direction > 0.0 {
            let current_amplitude = self.fade_progress * self.length_inverse;
            self.fade_progress = self.length_samples * (1.0 - current_amplitude);
        } else {
            self.fade_progress = 0.0;
        }
        self.state = VoiceState::Fading;
        self.fade_direction = -1.0;
        self.fade_out_block_offset = block_offset;
    }

    /// Advance one sample, returning the amplitude (or `None` once Done — the caller must break the sample loop).
    fn next_amplitude(&mut self, i: usize) -> Option<f64> {
        match self.state {
            VoiceState::Done => None,
            VoiceState::Active => Some(1.0),
            VoiceState::Fading => {
                if self.fade_direction > 0.0 {
                    let amplitude = self.fade_progress * self.length_inverse;
                    self.fade_progress += 1.0;
                    if self.fade_progress >= self.length_samples {
                        self.state = VoiceState::Active;
                        self.fade_progress = 0.0;
                        self.fade_direction = 0.0;
                    }
                    Some(amplitude)
                } else if i < self.fade_out_block_offset {
                    Some(1.0)
                } else {
                    let amplitude = 1.0 - self.fade_progress * self.length_inverse;
                    self.fade_progress += 1.0;
                    if self.fade_progress >= self.length_samples {
                        self.state = VoiceState::Done;
                        return None;
                    }
                    Some(amplitude)
                }
            }
        }
    }
}

/// Linear interpolation of a planar source at a fractional frame, or `None` when out of `[0, num_frames - 1)`
/// (TS `readInt >= 0 && readInt < numberOfFrames - 1`). Truncation matches the TS `readPosition | 0`.
#[inline]
fn read_interp(buffer: &[f32], num_frames: usize, position: f64) -> Option<f32> {
    let read_int = position as i64;
    if read_int < 0 || (read_int as usize) >= num_frames.saturating_sub(1) {
        return None;
    }
    let index = read_int as usize;
    let alpha = (position - read_int as f64) as f32;
    let here = buffer[index];
    Some(here + alpha * (buffer[index + 1] - here))
}

/// Plays a segment once, no looping: read start -> segment end, then silence (TS `OnceVoice`).
struct OnceVoice {
    fade: Fade,
    playback_rate: f64,
    segment_end: f64,
    read_position: f64,
    block_offset: usize
}

impl OnceVoice {
    fn new(segment_start: f64, segment_end: f64, playback_rate: f64, block_offset: usize, sample_rate: f32) -> Self {
        Self {fade: Fade::new(segment_start, false, sample_rate), playback_rate, segment_end, read_position: segment_start, block_offset}
    }

    fn start_fade_out(&mut self, block_offset: usize) {
        self.fade.start_fade_out(block_offset);
    }

    fn process(&mut self, source: &Source, output: &mut AudioBuffer, buffer_start: usize, buffer_count: usize, fading_gain: &[f32]) {
        if self.fade.state == VoiceState::Done {
            return;
        }
        let (out_left, out_right) = (&mut output.left, &mut output.right);
        for i in self.block_offset..buffer_count {
            let amplitude = match self.fade.next_amplitude(i) {
                Some(amplitude) => amplitude,
                None => break
            };
            let read = self.read_position;
            if let (Some(sample_l), Some(sample_r)) = (read_interp(source.left, source.num_frames, read), read_interp(source.right, source.num_frames, read)) {
                let gain = (amplitude as f32) * fading_gain[i];
                let j = buffer_start + i;
                out_left[j] += sample_l * gain;
                out_right[j] += sample_r * gain;
            }
            self.read_position += self.playback_rate;
        }
        self.block_offset = 0;
        self.fade.fade_out_block_offset = 0;
    }
}

/// Plays a segment with a seamless forward loop inside `[start+margin, end-margin]`, crossfading at the loop
/// boundary (TS `RepeatVoice`).
struct RepeatVoice {
    fade: Fade,
    playback_rate: f64,
    loop_start: f64,
    loop_end: f64,
    loop_fade_length: f64,
    loop_fade_inverse: f64,
    segment_end: f64,
    read_position: f64,
    loop_crossfade_progress: f64,
    loop_crossfade_position: f64,
    block_offset: usize
}

impl RepeatVoice {
    fn new(segment_start: f64, segment_end: f64, playback_rate: f64, block_offset: usize, sample_rate: f32, initial_read_position: Option<f64>) -> Self {
        let loop_start = segment_start + LOOP_MARGIN_START * sample_rate as f64;
        let loop_end = segment_end - LOOP_MARGIN_END * sample_rate as f64;
        let loop_fade_length = round(LOOP_FADE_DURATION * sample_rate as f64);
        let mut fade = Fade::new(segment_start, initial_read_position.is_some(), sample_rate);
        if loop_start >= loop_end {
            fade.state = VoiceState::Done;
        }
        Self {
            fade, playback_rate, loop_start, loop_end, loop_fade_length, loop_fade_inverse: 1.0 / loop_fade_length,
            segment_end, read_position: initial_read_position.unwrap_or(segment_start), loop_crossfade_progress: 0.0,
            loop_crossfade_position: 0.0, block_offset
        }
    }

    fn start_fade_out(&mut self, block_offset: usize) {
        self.fade.start_fade_out(block_offset);
    }

    fn process(&mut self, source: &Source, output: &mut AudioBuffer, buffer_start: usize, buffer_count: usize, fading_gain: &[f32]) {
        if self.fade.state == VoiceState::Done {
            return;
        }
        let (out_left, out_right) = (&mut output.left, &mut output.right);
        let loop_crossfade_start = self.loop_end - self.loop_fade_length;
        for i in self.block_offset..buffer_count {
            let amplitude = match self.fade.next_amplitude(i) {
                Some(amplitude) => amplitude,
                None => break
            };
            let mut sample_l = read_interp(source.left, source.num_frames, self.read_position).unwrap_or(0.0);
            let mut sample_r = read_interp(source.right, source.num_frames, self.read_position).unwrap_or(0.0);
            if self.loop_crossfade_progress == 0.0 && self.read_position >= loop_crossfade_start {
                self.loop_crossfade_progress = 1.0;
                self.loop_crossfade_position = self.loop_start;
            }
            if self.loop_crossfade_progress > 0.0 {
                if let (Some(loop_l), Some(loop_r)) = (read_interp(source.left, source.num_frames, self.loop_crossfade_position), read_interp(source.right, source.num_frames, self.loop_crossfade_position)) {
                    let crossfade = (self.loop_crossfade_progress * self.loop_fade_inverse) as f32;
                    sample_l = sample_l * (1.0 - crossfade) + loop_l * crossfade;
                    sample_r = sample_r * (1.0 - crossfade) + loop_r * crossfade;
                }
                self.loop_crossfade_position += self.playback_rate;
                self.loop_crossfade_progress += 1.0;
                if self.loop_crossfade_progress >= self.loop_fade_length {
                    self.read_position = self.loop_crossfade_position;
                    self.loop_crossfade_progress = 0.0;
                }
            }
            let gain = (amplitude as f32) * fading_gain[i];
            let j = buffer_start + i;
            out_left[j] += sample_l * gain;
            out_right[j] += sample_r * gain;
            self.read_position += self.playback_rate;
        }
        self.block_offset = 0;
        self.fade.fade_out_block_offset = 0;
    }
}

/// Plays a segment bouncing forward/backward within `[start+margin, end-margin]`, equal-power (cos/sin)
/// crossfade at each bounce (TS `PingpongVoice`).
struct PingpongVoice {
    fade: Fade,
    playback_rate: f64,
    loop_start: f64,
    loop_end: f64,
    bounce_fade_length: f64,
    segment_end: f64,
    read_position: f64,
    direction: f64,
    bounce_progress: f64,
    bounce_position: f64,
    block_offset: usize
}

impl PingpongVoice {
    fn new(segment_start: f64, segment_end: f64, playback_rate: f64, block_offset: usize, sample_rate: f32, initial: Option<(f64, f64)>) -> Self {
        let loop_start = segment_start + LOOP_MARGIN_START * sample_rate as f64;
        let loop_end = segment_end - LOOP_MARGIN_END * sample_rate as f64;
        let bounce_fade_length = round(LOOP_FADE_DURATION * sample_rate as f64);
        let mut fade = Fade::new(segment_start, initial.is_some(), sample_rate);
        if loop_start >= loop_end {
            fade.state = VoiceState::Done;
        }
        let (read_position, direction) = initial.unwrap_or((segment_start, 1.0));
        Self {
            fade, playback_rate, loop_start, loop_end, bounce_fade_length, segment_end, read_position, direction,
            bounce_progress: 0.0, bounce_position: 0.0, block_offset
        }
    }

    fn start_fade_out(&mut self, block_offset: usize) {
        self.fade.start_fade_out(block_offset);
    }

    fn process(&mut self, source: &Source, output: &mut AudioBuffer, buffer_start: usize, buffer_count: usize, fading_gain: &[f32]) {
        if self.fade.state == VoiceState::Done {
            return;
        }
        let (out_left, out_right) = (&mut output.left, &mut output.right);
        let bounce_start_forward = self.loop_end - self.bounce_fade_length;
        let bounce_start_backward = self.loop_start + self.bounce_fade_length;
        for i in self.block_offset..buffer_count {
            let amplitude = match self.fade.next_amplitude(i) {
                Some(amplitude) => amplitude,
                None => break
            };
            let mut sample_l = read_interp(source.left, source.num_frames, self.read_position).unwrap_or(0.0);
            let mut sample_r = read_interp(source.right, source.num_frames, self.read_position).unwrap_or(0.0);
            if self.bounce_progress == 0.0 {
                if self.direction > 0.0 && self.read_position >= bounce_start_forward {
                    self.bounce_progress = 1.0;
                    self.bounce_position = self.loop_end;
                } else if self.direction < 0.0 && self.read_position <= bounce_start_backward {
                    self.bounce_progress = 1.0;
                    self.bounce_position = self.loop_start;
                }
            }
            if self.bounce_progress > 0.0 {
                if let (Some(bounce_l), Some(bounce_r)) = (read_interp(source.left, source.num_frames, self.bounce_position), read_interp(source.right, source.num_frames, self.bounce_position)) {
                    let t = (self.bounce_progress / self.bounce_fade_length) as f32;
                    let fade_out = math::cos(t * core::f32::consts::PI * 0.5);
                    let fade_in = math::sin(t * core::f32::consts::PI * 0.5);
                    sample_l = sample_l * fade_out + bounce_l * fade_in;
                    sample_r = sample_r * fade_out + bounce_r * fade_in;
                }
                self.bounce_position -= self.direction * self.playback_rate;
                self.bounce_progress += 1.0;
                if self.bounce_progress >= self.bounce_fade_length {
                    self.read_position = self.bounce_position;
                    self.direction = -self.direction;
                    self.bounce_progress = 0.0;
                }
            }
            let gain = (amplitude as f32) * fading_gain[i];
            let j = buffer_start + i;
            out_left[j] += sample_l * gain;
            out_right[j] += sample_r * gain;
            self.read_position += self.direction * self.playback_rate;
        }
        self.block_offset = 0;
        self.fade.fade_out_block_offset = 0;
    }
}

/// One transient segment's bounds, in source SAMPLES, plus whether a next transient exists and where (seconds).
struct SegmentInfo {
    start_samples: f64,
    end_samples: f64,
    has_next: bool,
    next_transient_seconds: f64
}

/// The transient-aligned granular sequencer (TS `TimeStretchSequencer`). Persistent across blocks for one region.
pub(crate) struct TimeStretchSequencer {
    voices: Vec<Voice>,
    spawn: Vec<Voice>,
    current_transient_index: i32,
    accumulated_drift: f64
}

impl TimeStretchSequencer {
    pub(crate) fn new() -> Self {
        // pre-reserve so steady-state spawns never grow the heap on the render path
        Self {voices: Vec::with_capacity(8), spawn: Vec::with_capacity(4), current_transient_index: -1, accumulated_drift: 0.0}
    }

    pub(crate) fn reset(&mut self) {
        for voice in &mut self.voices {
            voice.start_fade_out(0);
        }
        self.current_transient_index = -1;
        self.accumulated_drift = 0.0;
    }

    /// Hard-clear for POOL reuse (another region takes this sequencer over): drop all voices outright
    /// (their fade-outs belong to the previous region's source) but keep the Vec capacities.
    pub(crate) fn recycle(&mut self) {
        self.voices.clear();
        self.spawn.clear();
        self.current_transient_index = -1;
        self.accumulated_drift = 0.0;
    }

    /// Render one loop cycle of a time-stretch region. `output` is summed into; `source` are the file planes;
    /// `transients` are the file's transient marker positions in SECONDS (sorted); `warp`/`mode`/`playback_rate`
    /// come from the `AudioTimeStretchBox`; `fading_gain` is the region fade envelope for this cycle, indexed by
    /// the within-cycle sample. `engine_rate`/`file_rate` are the output and source sample rates.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn process(
        &mut self,
        output: &mut AudioBuffer,
        source: &Source,
        file_rate: f32,
        transients: &[f64],
        config: &TimeStretchConfig,
        waveform_offset: f64,
        block: &Block,
        cycle_raw_start: f64,
        cycle_result_start: f64,
        cycle_result_end: f64,
        fading_gain: &[f32],
        engine_rate: f32
    ) {
        let warp = &config.warp;
        let playback_rate = config.playback_rate as f64;
        let effective_playback_rate = playback_rate * file_rate as f64 / engine_rate as f64;
        let file_duration_seconds = source.num_frames as f64 / file_rate as f64;
        if block.flags.discontinuous() {
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
        let transient_shift_seconds = VOICE_FADE_DURATION * file_to_output_ratio * playback_rate * (file_rate as f64 / engine_rate as f64);
        let shifted_file_seconds = file_seconds_end + transient_shift_seconds;
        let transient_index_shifted = floor_last_index(transients, shifted_file_seconds);
        if transient_index_shifted < self.current_transient_index {
            self.reset();
        }
        if transient_index_shifted > self.current_transient_index && transient_index_shifted >= 0 {
            if let Some(&transient_seconds) = transients.get(transient_index_shifted as usize) {
                self.handle_transient_boundary(
                    source, transients, warp, config.transient_play_mode, effective_playback_rate, waveform_offset,
                    block.bpm, engine_rate, file_rate, transient_index_shifted, transient_seconds, file_seconds_start
                );
                self.current_transient_index = transient_index_shifted;
            }
        }
        self.maintain_once_voices(source, transients, warp, config.transient_play_mode, effective_playback_rate, waveform_offset, block.bpm, engine_rate, file_rate, buffer_count);
        for voice in &mut self.voices {
            voice.process(source, output, buffer_start, buffer_count, fading_gain);
        }
        self.voices.retain(|voice| !voice.done());
    }

    /// The OnceVoice maintenance pass (TS lines 82-130): fade out voices that reached their segment end, and,
    /// when looping is needed to fill the remaining output, replace them with a looping voice.
    #[allow(clippy::too_many_arguments)]
    fn maintain_once_voices(
        &mut self, source: &Source, transients: &[f64], warp: &[(f64, f64)], mode: TransientPlayMode,
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
                if let Some(info) = segment_info(transients, self.current_transient_index, source.num_frames, file_rate) {
                    let segment_length = info.end_samples - info.start_samples;
                    let output_samples_until_next = self.output_samples_until_next(&info, transients, warp, waveform_offset, bpm, engine_rate);
                    let audio_samples_needed = output_samples_until_next * effective_playback_rate;
                    let speed_ratio = segment_length / audio_samples_needed;
                    let close_to_unity = (0.99..=1.01).contains(&speed_ratio);
                    let needs_looping = !close_to_unity && audio_samples_needed > segment_length;
                    if needs_looping {
                        self.voices[index].start_fade_out(0);
                        if let Some(voice) = create_voice(info.start_samples, info.end_samples, effective_playback_rate, engine_rate, mode, true, Some(read_pos)) {
                            self.spawn.push(voice);
                        }
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

    /// TS `#handleTransientBoundary`: continue a voice across the boundary when drift is small (so transients
    /// already in flight aren't re-attacked), else fade everything and spawn a fresh voice at the new segment.
    #[allow(clippy::too_many_arguments)]
    fn handle_transient_boundary(
        &mut self, source: &Source, transients: &[f64], warp: &[(f64, f64)], mode: TransientPlayMode,
        playback_rate: f64, waveform_offset: f64, bpm: f32, engine_rate: f32, file_rate: f32,
        transient_index: i32, transient_seconds: f64, file_seconds_start: f64
    ) {
        let info = match segment_info(transients, transient_index, source.num_frames, file_rate) {
            Some(info) => info,
            None => return
        };
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
        let drift_threshold = VOICE_FADE_DURATION * file_rate as f64;
        let lookahead_samples = VOICE_FADE_DURATION * engine_rate as f64 * playback_rate;
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
        let needs_looping = !close_to_unity && audio_samples_needed > segment_length;
        let fade_samples_in_file = VOICE_FADE_DURATION * engine_rate as f64 * playback_rate;
        let pre_roll_start = if transient_index == 0 {
            info.start_samples
        } else {
            (info.start_samples - fade_samples_in_file).max(0.0)
        };
        // START-POSITION POP FIX (open.md): never read EARLIER in the file than the current playhead. Starting
        // playback inside a silent gap makes `floor_last_index` pick the PRECEDING phrase's transient; without
        // this clamp the voice would replay that phrase (the "breathless pop"). Clamping the read start up to the
        // playhead file position makes a gap-start read silence, and leaves normal boundary spawns (where the
        // playhead sits at the onset) effectively unchanged.
        let playhead_file_samples = file_seconds_start * file_rate as f64;
        let voice_start_samples = pre_roll_start.max(playhead_file_samples);
        if let Some(voice) = create_voice(voice_start_samples, info.end_samples, playback_rate, engine_rate, mode, needs_looping, None) {
            self.voices.push(voice);
        }
        self.accumulated_drift = 0.0;
    }

    fn output_samples_until_next(&self, info: &SegmentInfo, transients: &[f64], warp: &[(f64, f64)], waveform_offset: f64, bpm: f32, engine_rate: f32) -> f64 {
        if !info.has_next {
            return f64::INFINITY;
        }
        let Some(&current_seconds) = transients.get(self.current_transient_index.max(0) as usize) else {
            return f64::INFINITY;
        };
        let transient_ppqn = seconds_to_ppqn(warp, current_seconds - waveform_offset);
        let next_ppqn = seconds_to_ppqn(warp, info.next_transient_seconds - waveform_offset);
        pulses_to_seconds(next_ppqn - transient_ppqn, bpm) * engine_rate as f64
    }

    #[cfg(test)]
    fn voice_count(&self) -> usize {
        self.voices.len()
    }
}

/// TS `#createVoice`: pick the voice type for the transient play-mode + whether the segment must loop to fill.
fn create_voice(start_samples: f64, end_samples: f64, playback_rate: f64, sample_rate: f32, mode: TransientPlayMode, needs_looping: bool, initial_read_position: Option<f64>) -> Option<Voice> {
    if start_samples >= end_samples {
        return None;
    }
    if mode == TransientPlayMode::Once || !needs_looping {
        return Some(Voice::Once(OnceVoice::new(start_samples, end_samples, playback_rate, 0, sample_rate)));
    }
    if mode == TransientPlayMode::Repeat {
        return Some(Voice::Repeat(RepeatVoice::new(start_samples, end_samples, playback_rate, 0, sample_rate, initial_read_position)));
    }
    let initial = initial_read_position.map(|position| (position, 1.0));
    Some(Voice::Pingpong(PingpongVoice::new(start_samples, end_samples, playback_rate, 0, sample_rate, initial)))
}

/// TS `#getSegmentInfo`: the sample bounds of transient `index`'s segment (to the next transient, or EOF).
fn segment_info(transients: &[f64], index: i32, num_frames: usize, file_rate: f32) -> Option<SegmentInfo> {
    if index < 0 {
        return None;
    }
    let current = *transients.get(index as usize)?;
    let next = transients.get(index as usize + 1).copied();
    Some(SegmentInfo {
        start_samples: current * file_rate as f64,
        end_samples: next.map(|seconds| seconds * file_rate as f64).unwrap_or(num_frames as f64),
        has_next: next.is_some(),
        next_transient_seconds: next.unwrap_or(f64::INFINITY)
    })
}

/// The last index whose value is <= `value` (TS `EventCollection.floorLastIndex`); `-1` when all are greater.
fn floor_last_index(values: &[f64], value: f64) -> i32 {
    values.partition_point(|entry| *entry <= value) as i32 - 1
}

/// Source seconds at content `ppqn`, linearly interpolated between bracketing warp markers (TS `#ppqnToSeconds`);
/// `None` when no segment brackets it. Shared with the COMPLEX stretch sequencer.
pub(crate) fn ppqn_to_seconds(warp: &[(f64, f64)], ppqn: f64) -> Option<f64> {
    for window in warp.windows(2) {
        let (left, right) = (window[0], window[1]);
        if ppqn >= left.0 && ppqn < right.0 {
            let alpha = (ppqn - left.0) / (right.0 - left.0);
            return Some(left.1 + alpha * (right.1 - left.1));
        }
    }
    None
}

/// Content ppqn at source `seconds`, linearly interpolated (TS `#secondsToPpqn`); clamps to the last marker
/// position when past the end, 0 when before the start.
fn seconds_to_ppqn(warp: &[(f64, f64)], seconds: f64) -> f64 {
    for window in warp.windows(2) {
        let (left, right) = (window[0], window[1]);
        if seconds >= left.1 && seconds < right.1 {
            let alpha = (seconds - left.1) / (right.1 - left.1);
            return left.0 + alpha * (right.0 - left.0);
        }
    }
    match warp.last() {
        Some(last) if seconds >= last.1 => last.0,
        _ => 0.0
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    use engine_env::block_flags::BlockFlags;

    #[test]
    fn floor_last_index_is_the_last_entry_at_or_below() {
        let values = [0.0, 0.5, 1.0];
        assert_eq!(floor_last_index(&values, -0.1), -1, "before all -> -1");
        assert_eq!(floor_last_index(&values, 0.0), 0, "exactly the first");
        assert_eq!(floor_last_index(&values, 0.49), 0);
        assert_eq!(floor_last_index(&values, 0.5), 1);
        assert_eq!(floor_last_index(&values, 9.0), 2, "past all -> last");
    }

    #[test]
    fn warp_maps_ppqn_and_seconds_both_ways() {
        let warp = [(0.0, 0.0), (3840.0, 1.0)];
        assert!((ppqn_to_seconds(&warp, 1920.0).unwrap() - 0.5).abs() < 1e-9, "midpoint maps to half a second");
        assert!(ppqn_to_seconds(&warp, 3840.0).is_none(), "the end is exclusive (no bracketing segment)");
        assert!((seconds_to_ppqn(&warp, 0.5) - 1920.0).abs() < 1e-9);
        assert_eq!(seconds_to_ppqn(&warp, 9.0), 3840.0, "past the last marker clamps to its position");
    }

    fn playing_block() -> Block {
        Block {index: 0, flags: BlockFlags::create(true, false, true, false), p0: 0.0, p1: 240.0, s0: 0, s1: 64, bpm: 120.0}
    }

    #[test]
    fn a_time_stretch_segment_is_audible() {
        // A constant-1.0 source, two transients, warp mapping 3840 ppqn -> 1.0 s of source (a 0.5x stretch at
        // 120 bpm). Processing from the very start spawns a voice at transient 0 that reads the source -> audible.
        let source: vec::Vec<f32> = vec![1.0; 48_000];
        let transients = [0.0, 0.5];
        let config = TimeStretchConfig {warp: vec![(0.0, 0.0), (3840.0, 1.0)], transient_play_mode: TransientPlayMode::Once, playback_rate: 1.0, algorithm: StretchAlgorithm::Granular};
        let mut sequencer = TimeStretchSequencer::new();
        let mut output = AudioBuffer::new();
        let fading_gain = [1.0f32; 128];
        let block = playing_block();
        let src = Source {left: &source, right: &source, num_frames: source.len()};
        sequencer.process(&mut output, &src, 48_000.0, &transients, &config, 0.0, &block, 0.0, 0.0, 240.0, &fading_gain, 48_000.0);
        assert!(sequencer.voice_count() >= 1, "a voice spawned at the transient boundary");
        let peak = (0..64).map(|i| output.left[i].abs()).fold(0.0f32, f32::max);
        assert!(peak > 0.5, "the time-stretch segment is audible (peak {peak})");
    }

    #[test]
    fn starting_in_a_silent_gap_stays_silent_no_phrase_replay() {
        // open.md (time-pitch-start-position-pop): the source is a phrase in [0, 0.5 s) then a SILENT gap in
        // [0.5 s, 1.0 s). The warp places the playhead at 0.6 s (inside the gap). `floor_last_index` selects the
        // phrase's transient (index 1 at 0.5 s); the pre-roll would look BACK into the phrase and replay it (the
        // "breathless pop"). The playhead clamp must instead read from 0.6 s -> the gap -> silence.
        let mut source: vec::Vec<f32> = vec![0.0; 48_000];
        for frame in source.iter_mut().take(24_000) {*frame = 1.0;} // phrase only in the first half
        let transients = [0.0, 0.5];
        let config = TimeStretchConfig {warp: vec![(0.0, 0.6), (3840.0, 1.0)], transient_play_mode: TransientPlayMode::Once, playback_rate: 1.0, algorithm: StretchAlgorithm::Granular};
        let mut sequencer = TimeStretchSequencer::new();
        let mut output = AudioBuffer::new();
        let fading_gain = [1.0f32; 128];
        let block = playing_block();
        let src = Source {left: &source, right: &source, num_frames: source.len()};
        sequencer.process(&mut output, &src, 48_000.0, &transients, &config, 0.0, &block, 0.0, 0.0, 240.0, &fading_gain, 48_000.0);
        let peak = (0..64).map(|i| output.left[i].abs()).fold(0.0f32, f32::max);
        assert!(peak < 1e-6, "starting inside the silent gap plays silence, not a replayed phrase (peak {peak})");
    }

    #[test]
    fn out_of_warp_range_renders_nothing() {
        let source: vec::Vec<f32> = vec![1.0; 48_000];
        let transients = [0.0, 0.5];
        let config = TimeStretchConfig {warp: vec![(0.0, 0.0), (10.0, 1.0)], transient_play_mode: TransientPlayMode::Once, playback_rate: 1.0, algorithm: StretchAlgorithm::Granular};
        let mut sequencer = TimeStretchSequencer::new();
        let mut output = AudioBuffer::new();
        let fading_gain = [1.0f32; 128];
        // content_ppqn 100 is past the last warp marker (10) -> the cycle is silent.
        let block = Block {index: 0, flags: BlockFlags::create(true, false, true, false), p0: 100.0, p1: 340.0, s0: 0, s1: 64, bpm: 120.0};
        let src = Source {left: &source, right: &source, num_frames: source.len()};
        sequencer.process(&mut output, &src, 48_000.0, &transients, &config, 0.0, &block, 100.0, 100.0, 340.0, &fading_gain, 48_000.0);
        assert_eq!(output.left[0], 0.0, "content past the warp range is silent");
    }
}
