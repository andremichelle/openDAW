//! A spectrum analyser (the port of lib-dsp `FFT` + `AudioAnalyser`): sums L+R into a 1024-sample frame,
//! applies a Blackman window, runs a radix-2 FFT, and holds 512 magnitude bins with a max-or-decay envelope
//! (the decay is armed by the CONSUMER after each read, mirroring TS `analyser.decay = true` in the
//! broadcast callbacks). The L-R difference adds its power through a second FFT, so anti-phase content shows
//! up and mono reads as before. ALLOCATION-FREE (device crates have no allocator): the struct embeds fixed
//! buffers and is built IN PLACE inside the engine-allocated state block via `init`.

pub const NUM_BINS: usize = 512; // TS AudioAnalyser.DEFAULT_SIZE
pub(crate) const FFT_SIZE: usize = NUM_BINS << 1;
const LEVELS: u32 = 32 - FFT_SIZE.trailing_zeros(); // bit-reversal shift for the fixed frame size
const DEFAULT_DECAY: f32 = 0.90; // TS AudioAnalyser.DEFAULT_DECAY

fn reverse(mut i: u32) -> u32 {
    i = (i & 0x55555555) << 1 | (i >> 1) & 0x55555555;
    i = (i & 0x33333333) << 2 | (i >> 2) & 0x33333333;
    i = (i & 0x0f0f0f0f) << 4 | (i >> 4) & 0x0f0f0f0f;
    (i << 24) | ((i & 0xff00) << 8) | ((i >> 8) & 0xff00) | (i >> 24)
}

pub struct AudioAnalyser {
    cos_table: [f32; NUM_BINS],
    sin_table: [f32; NUM_BINS],
    window: [f32; FFT_SIZE],
    real: [f32; FFT_SIZE],
    imag: [f32; FFT_SIZE],
    side_real: [f32; FFT_SIZE],
    side_imag: [f32; FFT_SIZE],
    has_side: bool,
    bins: [f32; NUM_BINS],
    index: usize,
    decay_factor: f32,
    /// Armed by the consumer after each bins read (TS sets `analyser.decay = true` in the broadcast
    /// callback); the next completed frame decays un-refreshed bins once, then clears the flag.
    pub decay: bool
}

impl AudioAnalyser {
    /// Build a fresh analyser (for owners that are not the zeroed device-state block).
    pub fn new(decay_factor: f32) -> Self {
        let mut analyser = Self {
            cos_table: [0.0; NUM_BINS], sin_table: [0.0; NUM_BINS], window: [0.0; FFT_SIZE],
            real: [0.0; FFT_SIZE], imag: [0.0; FFT_SIZE], side_real: [0.0; FFT_SIZE], side_imag: [0.0; FFT_SIZE],
            has_side: false, bins: [0.0; NUM_BINS], index: 0, decay_factor: 0.0, decay: false
        };
        analyser.init(decay_factor);
        analyser
    }

    /// Build IN PLACE (the state block arrives zeroed; this fills the twiddle + window tables).
    pub fn init(&mut self, decay_factor: f32) {
        for index in 0..NUM_BINS {
            let angle = 2.0 * core::f64::consts::PI * index as f64 / FFT_SIZE as f64;
            self.cos_table[index] = libm::cos(angle) as f32;
            self.sin_table[index] = libm::sin(angle) as f32;
        }
        // TS Window.create(Blackman, n): 0.42323 - 0.49755 cos(2ai) + 0.07922 cos(4ai), a = PI / (n - 1).
        let a = core::f64::consts::PI / (FFT_SIZE - 1) as f64;
        for index in 0..FFT_SIZE {
            let phase = index as f64;
            self.window[index] = (0.42323 - 0.49755 * libm::cos(2.0 * a * phase) + 0.07922 * libm::cos(4.0 * a * phase)) as f32;
        }
        self.real.fill(0.0);
        self.imag.fill(0.0);
        self.side_real.fill(0.0);
        self.side_imag.fill(0.0);
        self.has_side = false;
        self.bins.fill(0.0);
        self.index = 0;
        self.decay_factor = if decay_factor > 0.0 { decay_factor } else { DEFAULT_DECAY };
        self.decay = false;
    }

    pub fn bins(&self) -> &[f32] {
        &self.bins
    }

    pub fn clear(&mut self) {
        self.bins.fill(0.0);
        self.real.fill(0.0);
        self.side_real.fill(0.0);
        self.has_side = false;
        self.index = 0;
    }

    /// Feed one block (L+R and L-R, TS `AudioAnalyser.process`); a filled 1024-frame accumulator updates
    /// the bins and restarts.
    pub fn process(&mut self, left: &[f32], right: &[f32]) {
        for index in 0..left.len().min(right.len()) {
            let side = left[index] - right[index];
            self.real[self.index] = left[index] + right[index];
            self.side_real[self.index] = side;
            self.has_side |= side != 0.0;
            self.index += 1;
            if self.index == FFT_SIZE {
                self.update();
            }
        }
    }

    pub(crate) fn analyse_ring(&mut self, ring: &[f32; FFT_SIZE], side_ring: &[f32; FFT_SIZE], write_index: usize) {
        for index in 0..FFT_SIZE {
            let position = (write_index + index) & (FFT_SIZE - 1);
            self.real[index] = ring[position];
            self.side_real[index] = side_ring[position];
            self.has_side |= side_ring[position] != 0.0;
        }
        self.update();
    }

    fn update(&mut self) {
        for index in 0..FFT_SIZE {
            self.real[index] *= self.window[index];
        }
        fft(&mut self.real, &mut self.imag, &self.cos_table, &self.sin_table);
        if self.has_side {
            for index in 0..FFT_SIZE {
                self.side_real[index] *= self.window[index];
            }
            fft(&mut self.side_real, &mut self.side_imag, &self.cos_table, &self.sin_table);
        }
        let scale = 1.0 / NUM_BINS as f32;
        for index in 0..NUM_BINS {
            let re = self.real[index];
            let im = self.imag[index];
            let power = if self.has_side {
                let side_re = self.side_real[index];
                let side_im = self.side_imag[index];
                re * re + im * im + side_re * side_re + side_im * side_im
            } else {
                re * re + im * im
            };
            let energy = math::sqrt(power as f64) as f32 * scale;
            if self.bins[index] < energy {
                self.bins[index] = energy;
            } else if self.decay {
                self.bins[index] *= self.decay_factor;
            }
        }
        self.index = 0;
        self.imag.fill(0.0);
        if self.has_side {
            self.side_imag.fill(0.0);
            self.has_side = false;
        }
        self.decay = false;
    }
}

/// The radix-2 in-place FFT (lib-dsp `FFT.process`): bit-reversal permutation, then butterflies over the
/// precomputed twiddle tables.
fn fft(real: &mut [f32; FFT_SIZE], imag: &mut [f32; FFT_SIZE], cos_table: &[f32; NUM_BINS], sin_table: &[f32; NUM_BINS]) {
    for i in 0..FFT_SIZE {
        let j = (reverse(i as u32) >> LEVELS) as usize;
        if j > i {
            real.swap(i, j);
            imag.swap(i, j);
        }
    }
    let mut size = 2usize;
    loop {
        let half_size = size >> 1;
        let table_step = FFT_SIZE / size;
        let mut i = 0usize;
        while i < FFT_SIZE {
            let m = i + half_size;
            let mut k = 0usize;
            for j in i..m {
                let index = j + half_size;
                let cos = cos_table[k];
                let sin = sin_table[k];
                let real_i = real[index];
                let imag_i = imag[index];
                let p_re = real_i * cos + imag_i * sin;
                let p_im = imag_i * cos - real_i * sin;
                let real_j = real[j];
                let imag_j = imag[j];
                real[index] = real_j - p_re;
                imag[index] = imag_j - p_im;
                real[j] = real_j + p_re;
                imag[j] = imag_j + p_im;
                k += table_step;
            }
            i += size;
        }
        if size == FFT_SIZE {
            break;
        }
        size <<= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::{AudioAnalyser, DEFAULT_DECAY};

    fn analyser() -> Box<AudioAnalyser> {
        // The struct is large (device state embeds it); tests build it zeroed on the heap like the engine does.
        let mut boxed: Box<AudioAnalyser> = Box::new(unsafe { core::mem::zeroed() });
        boxed.init(DEFAULT_DECAY);
        boxed
    }

    #[test]
    fn a_sine_concentrates_energy_in_its_bin_and_decay_fades_it() {
        let mut analyser = analyser();
        // Bin k spans k * sr / fftSize; feed the exact center of bin 32 (frequency = 32/1024 cycles/sample).
        let mut block = [0.0f32; 128];
        for round in 0..8usize {
            for (offset, value) in block.iter_mut().enumerate() {
                let phase = (round * 128 + offset) as f64 * 32.0 / 1024.0;
                *value = libm::sin(phase * 2.0 * core::f64::consts::PI) as f32 * 0.5;
            }
            analyser.process(&block.clone(), &block);
        }
        let bins = analyser.bins();
        let peak_bin = (0..bins.len()).max_by(|&a, &b| bins[a].total_cmp(&bins[b])).unwrap();
        assert_eq!(peak_bin, 32, "the sine's energy lands in its bin");
        assert!(bins[32] > 0.1, "the bin carries real energy");
        let held = bins[32];
        analyser.decay = true;
        let silence = [0.0f32; 128];
        for _ in 0..8 {
            analyser.process(&silence, &silence);
        }
        assert!(analyser.bins()[32] < held, "an armed decay fades an un-refreshed bin");
    }

    fn sine_block(round: usize, bin: f64, gain: f64) -> [f32; 128] {
        let mut block = [0.0f32; 128];
        for (offset, value) in block.iter_mut().enumerate() {
            let phase = (round * 128 + offset) as f64 * bin / 1024.0;
            *value = (libm::sin(phase * 2.0 * core::f64::consts::PI) * gain) as f32;
        }
        block
    }

    fn feed(analyser: &mut AudioAnalyser, left: impl Fn(usize) -> [f32; 128], right: impl Fn(usize) -> [f32; 128]) {
        for round in 0..8usize {
            analyser.process(&left(round), &right(round));
        }
    }

    #[test]
    fn anti_phase_reads_exactly_like_mono() {
        let mut mono = analyser();
        let mut anti = analyser();
        feed(&mut mono, |round| sine_block(round, 32.0, 0.5), |round| sine_block(round, 32.0, 0.5));
        feed(&mut anti, |round| sine_block(round, 32.0, 0.5), |round| sine_block(round, 32.0, -0.5));
        assert!(anti.bins()[32] > 0.1, "an anti-phase sine is visible");
        for (index, (a, b)) in mono.bins().iter().zip(anti.bins()).enumerate() {
            assert!((a - b).abs() <= a.abs() * 1e-6 + 1e-9, "bin {index}: mono {a} anti-phase {b}");
        }
    }

    #[test]
    fn a_hard_left_sine_reads_like_mono_of_equal_power() {
        let mut left = analyser();
        let mut mono = analyser();
        feed(&mut left, |round| sine_block(round, 32.0, 0.5), |_| [0.0; 128]);
        let gain = 0.5 * core::f64::consts::FRAC_1_SQRT_2;
        feed(&mut mono, |round| sine_block(round, 32.0, gain), |round| sine_block(round, 32.0, gain));
        let difference = 20.0 * libm::log10((left.bins()[32] / mono.bins()[32]) as f64);
        assert!(difference.abs() < 0.01, "difference {difference} dB");
    }

    #[test]
    fn different_tones_left_and_right_both_show() {
        let mut stereo = analyser();
        feed(&mut stereo, |round| sine_block(round, 32.0, 0.5), |round| sine_block(round, 64.0, 0.5));
        let bins = stereo.bins();
        assert!(bins[32] > 0.1 && bins[64] > 0.1, "left {} right {}", bins[32], bins[64]);
        let difference = 20.0 * libm::log10((bins[32] / bins[64]) as f64);
        assert!(difference.abs() < 0.01, "both tones read the same level, difference {difference} dB");
    }

    #[test]
    fn silence_on_the_side_after_side_content_falls_back_to_the_mono_path() {
        let mut analyser = analyser();
        feed(&mut analyser, |round| sine_block(round, 32.0, 0.5), |round| sine_block(round, 32.0, -0.5));
        analyser.clear();
        let mut reference = super::AudioAnalyser::new(DEFAULT_DECAY);
        feed(&mut analyser, |round| sine_block(round, 16.0, 0.5), |round| sine_block(round, 16.0, 0.5));
        feed(&mut reference, |round| sine_block(round, 16.0, 0.5), |round| sine_block(round, 16.0, 0.5));
        assert_eq!(analyser.bins(), reference.bins());
    }
}
