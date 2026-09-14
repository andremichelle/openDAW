//! Driven modal bank: exactly-unity-peak resonators (constant-skirt bandpass with G = 1/decay —
//! peak gain G·decay = 1 identically at the design frequency, DC and Nyquist zeros for free) fed
//! by any mono excitation. Injection-side hit comb, per-mode alternating pan, per-mode slow gain
//! shimmer (decorrelated — lockstep partials read as an organ), √T60-neutral sustained injection,
//! and impulse-normalized injection for strikes. Eigensplit couples two banks at note-on.

use libm::{cosf, fabsf, powf, sinf, sqrtf};

use crate::engine::tables::{spec, Material, MAX_MODES};

const PI: f32 = core::f32::consts::PI;
const LN1000: f32 = 6.9077554;

#[derive(Clone, Copy)]
pub struct DrivenSpec {
    pub frequency: f32,
    pub t60: f32,
    pub gain_in: f32,
    pub gain_out: f32,
    pub pan_offset: f32,
}

pub const SILENT_SPEC: DrivenSpec =
    DrivenSpec {frequency: 0.0, t60: 0.1, gain_in: 0.0, gain_out: 0.0, pan_offset: 0.0};

/// The damping knob's T60 law. The live path bends by ratios of this, so note-on and live must
/// share one definition.
pub fn t60_scale(damping: f32) -> f32 {
    0.12 + 3.4 * damping * damping
}

/// Fills `out` from the material law; returns the mode count. Pan is stored as a unit offset —
/// the width knob applies it absolutely at shape time, so width stays live on sounding notes.
pub fn build_specs(material: Material, f0: f32, damping: f32, position: f32,
                   sample_rate: f32, out: &mut [DrivenSpec; MAX_MODES]) -> usize {
    let scale = t60_scale(damping);
    let mut seed = 0x2545f491u32;
    let mut count = 0;
    let mut index = 0;
    while let Some(mode) = spec(material, index) {
        index += 1;
        let frequency = f0 * mode.ratio;
        if frequency < 20.0 || frequency > sample_rate * 0.45 {
            continue;
        }
        let t60 = (mode.t60 * scale * powf(f0 * 1.6 / frequency, 0.5)).max(0.012);
        let position_gain = fabsf(sinf(index as f32 * PI * (0.06 + 0.88 * position)));
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        let rand = (seed >> 8) as f32 / 16777216.0;
        let side = if index % 2 == 1 {1.0} else {-1.0};
        out[count] = DrivenSpec {
            frequency,
            t60,
            gain_in: 0.25 + 0.75 * position_gain,
            gain_out: mode.amp,
            pan_offset: side * (0.12 + 0.38 * rand),
        };
        count += 1;
        if count == MAX_MODES {
            break;
        }
    }
    count
}

/// Eigensplit coupling (bridge-type bilinear, applied at note-on): pairs within `reach` Hz move
/// to f± = mean ± √(Δ² + k²); gains, pan and decay rotate by θ = ½·atan2(2k, f_hi − f_lo), pairs
/// ordered by frequency so θ → 0 as k → 0 (no slot swap for weak coupling). Decay eigenvalues are
/// the plain weighted blend — no cross term (it belongs to the off-diagonal, not the eigenvalues).
pub fn eigensplit(a: &mut [DrivenSpec], a_count: usize, b: &mut [DrivenSpec], b_count: usize,
                  k: f32, reach: f32) {
    if k <= 0.0 {
        return;
    }
    let mut b_used = [false; MAX_MODES];
    for index_a in 0..a_count {
        let mut best: Option<(usize, f32)> = None;
        for index_b in 0..b_count {
            if b_used[index_b] {
                continue;
            }
            let distance = fabsf(a[index_a].frequency - b[index_b].frequency);
            if distance <= reach && best.map_or(true, |(_, d)| distance < d) {
                best = Some((index_b, distance));
            }
        }
        let Some((index_b, _)) = best else {continue};
        b_used[index_b] = true;
        let a_is_high = a[index_a].frequency >= b[index_b].frequency;
        let (mut high, mut low) = if a_is_high {(a[index_a], b[index_b])} else {(b[index_b], a[index_a])};
        let mean = 0.5 * (high.frequency + low.frequency);
        let half_delta = 0.5 * (high.frequency - low.frequency);
        let split = sqrtf(half_delta * half_delta + k * k);
        let theta = 0.5 * libm::atan2f(2.0 * k, 2.0 * half_delta);
        let (sin_t, cos_t) = (sinf(theta), cosf(theta));
        let (gh_in, gl_in) = (high.gain_in, low.gain_in);
        let (gh_out, gl_out) = (high.gain_out, low.gain_out);
        let (decay_h, decay_l) = (1.0 / high.t60, 1.0 / low.t60);
        high.frequency = mean + split;
        low.frequency = mean - split;
        high.gain_in = cos_t * gh_in + sin_t * gl_in;
        low.gain_in = cos_t * gl_in - sin_t * gh_in;
        high.gain_out = cos_t * gh_out + sin_t * gl_out;
        low.gain_out = cos_t * gl_out - sin_t * gh_out;
        let (weight, cross_weight) = (cos_t * cos_t, sin_t * sin_t);
        let offset_h = high.pan_offset;
        high.pan_offset = weight * offset_h + cross_weight * low.pan_offset;
        low.pan_offset = weight * low.pan_offset + cross_weight * offset_h;
        high.t60 = 1.0 / (weight * decay_h + cross_weight * decay_l).max(1.0e-3);
        low.t60 = 1.0 / (weight * decay_l + cross_weight * decay_h).max(1.0e-3);
        if a_is_high {
            a[index_a] = high;
            b[index_b] = low;
        } else {
            b[index_b] = high;
            a[index_a] = low;
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Injection {
    Strike,
    Noise,
    Tonal,
}

#[derive(Clone, Copy)]
struct DrivenMode {
    a1: f32,
    a2: f32,
    inject: f32,
    tap_l: f32,
    tap_r: f32,
    inv_a0: f32,
    shim_state: f32,
    shim: f32,
    y1: f32,
    y2: f32,
    spec: DrivenSpec,
}

const SILENT_MODE: DrivenMode = DrivenMode {a1: 0.0, a2: 0.0, inject: 0.0, tap_l: 0.0,
    tap_r: 0.0, inv_a0: 1.0, shim_state: 0.0, shim: 1.0, y1: 0.0, y2: 0.0, spec: SILENT_SPEC};

/// Derives every coefficient from the note-on spec scaled by the live ratios (width is the
/// absolute knob value); ring state and the shimmer walk are untouched, so a sounding mode
/// bends instead of restarting.
fn shape(mode: &mut DrivenMode, kind: Injection, sample_rate: f32, freq_ratio: f32,
         t60_ratio: f32, width: f32, send: f32) {
    let spec = &mode.spec;
    let frequency = (spec.frequency * freq_ratio).clamp(8.0, sample_rate * 0.475);
    let t60 = (spec.t60 * t60_ratio).max(0.012);
    let omega = 2.0 * PI * frequency / sample_rate;
    let eps = LN1000 / (t60 * sample_rate);
    let inv_a0 = 1.0 / (1.0 + eps);
    let injection = match kind {
        Injection::Strike => 0.5,
        Injection::Noise => eps * sqrtf(t60),
        Injection::Tonal => eps,
    };
    let pan = (0.5 + spec.pan_offset * width).clamp(0.02, 0.98);
    mode.a1 = -2.0 * cosf(omega);
    mode.a2 = 1.0 - eps;
    mode.inv_a0 = inv_a0;
    mode.inject = injection * spec.gain_in * send * inv_a0;
    mode.tap_l = spec.gain_out * sqrtf(1.0 - pan);
    mode.tap_r = spec.gain_out * sqrtf(pan);
}

pub struct DrivenBank {
    modes: [DrivenMode; MAX_MODES],
    count: usize,
    kind: Injection,
    sample_rate: f32,
    noise_state: u32,
    x1: f32,
    x2: f32,
}

impl DrivenBank {
    pub const fn silent() -> Self {
        Self {modes: [SILENT_MODE; MAX_MODES], count: 0, kind: Injection::Strike,
            sample_rate: 48_000.0, noise_state: 0x51f15eed, x1: 0.0, x2: 0.0}
    }

    /// Injection normalization per drive type: an impulse through a unity-peak mode rings at
    /// ~2ε, so strikes inject 0.5 (= ε·1/2ε) and the ring follows the table amp law. Broadband
    /// sustained drive (breath) injects ε·√T60 for T60-neutral loudness (unity peak passes noise
    /// power ∝ bandwidth ∝ 1/T60). TONAL sustained drive (serial ring-through) injects plain ε —
    /// unity peak IS tonal-neutral, and √T60 would hand long-ring objects +15dB.
    pub fn build(&mut self, specs: &[DrivenSpec], count: usize, injection_kind: Injection,
                 width: f32, sample_rate: f32) {
        self.count = count;
        self.kind = injection_kind;
        self.sample_rate = sample_rate;
        self.x1 = 0.0;
        self.x2 = 0.0;
        for index in 0..count {
            self.modes[index] = DrivenMode {spec: specs[index], ..SILENT_MODE};
            shape(&mut self.modes[index], injection_kind, sample_rate, 1.0, 1.0, width, 1.0);
        }
    }

    /// Live knob feedback: rebends the sounding bank against its note-on specs — frequency and
    /// T60 as ratios, width as the absolute knob, send as a drive scale. The caller smooths.
    pub fn retune(&mut self, freq_ratio: f32, t60_ratio: f32, width: f32, send: f32) {
        for mode in self.modes[..self.count].iter_mut() {
            shape(mode, self.kind, self.sample_rate, freq_ratio, t60_ratio, width, send);
        }
    }

    /// Adds the stereo render into the output slices and writes the mono sum (for serial
    /// routing) into `mono_out`. Returns the chunk peak for voice-freeing.
    pub fn render(&mut self, excitation: &[f32], out_l: &mut [f32], out_r: &mut [f32],
                  mono_out: &mut [f32], gain: f32) -> f32 {
        let mut peak = 0.0f32;
        // Per-mode slow gain wobble (~0.35dB RMS, decorrelated, chunk-rate walk).
        for mode in self.modes[..self.count].iter_mut() {
            self.noise_state = self.noise_state.wrapping_mul(1664525).wrapping_add(1013904223);
            let noise = (self.noise_state >> 8) as f32 / 8388608.0 - 1.0;
            mode.shim_state += 0.02 * (noise - mode.shim_state);
            mode.shim = (1.0 + mode.shim_state * 0.4).clamp(0.6, 1.5);
        }
        for index in 0..excitation.len() {
            let x = excitation[index];
            let drive = x - self.x2;
            self.x2 = self.x1;
            self.x1 = x;
            let mut left = 0.0f32;
            let mut right = 0.0f32;
            let mut mono = 0.0f32;
            for mode in self.modes[..self.count].iter_mut() {
                let y = mode.inject * drive - (mode.a1 * mode.y1 + mode.a2 * mode.y2) * mode.inv_a0;
                mode.y2 = mode.y1;
                mode.y1 = y;
                let shimmed = y * mode.shim;
                left += shimmed * mode.tap_l;
                right += shimmed * mode.tap_r;
                mono += y * (mode.tap_l + mode.tap_r);
            }
            mono_out[index] = mono * gain * 0.5;
            out_l[index] += left * gain;
            out_r[index] += right * gain;
            peak = peak.max(fabsf(left * gain)).max(fabsf(right * gain));
        }
        peak
    }
}
