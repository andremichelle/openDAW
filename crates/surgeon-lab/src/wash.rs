use dsp::dattorro::DattorroReverbDsp;
use crate::svf::{Svf, SvfCoefficients};

const BLOCK: usize = 128;
const DRY: f32 = 0.775;

pub struct Wash {
    pub delay_sixteenths: f64,
    pub delay_feedback: f32,
    pub delay_mix: f32,
    pub reverb_decay: f32,
    pub reverb_mix: f32
}

impl Wash {
    pub const DEFAULT: Wash = Wash {delay_sixteenths: 3.0, delay_feedback: 0.6, delay_mix: 0.5, reverb_decay: 0.8, reverb_mix: 0.319};

    /// A ping pong delay with a darkening feedback path into a plate reverb. Returns left and right.
    pub fn process(&self, input: &[f32], tempo: f64, sample_rate: f64) -> [Vec<f32>; 2] {
        let length = ((60.0 / tempo / 4.0 * self.delay_sixteenths * sample_rate) as usize).max(1);
        let coefficients = SvfCoefficients::new(2800.0, 0.6, sample_rate as f32);
        let high = SvfCoefficients::new(250.0, 0.6, sample_rate as f32);
        let mut lines = [vec![0.0f32; length], vec![0.0f32; length]];
        let mut filters = [Svf::default(), Svf::default(), Svf::default(), Svf::default()];
        let mut delayed = [vec![0.0f32; input.len()], vec![0.0f32; input.len()]];
        for (index, &dry) in input.iter().enumerate() {
            let position = index % length;
            let taps = [lines[0][position], lines[1][position]];
            let dark = [filters[0].process(taps[1], &coefficients).low, filters[1].process(taps[0], &coefficients).low];
            let left = filters[2].process(dark[0], &high).high;
            let right = filters[3].process(dark[1], &high).high;
            lines[0][position] = dry + left * self.delay_feedback;
            lines[1][position] = right * self.delay_feedback;
            delayed[0][index] = dry + taps[0] * self.delay_mix;
            delayed[1][index] = dry + taps[1] * self.delay_mix;
        }
        let mut reverb: Box<DattorroReverbDsp> = unsafe {Box::<DattorroReverbDsp>::new_zeroed().assume_init()};
        reverb.init(sample_rate as f32);
        reverb.set_decay(self.reverb_decay);
        reverb.set_damping(0.3);
        reverb.set_bandwidth(0.7);
        reverb.set_wet_gain(self.reverb_mix);
        reverb.set_dry_gain(DRY);
        let mut output = [vec![0.0f32; input.len()], vec![0.0f32; input.len()]];
        let [out_left, out_right] = &mut output;
        let mut from = 0;
        while from < input.len() {
            let to = (from + BLOCK).min(input.len());
            reverb.process(&delayed[0], &delayed[1], out_left, out_right, from, to);
            from = to;
        }
        output
    }
}
