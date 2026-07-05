//! A spectrum analyser (the port of lib-dsp `FFT` + `AudioAnalyser`): sums L+R into a 1024-sample frame,
//! applies a Blackman window, runs a radix-2 FFT, and holds 512 magnitude bins with a max-or-decay envelope
//! (the decay is armed by the CONSUMER after each read, mirroring TS `analyser.decay = true` in the
//! broadcast callbacks). ALLOCATION-FREE (device crates have no allocator): the struct embeds fixed
//! buffers and is built IN PLACE inside the engine-allocated state block via `init`.

pub const NUM_BINS: usize = 512; // TS AudioAnalyser.DEFAULT_SIZE
const FFT_SIZE: usize = NUM_BINS << 1;
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
    bins: [f32; NUM_BINS],
    index: usize,
    decay_factor: f32,
    /// Armed by the consumer after each bins read (TS sets `analyser.decay = true` in the broadcast
    /// callback); the next completed frame decays un-refreshed bins once, then clears the flag.
    pub decay: bool
}

impl AudioAnalyser {
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
        self.index = 0;
    }

    /// Feed one block (L+R summed, TS `AudioAnalyser.process`); a filled 1024-frame accumulator updates
    /// the bins and restarts.
    pub fn process(&mut self, left: &[f32], right: &[f32]) {
        for index in 0..left.len().min(right.len()) {
            self.real[self.index] = left[index] + right[index];
            self.index += 1;
            if self.index == FFT_SIZE {
                self.update();
            }
        }
    }

    fn update(&mut self) {
        for index in 0..FFT_SIZE {
            self.real[index] *= self.window[index];
        }
        self.fft();
        let scale = 1.0 / NUM_BINS as f32;
        for index in 0..NUM_BINS {
            let re = self.real[index];
            let im = self.imag[index];
            let energy = math::sqrt((re * re + im * im) as f64) as f32 * scale;
            if self.bins[index] < energy {
                self.bins[index] = energy;
            } else if self.decay {
                self.bins[index] *= self.decay_factor;
            }
        }
        self.index = 0;
        self.imag.fill(0.0);
        self.decay = false;
    }

    /// The radix-2 in-place FFT (lib-dsp `FFT.process`): bit-reversal permutation, then butterflies over
    /// the precomputed twiddle tables.
    fn fft(&mut self) {
        for i in 0..FFT_SIZE {
            let j = (reverse(i as u32) >> LEVELS) as usize;
            if j > i {
                self.real.swap(i, j);
                self.imag.swap(i, j);
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
                    let cos = self.cos_table[k];
                    let sin = self.sin_table[k];
                    let real_i = self.real[index];
                    let imag_i = self.imag[index];
                    let p_re = real_i * cos + imag_i * sin;
                    let p_im = imag_i * cos - real_i * sin;
                    let real_j = self.real[j];
                    let imag_j = self.imag[j];
                    self.real[index] = real_j - p_re;
                    self.imag[index] = imag_j - p_im;
                    self.real[j] = real_j + p_re;
                    self.imag[j] = imag_j + p_im;
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
}
