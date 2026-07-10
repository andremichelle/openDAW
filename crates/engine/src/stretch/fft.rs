//! Complex math + an iterative radix-2 complex FFT for the COMPLEX-HQ stretch mode. The stretch STFT needs a
//! plain unnormalised transform (`ifft(fft(x)) == N*x`, matching the C++ signalsmith-linear convention where
//! the round-trip gain is folded into the overlap-add window products). Twiddles and the bit-reversal
//! permutation are precomputed at configure time; the transform itself never allocates. Sizes are powers of
//! two (the STFT picks its fft size accordingly), unlike upstream's 2^a*3^b sizes.

use alloc::vec::Vec;

/// A complex f32 sample. The stretch algorithm is all complex multiplies and conjugates, so the few needed
/// operations live here rather than pulling in a dependency.
#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub(crate) struct Complex {
    pub(crate) re: f32,
    pub(crate) im: f32
}

impl Complex {
    pub(crate) const ZERO: Complex = Complex {re: 0.0, im: 0.0};

    pub(crate) fn new(re: f32, im: f32) -> Self {
        Self {re, im}
    }

    /// `e^(i*angle)` (angle in radians).
    pub(crate) fn from_angle(angle: f32) -> Self {
        Self {re: math::cos(angle), im: math::sin(angle)}
    }

    pub(crate) fn add(self, other: Complex) -> Complex {
        Complex {re: self.re + other.re, im: self.im + other.im}
    }

    pub(crate) fn sub(self, other: Complex) -> Complex {
        Complex {re: self.re - other.re, im: self.im - other.im}
    }

    pub(crate) fn mul(self, other: Complex) -> Complex {
        Complex {
            re: self.re * other.re - self.im * other.im,
            im: self.re * other.im + self.im * other.re
        }
    }

    /// `self * conj(other)` (the C++ `mul<true>`), the phase-difference workhorse of the predictor.
    pub(crate) fn mul_conj(self, other: Complex) -> Complex {
        Complex {
            re: other.re * self.re + other.im * self.im,
            im: other.re * self.im - other.im * self.re
        }
    }

    pub(crate) fn conj(self) -> Complex {
        Complex {re: self.re, im: -self.im}
    }

    pub(crate) fn scale(self, factor: f32) -> Complex {
        Complex {re: self.re * factor, im: self.im * factor}
    }

    /// `|self|^2` (the C++ `norm`).
    pub(crate) fn norm(self) -> f32 {
        self.re * self.re + self.im * self.im
    }
}

/// Radix-2 DIT FFT with precomputed twiddles. `forward` uses `e^(-i2*pi*k/N)`, `inverse` the conjugates;
/// neither scales, so a round trip gains `N` (absorbed by the STFT's window products).
pub(crate) struct ComplexFft {
    size: usize,
    twiddles: Vec<Complex>,
    bit_reversed: Vec<u32>
}

impl ComplexFft {
    pub(crate) fn new(size: usize) -> Self {
        debug_assert!(size.is_power_of_two());
        let mut twiddles = Vec::with_capacity(size / 2);
        for k in 0..size / 2 {
            let angle = -2.0 * core::f64::consts::PI * k as f64 / size as f64;
            twiddles.push(Complex::new(math::cos(angle as f32), math::sin(angle as f32)));
        }
        let bits = size.trailing_zeros();
        let mut bit_reversed = Vec::with_capacity(size);
        for index in 0..size {
            bit_reversed.push((index as u32).reverse_bits() >> (32 - bits.max(1)));
        }
        if size == 1 {
            bit_reversed[0] = 0;
        }
        Self {size, twiddles, bit_reversed}
    }

    pub(crate) fn size(&self) -> usize {
        self.size
    }

    pub(crate) fn forward(&self, data: &mut [Complex]) {
        self.transform::<false>(data);
    }

    pub(crate) fn inverse(&self, data: &mut [Complex]) {
        self.transform::<true>(data);
    }

    fn transform<const INVERSE: bool>(&self, data: &mut [Complex]) {
        let size = self.size;
        debug_assert_eq!(data.len(), size);
        for index in 0..size {
            let swap = self.bit_reversed[index] as usize;
            if swap > index {
                data.swap(index, swap);
            }
        }
        let mut half = 1;
        while half < size {
            let stride = size / (half * 2);
            for start in (0..size).step_by(half * 2) {
                for k in 0..half {
                    let twiddle = self.twiddles[k * stride];
                    let twiddle = if INVERSE {twiddle.conj()} else {twiddle};
                    let even = data[start + k];
                    let odd = data[start + k + half].mul(twiddle);
                    data[start + k] = even.add(odd);
                    data[start + k + half] = even.sub(odd);
                }
            }
            half *= 2;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn dft_reference(input: &[Complex], k: usize) -> Complex {
        let size = input.len();
        let mut sum = Complex::ZERO;
        for (n, value) in input.iter().enumerate() {
            let angle = -2.0 * core::f64::consts::PI * (k * n) as f64 / size as f64;
            sum = sum.add(value.mul(Complex::new(math::cos(angle as f32), math::sin(angle as f32))));
        }
        sum
    }

    #[test]
    fn forward_matches_reference_dft() {
        let size = 16;
        let fft = ComplexFft::new(size);
        let mut rng = math::random::Mulberry32::new(0xBEEF);
        let input: vec::Vec<Complex> = (0..size)
            .map(|_| Complex::new(rng.uniform() * 2.0 - 1.0, rng.uniform() * 2.0 - 1.0))
            .collect();
        let mut data = input.clone();
        fft.forward(&mut data);
        for k in 0..size {
            let expected = dft_reference(&input, k);
            assert!((data[k].re - expected.re).abs() < 1e-3, "bin {k} re: {} vs {}", data[k].re, expected.re);
            assert!((data[k].im - expected.im).abs() < 1e-3, "bin {k} im: {} vs {}", data[k].im, expected.im);
        }
    }

    #[test]
    fn round_trip_gains_n() {
        let size = 1024;
        let fft = ComplexFft::new(size);
        let mut rng = math::random::Mulberry32::new(0xF00D);
        let input: vec::Vec<Complex> = (0..size)
            .map(|_| Complex::new(rng.uniform() * 2.0 - 1.0, 0.0))
            .collect();
        let mut data = input.clone();
        fft.forward(&mut data);
        fft.inverse(&mut data);
        for (out, original) in data.iter().zip(input.iter()) {
            assert!((out.re / size as f32 - original.re).abs() < 1e-4);
            assert!((out.im / size as f32 - original.im).abs() < 1e-4);
        }
    }
}
