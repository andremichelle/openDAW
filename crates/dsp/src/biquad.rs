//! Biquad filter: coefficients ([`BiquadCoeff`]) plus processors ([`BiquadMono`], [`BiquadStack`]) — a port
//! of lib-dsp `biquad-coeff.ts` / `biquad-processor.ts`. Coefficients and filter state are `f64` (TS
//! `number`) for stability at high Q / low cutoff; the signal buffers are `f32`. A `cutoff` (and shelf /
//! peaking `frequency`) is a NORMALISED frequency `freq / sample_rate`, so `0.5` is Nyquist — exactly the TS
//! `unitValue` convention.
//!
//! Not ported: `BiquadCoeff.getFrequencyResponse` (a UI analysis helper, not on the audio path).

use core::f64::consts::TAU;
use math::clamp;

/// The Butterworth (maximally flat) Q, the TS `setLowpassParams` default resonance (`Math.SQRT1_2`).
pub const BUTTERWORTH_Q: f64 = core::f64::consts::FRAC_1_SQRT_2;

/// The five normalised biquad coefficients (`a0` divided out). Mirrors TS `BiquadCoeff`.
#[derive(Clone, Copy, Debug)]
pub struct BiquadCoeff {
    pub a1: f64,
    pub a2: f64,
    pub b0: f64,
    pub b1: f64,
    pub b2: f64
}

impl Default for BiquadCoeff {
    fn default() -> Self {
        Self::new()
    }
}

impl BiquadCoeff {
    /// A pass-through (identity) filter.
    pub fn new() -> Self {
        let mut coeff = Self {a1: 0.0, a2: 0.0, b0: 0.0, b1: 0.0, b2: 0.0};
        coeff.identity();
        coeff
    }

    pub fn identity(&mut self) {
        self.set_normalized_coefficients(1.0, 0.0, 0.0, 1.0, 0.0, 0.0);
    }

    /// Store the coefficients divided by `a0` (the one place normalisation happens). Mirrors TS
    /// `setNormalizedCoefficients`.
    pub fn set_normalized_coefficients(&mut self, b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) {
        let inverse = 1.0 / a0;
        self.b0 = b0 * inverse;
        self.b1 = b1 * inverse;
        self.b2 = b2 * inverse;
        self.a1 = a1 * inverse;
        self.a2 = a2 * inverse;
    }

    pub fn set_lowpass_params(&mut self, cutoff: f64, resonance: f64) {
        let cutoff = clamp(cutoff, 0.0, 1.0);
        if cutoff >= 0.5 {
            self.set_normalized_coefficients(1.0, 0.0, 0.0, 1.0, 0.0, 0.0);
        } else if cutoff > 0.0 {
            let theta = TAU * cutoff;
            let alpha = libm::sin(theta) / (2.0 * resonance);
            let cosw = libm::cos(theta);
            let beta = (1.0 - cosw) / 2.0;
            self.set_normalized_coefficients(beta, 2.0 * beta, beta, 1.0 + alpha, -2.0 * cosw, 1.0 - alpha);
        } else {
            self.set_normalized_coefficients(0.0, 0.0, 0.0, 1.0, 0.0, 0.0);
        }
    }

    pub fn set_highpass_params(&mut self, cutoff: f64, resonance: f64) {
        let cutoff = clamp(cutoff, 0.0, 1.0);
        if cutoff == 1.0 {
            self.set_normalized_coefficients(0.0, 0.0, 0.0, 1.0, 0.0, 0.0);
        } else if cutoff > 0.0 {
            let theta = TAU * cutoff;
            let alpha = libm::sin(theta) / (2.0 * resonance);
            let cosw = libm::cos(theta);
            let beta = (1.0 + cosw) / 2.0;
            self.set_normalized_coefficients(beta, -2.0 * beta, beta, 1.0 + alpha, -2.0 * cosw, 1.0 - alpha);
        } else {
            self.set_normalized_coefficients(1.0, 0.0, 0.0, 1.0, 0.0, 0.0);
        }
    }

    pub fn set_low_shelf_params(&mut self, frequency: f64, db_gain: f64) {
        let frequency = clamp(frequency, 0.0, 1.0);
        let a = libm::pow(10.0, db_gain / 40.0);
        if frequency == 1.0 {
            self.set_normalized_coefficients(a * a, 0.0, 0.0, 1.0, 0.0, 0.0);
        } else if frequency > 0.0 {
            let w0 = TAU * frequency;
            // shelf slope S = 1, so the TS `sqrt((a + 1/a)*(1/S - 1) + 2)` collapses to a constant sqrt(2).
            let alpha = 0.5 * libm::sin(w0) * core::f64::consts::SQRT_2;
            let k = libm::cos(w0);
            let k2 = 2.0 * libm::sqrt(a) * alpha;
            let a_plus_one = a + 1.0;
            let a_minus_one = a - 1.0;
            self.set_normalized_coefficients(
                a * (a_plus_one - a_minus_one * k + k2),
                2.0 * a * (a_minus_one - a_plus_one * k),
                a * (a_plus_one - a_minus_one * k - k2),
                a_plus_one + a_minus_one * k + k2,
                -2.0 * (a_minus_one + a_plus_one * k),
                a_plus_one + a_minus_one * k - k2);
        } else {
            self.set_normalized_coefficients(1.0, 0.0, 0.0, 1.0, 0.0, 0.0);
        }
    }

    pub fn set_high_shelf_params(&mut self, frequency: f64, db_gain: f64) {
        let frequency = clamp(frequency, 0.0, 1.0);
        let a = libm::pow(10.0, db_gain / 40.0);
        if frequency == 1.0 {
            self.set_normalized_coefficients(1.0, 0.0, 0.0, 1.0, 0.0, 0.0);
        } else if frequency > 0.0 {
            let w0 = TAU * frequency;
            // shelf slope S = 1, so the TS `sqrt((a + 1/a)*(1/S - 1) + 2)` collapses to a constant sqrt(2).
            let alpha = 0.5 * libm::sin(w0) * core::f64::consts::SQRT_2;
            let k = libm::cos(w0);
            let k2 = 2.0 * libm::sqrt(a) * alpha;
            let a_plus_one = a + 1.0;
            let a_minus_one = a - 1.0;
            self.set_normalized_coefficients(
                a * (a_plus_one + a_minus_one * k + k2),
                -2.0 * a * (a_minus_one + a_plus_one * k),
                a * (a_plus_one + a_minus_one * k - k2),
                a_plus_one - a_minus_one * k + k2,
                2.0 * (a_minus_one - a_plus_one * k),
                a_plus_one - a_minus_one * k - k2);
        } else {
            self.set_normalized_coefficients(a * a, 0.0, 0.0, 1.0, 0.0, 0.0);
        }
    }

    pub fn set_peaking_params(&mut self, frequency: f64, q: f64, db_gain: f64) {
        let frequency = clamp(frequency, 0.0, 1.0);
        let q = q.max(0.0);
        let a = libm::pow(10.0, db_gain / 40.0);
        if frequency > 0.0 && frequency < 1.0 {
            if q > 0.0 {
                let w0 = TAU * frequency;
                let alpha = libm::sin(w0) / (2.0 * q);
                let k = libm::cos(w0);
                self.set_normalized_coefficients(
                    1.0 + alpha * a, -2.0 * k, 1.0 - alpha * a,
                    1.0 + alpha / a, -2.0 * k, 1.0 - alpha / a);
            } else {
                self.set_normalized_coefficients(a * a, 0.0, 0.0, 1.0, 0.0, 0.0);
            }
        } else {
            self.set_normalized_coefficients(1.0, 0.0, 0.0, 1.0, 0.0, 0.0);
        }
    }

    pub fn set_allpass_params(&mut self, frequency: f64, q: f64) {
        let frequency = clamp(frequency, 0.0, 1.0);
        let q = q.max(0.0);
        if frequency > 0.0 && frequency < 1.0 {
            if q > 0.0 {
                let w0 = TAU * frequency;
                let alpha = libm::sin(w0) / (2.0 * q);
                let k = libm::cos(w0);
                self.set_normalized_coefficients(
                    1.0 - alpha, -2.0 * k, 1.0 + alpha,
                    1.0 + alpha, -2.0 * k, 1.0 - alpha);
            } else {
                self.set_normalized_coefficients(-1.0, 0.0, 0.0, 1.0, 0.0, 0.0);
            }
        } else {
            self.set_normalized_coefficients(1.0, 0.0, 0.0, 1.0, 0.0, 0.0);
        }
    }

    pub fn set_notch_params(&mut self, frequency: f64, q: f64) {
        let frequency = clamp(frequency, 0.0, 1.0);
        let q = q.max(0.0);
        if frequency > 0.0 && frequency < 1.0 {
            if q > 0.0 {
                let w0 = TAU * frequency;
                let alpha = libm::sin(w0) / (2.0 * q);
                let k = libm::cos(w0);
                self.set_normalized_coefficients(
                    1.0, -2.0 * k, 1.0,
                    1.0 + alpha, -2.0 * k, 1.0 - alpha);
            } else {
                self.set_normalized_coefficients(0.0, 0.0, 0.0, 1.0, 0.0, 0.0);
            }
        } else {
            self.set_normalized_coefficients(1.0, 0.0, 0.0, 1.0, 0.0, 0.0);
        }
    }

    pub fn set_bandpass_params(&mut self, frequency: f64, q: f64) {
        let frequency = frequency.max(0.0);
        let q = q.max(0.0);
        if frequency > 0.0 && frequency < 1.0 {
            let w0 = TAU * frequency;
            if q > 0.0 {
                let alpha = libm::sin(w0) / (2.0 * q);
                let k = libm::cos(w0);
                self.set_normalized_coefficients(
                    alpha, 0.0, -alpha,
                    1.0 + alpha, -2.0 * k, 1.0 - alpha);
            } else {
                self.set_normalized_coefficients(1.0, 0.0, 0.0, 1.0, 0.0, 0.0);
            }
        } else {
            self.set_normalized_coefficients(0.0, 0.0, 0.0, 1.0, 0.0, 0.0);
        }
    }
}

/// A biquad signal processor (TS `BiquadProcessor`): a transposed-direct-form-II-ish difference equation
/// over a sample range, plus a single-sample form for serial chaining.
pub trait BiquadProcessor {
    fn reset(&mut self);
    /// Filter `source[from..to]` into `target[from..to]` with `coeff`. `source` and `target` are distinct
    /// buffers; for in-place chaining use [`BiquadStack`] or `process_frame`.
    fn process(&mut self, coeff: &BiquadCoeff, source: &[f32], target: &mut [f32], from: usize, to: usize);
    fn process_frame(&mut self, coeff: &BiquadCoeff, x: f64) -> f64;
}

/// One second-order section with its own delay state (`x[n-1..2]`, `y[n-1..2]`). Mirrors TS `BiquadMono`.
#[derive(Default)]
pub struct BiquadMono {
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64
}

impl BiquadMono {
    pub fn new() -> Self {
        Self::default()
    }

    /// Filter `buffer[from..to]` in place (used by [`BiquadStack`] for sections after the first).
    fn process_in_place(&mut self, coeff: &BiquadCoeff, buffer: &mut [f32], from: usize, to: usize) {
        let BiquadCoeff {a1, a2, b0, b1, b2} = *coeff;
        let (mut x1, mut x2, mut y1, mut y2) = (self.x1, self.x2, self.y1, self.y2);
        for sample in &mut buffer[from..to] {
            let x = *sample as f64;
            // the `+1e-18-1e-18` is the TS denormal flush (keeps tiny tails from stalling the FPU).
            let y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) + 1e-18 - 1e-18;
            *sample = y as f32;
            x2 = x1;
            x1 = x;
            y2 = y1;
            y1 = y;
        }
        self.x1 = x1;
        self.x2 = x2;
        self.y1 = y1;
        self.y2 = y2;
    }
}

impl BiquadProcessor for BiquadMono {
    fn reset(&mut self) {
        self.x1 = 0.0;
        self.x2 = 0.0;
        self.y1 = 0.0;
        self.y2 = 0.0;
    }

    fn process(&mut self, coeff: &BiquadCoeff, source: &[f32], target: &mut [f32], from: usize, to: usize) {
        let BiquadCoeff {a1, a2, b0, b1, b2} = *coeff;
        let (mut x1, mut x2, mut y1, mut y2) = (self.x1, self.x2, self.y1, self.y2);
        for index in from..to {
            let x = source[index] as f64;
            let y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) + 1e-18 - 1e-18;
            target[index] = y as f32;
            x2 = x1;
            x1 = x;
            y2 = y1;
            y1 = y;
        }
        self.x1 = x1;
        self.x2 = x2;
        self.y1 = y1;
        self.y2 = y2;
    }

    fn process_frame(&mut self, coeff: &BiquadCoeff, x: f64) -> f64 {
        let y = (coeff.b0 * x + coeff.b1 * self.x1 + coeff.b2 * self.x2 - coeff.a1 * self.y1 - coeff.a2 * self.y2)
            + 1e-18 - 1e-18;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

/// The most sections a [`BiquadStack`] can cascade. A fixed array (not a `Vec`) keeps `dsp` allocation-free,
/// so a `no_std` device with no global allocator can still use it.
pub const MAX_SECTIONS: usize = 8;

/// A serial stack of `BiquadMono` sections sharing one `coeff`, for steeper slopes (TS `BiquadStack`). The
/// active `order` (number of sections applied) can be lowered without clearing the array; changing it
/// resets the state.
pub struct BiquadStack {
    stack: [BiquadMono; MAX_SECTIONS],
    order: usize
}

impl BiquadStack {
    /// Build a stack with `max_order` active sections (capped at [`MAX_SECTIONS`]).
    pub fn new(max_order: usize) -> Self {
        Self {stack: core::array::from_fn(|_| BiquadMono::new()), order: max_order.min(MAX_SECTIONS)}
    }

    pub fn order(&self) -> usize {
        self.order
    }

    pub fn set_order(&mut self, value: usize) {
        let value = value.min(MAX_SECTIONS);
        if self.order == value {
            return;
        }
        self.order = value;
        self.reset();
    }

    /// Cascade the active sections over `buffer[from..to]` IN PLACE with one shared `coeff` (order 0 leaves
    /// the buffer untouched). Used by [`ModulatedBiquad`], which feeds a run of same-cutoff samples.
    pub fn process_in_place(&mut self, coeff: &BiquadCoeff, buffer: &mut [f32], from: usize, to: usize) {
        for section in &mut self.stack[..self.order] {
            section.process_in_place(coeff, buffer, from, to);
        }
    }
}

impl BiquadProcessor for BiquadStack {
    fn reset(&mut self) {
        for section in &mut self.stack {
            section.reset();
        }
    }

    fn process(&mut self, coeff: &BiquadCoeff, source: &[f32], target: &mut [f32], from: usize, to: usize) {
        if self.order == 0 {
            target[from..to].copy_from_slice(&source[from..to]);
            return;
        }
        // First section reads the external source; the rest chain in place over the target.
        self.stack[0].process(coeff, source, target, from, to);
        for section in &mut self.stack[1..self.order] {
            section.process_in_place(coeff, target, from, to);
        }
    }

    fn process_frame(&mut self, coeff: &BiquadCoeff, x: f64) -> f64 {
        let mut value = x;
        for section in &mut self.stack[..self.order] {
            value = section.process_frame(coeff, value);
        }
        value
    }
}

/// The number of exponential frequency steps the modulated cutoff is quantised to (mirrors the TS LUT size).
const MODULATION_STEPS: i32 = 512;

/// A low-pass biquad whose cutoff is MODULATED per sample (filter envelope, LFO, keyboard tracking) — a
/// heap-free port of lib-dsp `ModulatedBiquad`. The cutoff arrives as a UNIT value (0..1), is quantised to
/// [`MODULATION_STEPS`] steps mapped EXPONENTIALLY onto `[min_cutoff, max_cutoff]`, and the coefficients are
/// recomputed only when the quantised step changes — so a smoothly-moving cutoff costs a handful of updates
/// per block, not one per sample. `order` cascades that many sections (shared Q). Unlike the TS there is no
/// precomputed frequency table (the frequency is computed on each step change), so the filter is valid when
/// zeroed and needs no constructor.
pub struct ModulatedBiquad {
    stack: BiquadStack,
    coeff: BiquadCoeff,
    last_index: i32,
    coeff_valid: bool
}

impl ModulatedBiquad {
    pub fn new() -> Self {
        Self {stack: BiquadStack::new(1), coeff: BiquadCoeff::new(), last_index: 0, coeff_valid: false}
    }

    /// Filter `buffer[from..to]` in place. `cutoffs[i]` is the unit cutoff (0..1) for sample `i`, mapped
    /// exponentially onto `[min_cutoff, max_cutoff]` Hz at `sample_rate`; `resonance` is the shared Q; `order`
    /// (>= 1) is the number of cascaded sections.
    #[allow(clippy::too_many_arguments)]
    pub fn process(&mut self, buffer: &mut [f32], cutoffs: &[f32], resonance: f64, order: usize,
                   min_cutoff: f64, max_cutoff: f64, sample_rate: f32, from: usize, to: usize) {
        self.stack.set_order(order);
        let inv_sample_rate = 1.0 / sample_rate as f64;
        let log_ratio = libm::log(max_cutoff / min_cutoff);
        let last = (MODULATION_STEPS - 1) as f32;
        let index_at = |sample: usize| (clamp(cutoffs[sample], 0.0, 1.0) * last) as i32;
        let mut start = from;
        while start < to {
            let index = index_at(start);
            if !self.coeff_valid || index != self.last_index {
                let frequency = min_cutoff * libm::exp(index as f64 / last as f64 * log_ratio);
                self.coeff.set_lowpass_params(frequency * inv_sample_rate, resonance);
                self.last_index = index;
                self.coeff_valid = true;
            }
            // extend the run while the quantised cutoff (hence the coefficients) stays the same.
            let mut end = start + 1;
            while end < to && index_at(end) == index {
                end += 1;
            }
            self.stack.process_in_place(&self.coeff, buffer, start, end);
            start = end;
        }
    }

    pub fn reset(&mut self) {
        self.stack.reset();
        self.coeff_valid = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn energy(samples: &[f32]) -> f32 {
        samples.iter().map(|sample| sample * sample).sum()
    }

    fn nyquist(len: usize) -> Vec<f32> {
        (0..len).map(|index| if index % 2 == 0 {1.0} else {-1.0}).collect()
    }

    fn run<P: BiquadProcessor>(processor: &mut P, coeff: &BiquadCoeff, input: &[f32]) -> Vec<f32> {
        let mut output = vec![0.0f32; input.len()];
        processor.process(coeff, input, &mut output, 0, input.len());
        output
    }

    #[test]
    fn identity_passes_through() {
        let coeff = BiquadCoeff::new();
        let input: Vec<f32> = (0..64).map(|index| (index as f32 * 0.1).sin()).collect();
        let output = run(&mut BiquadMono::new(), &coeff, &input);
        for (a, b) in input.iter().zip(output.iter()) {
            assert!((a - b).abs() < 1.0e-6, "identity is a pass-through");
        }
    }

    #[test]
    fn lowpass_attenuates_nyquist_and_passes_dc() {
        let mut coeff = BiquadCoeff::new();
        coeff.set_lowpass_params(0.05, BUTTERWORTH_Q); // 0.05 * sample_rate cutoff
        let nyq = run(&mut BiquadMono::new(), &coeff, &nyquist(512));
        assert!(energy(&nyq) < 0.05 * energy(&nyquist(512)), "the Nyquist tone is strongly attenuated");
        let dc = run(&mut BiquadMono::new(), &coeff, &[1.0f32; 512]);
        assert!(dc[511] > 0.95, "DC passes through");
    }

    #[test]
    fn highpass_passes_nyquist_and_blocks_dc() {
        let mut coeff = BiquadCoeff::new();
        coeff.set_highpass_params(0.05, BUTTERWORTH_Q);
        let dc = run(&mut BiquadMono::new(), &coeff, &[1.0f32; 512]);
        assert!(dc[511].abs() < 0.05, "DC is blocked");
        let nyq = run(&mut BiquadMono::new(), &coeff, &nyquist(512));
        assert!(energy(&nyq) > 0.5 * energy(&nyquist(512)), "the Nyquist tone passes");
    }

    #[test]
    fn higher_resonance_peaks_more_at_the_cutoff() {
        // A tone at the cutoff frequency passes with more energy as Q rises (the resonant peak).
        let cutoff = 0.05;
        let tone: Vec<f32> = (0..2048).map(|index| (core::f64::consts::TAU * cutoff * index as f64).sin() as f32).collect();
        let mut flat = BiquadCoeff::new();
        flat.set_lowpass_params(cutoff, BUTTERWORTH_Q);
        let mut resonant = BiquadCoeff::new();
        resonant.set_lowpass_params(cutoff, 8.0);
        let low = run(&mut BiquadMono::new(), &flat, &tone);
        let high = run(&mut BiquadMono::new(), &resonant, &tone);
        // compare the settled tail, past the transient.
        assert!(energy(&high[1024..]) > energy(&low[1024..]) * 1.5, "higher Q lifts the tone at the cutoff");
    }

    #[test]
    fn stack_is_steeper_than_a_single_section() {
        // Two cascaded sections attenuate a tone above the cutoff more than one.
        let cutoff = 0.02;
        let tone: Vec<f32> = (0..2048).map(|index| (core::f64::consts::TAU * 0.1 * index as f64).sin() as f32).collect();
        let mut coeff = BiquadCoeff::new();
        coeff.set_lowpass_params(cutoff, BUTTERWORTH_Q);
        let one = run(&mut BiquadMono::new(), &coeff, &tone);
        let mut stack = BiquadStack::new(2);
        let two = run(&mut stack, &coeff, &tone);
        assert!(energy(&two[1024..]) < energy(&one[1024..]), "the 2-section stack attenuates more");
    }

    // The modulated biquad maps a UNIT cutoff (0..1) exponentially onto [20, 20000] Hz at 48 kHz.
    const MOD_SR: f32 = 48_000.0;
    const MOD_MIN: f64 = 20.0;
    const MOD_MAX: f64 = 20_000.0;

    #[test]
    fn modulated_low_cutoff_attenuates_more_than_high() {
        let input = nyquist(2048);
        let (mut low, mut high) = (input.clone(), input.clone());
        let cut_low = vec![0.1f32; 2048];
        let cut_high = vec![0.9f32; 2048];
        ModulatedBiquad::new().process(&mut low, &cut_low, BUTTERWORTH_Q, 1, MOD_MIN, MOD_MAX, MOD_SR, 0, 2048);
        ModulatedBiquad::new().process(&mut high, &cut_high, BUTTERWORTH_Q, 1, MOD_MIN, MOD_MAX, MOD_SR, 0, 2048);
        assert!(energy(&high) > energy(&low) * 2.0, "a higher cutoff passes more of the Nyquist tone");
    }

    #[test]
    fn modulated_higher_order_is_steeper() {
        let input = nyquist(2048);
        let (mut order1, mut order4) = (input.clone(), input.clone());
        let cut = vec![0.3f32; 2048];
        ModulatedBiquad::new().process(&mut order1, &cut, BUTTERWORTH_Q, 1, MOD_MIN, MOD_MAX, MOD_SR, 0, 2048);
        ModulatedBiquad::new().process(&mut order4, &cut, BUTTERWORTH_Q, 4, MOD_MIN, MOD_MAX, MOD_SR, 0, 2048);
        assert!(energy(&order4) < energy(&order1), "more cascaded sections attenuate the stop-band more");
    }

    #[test]
    fn a_constant_cutoff_filters_steadily() {
        let input = nyquist(512);
        let mut buffer = input.clone();
        let cut = vec![0.5f32; 512];
        ModulatedBiquad::new().process(&mut buffer, &cut, BUTTERWORTH_Q, 1, MOD_MIN, MOD_MAX, MOD_SR, 0, 512);
        assert!(energy(&buffer) < energy(&input), "the steady low-pass attenuates the Nyquist tone");
    }

    #[test]
    fn a_swept_cutoff_stays_bounded() {
        // A cutoff sweeping 0 -> 1 crosses many quantisation steps, recomputing coefficients along the way.
        let input = nyquist(512);
        let mut buffer = input.clone();
        let cut: Vec<f32> = (0..512).map(|index| index as f32 / 511.0).collect();
        ModulatedBiquad::new().process(&mut buffer, &cut, BUTTERWORTH_Q, 2, MOD_MIN, MOD_MAX, MOD_SR, 0, 512);
        assert!(buffer.iter().all(|sample| sample.abs() < 4.0), "stays finite across the sweep");
    }
}
