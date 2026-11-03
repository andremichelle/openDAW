// Matchering - Audio Matching and Mastering
// Copyright (C) 2016-2022 Sergree, ported to Rust for openDAW
// Licensed under the GNU General Public License v3.0 or later, see lib.rs.

use std::f64::consts::PI;

/// Iterative radix-2 complex FFT in f64, the precision numpy computes Matchering's analysis in.
pub struct Fft {
    size: usize,
    cos: Vec<f64>,
    sin: Vec<f64>
}

impl Fft {
    pub fn new(size: usize) -> Self {
        assert!(size.is_power_of_two() && size >= 2);
        let (cos, sin) = (0..size / 2).map(|index| {
            let angle = -2.0 * PI * index as f64 / size as f64;
            (angle.cos(), angle.sin())
        }).unzip();
        Self {size, cos, sin}
    }

    pub fn size(&self) -> usize {self.size}

    pub fn forward(&self, re: &mut [f64], im: &mut [f64]) {self.transform(re, im, false);}

    /// Unscaled, a forward-inverse round trip multiplies by `size`.
    pub fn inverse(&self, re: &mut [f64], im: &mut [f64]) {self.transform(re, im, true);}

    fn transform(&self, re: &mut [f64], im: &mut [f64], inverse: bool) {
        let size = self.size;
        assert!(re.len() == size && im.len() == size);
        let bits = size.trailing_zeros();
        for index in 0..size {
            let reversed = index.reverse_bits() >> (usize::BITS - bits);
            if reversed > index {
                re.swap(index, reversed);
                im.swap(index, reversed);
            }
        }
        let sign = if inverse {-1.0} else {1.0};
        let mut length = 2;
        while length <= size {
            let half = length / 2;
            let stride = size / length;
            for start in (0..size).step_by(length) {
                for offset in 0..half {
                    let cos = self.cos[offset * stride];
                    let sin = sign * self.sin[offset * stride];
                    let (a, b) = (start + offset, start + offset + half);
                    let t_re = re[b] * cos - im[b] * sin;
                    let t_im = re[b] * sin + im[b] * cos;
                    re[b] = re[a] - t_re;
                    im[b] = im[a] - t_im;
                    re[a] += t_re;
                    im[a] += t_im;
                }
            }
            length <<= 1;
        }
    }
}
