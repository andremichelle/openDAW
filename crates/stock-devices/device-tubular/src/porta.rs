//! Portamento rates per CC value (`porta.cpp`, Jean Pierre Cimalando, Apache-2.0): semitones per frame
//! in Q24-per-octave pitch units, plus the slower glissando variant.

use crate::N;

#[derive(Clone, Copy)]
pub struct Porta {
    pub rates: [i32; 128],
    pub rates_glissando: [i32; 128]
}

impl Default for Porta {
    fn default() -> Self {
        Self {rates: [0; 128], rates_glissando: [0; 128]}
    }
}

impl Porta {
    pub fn init(&mut self, sample_rate: f64) {
        const STEP: i32 = (1 << 24) / 12;
        for i in 0..128 {
            let sps = 2100.0 * libm::pow(2.0, -0.062 * i as f64);
            let spp = sps / sample_rate * N as f64;
            self.rates[i] = (0.5f32 as f64 + STEP as f64 * spp) as i32;
            let sps = 1300.0 * libm::pow(2.0, -0.062 * i as f64);
            let spp = sps / sample_rate * N as f64;
            self.rates_glissando[i] = (0.5f32 as f64 + STEP as f64 * spp) as i32;
        }
    }
}
