//! The Soundfont per-note voice + its envelope, a faithful port of the TS `SoundfontVoice` (with `lib-dsp`'s
//! `Adsr` and `Smooth`). Pure, heap-free, zeroable DSP so voices live in the device's fixed zeroed pool.
//!
//! Playback mirrors `SoundfontVoice.processAdd`: a pitch-rate read head with linear interpolation over the
//! (already normalized f32) sample plane, a LINEAR ADSR whose per-sample value is 3 ms one-pole smoothed,
//! constant-power pan, and sample looping when the region's loop mode is on. A voice ends when a non-looping
//! sample runs out, or when the envelope is idle AND the smoothed gain has fallen below `SILENCE_THRESHOLD`.

use libm::{cosf, exp2f, expf, sinf};
use crate::blob::{Region, Sample};

const SILENCE_THRESHOLD: f32 = 1.0e-4; // lib-dsp constants.ts
const SMOOTH_SECONDS: f32 = 0.003;     // the TS voice's 3 ms gain smoothing

/// The ADSR states, matching TS `Adsr`.
#[derive(Clone, Copy, PartialEq, Eq, Default)]
enum Stage {
    #[default]
    Idle,
    Attack,
    Decay,
    Sustain,
    Release
}

/// A LINEAR attack/decay/sustain/release envelope, ported from `packages/lib/dsp/src/adsr.ts`. Rates are
/// re-solved from the current value on `set` / `gate_off` so a ramp resumes correctly.
#[derive(Clone, Copy, Default)]
pub struct Adsr {
    stage: Stage,
    value: f32,
    inv_sample_rate: f32,
    attack: f32,
    decay: f32,
    sustain: f32,
    release: f32,
    attack_inc: f32,
    decay_dec: f32,
    release_dec: f32
}

impl Adsr {
    #[inline]
    pub fn new(sample_rate: f32) -> Self {
        Self {inv_sample_rate: 1.0 / sample_rate, ..Default::default()}
    }

    /// Store the times (seconds) + sustain level (unit) and solve the ramp rates for the current state.
    #[inline]
    pub fn set(&mut self, attack: f32, decay: f32, sustain: f32, release: f32) {
        self.attack = attack;
        self.decay = decay;
        self.sustain = sustain;
        self.release = release;
        self.update_rates();
    }

    #[inline]
    fn update_rates(&mut self) {
        let inv = self.inv_sample_rate;
        match self.stage {
            Stage::Attack => self.attack_inc = (1.0 - self.value) * inv / self.attack.max(1.0e-6),
            Stage::Decay => self.decay_dec = (self.value - self.sustain) * inv / self.decay.max(1.0e-6),
            Stage::Release => self.release_dec = self.value * inv / self.release.max(1.0e-6),
            _ => {
                self.attack_inc = inv / self.attack.max(1.0e-6);
                self.decay_dec = (1.0 - self.sustain) * inv / self.decay.max(1.0e-6);
                self.release_dec = self.sustain * inv / self.release.max(1.0e-6);
            }
        }
    }

    #[inline]
    pub fn gate_on(&mut self) {
        self.stage = Stage::Attack;
    }

    #[inline]
    pub fn gate_off(&mut self) {
        if self.stage != Stage::Idle {
            self.stage = Stage::Release;
            self.update_rates();
        }
    }

    #[inline]
    pub fn complete(&self) -> bool {
        self.stage == Stage::Idle
    }

    /// Advance one sample and return the envelope value (matches TS `Adsr.process` per-sample).
    #[inline]
    pub fn next(&mut self) -> f32 {
        match self.stage {
            Stage::Attack => {
                self.value += self.attack_inc;
                if self.value >= 1.0 {
                    self.value = 1.0;
                    self.stage = Stage::Decay;
                }
                self.value
            }
            Stage::Decay => {
                self.value -= self.decay_dec;
                if self.value <= self.sustain {
                    self.value = self.sustain;
                    self.stage = Stage::Sustain;
                }
                self.value
            }
            Stage::Sustain => self.sustain,
            Stage::Release => {
                self.value -= self.release_dec;
                if self.value <= 0.0 {
                    self.value = 0.0;
                    self.stage = Stage::Idle;
                }
                self.value
            }
            Stage::Idle => 0.0
        }
    }
}

/// A one-pole smoother, ported from `packages/lib/dsp/src/smooth.ts`.
#[derive(Clone, Copy, Default)]
pub struct Smooth {
    coeff: f32,
    value: f32
}

impl Smooth {
    #[inline]
    pub fn new(time: f32, sample_rate: f32) -> Self {
        Self {coeff: 1.0 - expf(-1.0 / (time * sample_rate)), value: 0.0}
    }

    #[inline]
    pub fn process(&mut self, target: f32) -> f32 {
        self.value += self.coeff * (target - self.value);
        self.value
    }

    #[inline]
    pub fn value(&self) -> f32 {
        self.value
    }
}

#[derive(Clone, Copy, Default)]
pub struct SoundfontVoice {
    active: bool,
    id: u32,
    sample_index: u32, // which blob sample this voice reads (the device fetches the plane each block)
    loop_start: u32,
    loop_end: u32,
    looping: bool,
    position: f64,
    playback_rate: f64,
    gain: f32,
    pan_left: f32,
    pan_right: f32,
    adsr: Adsr,
    smooth: Smooth
}

impl SoundfontVoice {
    #[inline]
    pub fn is_active(&self) -> bool {
        self.active
    }

    #[inline]
    pub fn id(&self) -> u32 {
        self.id
    }

    #[inline]
    pub fn sample_index(&self) -> u32 {
        self.sample_index
    }

    /// Begin a note for a matched `region` + its `sample`, at the engine `sample_rate` (the TS context rate).
    #[inline]
    pub fn start(&mut self, id: u32, pitch: u32, cent: f32, velocity: f32, region: &Region, sample: &Sample, sample_rate: f32) {
        self.active = true;
        self.id = id;
        self.sample_index = region.sample_index;
        self.loop_start = sample.loop_start;
        self.loop_end = sample.loop_end;
        self.looping = region.loop_mode != 0;
        self.position = 0.0;
        // pitchRatio = midiToHz(pitch + cent/100) / midiToHz(rootKey) = 2^((pitch + cent/100 - rootKey)/12).
        let semis = pitch as f32 + cent / 100.0 - region.root_key as f32;
        let pitch_ratio = exp2f(semis / 12.0) as f64;
        self.playback_rate = pitch_ratio * sample.sample_rate as f64 / sample_rate as f64;
        // velocityToGain(v) = dbToGain(20*log10(v)) == v for v in (0,1]; 0 at v<=0.
        self.gain = if velocity > 0.0 {velocity} else {0.0};
        let pan_angle = (region.pan + 1.0) * core::f32::consts::FRAC_PI_4;
        self.pan_left = cosf(pan_angle);
        self.pan_right = sinf(pan_angle);
        self.adsr = Adsr::new(sample_rate);
        self.adsr.set(region.attack, region.decay, region.sustain, region.release);
        self.adsr.gate_on();
        self.smooth = Smooth::new(SMOOTH_SECONDS, sample_rate);
    }

    /// Note-off: begin the envelope release.
    #[inline]
    pub fn release(&mut self) {
        self.adsr.gate_off();
    }

    /// Free the slot immediately.
    #[inline]
    pub fn force_stop(&mut self) {
        self.active = false;
    }

    /// Render additively into the stereo chunk, reading from the voice's sample `pcm` plane (the device fetches
    /// it from the blob each block). Returns `true` once finished (non-looping sample ran out, or the envelope
    /// idled and the smoothed gain fell silent), so the device frees the slot. Mirrors `processAdd`.
    #[inline]
    pub fn process(&mut self, out_left: &mut [f32], out_right: &mut [f32], pcm: &[f32]) -> bool {
        let frame_count = pcm.len();
        if frame_count == 0 {
            return true;
        }
        let last = frame_count - 1;
        let loop_start = self.loop_start as f64;
        let loop_end = self.loop_end as f64;
        for index in 0..out_left.len() {
            let int_position = self.position as usize;
            let sample = if int_position >= last {
                pcm[last]
            } else {
                let frac = (self.position - int_position as f64) as f32;
                pcm[int_position] * (1.0 - frac) + pcm[int_position + 1] * frac
            };
            let env = self.adsr.next();
            let amp = sample * self.gain * self.smooth.process(env);
            out_left[index] += amp * self.pan_left;
            out_right[index] += amp * self.pan_right;
            self.position += self.playback_rate;
            if self.looping {
                if self.position >= loop_end && loop_end > loop_start {
                    self.position = loop_start + (self.position - loop_end);
                }
            } else if self.position >= last as f64 {
                return true;
            }
        }
        self.adsr.complete() && self.smooth.value() < SILENCE_THRESHOLD
    }
}
