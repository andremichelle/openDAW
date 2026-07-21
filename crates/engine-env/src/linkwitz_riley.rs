use core::f64::consts::PI;
use math::{sqrt, tan};

const DENORMAL: f64 = 1.0e-18;

#[derive(Clone, Copy, Default)]
pub struct LinkwitzRileyCoefficients {
    forward_lp: [f64; 5],
    forward_hp: [f64; 5],
    feedback: [f64; 4]
}

impl LinkwitzRileyCoefficients {
    pub fn crossover(fc: f64, sf: f64) -> Self {
        let wc = 2.0 * PI * fc;
        let wc2 = wc * wc;
        let wc3 = wc2 * wc;
        let wc4 = wc2 * wc2;
        let k = wc / tan(PI * fc / sf);
        let k2 = k * k;
        let k3 = k2 * k;
        let k4 = k2 * k2;
        let sqrt2 = sqrt(2.0);
        let sq_tmp1 = sqrt2 * wc3 * k;
        let sq_tmp2 = sqrt2 * wc * k3;
        let a_tmp = 4.0 * wc2 * k2 + 2.0 * sq_tmp1 + k4 + 2.0 * sq_tmp2 + wc4;
        let b1 = (4.0 * (wc4 + sq_tmp1 - k4 - sq_tmp2)) / a_tmp;
        let b2 = (6.0 * wc4 - 8.0 * wc2 * k2 + 6.0 * k4) / a_tmp;
        let b3 = (4.0 * (wc4 - sq_tmp1 + sq_tmp2 - k4)) / a_tmp;
        let b4 = (k4 - 2.0 * sq_tmp1 + wc4 - 2.0 * sq_tmp2 + 4.0 * wc2 * k2) / a_tmp;
        let la0 = wc4 / a_tmp;
        let la1 = 4.0 * wc4 / a_tmp;
        let la2 = 6.0 * wc4 / a_tmp;
        let ha0 = k4 / a_tmp;
        let ha1 = -4.0 * k4 / a_tmp;
        let ha2 = 6.0 * k4 / a_tmp;
        Self {
            forward_lp: [la0, la1, la2, la1, la0],
            forward_hp: [ha0, ha1, ha2, ha1, ha0],
            feedback: [b1, b2, b3, b4]
        }
    }
}

#[derive(Clone, Copy)]
struct Channel {
    x: [f64; 4],
    y: [f64; 4]
}

impl Channel {
    const fn new() -> Self {Self {x: [0.0; 4], y: [0.0; 4]}}

    #[inline]
    fn tick(&mut self, a: &[f64; 5], b: &[f64; 4], input: f64) -> f64 {
        let output = a[0] * input + a[1] * self.x[0] + a[2] * self.x[1] + a[3] * self.x[2] + a[4] * self.x[3]
            - b[0] * self.y[0] - b[1] * self.y[1] - b[2] * self.y[2] - b[3] * self.y[3] + DENORMAL - DENORMAL;
        self.x[3] = self.x[2];
        self.x[2] = self.x[1];
        self.x[1] = self.x[0];
        self.x[0] = input;
        self.y[3] = self.y[2];
        self.y[2] = self.y[1];
        self.y[1] = self.y[0];
        self.y[0] = output;
        output
    }
}

#[derive(Clone, Copy)]
pub struct LinkwitzRileyStage {
    a: [f64; 5],
    b: [f64; 4],
    left: Channel,
    right: Channel
}

impl LinkwitzRileyStage {
    pub const fn new() -> Self {
        Self {a: [0.0; 5], b: [0.0; 4], left: Channel::new(), right: Channel::new()}
    }

    pub fn set_lowpass(&mut self, coefficients: &LinkwitzRileyCoefficients) {
        self.a = coefficients.forward_lp;
        self.b = coefficients.feedback;
    }

    pub fn set_highpass(&mut self, coefficients: &LinkwitzRileyCoefficients) {
        self.a = coefficients.forward_hp;
        self.b = coefficients.feedback;
    }

    pub fn clear(&mut self) {
        self.left = Channel::new();
        self.right = Channel::new();
    }

    pub fn process(&mut self, input_l: &[f32], input_r: &[f32], output_l: &mut [f32], output_r: &mut [f32]) {
        for index in 0..input_l.len() {
            output_l[index] = self.left.tick(&self.a, &self.b, input_l[index] as f64) as f32;
            output_r[index] = self.right.tick(&self.a, &self.b, input_r[index] as f64) as f32;
        }
    }

    pub fn process_add(&mut self, input_l: &[f32], input_r: &[f32], output_l: &mut [f32], output_r: &mut [f32]) {
        for index in 0..input_l.len() {
            output_l[index] += self.left.tick(&self.a, &self.b, input_l[index] as f64) as f32;
            output_r[index] += self.right.tick(&self.a, &self.b, input_r[index] as f64) as f32;
        }
    }
}
