use core::f64::consts::{PI, SQRT_2};
use math::tan;

// Butterworth damping: Q = 1/sqrt(2), so k = 1/Q = sqrt(2).
const K: f64 = SQRT_2;

// A TPT (topology-preserving transform) state-variable filter section (Zavalishin / Cytomic). Unlike a direct-
// form biquad, its integrator states stay meaningful when the cutoff changes, so it can be modulated (a crossover
// drag) without ringing or going unstable.
#[derive(Clone, Copy)]
struct Svf {
    a1: f64,
    a2: f64,
    a3: f64,
    ic1: [f64; 2],
    ic2: [f64; 2]
}

impl Svf {
    const fn new() -> Self {Self {a1: 0.0, a2: 0.0, a3: 0.0, ic1: [0.0; 2], ic2: [0.0; 2]}}

    fn set(&mut self, fc: f64, sample_rate: f64) {
        let g = tan(PI * fc / sample_rate);
        self.a1 = 1.0 / (1.0 + g * (g + K));
        self.a2 = g * self.a1;
        self.a3 = g * self.a2;
    }

    fn clear(&mut self) {
        self.ic1 = [0.0; 2];
        self.ic2 = [0.0; 2];
    }

    #[inline]
    fn lowpass(&mut self, channel: usize, input: f64) -> f64 {
        let ic1 = self.ic1[channel];
        let ic2 = self.ic2[channel];
        let v3 = input - ic2;
        let v1 = self.a1 * ic1 + self.a2 * v3;
        let v2 = ic2 + self.a2 * ic1 + self.a3 * v3;
        self.ic1[channel] = 2.0 * v1 - ic1;
        self.ic2[channel] = 2.0 * v2 - ic2;
        v2
    }
}

// A 4th-order Linkwitz-Riley lowpass: two cascaded Butterworth SVF sections (-6 dB at the cutoff, 24 dB/oct). The
// frequency splitter derives each band's high side by subtraction, so only the lowpass is needed.
#[derive(Clone, Copy)]
pub struct LinkwitzRiley {
    first: Svf,
    second: Svf
}

impl LinkwitzRiley {
    pub const fn lowpass() -> Self {Self {first: Svf::new(), second: Svf::new()}}

    pub fn set(&mut self, fc: f64, sample_rate: f64) {
        self.first.set(fc, sample_rate);
        self.second.set(fc, sample_rate);
    }

    pub fn clear(&mut self) {
        self.first.clear();
        self.second.clear();
    }

    #[inline]
    fn run(&mut self, channel: usize, input: f64) -> f64 {
        let stage = self.first.lowpass(channel, input);
        self.second.lowpass(channel, stage)
    }

    pub fn process(&mut self, input_l: &[f32], input_r: &[f32], output_l: &mut [f32], output_r: &mut [f32]) {
        for index in 0..input_l.len() {
            output_l[index] = self.run(0, input_l[index] as f64) as f32;
            output_r[index] = self.run(1, input_r[index] as f64) as f32;
        }
    }
}
