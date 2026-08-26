//! A real-time streaming TD-PSOLA (Time-Domain Pitch-Synchronous Overlap-Add) pitch shifter. Unlike a
//! granular/doppler resampling shifter (a swept delay line, which sounds like the tape speeding
//! up / down whenever the ratio moves), PSOLA copies whole WAVEFORM PERIODS
//! and overlap-adds them at a new spacing: pitch changes, duration and formants do not, and a moving ratio
//! produces no doppler. This is the quality path for the autotune device.
//!
//! It needs the input's PERIOD (fed from the pitch detector) to place analysis marks, plus the shift ratio.
//! Zero-allocation: all state is fixed arrays. A fixed lookahead latency of `2 * MAX_PERIOD` samples lets
//! every synthesis grain see its full extent before the output is read.

const MAX_PERIOD: i64 = 640; // longest input period handled (~75 Hz at 48k); grains span up to 2x this
const MIN_PERIOD: f64 = 40.0; // shortest (~1200 Hz)
const RING_SIZE: usize = 4096;
const RING_MASK: i64 = (RING_SIZE - 1) as i64;
const LATENCY: i64 = 2 * MAX_PERIOD; // output lags input so a grain's full ±P extent is buffered
const MARKS: usize = 64; // recent analysis marks kept for nearest-mark lookup
const MIN_RATIO: f64 = 0.5; // clamp: below this, 2P grains leave gaps in the overlap-add
const MAX_RATIO: f64 = 2.0;

pub struct Psola {
    input: [[f32; RING_SIZE]; 2],
    output: [[f32; RING_SIZE]; 2],
    window_sum: [f32; RING_SIZE], // running Σ of grain windows, for amplitude normalisation
    marks: [i64; MARKS],
    mark_head: usize,
    mark_count: usize,
    write_pos: i64,
    next_analysis: f64,
    next_synth: f64,
    period: f64,
    ratio: f64,
}

impl Psola {
    /// Initialise in place (the state is a ~80KB engine-allocated block; a by-value constructor would put
    /// it on the device's small stack).
    pub fn prepare(&mut self, sample_rate: f32) {
        self.period = sample_rate as f64 / 220.0;
        self.ratio = 1.0;
        self.reset();
    }

    /// The input's fundamental period in samples (from the detector). Analysis grains are spaced by it.
    pub fn set_period(&mut self, period_samples: f32) {
        self.period = math::clamp(period_samples as f64, MIN_PERIOD, MAX_PERIOD as f64);
    }

    pub fn set_ratio_semitones(&mut self, semitones: f32) {
        self.ratio = math::clamp(libm::exp2(semitones as f64 / 12.0), MIN_RATIO, MAX_RATIO);
    }

    pub fn reset(&mut self) {
        for channel in self.input.iter_mut() {channel.fill(0.0);}
        for channel in self.output.iter_mut() {channel.fill(0.0);}
        self.window_sum.fill(0.0);
        self.marks.fill(0);
        self.mark_head = 0;
        self.mark_count = 0;
        self.write_pos = 0;
        self.next_analysis = MAX_PERIOD as f64;
        self.next_synth = MAX_PERIOD as f64;
    }

    pub fn process(&mut self,
                   in_left: &[f32], in_right: &[f32],
                   out_left: &mut [f32], out_right: &mut [f32],
                   from: usize, to: usize) {
        for index in from..to {
            let write_slot = (self.write_pos & RING_MASK) as usize;
            self.input[0][write_slot] = in_left[index];
            self.input[1][write_slot] = in_right[index];
            self.write_pos += 1;
            // Place analysis marks — PITCH-SYNCHRONOUS: advance one period from the PREVIOUS mark, then
            // refine the position by cross-correlation with the previous grain so successive marks sit at
            // the SAME phase of the waveform every period. (The old "loudest sample" anchoring drifted in
            // phase on real vocals → the warble; correlation keeps grains in phase and self-corrects the
            // period estimate.)
            let corr_len = libm::round(self.period) as i64;
            let search = (self.period * 0.25) as i64;
            while self.next_analysis + (corr_len + search) as f64 <= self.write_pos as f64 {
                let expected = libm::round(self.next_analysis) as i64;
                let mark = if self.mark_count > 0 {
                    let prev = self.marks[(self.mark_head + MARKS - 1) % MARKS];
                    self.refine_by_correlation(prev, expected, corr_len, search)
                } else {
                    expected
                };
                self.marks[self.mark_head] = mark;
                self.mark_head = (self.mark_head + 1) % MARKS;
                if self.mark_count < MARKS {self.mark_count += 1;}
                self.next_analysis = mark as f64 + self.period;
            }
            // Place synthesis grains up to where their full extent is available.
            let synth_period = self.period / self.ratio;
            while self.next_synth <= (self.write_pos - MAX_PERIOD) as f64 {
                let center = libm::round(self.next_synth) as i64;
                let analysis = self.nearest_mark(center);
                self.overlap_add(analysis, center);
                self.next_synth += synth_period;
            }
            // Read (and clear) the finalised output `LATENCY` samples behind the input.
            let read_pos = self.write_pos - LATENCY;
            if read_pos >= 0 {
                let read_slot = (read_pos & RING_MASK) as usize;
                let sum = self.window_sum[read_slot];
                let gain = if sum > 1.0e-6 {1.0 / sum} else {0.0};
                out_left[index] = self.output[0][read_slot] * gain;
                out_right[index] = self.output[1][read_slot] * gain;
                self.output[0][read_slot] = 0.0;
                self.output[1][read_slot] = 0.0;
                self.window_sum[read_slot] = 0.0;
            } else {
                out_left[index] = 0.0;
                out_right[index] = 0.0;
            }
        }
    }

    /// Refine a mark near `expected` (within ±search) to the lag whose `corr_len`-long segment best
    /// matches the previous grain in waveform SHAPE (correlation normalised by the candidate's energy).
    /// This locks successive marks to the same phase of the pitch period and self-corrects the period
    /// estimate, which is what keeps the overlap-add clean.
    fn refine_by_correlation(&self, prev: i64, expected: i64, corr_len: i64, search: i64) -> i64 {
        let mut best = expected;
        let mut best_score = f64::NEG_INFINITY;
        for lag in -search..=search {
            let cand = expected + lag;
            if cand < 0 {continue;}
            let mut dot = 0.0f64;
            let mut energy = 0.0f64;
            for k in 0..corr_len {
                let reference = self.input[0][((prev + k) & RING_MASK) as usize] as f64;
                let candidate = self.input[0][((cand + k) & RING_MASK) as usize] as f64;
                dot += reference * candidate;
                energy += candidate * candidate;
            }
            let score = if energy > 1.0e-9 {dot / libm::sqrt(energy)} else {0.0};
            if score > best_score {
                best_score = score;
                best = cand;
            }
        }
        best
    }

    fn nearest_mark(&self, center: i64) -> i64 {
        let mut best = center;
        let mut best_distance = i64::MAX;
        for index in 0..self.mark_count {
            let mark = self.marks[index];
            let distance = (mark - center).abs();
            if distance < best_distance {
                best_distance = distance;
                best = mark;
            }
        }
        best
    }

    /// Overlap-add a Hann-windowed grain (2*period long, centred on the analysis mark) into the output at
    /// `center`, accumulating the window into `window_sum` for later normalisation.
    fn overlap_add(&mut self, analysis: i64, center: i64) {
        let half = libm::round(self.period) as i64;
        for offset in -half..=half {
            let window = 0.5 + 0.5 * libm::cos(core::f64::consts::PI * offset as f64 / half as f64);
            let window = window as f32;
            let source = ((analysis + offset) & RING_MASK) as usize;
            let target = ((center + offset) & RING_MASK) as usize;
            self.output[0][target] += self.input[0][source] * window;
            self.output[1][target] += self.input[1][source] * window;
            self.window_sum[target] += window;
        }
    }
}

#[cfg(test)]
mod tests {
    extern crate alloc;
    use super::*;
    use math::PI;
    use alloc::boxed::Box;
    use alloc::vec;

    fn make(sample_rate: f32) -> Box<Psola> {
        let mut psola: Box<Psola> = unsafe { Box::new(core::mem::zeroed()) };
        psola.prepare(sample_rate);
        psola
    }

    // Zero-crossing frequency estimate on a steady tone.
    fn frequency(samples: &[f32], sample_rate: f32) -> f32 {
        let mut crossings = vec![];
        for index in 1..samples.len() {
            if samples[index - 1] <= 0.0 && samples[index] > 0.0 {crossings.push(index);}
        }
        assert!(crossings.len() > 8, "not enough crossings ({})", crossings.len());
        let spans: f32 = crossings.windows(2).map(|pair| (pair[1] - pair[0]) as f32).sum();
        let period = spans / (crossings.len() - 1) as f32;
        sample_rate / period
    }

    // A harmonic-rich (sawtooth-ish) tone — like real audio, and unlike a pure sine it does not
    // self-cancel under large PSOLA upshifts.
    fn rich(frequency_hz: f32, sample_rate: f32, frames: usize) -> alloc::vec::Vec<f32> {
        let mut phase = 0.0f32;
        (0..frames).map(|_| {
            phase += 2.0 * PI * frequency_hz / sample_rate;
            let mut sample = 0.0f32;
            for harmonic in 1..=6 {
                sample += libm::sinf(harmonic as f32 * phase) / harmonic as f32;
            }
            sample * 0.3
        }).collect()
    }

    fn run_input(psola: &mut Psola, input: &[f32]) -> alloc::vec::Vec<f32> {
        let frames = input.len();
        let (mut left, mut right) = (vec![0.0f32; frames], vec![0.0f32; frames]);
        let mut offset = 0usize;
        while offset < frames {
            let end = core::cmp::min(offset + 128, frames);
            psola.process(input, input, &mut left, &mut right, offset, end);
            offset = end;
        }
        left
    }

    fn run(psola: &mut Psola, frequency_hz: f32, sample_rate: f32, frames: usize) -> alloc::vec::Vec<f32> {
        let input: alloc::vec::Vec<f32> =
            (0..frames).map(|index| 0.5 * libm::sinf(2.0 * PI * frequency_hz * index as f32 / sample_rate)).collect();
        run_input(psola, &input)
    }

    #[test]
    fn octave_up_doubles_the_frequency_without_doppler() {
        let sample_rate = 48_000.0;
        let mut psola = make(sample_rate);
        psola.set_period(sample_rate / 220.0);
        psola.set_ratio_semitones(12.0);
        let input = rich(220.0, sample_rate, 48_000);
        let out = run_input(&mut psola, &input);
        let measured = frequency(&out[24_000..], sample_rate);
        assert!((measured - 440.0).abs() < 12.0, "expected ~440Hz steady, measured {measured}");
    }

    #[test]
    fn fifth_up_raises_by_the_right_ratio() {
        let sample_rate = 48_000.0;
        let mut psola = make(sample_rate);
        psola.set_period(sample_rate / 330.0);
        psola.set_ratio_semitones(7.0); // +7 st => x1.4983
        let out = run(&mut psola, 330.0, sample_rate, 48_000);
        let measured = frequency(&out[24_000..], sample_rate);
        let expected = 330.0 * libm::powf(2.0, 7.0 / 12.0);
        assert!((measured - expected).abs() < 15.0, "expected ~{expected}Hz, measured {measured}");
    }

    #[test]
    fn unity_ratio_preserves_the_pitch() {
        let sample_rate = 48_000.0;
        let mut psola = make(sample_rate);
        psola.set_period(sample_rate / 220.0);
        psola.set_ratio_semitones(0.0);
        let out = run(&mut psola, 220.0, sample_rate, 24_000);
        let measured = frequency(&out[12_000..], sample_rate);
        assert!((measured - 220.0).abs() < 6.0, "ratio 1 must keep 220Hz, measured {measured}");
    }

    #[test]
    fn output_stays_finite_and_bounded() {
        let sample_rate = 44_100.0;
        let mut psola = make(sample_rate);
        psola.set_period(sample_rate / 200.0);
        psola.set_ratio_semitones(-5.0);
        let out = run(&mut psola, 200.0, sample_rate, 22_050);
        for sample in &out {
            assert!(sample.is_finite() && sample.abs() < 2.0, "sample out of range: {sample}");
        }
    }
}
