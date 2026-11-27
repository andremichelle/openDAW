use dsp::biquad::{BiquadCoeff, BiquadMono, BiquadProcessor};
use dsp::noise::WhiteNoise;

pub const MODE_NOISE: i32 = 0;
pub const MODE_WIDE_NOISE: i32 = 1;
pub const MODE_SINE: i32 = 2;
pub const MAX_DEVIATION_SECONDS: f64 = 0.001;
const BUFFER_SIZE: usize = 2048;
const BUFFER_MASK: usize = BUFFER_SIZE - 1;
const SMOOTH_SECONDS: f64 = 0.01;
const COEFF_INTERVAL: u32 = 16;
const NOISE_RMS: f64 = 0.35;
const NOISE_VARIANCE: f64 = 1.0 / 3.0; // uniform white noise in [-1, 1)
const SETTLED: f64 = 1.0e-9;

#[derive(Clone, Copy, Default)]
struct Glide {
    value: f64,
    target: f64
}

impl Glide {
    #[inline]
    fn next(&mut self, coefficient: f64) -> f64 {
        let delta = self.target - self.value;
        if delta.abs() < SETTLED {self.value = self.target} else {self.value += coefficient * delta}
        self.value
    }

    fn jump(&mut self) {self.value = self.target}
}

pub fn width_to_q(octaves: f64) -> f64 {
    let ratio = libm::exp2(octaves);
    libm::sqrt(ratio) / (ratio - 1.0)
}

// A sine or band-passed noise modulates the read position of a short delay, the base delay is the latency.
pub struct Corrode {
    left: [f32; BUFFER_SIZE],
    right: [f32; BUFFER_SIZE],
    write: usize,
    sample_rate: f64,
    base_delay: f64,
    max_deviation: f64,
    smooth: f64,
    noise_a: WhiteNoise,
    noise_b: WhiteNoise,
    filter_a: BiquadMono,
    filter_b: BiquadMono,
    coeff: BiquadCoeff,
    noise_gain: f64,
    phase: f64,
    countdown: u32,
    frequency: Glide,
    width: Glide,
    depth: Glide,
    sine_weight: Glide,
    wide_weight: Glide,
    primed: bool
}

impl Corrode {
    pub fn init(&mut self, sample_rate: f32) {
        self.sample_rate = sample_rate as f64;
        self.max_deviation = MAX_DEVIATION_SECONDS * self.sample_rate;
        self.base_delay = libm::ceil(self.max_deviation) + 2.0;
        self.smooth = 1.0 - libm::exp(-1.0 / (SMOOTH_SECONDS * self.sample_rate));
        self.coeff = BiquadCoeff::new();
        self.frequency.target = 3000.0;
        self.width.target = 1.0;
        self.reset();
    }

    pub fn latency(&self) -> u32 {self.base_delay as u32}

    pub fn reset(&mut self) {
        self.left = [0.0; BUFFER_SIZE];
        self.right = [0.0; BUFFER_SIZE];
        self.write = 0;
        self.noise_a.reset(0x9E37_79B9);
        self.noise_b.reset(0x85EB_CA6B);
        self.filter_a.reset();
        self.filter_b.reset();
        self.phase = 0.0;
        self.countdown = 0;
        self.primed = false;
    }

    pub fn set_mode(&mut self, mode: i32) {
        self.sine_weight.target = if mode == MODE_SINE {1.0} else {0.0};
        self.wide_weight.target = if mode == MODE_WIDE_NOISE {1.0} else {0.0};
    }

    pub fn set_frequency(&mut self, hz: f32) {self.frequency.target = (hz as f64).clamp(1.0, self.sample_rate * 0.45)}

    pub fn set_width(&mut self, octaves: f32) {self.width.target = (octaves as f64).clamp(0.01, 12.0)}

    pub fn set_amount(&mut self, amount: f32) {
        let unit = (amount as f64 / 100.0).clamp(0.0, 1.0);
        self.depth.target = unit * unit * self.max_deviation;
    }

    fn update_filter(&mut self) {
        let frequency = self.frequency.value;
        let q = width_to_q(self.width.value);
        self.coeff.set_bandpass_params(frequency / self.sample_rate, q);
        let band = (core::f64::consts::PI * frequency / (q * self.sample_rate)).min(1.0);
        self.noise_gain = NOISE_RMS / libm::sqrt(NOISE_VARIANCE * band);
    }

    #[inline]
    fn read(buffer: &[f32; BUFFER_SIZE], write: usize, delay: f64) -> f32 {
        let whole = libm::floor(delay);
        let t = delay - whole;
        let base = write.wrapping_sub(whole as usize + 1);
        let xm1 = buffer[base.wrapping_add(1) & BUFFER_MASK] as f64;
        let x0 = buffer[base & BUFFER_MASK] as f64;
        let x1 = buffer[base.wrapping_sub(1) & BUFFER_MASK] as f64;
        let x2 = buffer[base.wrapping_sub(2) & BUFFER_MASK] as f64;
        let c1 = 0.5 * (x1 - xm1);
        let c2 = xm1 - 2.5 * x0 + 2.0 * x1 - 0.5 * x2;
        let c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
        (((c3 * t + c2) * t + c1) * t + x0) as f32
    }

    pub fn process(&mut self, in_left: &[f32], in_right: &[f32], out_left: &mut [f32], out_right: &mut [f32],
                   from: usize, to: usize) {
        if !self.primed {
            for glide in [&mut self.frequency, &mut self.width, &mut self.depth, &mut self.sine_weight, &mut self.wide_weight] {
                glide.jump();
            }
            self.update_filter();
            self.primed = true;
        }
        let smooth = self.smooth;
        for index in from..to {
            let frequency = self.frequency.next(smooth);
            self.width.next(smooth);
            if self.countdown == 0 {
                self.update_filter();
                self.countdown = COEFF_INTERVAL;
            }
            self.countdown -= 1;
            let depth = self.depth.next(smooth);
            let sine_weight = self.sine_weight.next(smooth);
            let wide_weight = self.wide_weight.next(smooth);
            let sine = libm::sin(core::f64::consts::TAU * self.phase);
            self.phase += frequency / self.sample_rate;
            if self.phase >= 1.0 {self.phase -= 1.0}
            let noise_a = self.filter_a.process_frame(&self.coeff, self.noise_a.next() as f64) * self.noise_gain;
            let noise_b = self.filter_b.process_frame(&self.coeff, self.noise_b.next() as f64) * self.noise_gain;
            let noise_right = noise_a + wide_weight * (noise_b - noise_a);
            let modulation_left = (noise_a + sine_weight * (sine - noise_a)).clamp(-1.0, 1.0);
            let modulation_right = (noise_right + sine_weight * (sine - noise_right)).clamp(-1.0, 1.0);
            let write = self.write;
            self.left[write] = in_left[index];
            self.right[write] = in_right[index];
            self.write = (write + 1) & BUFFER_MASK;
            out_left[index] = Self::read(&self.left, self.write, self.base_delay + depth * modulation_left);
            out_right[index] = Self::read(&self.right, self.write, self.base_delay + depth * modulation_right);
        }
    }
}
