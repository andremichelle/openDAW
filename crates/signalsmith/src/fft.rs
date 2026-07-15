//! A general iterative radix-2 complex FFT (runtime power-of-two size), the crate's one transform:
//! onset STFT now, phase-vocoder blocks later. Homebrew (no rustfft — dependency policy); twiddles are
//! computed once in f64 via libm and stored f32. `analyser.rs` in `dsp` is fixed-1024/private and not
//! reusable, hence this generalized sibling.

use alloc::vec::Vec;

pub struct Fft {
    size: usize,
    bit_rev: Vec<u32>,
    cos_table: Vec<f32>,
    sin_table: Vec<f32>
}

impl Fft {
    pub fn new(size: usize) -> Self {
        assert!(size.is_power_of_two() && size >= 2, "fft size must be a power of two >= 2");
        let levels = size.trailing_zeros();
        let mut bit_rev = Vec::with_capacity(size);
        for index in 0..size as u32 {
            bit_rev.push(index.reverse_bits() >> (32 - levels));
        }
        let half = size / 2;
        let mut cos_table = Vec::with_capacity(half);
        let mut sin_table = Vec::with_capacity(half);
        for index in 0..half {
            let angle = -2.0 * core::f64::consts::PI * index as f64 / size as f64;
            cos_table.push(libm::cos(angle) as f32);
            sin_table.push(libm::sin(angle) as f32);
        }
        Self {size, bit_rev, cos_table, sin_table}
    }

    pub fn size(&self) -> usize {
        self.size
    }

    /// In-place forward DFT (DIT). `re`/`im` must be `size` long.
    pub fn forward(&self, re: &mut [f32], im: &mut [f32]) {
        self.transform(re, im, false);
    }

    /// In-place inverse DFT, scaled by 1/N so `inverse(forward(x)) == x`.
    pub fn inverse(&self, re: &mut [f32], im: &mut [f32]) {
        self.transform(re, im, true);
        let scale = 1.0 / self.size as f32;
        for value in re.iter_mut() {
            *value *= scale;
        }
        for value in im.iter_mut() {
            *value *= scale;
        }
    }

    fn transform(&self, re: &mut [f32], im: &mut [f32], inverse: bool) {
        let size = self.size;
        assert!(re.len() == size && im.len() == size, "buffer length must equal fft size");
        for index in 0..size {
            let swap = self.bit_rev[index] as usize;
            if swap > index {
                re.swap(index, swap);
                im.swap(index, swap);
            }
        }
        let mut half_block = 1;
        while half_block < size {
            let block = half_block * 2;
            let stride = size / block;
            for start in (0..size).step_by(block) {
                let mut twiddle = 0;
                for even in start..start + half_block {
                    let odd = even + half_block;
                    let cos = self.cos_table[twiddle];
                    let sin = if inverse { -self.sin_table[twiddle] } else { self.sin_table[twiddle] };
                    let odd_re = re[odd] * cos - im[odd] * sin;
                    let odd_im = re[odd] * sin + im[odd] * cos;
                    re[odd] = re[even] - odd_re;
                    im[odd] = im[even] - odd_im;
                    re[even] += odd_re;
                    im[even] += odd_im;
                    twiddle += stride;
                }
            }
            half_block = block;
        }
    }
}
