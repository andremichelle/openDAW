//! A channel vocoder (`VocoderDsp`) plus its noise source (`NoiseGenerator`), a faithful port of the TS
//! core-processors `VocoderDsp` / `NoiseGenerator`. The CARRIER is the device's main input; the MODULATOR is
//! either synthesised noise, the carrier itself (a multi-band gate), or an external sidechain. A bank of up to
//! 16 bandpass filter pairs (carrier + modulator) tracks the modulator's per-band energy through an envelope
//! follower and imprints it on the carrier band. Coefficients interpolate geometrically every SUB_BLOCK samples
//! and a band-count change fades in click-free. `f32` internal math, fixed arrays, no allocation on the hot path.
#![allow(clippy::excessive_precision, clippy::needless_range_loop, clippy::too_many_arguments)]

use crate::biquad::BiquadCoeff;
use crate::db_to_gain;

const NOISE_SEED: u32 = 0x0F123F42;

/// White / pink / brown noise, byte-parity with the TS `NoiseGenerator` (a mulberry32 white core, a 7-pole
/// pink filter, and an integrating brown). Bipolar output in roughly `[-1, 1]`.
pub struct NoiseGenerator {
    seed: u32,
    b0: f32,
    b1: f32,
    b2: f32,
    b3: f32,
    b4: f32,
    b5: f32,
    b6: f32,
    brown: f32
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum NoiseColor {
    White,
    Pink,
    Brown
}

impl Default for NoiseGenerator {
    fn default() -> Self {
        Self {seed: NOISE_SEED, b0: 0.0, b1: 0.0, b2: 0.0, b3: 0.0, b4: 0.0, b5: 0.0, b6: 0.0, brown: 0.0}
    }
}

impl NoiseGenerator {
    #[inline]
    fn white_sample(seed: &mut u32) -> f32 {
        *seed = seed.wrapping_add(0x6D2B79F5);
        let mut t = *seed;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        (((t ^ (t >> 14)) as f32) / 4294967296.0) * 2.0 - 1.0
    }

    pub fn fill(&mut self, color: NoiseColor, target: &mut [f32], from: usize, to: usize) {
        let mut seed = self.seed;
        match color {
            NoiseColor::White => {
                for sample in &mut target[from..to] {
                    *sample = Self::white_sample(&mut seed);
                }
            }
            NoiseColor::Pink => {
                let (mut b0, mut b1, mut b2, mut b3) = (self.b0, self.b1, self.b2, self.b3);
                let (mut b4, mut b5, mut b6) = (self.b4, self.b5, self.b6);
                for sample in &mut target[from..to] {
                    let white = Self::white_sample(&mut seed);
                    b0 = 0.99886 * b0 + white * 0.0555179;
                    b1 = 0.99332 * b1 + white * 0.0750759;
                    b2 = 0.96900 * b2 + white * 0.1538520;
                    b3 = 0.86650 * b3 + white * 0.3104856;
                    b4 = 0.55000 * b4 + white * 0.5329522;
                    b5 = -0.7616 * b5 - white * 0.0168980;
                    *sample = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
                    b6 = white * 0.115926;
                }
                self.b0 = b0; self.b1 = b1; self.b2 = b2; self.b3 = b3;
                self.b4 = b4; self.b5 = b5; self.b6 = b6;
            }
            NoiseColor::Brown => {
                let mut brown = self.brown;
                for sample in &mut target[from..to] {
                    let white = Self::white_sample(&mut seed);
                    brown = (brown + 0.02 * white) / 1.02;
                    *sample = brown * 3.5;
                }
                self.brown = brown;
            }
        }
        self.seed = seed;
    }

    pub fn reset(&mut self) {
        self.seed = NOISE_SEED;
        self.b0 = 0.0; self.b1 = 0.0; self.b2 = 0.0; self.b3 = 0.0;
        self.b4 = 0.0; self.b5 = 0.0; self.b6 = 0.0; self.brown = 0.0;
    }
}

const MAX_BANDS: usize = 16;
const SUB_BLOCK: usize = 64;
const COEFF_LERP: f32 = 0.25;
const BAND_FADE_SECONDS: f32 = 0.003;
const COLD_THRESHOLD: f32 = 1.0e-4;
const GAIN_K: f32 = 186.0;

/// The vocoder DSP. Held in the device's engine-zeroed state and initialised in place (`init`), since it is
/// large enough to prefer not constructing by value on the audio thread.
pub struct VocoderDsp {
    sample_rate: f32,
    target_active: [f32; MAX_BANDS], // 1.0 = band on, 0.0 = off (numeric, drives the fade)
    band_gain_current: [f32; MAX_BANDS],
    fade_coeff: f32,
    processed_bands: usize,
    target_band_count: usize,
    target_carrier_min_freq: f32,
    target_carrier_max_freq: f32,
    target_modulator_min_freq: f32,
    target_modulator_max_freq: f32,
    target_q_min: f32,
    target_q_max: f32,
    coeffs_dirty: bool,
    cur_carrier_freq: [f32; MAX_BANDS],
    cur_modulator_freq: [f32; MAX_BANDS],
    cur_carrier_q: [f32; MAX_BANDS],
    cur_modulator_q: [f32; MAX_BANDS],
    tmp_carrier_freq: [f32; MAX_BANDS],
    tmp_modulator_freq: [f32; MAX_BANDS],
    tmp_q: [f32; MAX_BANDS],
    envelope: [f32; MAX_BANDS],
    attack_coeff: f32,
    release_coeff: f32,
    band_gain: f32,
    output_gain: f32,
    carrier_coeffs: [f32; 5 * MAX_BANDS], // per band i: [b0, b1, b2, a1, a2] at i*5
    modulator_coeffs: [f32; 5 * MAX_BANDS],
    car_cx_l1: [f32; MAX_BANDS], car_cx_l2: [f32; MAX_BANDS], car_cy_l1: [f32; MAX_BANDS], car_cy_l2: [f32; MAX_BANDS],
    car_cx_r1: [f32; MAX_BANDS], car_cx_r2: [f32; MAX_BANDS], car_cy_r1: [f32; MAX_BANDS], car_cy_r2: [f32; MAX_BANDS],
    mod_mx_l1: [f32; MAX_BANDS], mod_mx_l2: [f32; MAX_BANDS], mod_my_l1: [f32; MAX_BANDS], mod_my_l2: [f32; MAX_BANDS],
    mod_mx_r1: [f32; MAX_BANDS], mod_mx_r2: [f32; MAX_BANDS], mod_my_r1: [f32; MAX_BANDS], mod_my_r2: [f32; MAX_BANDS],
    wet_gain: f32,
    dry_gain: f32
}

impl VocoderDsp {
    /// Initialise a zeroed instance: default parameters, band targets snapped to the current values, and the
    /// initial coefficient set written. Mirrors the TS constructor.
    pub fn init(&mut self, sample_rate: f32) {
        self.sample_rate = sample_rate;
        self.processed_bands = MAX_BANDS;
        self.target_band_count = 16;
        self.target_carrier_min_freq = 80.0;
        self.target_carrier_max_freq = 12000.0;
        self.target_modulator_min_freq = 80.0;
        self.target_modulator_max_freq = 12000.0;
        self.target_q_min = 2.0;
        self.target_q_max = 20.0;
        self.coeffs_dirty = true;
        self.band_gain = 75.0;
        self.output_gain = 1.0;
        self.wet_gain = 1.0;
        self.dry_gain = 0.0;
        for i in 0..self.target_band_count {
            self.target_active[i] = 1.0;
            self.band_gain_current[i] = 1.0;
        }
        self.compute_band_targets();
        for i in 0..MAX_BANDS {
            let t = i.min(self.target_band_count - 1);
            self.cur_carrier_freq[i] = self.tmp_carrier_freq[t];
            self.cur_modulator_freq[i] = self.tmp_modulator_freq[t];
            self.cur_carrier_q[i] = self.tmp_q[t];
            self.cur_modulator_q[i] = self.tmp_q[t];
        }
        self.fade_coeff = libm::expf(-1.0 / (sample_rate * BAND_FADE_SECONDS));
        self.set_attack_seconds(0.005);
        self.set_release_seconds(0.030);
        self.recompute_band_gain();
        self.write_all_coefficients();
    }

    pub fn set_carrier_min_freq(&mut self, hz: f32) {self.target_carrier_min_freq = hz; self.coeffs_dirty = true;}
    pub fn set_carrier_max_freq(&mut self, hz: f32) {self.target_carrier_max_freq = hz; self.coeffs_dirty = true;}
    pub fn set_modulator_min_freq(&mut self, hz: f32) {self.target_modulator_min_freq = hz; self.coeffs_dirty = true;}
    pub fn set_modulator_max_freq(&mut self, hz: f32) {self.target_modulator_max_freq = hz; self.coeffs_dirty = true;}
    pub fn set_q_min(&mut self, q: f32) {self.target_q_min = q; self.coeffs_dirty = true;}
    pub fn set_q_max(&mut self, q: f32) {self.target_q_max = q; self.coeffs_dirty = true;}

    pub fn set_mix(&mut self, value: f32) {
        let angle = value * core::f32::consts::PI * 0.5;
        self.dry_gain = libm::cosf(angle);
        self.wet_gain = libm::sinf(angle);
    }

    pub fn set_attack_seconds(&mut self, seconds: f32) {self.attack_coeff = libm::expf(-1.0 / (self.sample_rate * seconds));}
    pub fn set_release_seconds(&mut self, seconds: f32) {self.release_coeff = libm::expf(-1.0 / (self.sample_rate * seconds));}
    pub fn set_gain_db(&mut self, db: f32) {self.output_gain = db_to_gain(db);}

    fn recompute_band_gain(&mut self) {
        let n = self.target_band_count;
        let q_max = self.target_q_max;
        let q_log = libm::logf(self.target_q_max / self.target_q_min);
        let mut sum = 0.0f32;
        for i in 0..n {
            let x = if n == 1 { 0.0 } else { i as f32 / (n - 1) as f32 };
            let q = q_max * libm::expf(-x * q_log);
            sum += 1.0 / q;
        }
        self.band_gain = GAIN_K / sum;
    }

    pub fn set_band_count(&mut self, count: usize) {
        if count != 8 && count != 12 && count != 16 {return;}
        if count == self.target_band_count {return;}
        self.target_band_count = count;
        self.coeffs_dirty = true;
        for i in 0..MAX_BANDS {
            self.target_active[i] = if i < count { 1.0 } else { 0.0 };
        }
        self.compute_band_targets();
        for i in 0..MAX_BANDS {
            if self.target_active[i] != 0.0 && self.band_gain_current[i] < COLD_THRESHOLD {
                self.reset_band_state(i);
                self.cur_carrier_freq[i] = self.tmp_carrier_freq[i];
                self.cur_modulator_freq[i] = self.tmp_modulator_freq[i];
                self.cur_carrier_q[i] = self.tmp_q[i];
                self.cur_modulator_q[i] = self.tmp_q[i];
            }
        }
        self.processed_bands = MAX_BANDS;
    }

    pub fn reset(&mut self) {
        for i in 0..MAX_BANDS {
            self.reset_band_state(i);
            self.band_gain_current[i] = self.target_active[i];
        }
        self.processed_bands = self.target_band_count;
    }

    pub fn process_stereo_mod(&mut self, car_l: &[f32], car_r: &[f32], mod_l: &[f32], mod_r: &[f32],
                              out_l: &mut [f32], out_r: &mut [f32], from: usize, to: usize) {
        let mut base = from;
        while base < to {
            let end = (base + SUB_BLOCK).min(to);
            self.interpolate_coeffs();
            self.inner_stereo_mod(car_l, car_r, mod_l, mod_r, out_l, out_r, base, end);
            base = end;
        }
        self.trim_processed_bands();
    }

    pub fn process_mono_mod(&mut self, car_l: &[f32], car_r: &[f32], modu: &[f32],
                            out_l: &mut [f32], out_r: &mut [f32], from: usize, to: usize) {
        let mut base = from;
        while base < to {
            let end = (base + SUB_BLOCK).min(to);
            self.interpolate_coeffs();
            self.inner_mono_mod(car_l, car_r, modu, out_l, out_r, base, end);
            base = end;
        }
        self.trim_processed_bands();
    }

    pub fn process_self(&mut self, car_l: &[f32], car_r: &[f32], out_l: &mut [f32], out_r: &mut [f32], from: usize, to: usize) {
        let mut base = from;
        while base < to {
            let end = (base + SUB_BLOCK).min(to);
            self.interpolate_coeffs();
            self.inner_self(car_l, car_r, out_l, out_r, base, end);
            base = end;
        }
        self.trim_processed_bands();
    }

    fn compute_band_targets(&mut self) {
        let n = self.target_band_count;
        let cf_min = self.target_carrier_min_freq;
        let mf_min = self.target_modulator_min_freq;
        let cf_log = libm::logf(self.target_carrier_max_freq / cf_min);
        let mf_log = libm::logf(self.target_modulator_max_freq / mf_min);
        let q_min = self.target_q_min;
        let q_log = libm::logf(self.target_q_max / q_min);
        let denom = if n == 1 { 1.0 } else { (n - 1) as f32 };
        for i in 0..n {
            let x = if n == 1 { 0.0 } else { i as f32 / denom };
            self.tmp_carrier_freq[i] = cf_min * libm::expf(x * cf_log);
            self.tmp_modulator_freq[i] = mf_min * libm::expf(x * mf_log);
            self.tmp_q[i] = self.target_q_max * libm::expf(-x * q_log);
        }
    }

    fn interpolate_coeffs(&mut self) {
        if !self.coeffs_dirty {return;}
        self.recompute_band_gain();
        self.compute_band_targets();
        let alpha = COEFF_LERP;
        let sr = self.sample_rate as f64;
        let mut carrier = BiquadCoeff::new();
        let mut modulator = BiquadCoeff::new();
        let upper = self.processed_bands;
        let mut converged = true;
        for i in 0..upper {
            if self.target_active[i] != 0.0 {
                self.cur_carrier_freq[i] *= libm::powf(self.tmp_carrier_freq[i] / self.cur_carrier_freq[i], alpha);
                self.cur_modulator_freq[i] *= libm::powf(self.tmp_modulator_freq[i] / self.cur_modulator_freq[i], alpha);
                self.cur_carrier_q[i] *= libm::powf(self.tmp_q[i] / self.cur_carrier_q[i], alpha);
                self.cur_modulator_q[i] *= libm::powf(self.tmp_q[i] / self.cur_modulator_q[i], alpha);
                let eps = 0.01;
                if libm::fabsf(self.cur_carrier_freq[i] - self.tmp_carrier_freq[i]) > eps
                    || libm::fabsf(self.cur_modulator_freq[i] - self.tmp_modulator_freq[i]) > eps
                    || libm::fabsf(self.cur_carrier_q[i] - self.tmp_q[i]) > eps {
                    converged = false;
                }
            }
            carrier.set_bandpass_params(self.cur_carrier_freq[i] as f64 / sr, self.cur_carrier_q[i] as f64);
            modulator.set_bandpass_params(self.cur_modulator_freq[i] as f64 / sr, self.cur_modulator_q[i] as f64);
            Self::store_coeffs(&mut self.carrier_coeffs, i, &carrier);
            Self::store_coeffs(&mut self.modulator_coeffs, i, &modulator);
        }
        if converged {self.coeffs_dirty = false;}
    }

    fn write_all_coefficients(&mut self) {
        let sr = self.sample_rate as f64;
        let mut carrier = BiquadCoeff::new();
        let mut modulator = BiquadCoeff::new();
        for i in 0..MAX_BANDS {
            carrier.set_bandpass_params(self.cur_carrier_freq[i] as f64 / sr, self.cur_carrier_q[i] as f64);
            modulator.set_bandpass_params(self.cur_modulator_freq[i] as f64 / sr, self.cur_modulator_q[i] as f64);
            Self::store_coeffs(&mut self.carrier_coeffs, i, &carrier);
            Self::store_coeffs(&mut self.modulator_coeffs, i, &modulator);
        }
    }

    #[inline]
    fn store_coeffs(coeffs: &mut [f32; 5 * MAX_BANDS], i: usize, c: &BiquadCoeff) {
        let o = i * 5;
        coeffs[o] = c.b0 as f32;
        coeffs[o + 1] = c.b1 as f32;
        coeffs[o + 2] = c.b2 as f32;
        coeffs[o + 3] = c.a1 as f32;
        coeffs[o + 4] = c.a2 as f32;
    }

    fn reset_band_state(&mut self, i: usize) {
        self.car_cx_l1[i] = 0.0; self.car_cx_l2[i] = 0.0; self.car_cy_l1[i] = 0.0; self.car_cy_l2[i] = 0.0;
        self.car_cx_r1[i] = 0.0; self.car_cx_r2[i] = 0.0; self.car_cy_r1[i] = 0.0; self.car_cy_r2[i] = 0.0;
        self.mod_mx_l1[i] = 0.0; self.mod_mx_l2[i] = 0.0; self.mod_my_l1[i] = 0.0; self.mod_my_l2[i] = 0.0;
        self.mod_mx_r1[i] = 0.0; self.mod_mx_r2[i] = 0.0; self.mod_my_r1[i] = 0.0; self.mod_my_r2[i] = 0.0;
        self.envelope[i] = 0.0;
    }

    fn trim_processed_bands(&mut self) {
        let mut i = self.processed_bands as isize - 1;
        while i >= 0 {
            let index = i as usize;
            if self.target_active[index] != 0.0 || self.band_gain_current[index] >= COLD_THRESHOLD {
                self.processed_bands = index + 1;
                return;
            }
            i -= 1;
        }
        self.processed_bands = 0;
    }

    fn inner_stereo_mod(&mut self, car_l: &[f32], car_r: &[f32], mod_l: &[f32], mod_r: &[f32],
                        out_l: &mut [f32], out_r: &mut [f32], from: usize, to: usize) {
        let dry = self.dry_gain;
        for i in from..to {
            out_l[i] = car_l[i] * dry;
            out_r[i] = car_r[i] * dry;
        }
        let wet = self.wet_gain;
        let band_g = self.band_gain * self.output_gain;
        let a_coeff = self.attack_coeff;
        let r_coeff = self.release_coeff;
        let fade = self.fade_coeff;
        for i in 0..self.processed_bands {
            let o = i * 5;
            let (cb0, cb1, cb2) = (self.carrier_coeffs[o], self.carrier_coeffs[o + 1], self.carrier_coeffs[o + 2]);
            let (ca1, ca2) = (self.carrier_coeffs[o + 3], self.carrier_coeffs[o + 4]);
            let (mb0, mb1, mb2) = (self.modulator_coeffs[o], self.modulator_coeffs[o + 1], self.modulator_coeffs[o + 2]);
            let (ma1, ma2) = (self.modulator_coeffs[o + 3], self.modulator_coeffs[o + 4]);
            let (mut cx_l1, mut cx_l2, mut cy_l1, mut cy_l2) = (self.car_cx_l1[i], self.car_cx_l2[i], self.car_cy_l1[i], self.car_cy_l2[i]);
            let (mut cx_r1, mut cx_r2, mut cy_r1, mut cy_r2) = (self.car_cx_r1[i], self.car_cx_r2[i], self.car_cy_r1[i], self.car_cy_r2[i]);
            let (mut mx_l1, mut mx_l2, mut my_l1, mut my_l2) = (self.mod_mx_l1[i], self.mod_mx_l2[i], self.mod_my_l1[i], self.mod_my_l2[i]);
            let (mut mx_r1, mut mx_r2, mut my_r1, mut my_r2) = (self.mod_mx_r1[i], self.mod_mx_r2[i], self.mod_my_r1[i], self.mod_my_r2[i]);
            let mut env = self.envelope[i];
            let mut gain = self.band_gain_current[i];
            let tgt = self.target_active[i];
            for s in from..to {
                gain = tgt + fade * (gain - tgt);
                let mx_l = mod_l[s];
                let my_l = (mb0 * mx_l + mb1 * mx_l1 + mb2 * mx_l2 - ma1 * my_l1 - ma2 * my_l2) + 1e-18 - 1e-18;
                mx_l2 = mx_l1; mx_l1 = mx_l; my_l2 = my_l1; my_l1 = my_l;
                let mx_r = mod_r[s];
                let my_r = (mb0 * mx_r + mb1 * mx_r1 + mb2 * mx_r2 - ma1 * my_r1 - ma2 * my_r2) + 1e-18 - 1e-18;
                mx_r2 = mx_r1; mx_r1 = mx_r; my_r2 = my_r1; my_r1 = my_r;
                let a_l = my_l.abs();
                let a_r = my_r.abs();
                let peak = if a_l > a_r { a_l } else { a_r };
                env = if env < peak { peak + a_coeff * (env - peak) } else { peak + r_coeff * (env - peak) };
                let cx_l = car_l[s];
                let cy_l = (cb0 * cx_l + cb1 * cx_l1 + cb2 * cx_l2 - ca1 * cy_l1 - ca2 * cy_l2) + 1e-18 - 1e-18;
                cx_l2 = cx_l1; cx_l1 = cx_l; cy_l2 = cy_l1; cy_l1 = cy_l;
                let cx_r = car_r[s];
                let cy_r = (cb0 * cx_r + cb1 * cx_r1 + cb2 * cx_r2 - ca1 * cy_r1 - ca2 * cy_r2) + 1e-18 - 1e-18;
                cx_r2 = cx_r1; cx_r1 = cx_r; cy_r2 = cy_r1; cy_r1 = cy_r;
                let k = env * band_g * wet * gain;
                out_l[s] += cy_l * k;
                out_r[s] += cy_r * k;
            }
            self.car_cx_l1[i] = cx_l1; self.car_cx_l2[i] = cx_l2; self.car_cy_l1[i] = cy_l1; self.car_cy_l2[i] = cy_l2;
            self.car_cx_r1[i] = cx_r1; self.car_cx_r2[i] = cx_r2; self.car_cy_r1[i] = cy_r1; self.car_cy_r2[i] = cy_r2;
            self.mod_mx_l1[i] = mx_l1; self.mod_mx_l2[i] = mx_l2; self.mod_my_l1[i] = my_l1; self.mod_my_l2[i] = my_l2;
            self.mod_mx_r1[i] = mx_r1; self.mod_mx_r2[i] = mx_r2; self.mod_my_r1[i] = my_r1; self.mod_my_r2[i] = my_r2;
            self.envelope[i] = env;
            self.band_gain_current[i] = gain;
        }
    }

    fn inner_mono_mod(&mut self, car_l: &[f32], car_r: &[f32], modu: &[f32],
                      out_l: &mut [f32], out_r: &mut [f32], from: usize, to: usize) {
        let dry = self.dry_gain;
        for i in from..to {
            out_l[i] = car_l[i] * dry;
            out_r[i] = car_r[i] * dry;
        }
        let wet = self.wet_gain;
        let band_g = self.band_gain * self.output_gain;
        let a_coeff = self.attack_coeff;
        let r_coeff = self.release_coeff;
        let fade = self.fade_coeff;
        for i in 0..self.processed_bands {
            let o = i * 5;
            let (cb0, cb1, cb2) = (self.carrier_coeffs[o], self.carrier_coeffs[o + 1], self.carrier_coeffs[o + 2]);
            let (ca1, ca2) = (self.carrier_coeffs[o + 3], self.carrier_coeffs[o + 4]);
            let (mb0, mb1, mb2) = (self.modulator_coeffs[o], self.modulator_coeffs[o + 1], self.modulator_coeffs[o + 2]);
            let (ma1, ma2) = (self.modulator_coeffs[o + 3], self.modulator_coeffs[o + 4]);
            let (mut cx_l1, mut cx_l2, mut cy_l1, mut cy_l2) = (self.car_cx_l1[i], self.car_cx_l2[i], self.car_cy_l1[i], self.car_cy_l2[i]);
            let (mut cx_r1, mut cx_r2, mut cy_r1, mut cy_r2) = (self.car_cx_r1[i], self.car_cx_r2[i], self.car_cy_r1[i], self.car_cy_r2[i]);
            let (mut mx_l1, mut mx_l2, mut my_l1, mut my_l2) = (self.mod_mx_l1[i], self.mod_mx_l2[i], self.mod_my_l1[i], self.mod_my_l2[i]);
            let mut env = self.envelope[i];
            let mut gain = self.band_gain_current[i];
            let tgt = self.target_active[i];
            for s in from..to {
                gain = tgt + fade * (gain - tgt);
                let mx = modu[s];
                let my = (mb0 * mx + mb1 * mx_l1 + mb2 * mx_l2 - ma1 * my_l1 - ma2 * my_l2) + 1e-18 - 1e-18;
                mx_l2 = mx_l1; mx_l1 = mx; my_l2 = my_l1; my_l1 = my;
                let peak = my.abs();
                env = if env < peak { peak + a_coeff * (env - peak) } else { peak + r_coeff * (env - peak) };
                let cx_l = car_l[s];
                let cy_l = (cb0 * cx_l + cb1 * cx_l1 + cb2 * cx_l2 - ca1 * cy_l1 - ca2 * cy_l2) + 1e-18 - 1e-18;
                cx_l2 = cx_l1; cx_l1 = cx_l; cy_l2 = cy_l1; cy_l1 = cy_l;
                let cx_r = car_r[s];
                let cy_r = (cb0 * cx_r + cb1 * cx_r1 + cb2 * cx_r2 - ca1 * cy_r1 - ca2 * cy_r2) + 1e-18 - 1e-18;
                cx_r2 = cx_r1; cx_r1 = cx_r; cy_r2 = cy_r1; cy_r1 = cy_r;
                let k = env * band_g * wet * gain;
                out_l[s] += cy_l * k;
                out_r[s] += cy_r * k;
            }
            self.car_cx_l1[i] = cx_l1; self.car_cx_l2[i] = cx_l2; self.car_cy_l1[i] = cy_l1; self.car_cy_l2[i] = cy_l2;
            self.car_cx_r1[i] = cx_r1; self.car_cx_r2[i] = cx_r2; self.car_cy_r1[i] = cy_r1; self.car_cy_r2[i] = cy_r2;
            self.mod_mx_l1[i] = mx_l1; self.mod_mx_l2[i] = mx_l2; self.mod_my_l1[i] = my_l1; self.mod_my_l2[i] = my_l2;
            self.envelope[i] = env;
            self.band_gain_current[i] = gain;
        }
    }

    fn inner_self(&mut self, car_l: &[f32], car_r: &[f32], out_l: &mut [f32], out_r: &mut [f32], from: usize, to: usize) {
        let dry = self.dry_gain;
        for i in from..to {
            out_l[i] = car_l[i] * dry;
            out_r[i] = car_r[i] * dry;
        }
        let wet = self.wet_gain;
        let band_g = self.band_gain * self.output_gain;
        let a_coeff = self.attack_coeff;
        let r_coeff = self.release_coeff;
        let fade = self.fade_coeff;
        for i in 0..self.processed_bands {
            let o = i * 5;
            let (cb0, cb1, cb2) = (self.carrier_coeffs[o], self.carrier_coeffs[o + 1], self.carrier_coeffs[o + 2]);
            let (ca1, ca2) = (self.carrier_coeffs[o + 3], self.carrier_coeffs[o + 4]);
            let (mut cx_l1, mut cx_l2, mut cy_l1, mut cy_l2) = (self.car_cx_l1[i], self.car_cx_l2[i], self.car_cy_l1[i], self.car_cy_l2[i]);
            let (mut cx_r1, mut cx_r2, mut cy_r1, mut cy_r2) = (self.car_cx_r1[i], self.car_cx_r2[i], self.car_cy_r1[i], self.car_cy_r2[i]);
            let mut env = self.envelope[i];
            let mut gain = self.band_gain_current[i];
            let tgt = self.target_active[i];
            for s in from..to {
                gain = tgt + fade * (gain - tgt);
                let cx_l = car_l[s];
                let cy_l = (cb0 * cx_l + cb1 * cx_l1 + cb2 * cx_l2 - ca1 * cy_l1 - ca2 * cy_l2) + 1e-18 - 1e-18;
                cx_l2 = cx_l1; cx_l1 = cx_l; cy_l2 = cy_l1; cy_l1 = cy_l;
                let cx_r = car_r[s];
                let cy_r = (cb0 * cx_r + cb1 * cx_r1 + cb2 * cx_r2 - ca1 * cy_r1 - ca2 * cy_r2) + 1e-18 - 1e-18;
                cx_r2 = cx_r1; cx_r1 = cx_r; cy_r2 = cy_r1; cy_r1 = cy_r;
                let a_l = cy_l.abs();
                let a_r = cy_r.abs();
                let peak = if a_l > a_r { a_l } else { a_r };
                env = if env < peak { peak + a_coeff * (env - peak) } else { peak + r_coeff * (env - peak) };
                let k = env * band_g * wet * gain;
                out_l[s] += cy_l * k;
                out_r[s] += cy_r * k;
            }
            self.car_cx_l1[i] = cx_l1; self.car_cx_l2[i] = cx_l2; self.car_cy_l1[i] = cy_l1; self.car_cy_l2[i] = cy_l2;
            self.car_cx_r1[i] = cx_r1; self.car_cx_r2[i] = cx_r2; self.car_cy_r1[i] = cy_r1; self.car_cy_r2[i] = cy_r2;
            self.envelope[i] = env;
            self.band_gain_current[i] = gain;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{NoiseColor, NoiseGenerator, VocoderDsp};
    extern crate alloc;

    fn make() -> alloc::boxed::Box<VocoderDsp> {
        let mut dsp: alloc::boxed::Box<VocoderDsp> = unsafe { alloc::boxed::Box::new(core::mem::zeroed()) };
        dsp.init(48_000.0);
        dsp
    }

    #[test]
    fn noise_is_bounded_and_deterministic() {
        let mut a = NoiseGenerator::default();
        let mut b = NoiseGenerator::default();
        for color in [NoiseColor::White, NoiseColor::Pink, NoiseColor::Brown] {
            let mut ba = [0.0f32; 128];
            let mut bb = [0.0f32; 128];
            a.reset(); b.reset();
            a.fill(color, &mut ba, 0, 128);
            b.fill(color, &mut bb, 0, 128);
            assert_eq!(ba, bb, "same seed -> same stream");
            assert!(ba.iter().all(|s| s.is_finite() && s.abs() < 8.0));
        }
    }

    #[test]
    fn self_mode_gates_the_carrier() {
        // A tone through the vocoder in "self" mode (multi-band gate) stays finite and non-silent.
        let mut dsp = make();
        dsp.set_mix(1.0);
        let mut out_l = [0.0f32; 128];
        let mut out_r = [0.0f32; 128];
        let mut car = [0.0f32; 128];
        let mut peak = 0.0f32;
        for block in 0..200 {
            for (i, sample) in car.iter_mut().enumerate() {
                let n = block * 128 + i;
                *sample = 0.5 * libm::sinf(2.0 * core::f32::consts::PI * 220.0 * n as f32 / 48_000.0);
            }
            dsp.process_self(&car, &car, &mut out_l, &mut out_r, 0, 128);
            for &s in out_l.iter() {peak = peak.max(s.abs()); assert!(s.is_finite());}
        }
        assert!(peak > 1.0e-3, "the gated tone is audible (peak {peak})");
    }

    #[test]
    fn external_mod_imprints_when_modulator_present() {
        let mut dsp = make();
        dsp.set_mix(1.0);
        let mut noise = NoiseGenerator::default();
        let (mut out_l, mut out_r) = ([0.0f32; 128], [0.0f32; 128]);
        let (mut car, mut modu) = ([0.0f32; 128], [0.0f32; 128]);
        let mut peak = 0.0f32;
        for block in 0..200 {
            for (i, sample) in car.iter_mut().enumerate() {
                let n = block * 128 + i;
                *sample = 0.4 * libm::sinf(2.0 * core::f32::consts::PI * 330.0 * n as f32 / 48_000.0);
            }
            noise.fill(NoiseColor::White, &mut modu, 0, 128);
            dsp.process_stereo_mod(&car, &car, &modu, &modu, &mut out_l, &mut out_r, 0, 128);
            for &s in out_l.iter() {peak = peak.max(s.abs()); assert!(s.is_finite());}
        }
        assert!(peak > 1.0e-3, "external modulation produces output (peak {peak})");
    }
}
