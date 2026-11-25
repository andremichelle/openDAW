//! Output meters for the mastering device: peak, ITU-R BS.1770 loudness (short-term over 3 s, integrated with the
//! absolute -70 LUFS and relative -10 LU gates) and stereo correlation. Integrated loudness keeps a fixed histogram
//! of 400 ms block energies (the libebur128 approach), so memory never grows while playing. Built in place.

const BLOCK_SECONDS: f64 = 0.1;
const SHORT_TERM_BLOCKS: usize = 30;
const GATE_BLOCKS: usize = 4;
const HISTOGRAM_MIN: f64 = -70.0;
const HISTOGRAM_STEP: f64 = 0.1;
const HISTOGRAM_BINS: usize = 1000;
const CORRELATION_SECONDS: f64 = 0.3;
pub const SILENCE: f32 = -144.0;

fn loudness_of(mean_square: f64) -> f64 {-0.691 + 10.0 * libm::log10(mean_square.max(1e-30))}

#[derive(Clone, Copy)]
struct Biquad {b0: f64, b1: f64, b2: f64, a1: f64, a2: f64}

/// The BS.1770 K-weighting for any rate (high shelf, then high pass), the libebur128 formulas.
fn k_weighting(sample_rate: f64) -> [Biquad; 2] {
    let shelf = {
        let (frequency, gain, quality) = (1681.974450955533, 3.999843853973347, 0.7071752369554196);
        let k = libm::tan(core::f64::consts::PI * frequency / sample_rate);
        let vh = libm::pow(10.0, gain / 20.0);
        let vb = libm::pow(vh, 0.4996667741545416);
        let a0 = 1.0 + k / quality + k * k;
        Biquad {
            b0: (vh + vb * k / quality + k * k) / a0, b1: 2.0 * (k * k - vh) / a0,
            b2: (vh - vb * k / quality + k * k) / a0, a1: 2.0 * (k * k - 1.0) / a0, a2: (1.0 - k / quality + k * k) / a0
        }
    };
    let high_pass = {
        let (frequency, quality) = (38.13547087602444, 0.5003270373238773);
        let k = libm::tan(core::f64::consts::PI * frequency / sample_rate);
        let a0 = 1.0 + k / quality + k * k;
        Biquad {b0: 1.0, b1: -2.0, b2: 1.0, a1: 2.0 * (k * k - 1.0) / a0, a2: (1.0 - k / quality + k * k) / a0}
    };
    [shelf, high_pass]
}

pub struct Loudness {
    filters: [Biquad; 2],
    state: [[[f64; 2]; 2]; 2],
    block_size: usize,
    block_count: usize,
    block_sum: f64,
    blocks: [f64; SHORT_TERM_BLOCKS],
    block_index: usize,
    blocks_seen: usize,
    histogram_counts: [u32; HISTOGRAM_BINS],
    histogram_sums: [f64; HISTOGRAM_BINS]
}

impl Loudness {
    pub fn init(&mut self, sample_rate: f32) {
        self.filters = k_weighting(sample_rate as f64);
        self.block_size = (sample_rate as f64 * BLOCK_SECONDS) as usize;
        self.clear();
    }

    pub fn clear(&mut self) {
        self.state = [[[0.0; 2]; 2]; 2];
        self.block_count = 0;
        self.block_sum = 0.0;
        self.blocks.fill(0.0);
        self.block_index = 0;
        self.blocks_seen = 0;
        self.histogram_counts.fill(0);
        self.histogram_sums.fill(0.0);
    }

    fn weigh(&mut self, channel: usize, input: f64) -> f64 {
        let mut value = input;
        for (stage, filter) in self.filters.iter().enumerate() {
            let [z1, z2] = self.state[channel][stage];
            let output = filter.b0 * value + z1;
            self.state[channel][stage] = [filter.b1 * value - filter.a1 * output + z2, filter.b2 * value - filter.a2 * output];
            value = output;
        }
        value
    }

    pub fn process(&mut self, left: &[f32], right: &[f32]) {
        for (left, right) in left.iter().zip(right) {
            let weighted_left = self.weigh(0, *left as f64);
            let weighted_right = self.weigh(1, *right as f64);
            self.block_sum += weighted_left * weighted_left + weighted_right * weighted_right;
            self.block_count += 1;
            if self.block_count == self.block_size {self.complete_block();}
        }
    }

    fn complete_block(&mut self) {
        self.blocks[self.block_index] = self.block_sum / self.block_size as f64;
        self.block_index = (self.block_index + 1) % SHORT_TERM_BLOCKS;
        self.blocks_seen += 1;
        self.block_sum = 0.0;
        self.block_count = 0;
        if self.blocks_seen >= GATE_BLOCKS {
            let gate = self.mean_of_last(GATE_BLOCKS);
            let loudness = loudness_of(gate);
            if loudness >= HISTOGRAM_MIN {
                let bin = (((loudness - HISTOGRAM_MIN) / HISTOGRAM_STEP) as usize).min(HISTOGRAM_BINS - 1);
                self.histogram_counts[bin] += 1;
                self.histogram_sums[bin] += gate;
            }
        }
    }

    fn mean_of_last(&self, count: usize) -> f64 {
        let count = count.min(self.blocks_seen).min(SHORT_TERM_BLOCKS).max(1);
        (1..=count).map(|offset| self.blocks[(self.block_index + SHORT_TERM_BLOCKS - offset) % SHORT_TERM_BLOCKS])
            .sum::<f64>() / count as f64
    }

    /// The K-weighted mean square of the last 3 s (or less right after a clear).
    pub fn short_term_mean_square(&self) -> f64 {
        if self.blocks_seen == 0 {0.0} else {self.mean_of_last(SHORT_TERM_BLOCKS)}
    }

    pub fn short_term(&self) -> f32 {
        if self.blocks_seen == 0 {SILENCE} else {loudness_of(self.short_term_mean_square()) as f32}
    }

    pub fn integrated(&self) -> f32 {
        let (count, sum) = self.gated(HISTOGRAM_MIN);
        if count == 0 {return SILENCE;}
        let relative = loudness_of(sum / count as f64) - 10.0;
        let (count, sum) = self.gated(relative);
        if count == 0 {SILENCE} else {loudness_of(sum / count as f64) as f32}
    }

    fn gated(&self, threshold: f64) -> (u64, f64) {
        let first = (((threshold - HISTOGRAM_MIN) / HISTOGRAM_STEP).max(0.0) as usize).min(HISTOGRAM_BINS);
        (first..HISTOGRAM_BINS).fold((0, 0.0), |(count, sum), bin|
            (count + self.histogram_counts[bin] as u64, sum + self.histogram_sums[bin]))
    }
}

pub struct Correlation {
    coefficient: f64,
    left_right: f64,
    left_left: f64,
    right_right: f64
}

impl Correlation {
    pub fn init(&mut self, sample_rate: f32) {
        self.coefficient = libm::exp(-1.0 / (CORRELATION_SECONDS * sample_rate as f64));
        self.clear();
    }

    pub fn clear(&mut self) {
        self.left_right = 0.0;
        self.left_left = 0.0;
        self.right_right = 0.0;
    }

    pub fn process(&mut self, left: &[f32], right: &[f32]) {
        let (c, d) = (self.coefficient, 1.0 - self.coefficient);
        for (left, right) in left.iter().zip(right) {
            let (left, right) = (*left as f64, *right as f64);
            self.left_right = c * self.left_right + d * left * right;
            self.left_left = c * self.left_left + d * left * left;
            self.right_right = c * self.right_right + d * right * right;
        }
    }

    /// -1 (out of phase) to +1 (mono), 0 for silence.
    pub fn value(&self) -> f32 {
        let energy = libm::sqrt(self.left_left * self.right_right);
        if energy < 1e-12 {0.0} else {(self.left_right / energy).clamp(-1.0, 1.0) as f32}
    }
}
