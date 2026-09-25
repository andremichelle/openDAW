//! Dexed's output stage (`PluginFx.cpp`, Pascal Gauthier / Filatov Vadim, GPL-3.0): a one-pole DC blocker,
//! the output gain and the OBXd 4-pole low-pass (cutoff / resonance), bypassed at cutoff 1. Float / double
//! promotions mirror the C++ expression by expression.

const PI: f32 = core::f32::consts::PI;

fn tptpc(state: &mut f32, inp: f32, cutoff: f32) -> f32 {
    let v: f64 = ((inp - *state) * cutoff / (1.0 + cutoff)) as f64;
    let res: f64 = v + *state as f64;
    *state = (res + v) as f32;
    res as f32
}

fn tptlpupw(state: &mut f32, inp: f32, cutoff: f32, sr_inv: f32) -> f32 {
    let cutoff = (cutoff * sr_inv) * PI;
    let v: f64 = ((inp - *state) * cutoff / (1.0 + cutoff)) as f64;
    let res: f64 = v + *state as f64;
    *state = (res + v) as f32;
    res as f32
}

fn logsc(param: f32, min: f32, max: f32) -> f32 {
    const ROLLOFF: f32 = 19.0;
    ((libm::expf(param * libm::logf(ROLLOFF + 1.0)) - 1.0) / ROLLOFF) * (max - min) + min
}

#[derive(Clone, Copy, Default)]
pub struct PluginFx {
    s1: f32,
    s2: f32,
    s3: f32,
    s4: f32,
    sample_rate: f32,
    sample_rate_inv: f32,
    d: f32,
    c: f32,
    r24: f32,
    rcor24: f32,
    rcor24_inv: f32,
    bright: f32,
    r_cutoff: f32,
    r_reso: f32,
    p_reso: f32,
    p_cutoff: f32,
    dc_id: f32,
    dc_od: f32,
    dc_r: f32,
    pub ui_cutoff: f32,
    pub ui_reso: f32,
    pub ui_gain: f32
}

impl PluginFx {
    pub fn init(&mut self, sample_rate: i32) {
        self.s1 = 0.0;
        self.s2 = 0.0;
        self.s3 = 0.0;
        self.s4 = 0.0;
        self.c = 0.0;
        self.d = 0.0;
        self.r24 = 0.0;
        self.sample_rate = sample_rate as f32;
        self.sample_rate_inv = 1.0 / self.sample_rate;
        let rcrate = libm::sqrt((44000.0f32 / self.sample_rate) as f64) as f32;
        self.rcor24 = ((970.0 / 44000.0) * rcrate as f64) as f32;
        self.rcor24_inv = 1.0 / self.rcor24;
        self.bright = libm::tan(((self.sample_rate * 0.5 - 10.0) * PI * self.sample_rate_inv) as f64) as f32;
        self.p_cutoff = -1.0;
        self.p_reso = -1.0;
        self.dc_r = (1.0 - (126.0 / sample_rate as f64)) as f32;
        self.dc_id = 0.0;
        self.dc_od = 0.0;
        self.ui_cutoff = 1.0;
        self.ui_reso = 0.0;
        self.ui_gain = 1.0;
    }

    pub fn reset_state(&mut self) {
        self.dc_id = 0.0;
        self.dc_od = 0.0;
        self.s1 = 0.0;
        self.s2 = 0.0;
        self.s3 = 0.0;
        self.s4 = 0.0;
        self.c = 0.0;
        self.d = 0.0;
    }

    fn nr24(&self, sample: f32, g: f32, lpc: f32) -> f32 {
        let ml = 1.0 / (1.0 + g);
        let s = (lpc * (lpc * (lpc * self.s1 + self.s2) + self.s3) + self.s4) * ml;
        let big_g = lpc * lpc * lpc * lpc;
        let y = (sample - self.r24 * s) / (1.0 + self.r24 * big_g);
        (y as f64 + 1e-8) as f32
    }

    pub fn process(&mut self, work: &mut [f32]) {
        if work.is_empty() {
            return;
        }
        let mut t_fd = work[0];
        work[0] = work[0] - self.dc_id + self.dc_r * self.dc_od;
        self.dc_id = t_fd;
        for i in 1..work.len() {
            t_fd = work[i];
            work[i] = work[i] - self.dc_id + self.dc_r * work[i - 1];
            self.dc_id = t_fd;
        }
        self.dc_od = work[work.len() - 1];
        if self.ui_gain != 1.0 {
            for sample in work.iter_mut() {
                *sample *= self.ui_gain;
            }
        }
        if self.ui_cutoff == 1.0 {
            return;
        }
        if self.ui_cutoff != self.p_cutoff || self.ui_reso != self.p_reso {
            self.r_reso = (0.991 - logsc(1.0 - self.ui_reso, 0.0, 0.991) as f64) as f32;
            self.r24 = (3.5 * self.r_reso as f64) as f32;
            let cutoff_norm = logsc(self.ui_cutoff, 60.0, 19000.0);
            self.r_cutoff = libm::tan((cutoff_norm * self.sample_rate_inv * PI) as f64) as f32;
            self.p_cutoff = self.ui_cutoff;
            self.p_reso = self.ui_reso;
        }
        let g = self.r_cutoff;
        let lpc = g / (1.0 + g);
        for sample in work.iter_mut() {
            let mut s = *sample;
            s = (s as f64 - 0.45 * tptlpupw(&mut self.c, s, 15.0, self.sample_rate_inv) as f64) as f32;
            s = tptpc(&mut self.d, s, self.bright);
            let y0 = self.nr24(s, g, lpc);
            let v: f64 = ((y0 - self.s1) * lpc) as f64;
            let res: f64 = v + self.s1 as f64;
            self.s1 = (res + v) as f32;
            self.s1 = (libm::atan((self.s1 * self.rcor24) as f64) * self.rcor24_inv as f64) as f32;
            let y1 = res as f32;
            let y2 = tptpc(&mut self.s2, y1, g);
            let y3 = tptpc(&mut self.s3, y2, g);
            let y4 = tptpc(&mut self.s4, y3, g);
            let mc = y4;
            *sample = (mc as f64 * (1.0 + self.r24 as f64 * 0.45)) as f32;
        }
    }
}
