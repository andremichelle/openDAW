use engine_env::linkwitz_riley::{LinkwitzRileyCoefficients, LinkwitzRileyStage};
use std::f64::consts::PI;

const SR: f64 = 48_000.0;
const CHUNK: usize = 128;
const SAMPLES: usize = 16_384;
const SETTLE: usize = SAMPLES / 2;

struct Sine {
    phase: f64,
    step: f64
}

impl Sine {
    fn new(freq: f64) -> Self {Self {phase: 0.0, step: 2.0 * PI * freq / SR}}

    fn fill(&mut self, left: &mut [f32], right: &mut [f32]) {
        for index in 0..left.len() {
            let value = self.phase.sin() as f32;
            left[index] = value;
            right[index] = value;
            self.phase += self.step;
        }
    }
}

struct Rms {
    input: f64,
    output: f64,
    count: usize
}

impl Rms {
    fn new() -> Self {Self {input: 0.0, output: 0.0, count: 0}}

    fn add(&mut self, global_index: usize, input: f32, output: f32) {
        if global_index >= SETTLE {
            self.input += (input as f64) * (input as f64);
            self.output += (output as f64) * (output as f64);
            self.count += 1;
        }
    }

    fn ratio(&self) -> f64 {(self.output / self.input).sqrt()}
}

fn allpass(stage_lp: &mut LinkwitzRileyStage, stage_hp: &mut LinkwitzRileyStage,
           input_l: &[f32], input_r: &[f32], output_l: &mut [f32], output_r: &mut [f32]) {
    stage_lp.process(input_l, input_r, output_l, output_r);
    stage_hp.process_add(input_l, input_r, output_l, output_r);
}

fn single_crossover_ratio(fc: f64, freq: f64) -> f64 {
    let coeff = LinkwitzRileyCoefficients::crossover(fc, SR);
    let mut lp = LinkwitzRileyStage::new();
    let mut hp = LinkwitzRileyStage::new();
    lp.set_lowpass(&coeff);
    hp.set_highpass(&coeff);
    let mut sine = Sine::new(freq);
    let mut rms = Rms::new();
    let mut processed = 0usize;
    while processed < SAMPLES {
        let (mut in_l, mut in_r) = ([0.0f32; CHUNK], [0.0f32; CHUNK]);
        sine.fill(&mut in_l, &mut in_r);
        let (mut lo_l, mut lo_r) = ([0.0f32; CHUNK], [0.0f32; CHUNK]);
        let (mut hi_l, mut hi_r) = ([0.0f32; CHUNK], [0.0f32; CHUNK]);
        lp.process(&in_l, &in_r, &mut lo_l, &mut lo_r);
        hp.process(&in_l, &in_r, &mut hi_l, &mut hi_r);
        for index in 0..CHUNK {
            rms.add(processed + index, in_l[index], lo_l[index] + hi_l[index]);
        }
        processed += CHUNK;
    }
    rms.ratio()
}

fn three_band_ratio(f0: f64, f1: f64, freq: f64, compensate: bool) -> f64 {
    let coeff0 = LinkwitzRileyCoefficients::crossover(f0, SR);
    let coeff1 = LinkwitzRileyCoefficients::crossover(f1, SR);
    let mut lp0 = LinkwitzRileyStage::new();
    let mut hp0 = LinkwitzRileyStage::new();
    let mut lp1 = LinkwitzRileyStage::new();
    let mut hp1 = LinkwitzRileyStage::new();
    let mut ap_lp = LinkwitzRileyStage::new();
    let mut ap_hp = LinkwitzRileyStage::new();
    lp0.set_lowpass(&coeff0);
    hp0.set_highpass(&coeff0);
    lp1.set_lowpass(&coeff1);
    hp1.set_highpass(&coeff1);
    ap_lp.set_lowpass(&coeff1);
    ap_hp.set_highpass(&coeff1);
    let mut sine = Sine::new(freq);
    let mut rms = Rms::new();
    let mut processed = 0usize;
    while processed < SAMPLES {
        let (mut in_l, mut in_r) = ([0.0f32; CHUNK], [0.0f32; CHUNK]);
        sine.fill(&mut in_l, &mut in_r);
        let (mut band0_l, mut band0_r) = ([0.0f32; CHUNK], [0.0f32; CHUNK]);
        let (mut rem_l, mut rem_r) = ([0.0f32; CHUNK], [0.0f32; CHUNK]);
        lp0.process(&in_l, &in_r, &mut band0_l, &mut band0_r);
        hp0.process(&in_l, &in_r, &mut rem_l, &mut rem_r);
        let (mut band1_l, mut band1_r) = ([0.0f32; CHUNK], [0.0f32; CHUNK]);
        let (mut band2_l, mut band2_r) = ([0.0f32; CHUNK], [0.0f32; CHUNK]);
        lp1.process(&rem_l, &rem_r, &mut band1_l, &mut band1_r);
        hp1.process(&rem_l, &rem_r, &mut band2_l, &mut band2_r);
        if compensate {
            let (mut ap0_l, mut ap0_r) = ([0.0f32; CHUNK], [0.0f32; CHUNK]);
            allpass(&mut ap_lp, &mut ap_hp, &band0_l, &band0_r, &mut ap0_l, &mut ap0_r);
            band0_l = ap0_l;
        }
        for index in 0..CHUNK {
            rms.add(processed + index, in_l[index], band0_l[index] + band1_l[index] + band2_l[index]);
        }
        processed += CHUNK;
    }
    rms.ratio()
}

#[test]
fn single_crossover_sum_is_allpass_flat_magnitude() {
    for &freq in &[60.0, 250.0, 1_000.0, 4_000.0, 12_000.0] {
        let ratio = single_crossover_ratio(1_000.0, freq);
        assert!((ratio - 1.0).abs() < 0.01,
            "LP+HP at 1kHz should preserve a {freq}Hz sine's magnitude (ratio {ratio})");
    }
}

#[test]
fn three_band_cascade_with_allpass_stays_flat_across_crossovers() {
    for &freq in &[60.0, 200.0, 500.0, 900.0, 1_500.0, 2_000.0, 6_000.0, 12_000.0] {
        let ratio = three_band_ratio(500.0, 1_500.0, freq, true);
        assert!((ratio - 1.0).abs() < 0.02,
            "compensated 3-band sum should preserve a {freq}Hz sine's magnitude (ratio {ratio})");
    }
}

#[test]
fn without_allpass_the_sum_ripples_between_adjacent_crossovers() {
    let worst = [700.0, 900.0, 1_100.0, 1_300.0]
        .iter()
        .map(|&freq| (three_band_ratio(500.0, 1_500.0, freq, false) - 1.0).abs())
        .fold(0.0f64, f64::max);
    assert!(worst > 0.1, "an uncompensated cascade must ripple between close crossovers (worst {worst})");
}
