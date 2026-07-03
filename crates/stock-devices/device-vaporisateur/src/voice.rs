//! One Vaporisateur voice (a port of TS `VaporisateurVoice`), the leaf [`Voice`] nested inside a
//! [`voicing::VoiceUnison`], plus the live parameters it reads ([`VaporisateurParams`], the voicing `Shared`
//! type) and the reusable render workspace.
//!
//! The per-chunk scratch buffers (oscillator / frequency / envelope / filter-cutoff / LFO) are NOT allocated
//! per call: they live in a [`Workspace`] held behind a `RefCell` in the shared params, so the engine
//! allocates them once with the state block and every voice borrows the SAME workspace in turn each block (a
//! safe analog of the TS module-level shared buffers, which rely on the single-threaded processor).

use core::cell::RefCell;
use abi::{Block, EventRecord};
use dsp::biquad::ModulatedBiquad;
use dsp::glide::Glide;
use dsp::lfo::Lfo;
use dsp::osc::{BandLimitedOscillator, ClassicWaveform};
use dsp::panning::{panning_to_gains, Mixing};
use dsp::smooth::Smooth;
use dsp::{keyboard_tracking, velocity_to_gain, RENDER_QUANTUM};
use math::clamp_unit;
use voicing::Voice;
use crate::adsr::Adsr;

pub const MIN_CUTOFF: f64 = 20.0; // VaporisateurSettings.MIN_CUTOFF
pub const MAX_CUTOFF: f64 = 20_000.0; // VaporisateurSettings.MAX_CUTOFF
const SILENCE_THRESHOLD: f32 = 1.0e-4; // lib-dsp SILENCE_THRESHOLD (≈ -80 dB)
const SMOOTH_TIME: f64 = 0.003; // the gain smoothers' time constant (seconds)

/// The per-chunk render scratch (one quantum wide), reused by every voice each block. Mirrors the TS
/// module-level `oscABuffer` / `freqBuffer` / … set, but owned by the device state (one per instance) so no
/// `unsafe` and no per-call allocation. Valid when zeroed (the engine zero-allocates the state).
pub struct Workspace {
    freq: [f32; RENDER_QUANTUM],
    freq_a: [f32; RENDER_QUANTUM],
    freq_b: [f32; RENDER_QUANTUM],
    vca: [f32; RENDER_QUANTUM],
    lfo: [f32; RENDER_QUANTUM],
    cutoff: [f32; RENDER_QUANTUM],
    osc_a: [f32; RENDER_QUANTUM],
    osc_b: [f32; RENDER_QUANTUM],
    osc_sum: [f32; RENDER_QUANTUM]
}

impl Default for Workspace {
    fn default() -> Self {
        Self {
            freq: [0.0; RENDER_QUANTUM], freq_a: [0.0; RENDER_QUANTUM], freq_b: [0.0; RENDER_QUANTUM],
            vca: [0.0; RENDER_QUANTUM], lfo: [0.0; RENDER_QUANTUM], cutoff: [0.0; RENDER_QUANTUM],
            osc_a: [0.0; RENDER_QUANTUM], osc_b: [0.0; RENDER_QUANTUM], osc_sum: [0.0; RENDER_QUANTUM]
        }
    }
}

/// The device's live parameters the voice reads (the `voicing::Voice::Shared` type): the resolved real values
/// (osc gains / waveforms / frequency multipliers, filter cutoff / resonance / envelope amount / order, the
/// ADSR times, LFO shape / rate / targets, unison detune / stereo), the sample rate, and the shared render
/// [`Workspace`]. The device mutates these in `parameter_changed`; voices read them at note-on (`start`) and
/// each chunk (`process`). The osc octave / tune are kept so the frequency multiplier can be recomputed when
/// either changes.
pub struct VaporisateurParams {
    pub(crate) gain_osc_a: f32,
    pub(crate) gain_osc_b: f32,
    pub(crate) osc_a_waveform: ClassicWaveform,
    pub(crate) osc_b_waveform: ClassicWaveform,
    pub(crate) osc_a_octave: i32,
    pub(crate) osc_a_tune: f32,
    pub(crate) osc_b_octave: i32,
    pub(crate) osc_b_tune: f32,
    pub(crate) frequency_a_multiplier: f32,
    pub(crate) frequency_b_multiplier: f32,
    pub(crate) env_attack: f32,
    pub(crate) env_decay: f32,
    pub(crate) env_sustain: f32,
    pub(crate) env_release: f32,
    pub(crate) flt_cutoff: f32, // a unit value (0..1); the filter maps it to Hz
    pub(crate) flt_resonance: f32,
    pub(crate) flt_env_amount: f32,
    pub(crate) flt_order: i32,
    pub(crate) filter_keyboard: f32, // the keyboard-tracking amount (bipolar)
    pub(crate) lfo_shape: ClassicWaveform,
    pub(crate) lfo_rate: f32,
    pub(crate) lfo_target_tune: f32,
    pub(crate) lfo_target_cutoff: f32,
    pub(crate) lfo_target_volume: f32,
    pub(crate) unison_detune: f32,
    pub(crate) unison_stereo: f32,
    pub(crate) sample_rate: f32,
    pub(crate) workspace: RefCell<Workspace>
}

/// One Vaporisateur voice. All per-note DSP is reconstructed in `start` (fresh phase / envelope / glide, like
/// the TS `new VaporisateurVoice` per note); `process` renders the osc -> mix -> filter -> ADSR-VCA chain.
pub struct VaporisateurVoice {
    osc_a: BandLimitedOscillator,
    osc_b: BandLimitedOscillator,
    lfo: Lfo,
    filter: ModulatedBiquad,
    env: Adsr,
    glide: Glide,
    gain_a_smooth: Smooth,
    gain_b_smooth: Smooth,
    gain_vca_smooth: Smooth,
    smooth_coeff: f64,
    gain: f32,
    spread: f32,
    velocity: f32,
    filter_keyboard_delta: f32,
    sample_rate: f32
}

impl Default for VaporisateurVoice {
    fn default() -> Self {
        Self {
            osc_a: BandLimitedOscillator::default(), osc_b: BandLimitedOscillator::default(),
            lfo: Lfo::default(), filter: ModulatedBiquad::new(), env: Adsr::default(), glide: Glide::default(),
            gain_a_smooth: Smooth::default(), gain_b_smooth: Smooth::default(), gain_vca_smooth: Smooth::default(),
            smooth_coeff: 0.0, gain: 0.0, spread: 0.0, velocity: 0.0, filter_keyboard_delta: 0.0, sample_rate: 0.0
        }
    }
}

impl VaporisateurVoice {
    /// Render one window (`<= RENDER_QUANTUM`) into the stereo slices, returning `true` once the envelope has
    /// completed and faded below silence. A faithful per-sample port of the TS `process` body, using the
    /// borrowed shared `workspace` for scratch.
    fn process_window(&mut self, out_left: &mut [f32], out_right: &mut [f32], block: &Block, shared: &VaporisateurParams, work: &mut Workspace) -> bool {
        let len = out_left.len();
        let gain = velocity_to_gain(self.velocity) * self.gain;
        let detune = libm::exp2f(self.spread * (shared.unison_detune / 1200.0));
        let panning = self.spread * shared.unison_stereo;
        let [gain_l, gain_r] = panning_to_gains(panning, Mixing::Linear);
        for sample in &mut work.freq[..len] {
            *sample = detune;
        }
        self.glide.process(&mut work.freq, block.bpm, self.sample_rate, 0, len);
        self.lfo.fill(&mut work.lfo, shared.lfo_shape, shared.lfo_rate, 0, len);
        self.env.process(&mut work.vca, 0, len);
        let lfo_target_tune = shared.lfo_target_tune;
        let lfo_target_cutoff = shared.lfo_target_cutoff;
        let lfo_target_volume = shared.lfo_target_volume;
        // BIT-EXACT fast path: with no tune modulation, `exp2f(lfo * 0.0)` is exactly 1.0 and `freq * 1.0`
        // is the identity, so the per-sample call (a large share of the voice cost) can be skipped outright.
        let tune_modulated = lfo_target_tune != 0.0;
        for index in 0..len {
            let lfo = work.lfo[index];
            work.cutoff[index] = shared.flt_cutoff + self.filter_keyboard_delta + work.vca[index] * shared.flt_env_amount + lfo * lfo_target_cutoff;
            work.vca[index] *= clamp_unit(gain + lfo * lfo_target_volume);
            // WASM CONTRACT: `fast_exp2` mirrors lib-dsp `fastExp2`, fed the f64 product like the TS voice.
            let frequency = if tune_modulated { work.freq[index] * dsp::fast_math::fast_exp2(lfo as f64 * lfo_target_tune as f64) as f32 } else { work.freq[index] };
            work.freq_a[index] = frequency * shared.frequency_a_multiplier;
            work.freq_b[index] = frequency * shared.frequency_b_multiplier;
        }
        self.osc_a.generate_from_frequencies(&mut work.osc_a, &work.freq_a, shared.osc_a_waveform, 0, len);
        self.osc_b.generate_from_frequencies(&mut work.osc_b, &work.freq_b, shared.osc_b_waveform, 0, len);
        for index in 0..len {
            work.osc_sum[index] = work.osc_a[index] * self.gain_a_smooth.process(self.smooth_coeff, shared.gain_osc_a as f64) as f32
                + work.osc_b[index] * self.gain_b_smooth.process(self.smooth_coeff, shared.gain_osc_b as f64) as f32;
        }
        self.filter.process(&mut work.osc_sum, &work.cutoff, shared.flt_resonance as f64, shared.flt_order.clamp(1, 4) as usize, MIN_CUTOFF, MAX_CUTOFF, self.sample_rate, 0, len);
        for index in 0..len {
            let vca = self.gain_vca_smooth.process(self.smooth_coeff, clamp_unit(work.vca[index]) as f64) as f32;
            let out = work.osc_sum[index] * vca;
            out_left[index] += out * gain_l;
            out_right[index] += out * gain_r;
            if self.env.is_complete() && vca < SILENCE_THRESHOLD {
                return true;
            }
        }
        false
    }
}

impl Voice for VaporisateurVoice {
    type Shared = VaporisateurParams;

    fn start(&mut self, event: &EventRecord, frequency: f32, gain: f32, spread: f32, _unison: usize, shared: &VaporisateurParams) {
        let sample_rate = shared.sample_rate;
        self.gain = gain;
        self.spread = spread;
        self.velocity = event.velocity;
        self.sample_rate = sample_rate;
        self.filter_keyboard_delta = keyboard_tracking(event.pitch as f32, shared.filter_keyboard);
        self.osc_a = BandLimitedOscillator::new(sample_rate);
        self.osc_b = BandLimitedOscillator::new(sample_rate);
        self.lfo = Lfo::new(sample_rate);
        self.filter = ModulatedBiquad::new();
        self.env = Adsr::new(sample_rate);
        self.env.set(shared.env_attack, shared.env_decay, shared.env_sustain, shared.env_release);
        self.env.gate_on();
        self.glide = Glide::default();
        self.glide.init(frequency as f64);
        self.gain_a_smooth = Smooth::default();
        self.gain_b_smooth = Smooth::default();
        self.gain_vca_smooth = Smooth::default();
        self.smooth_coeff = Smooth::coefficient(SMOOTH_TIME, sample_rate as f64);
    }

    fn stop(&mut self) {
        self.env.gate_off();
    }

    fn force_stop(&mut self) {
        self.env.force_stop();
    }

    fn start_glide(&mut self, target_frequency: f32, glide_duration: f64) {
        self.glide.glide_to(target_frequency as f64, glide_duration);
    }

    fn gate(&self) -> bool {
        self.env.gate()
    }

    fn current_frequency(&self) -> f32 {
        self.glide.current_frequency() as f32
    }

    fn process(&mut self, output: [&mut [f32]; 2], block: &Block, shared: &VaporisateurParams) -> bool {
        let [out_left, out_right] = output;
        let mut work = shared.workspace.borrow_mut();
        let total = out_left.len();
        let mut base = 0;
        while base < total {
            let len = (total - base).min(RENDER_QUANTUM);
            if self.process_window(&mut out_left[base..base + len], &mut out_right[base..base + len], block, shared, &mut work) {
                return true;
            }
            base += len;
        }
        false
    }
}
