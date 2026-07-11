//! The granular voices (Once / Repeat / Pingpong), ported from `engine/src/time_stretch.rs`. All
//! parameters that were fixed constants arrive resolved through `VoiceParams` (computed per spawn by
//! the sequencer from `Tuning` + the segment's `TransientDescriptor`). With legacy params the sample
//! math is identical to the shipped engine; `equal_power` switches the voice and loop crossfades to
//! cos/sin (what `PingpongVoice` always did at its bounce).

#![allow(clippy::needless_range_loop)]

use math::round;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum VoiceState {
    Fading,
    Active,
    Done
}

/// Everything a voice needs that the sequencer resolves at spawn time. `equal_power` shapes the
/// voice in/out fades (crossfading DIFFERENT segments — uncorrelated, equal-power is right);
/// `splice_equal_power` shapes the loop splice, where the law follows alignment: a correlation-
/// aligned splice is phase-coherent and must crossfade LINEARLY (coherent sum is constant — cos/sin
/// would bump +3 dB), while an arbitrary fallback splice is uncorrelated and wants equal-power.
#[derive(Clone, Copy)]
pub(crate) struct VoiceParams {
    pub fade_seconds: f64,
    pub equal_power: bool,
    pub splice_equal_power: bool,
    /// Measured splice correlation for the CONSTANT-POWER law: gains (a, b) are normalized by
    /// sqrt(a^2 + b^2 + 2*rho*a*b), exactly constant power for that rho (rho 1 -> linear,
    /// rho 0 -> equal-power). Negative = use the legacy binary law (parity path).
    pub splice_rho: f64,
    pub loop_start: f64,
    pub loop_end: f64,
    pub loop_fade_samples: f64
}

/// The source planes a voice reads, threaded in per call.
pub struct Source<'a> {
    pub left: &'a [f32],
    pub right: &'a [f32],
    pub num_frames: usize
}

/// Linear amplitude -> output gain: identity (legacy) or the equal-power quarter-sine. Fading a pair
/// of voices with complementary linear amplitudes through the quarter-sine yields sin/cos — constant
/// power across the crossfade instead of the linear mid-dip.
#[inline]
fn shape(amplitude: f64, equal_power: bool) -> f64 {
    if equal_power {
        libm::sin(amplitude * core::f64::consts::FRAC_PI_2)
    } else {
        amplitude
    }
}

/// The shared fade-in/out amplitude state machine (identical across all three voices).
pub(crate) struct Fade {
    pub(crate) state: VoiceState,
    pub(crate) fade_direction: f64,
    fade_progress: f64,
    length_samples: f64,
    length_inverse: f64,
    pub(crate) fade_out_block_offset: usize,
    equal_power: bool
}

impl Fade {
    fn new(segment_start: f64, fade_in_forced: bool, sample_rate: f32, params: &VoiceParams) -> Self {
        let length_samples = round(params.fade_seconds * sample_rate as f64);
        let (state, fade_direction) = if fade_in_forced || segment_start > 0.0 {
            (VoiceState::Fading, 1.0)
        } else {
            (VoiceState::Active, 0.0)
        };
        Self {
            state, fade_direction, fade_progress: 0.0, length_samples,
            length_inverse: 1.0 / length_samples, fade_out_block_offset: 0, equal_power: params.equal_power
        }
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

    /// Advance one sample, returning the gain (or `None` once Done — the caller must break).
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
                    Some(shape(amplitude, self.equal_power))
                } else if i < self.fade_out_block_offset {
                    Some(1.0)
                } else {
                    let amplitude = 1.0 - self.fade_progress * self.length_inverse;
                    self.fade_progress += 1.0;
                    if self.fade_progress >= self.length_samples {
                        self.state = VoiceState::Done;
                        return None;
                    }
                    Some(shape(amplitude, self.equal_power))
                }
            }
        }
    }
}

/// Linear interpolation of a planar source at a fractional frame, or `None` when out of
/// `[0, num_frames - 1)`. Truncation matches the engine (`readPosition | 0`).
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

pub(crate) enum Voice {
    Once(OnceVoice),
    Repeat(RepeatVoice),
    Pingpong(PingpongVoice)
}

impl Voice {
    pub(crate) fn done(&self) -> bool {
        self.fade().state == VoiceState::Done
    }

    pub(crate) fn is_once(&self) -> bool {
        matches!(self, Voice::Once(_))
    }

    pub(crate) fn is_fading_out(&self) -> bool {
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

    pub(crate) fn read_position(&self) -> f64 {
        match self {
            Voice::Once(voice) => voice.read_position,
            Voice::Repeat(voice) => voice.read_position,
            Voice::Pingpong(voice) => voice.read_position
        }
    }

    pub(crate) fn segment_end(&self) -> f64 {
        match self {
            Voice::Once(voice) => voice.segment_end,
            Voice::Repeat(voice) => voice.segment_end,
            Voice::Pingpong(voice) => voice.segment_end
        }
    }

    pub(crate) fn set_segment_end(&mut self, end: f64) {
        match self {
            Voice::Once(voice) => voice.segment_end = end,
            Voice::Repeat(voice) => voice.segment_end = end,
            Voice::Pingpong(voice) => voice.segment_end = end
        }
    }

    pub(crate) fn start_fade_out(&mut self, block_offset: usize) {
        match self {
            Voice::Once(voice) => voice.fade.start_fade_out(block_offset),
            Voice::Repeat(voice) => voice.fade.start_fade_out(block_offset),
            Voice::Pingpong(voice) => voice.fade.start_fade_out(block_offset)
        }
    }

    pub(crate) fn process(&mut self, source: &Source, out_left: &mut [f32], out_right: &mut [f32], buffer_start: usize, buffer_count: usize, fading_gain: &[f32]) {
        match self {
            Voice::Once(voice) => voice.process(source, out_left, out_right, buffer_start, buffer_count, fading_gain),
            Voice::Repeat(voice) => voice.process(source, out_left, out_right, buffer_start, buffer_count, fading_gain),
            Voice::Pingpong(voice) => voice.process(source, out_left, out_right, buffer_start, buffer_count, fading_gain)
        }
    }
}

/// Plays a segment once, no looping: read start -> segment end, then silence.
pub(crate) struct OnceVoice {
    fade: Fade,
    playback_rate: f64,
    pub(crate) segment_end: f64,
    pub(crate) read_position: f64,
    block_offset: usize
}

impl OnceVoice {
    pub(crate) fn new(segment_start: f64, segment_end: f64, playback_rate: f64, block_offset: usize, sample_rate: f32, params: &VoiceParams) -> Self {
        Self {fade: Fade::new(segment_start, false, sample_rate, params), playback_rate, segment_end, read_position: segment_start, block_offset}
    }

    fn process(&mut self, source: &Source, out_left: &mut [f32], out_right: &mut [f32], buffer_start: usize, buffer_count: usize, fading_gain: &[f32]) {
        if self.fade.state == VoiceState::Done {
            return;
        }
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

/// Plays a segment with a seamless forward loop, crossfading at the loop boundary.
pub(crate) struct RepeatVoice {
    fade: Fade,
    playback_rate: f64,
    loop_start: f64,
    loop_end: f64,
    loop_fade_length: f64,
    loop_fade_inverse: f64,
    splice_equal_power: bool,
    splice_rho: f64,
    pub(crate) segment_end: f64,
    pub(crate) read_position: f64,
    loop_crossfade_progress: f64,
    loop_crossfade_position: f64,
    block_offset: usize
}

impl RepeatVoice {
    pub(crate) fn new(segment_start: f64, segment_end: f64, playback_rate: f64, block_offset: usize, sample_rate: f32, initial_read_position: Option<f64>, params: &VoiceParams) -> Self {
        let loop_start = params.loop_start;
        let loop_end = params.loop_end;
        let loop_fade_length = params.loop_fade_samples;
        let mut fade = Fade::new(segment_start, initial_read_position.is_some(), sample_rate, params);
        if loop_start >= loop_end {
            fade.state = VoiceState::Done;
        }
        Self {
            fade, playback_rate, loop_start, loop_end, loop_fade_length, loop_fade_inverse: 1.0 / loop_fade_length,
            splice_equal_power: params.splice_equal_power, splice_rho: params.splice_rho, segment_end, read_position: initial_read_position.unwrap_or(segment_start),
            loop_crossfade_progress: 0.0, loop_crossfade_position: 0.0, block_offset
        }
    }

    fn process(&mut self, source: &Source, out_left: &mut [f32], out_right: &mut [f32], buffer_start: usize, buffer_count: usize, fading_gain: &[f32]) {
        if self.fade.state == VoiceState::Done {
            return;
        }
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
                    if self.splice_rho >= 0.0 {
                        let a = 1.0 - crossfade;
                        let b = crossfade;
                        let rho = self.splice_rho as f32;
                        let norm = libm::sqrtf((a * a + b * b + 2.0 * rho * a * b).max(1e-9));
                        sample_l = (sample_l * a + loop_l * b) / norm;
                        sample_r = (sample_r * a + loop_r * b) / norm;
                    } else if self.splice_equal_power {
                        let fade_out = math::cos(crossfade * core::f32::consts::PI * 0.5);
                        let fade_in = math::sin(crossfade * core::f32::consts::PI * 0.5);
                        sample_l = sample_l * fade_out + loop_l * fade_in;
                        sample_r = sample_r * fade_out + loop_r * fade_in;
                    } else {
                        sample_l = sample_l * (1.0 - crossfade) + loop_l * crossfade;
                        sample_r = sample_r * (1.0 - crossfade) + loop_r * crossfade;
                    }
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

/// Plays a segment bouncing forward/backward, equal-power (cos/sin) crossfade at each bounce.
pub(crate) struct PingpongVoice {
    fade: Fade,
    playback_rate: f64,
    loop_start: f64,
    loop_end: f64,
    bounce_fade_length: f64,
    pub(crate) segment_end: f64,
    pub(crate) read_position: f64,
    direction: f64,
    bounce_progress: f64,
    bounce_position: f64,
    block_offset: usize
}

impl PingpongVoice {
    pub(crate) fn new(segment_start: f64, segment_end: f64, playback_rate: f64, block_offset: usize, sample_rate: f32, initial: Option<(f64, f64)>, params: &VoiceParams) -> Self {
        let loop_start = params.loop_start;
        let loop_end = params.loop_end;
        let bounce_fade_length = params.loop_fade_samples;
        let mut fade = Fade::new(segment_start, initial.is_some(), sample_rate, params);
        if loop_start >= loop_end {
            fade.state = VoiceState::Done;
        }
        let (read_position, direction) = initial.unwrap_or((segment_start, 1.0));
        Self {
            fade, playback_rate, loop_start, loop_end, bounce_fade_length, segment_end, read_position, direction,
            bounce_progress: 0.0, bounce_position: 0.0, block_offset
        }
    }

    fn process(&mut self, source: &Source, out_left: &mut [f32], out_right: &mut [f32], buffer_start: usize, buffer_count: usize, fading_gain: &[f32]) {
        if self.fade.state == VoiceState::Done {
            return;
        }
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
