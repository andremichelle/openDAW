//! The msfa lookup tables (`sin.cc`, `exp2.cc`, `freqlut.cc`): a delta-encoded sine (Q24 phase in, Q24 out),
//! a delta-encoded 2^x (Q24 in / out) and the log-frequency to phase-increment table (per sample rate).
//! Instance-owned instead of C++ globals; built once in `init`.

pub const SIN_LG_N_SAMPLES: u32 = 10;
pub const SIN_N_SAMPLES: usize = 1 << SIN_LG_N_SAMPLES;
pub const EXP2_LG_N_SAMPLES: u32 = 10;
pub const EXP2_N_SAMPLES: usize = 1 << EXP2_LG_N_SAMPLES;
const FREQ_LG_N_SAMPLES: u32 = 10;
const FREQ_N_SAMPLES: usize = 1 << FREQ_LG_N_SAMPLES;
const FREQ_SAMPLE_SHIFT: u32 = 24 - FREQ_LG_N_SAMPLES;
const MAX_LOGFREQ_INT: i32 = 20;

pub struct Tables {
    pub sin: [i32; SIN_N_SAMPLES << 1],
    pub exp2: [i32; EXP2_N_SAMPLES << 1],
    pub freq: [i32; FREQ_N_SAMPLES + 1]
}

impl Tables {
    pub fn init(&mut self, sample_rate: f64) {
        self.init_sin();
        self.init_exp2();
        self.init_freq(sample_rate);
    }

    fn init_sin(&mut self) {
        const R: i64 = 1 << 29;
        let dphase = 2.0 * core::f64::consts::PI / SIN_N_SAMPLES as f64;
        let c = libm::floor(libm::cos(dphase) * (1u32 << 30) as f64 + 0.5) as i32;
        let s = libm::floor(libm::sin(dphase) * (1u32 << 30) as f64 + 0.5) as i32;
        let mut u: i32 = 1 << 30;
        let mut v: i32 = 0;
        for i in 0..SIN_N_SAMPLES / 2 {
            self.sin[(i << 1) + 1] = (v + 32) >> 6;
            self.sin[((i + SIN_N_SAMPLES / 2) << 1) + 1] = -((v + 32) >> 6);
            let t = ((u as i64 * s as i64 + v as i64 * c as i64 + R) >> 30) as i32;
            u = ((u as i64 * c as i64 - v as i64 * s as i64 + R) >> 30) as i32;
            v = t;
        }
        for i in 0..SIN_N_SAMPLES - 1 {
            self.sin[i << 1] = self.sin[(i << 1) + 3] - self.sin[(i << 1) + 1];
        }
        self.sin[(SIN_N_SAMPLES << 1) - 2] = -self.sin[(SIN_N_SAMPLES << 1) - 1];
    }

    fn init_exp2(&mut self) {
        let inc = libm::exp2(1.0 / EXP2_N_SAMPLES as f64);
        let mut y: f64 = (1u32 << 30) as f64;
        for i in 0..EXP2_N_SAMPLES {
            self.exp2[(i << 1) + 1] = libm::floor(y + 0.5) as i32;
            y *= inc;
        }
        for i in 0..EXP2_N_SAMPLES - 1 {
            self.exp2[i << 1] = self.exp2[(i << 1) + 3] - self.exp2[(i << 1) + 1];
        }
        self.exp2[(EXP2_N_SAMPLES << 1) - 2] = (1u32 << 31).wrapping_sub(self.exp2[(EXP2_N_SAMPLES << 1) - 1] as u32) as i32;
    }

    fn init_freq(&mut self, sample_rate: f64) {
        let mut y = (1i64 << (24 + MAX_LOGFREQ_INT)) as f64 / sample_rate;
        let inc = libm::pow(2.0, 1.0 / FREQ_N_SAMPLES as f64);
        for i in 0..FREQ_N_SAMPLES + 1 {
            self.freq[i] = libm::floor(y + 0.5) as i32;
            y *= inc;
        }
    }

    #[inline]
    pub fn sin_lookup(&self, phase: i32) -> i32 {
        const SHIFT: u32 = 24 - SIN_LG_N_SAMPLES;
        let lowbits = phase & ((1 << SHIFT) - 1);
        let phase_int = ((phase >> (SHIFT - 1)) & ((SIN_N_SAMPLES as i32 - 1) << 1)) as usize;
        let dy = self.sin[phase_int];
        let y0 = self.sin[phase_int + 1];
        y0.wrapping_add(((dy as i64 * lowbits as i64) >> SHIFT) as i32)
    }

    #[inline]
    pub fn exp2_lookup(&self, x: i32) -> i32 {
        const SHIFT: u32 = 24 - EXP2_LG_N_SAMPLES;
        let lowbits = x & ((1 << SHIFT) - 1);
        let x_int = ((x >> (SHIFT - 1)) & ((EXP2_N_SAMPLES as i32 - 1) << 1)) as usize;
        let dy = self.exp2[x_int];
        let y0 = self.exp2[x_int + 1];
        let y = y0.wrapping_add(((dy as i64 * lowbits as i64) >> SHIFT) as i32);
        y >> (6 - (x >> 24)).clamp(0, 31)
    }

    #[inline]
    pub fn freq_lookup(&self, logfreq: i32) -> i32 {
        let ix = ((logfreq & 0xffffff) >> FREQ_SAMPLE_SHIFT) as usize;
        let y0 = self.freq[ix];
        let y1 = self.freq[ix + 1];
        let lowbits = logfreq & ((1 << FREQ_SAMPLE_SHIFT) - 1);
        let y = y0.wrapping_add((((y1 - y0) as i64 * lowbits as i64) >> FREQ_SAMPLE_SHIFT) as i32);
        let hibits = logfreq >> 24;
        y >> (MAX_LOGFREQ_INT - hibits).clamp(0, 31)
    }
}
