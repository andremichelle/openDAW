//! Real FFT for the partitioned convolver: an iterative radix-2 complex FFT on SPLIT re/im arrays
//! (SIMD-friendly, no interleaving) wrapped into a real transform of size `n` via even/odd packing
//! (complex size `n/2`) and a post twist. ALLOCATION-FREE: tables live in a capacity-generic struct
//! the owner embeds in its engine-allocated state and fills IN PLACE via `init` (analyser pattern).
//!
//! Spectrum layout: `n/2 + 1` bins in split `re[]` / `im[]` (bin 0 = DC, bin `n/2` = Nyquist, both
//! with zero imag). Inverse takes the same layout and returns `n` real samples scaled by 1 (a full
//! forward+inverse round trip is identity).

/// Twiddle + twist tables for real FFT size `n`. `CAP` must be >= `n/2 + 1`.
pub struct FftTables<const CAP: usize> {
    cos: [f32; CAP],
    sin: [f32; CAP],
    twist_cos: [f32; CAP],
    twist_sin: [f32; CAP],
    n: usize
}

impl<const CAP: usize> FftTables<CAP> {
    /// Fill the tables IN PLACE for real size `n` (a power of two, `n/2 + 1 <= CAP`).
    pub fn init(&mut self, n: usize) {
        assert!(n.is_power_of_two() && n / 2 + 1 <= CAP);
        let m = n / 2;
        for index in 0..m / 2 {
            let angle = 2.0 * core::f64::consts::PI * index as f64 / m as f64;
            self.cos[index] = libm::cos(angle) as f32;
            self.sin[index] = libm::sin(angle) as f32;
        }
        for index in 0..=m {
            let angle = 2.0 * core::f64::consts::PI * index as f64 / n as f64;
            self.twist_cos[index] = libm::cos(angle) as f32;
            self.twist_sin[index] = libm::sin(angle) as f32;
        }
        self.n = n;
    }

    pub fn size(&self) -> usize {
        self.n
    }

    /// In-place complex FFT of size `m` on split arrays (forward when `inverse` is false).
    fn cfft(&self, re: &mut [f32], im: &mut [f32], m: usize, inverse: bool) {
        let shift = 32 - m.trailing_zeros();
        for i in 0..m {
            let j = (reverse_bits(i as u32) >> shift) as usize;
            if j > i {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let sign = if inverse { -1.0f32 } else { 1.0f32 };
        let mut size = 2usize;
        loop {
            let half_size = size >> 1;
            let table_step = m / size;
            let mut i = 0usize;
            while i < m {
                let mut k = 0usize;
                for j in i..i + half_size {
                    let index = j + half_size;
                    let cos = self.cos[k];
                    let sin = sign * self.sin[k];
                    let re_i = re[index];
                    let im_i = im[index];
                    let p_re = re_i * cos + im_i * sin;
                    let p_im = im_i * cos - re_i * sin;
                    let re_j = re[j];
                    let im_j = im[j];
                    re[index] = re_j - p_re;
                    im[index] = im_j - p_im;
                    re[j] = re_j + p_re;
                    im[j] = im_j + p_im;
                    k += table_step;
                }
                i += size;
            }
            if size == m {
                break;
            }
            size <<= 1;
        }
    }

    /// Forward real FFT: `input` (`n` samples) into `spec_re`/`spec_im` (`n/2 + 1` bins each).
    /// The `scratch_*` buffers need `n/2` floats each.
    pub fn forward(&self, input: &[f32], spec_re: &mut [f32], spec_im: &mut [f32],
                   scratch_re: &mut [f32], scratch_im: &mut [f32]) {
        let n = self.n;
        let m = n / 2;
        let (z_re, z_im) = (&mut scratch_re[..m], &mut scratch_im[..m]);
        for index in 0..m {
            z_re[index] = input[index << 1];
            z_im[index] = input[(index << 1) + 1];
        }
        self.cfft(z_re, z_im, m, false);
        spec_re[0] = z_re[0] + z_im[0];
        spec_im[0] = 0.0;
        spec_re[m] = z_re[0] - z_im[0];
        spec_im[m] = 0.0;
        for k in 1..=m / 2 {
            let k2 = m - k;
            let er = 0.5 * (z_re[k] + z_re[k2]);
            let ei = 0.5 * (z_im[k] - z_im[k2]);
            let or = 0.5 * (z_im[k] + z_im[k2]);
            let oi = -0.5 * (z_re[k] - z_re[k2]);
            let wr = self.twist_cos[k];
            let wi = -self.twist_sin[k];
            let tr = or * wr - oi * wi;
            let ti = or * wi + oi * wr;
            spec_re[k] = er + tr;
            spec_im[k] = ei + ti;
            spec_re[k2] = er - tr;
            spec_im[k2] = -(ei - ti);
        }
    }

    /// Inverse real FFT: `spec_re`/`spec_im` (`n/2 + 1` bins) into `output` (`n` samples).
    /// The `scratch_*` buffers need `n/2` floats each. Forward followed by inverse is identity.
    pub fn inverse(&self, spec_re: &[f32], spec_im: &[f32], output: &mut [f32],
                   scratch_re: &mut [f32], scratch_im: &mut [f32]) {
        let n = self.n;
        let m = n / 2;
        let (z_re, z_im) = (&mut scratch_re[..m], &mut scratch_im[..m]);
        z_re[0] = 0.5 * (spec_re[0] + spec_re[m]);
        z_im[0] = 0.5 * (spec_re[0] - spec_re[m]);
        for k in 1..=m / 2 {
            let k2 = m - k;
            let er = 0.5 * (spec_re[k] + spec_re[k2]);
            let ei = 0.5 * (spec_im[k] - spec_im[k2]);
            let tr = 0.5 * (spec_re[k] - spec_re[k2]);
            let ti = 0.5 * (spec_im[k] + spec_im[k2]);
            let wr = self.twist_cos[k];
            let wi = self.twist_sin[k];
            let or = tr * wr - ti * wi;
            let oi = tr * wi + ti * wr;
            z_re[k] = er - oi;
            z_im[k] = ei + or;
            z_re[k2] = er + oi;
            z_im[k2] = -(ei - or);
        }
        self.cfft(z_re, z_im, m, true);
        let scale = 1.0 / m as f32;
        for index in 0..m {
            output[index << 1] = z_re[index] * scale;
            output[(index << 1) + 1] = z_im[index] * scale;
        }
    }
}

fn reverse_bits(mut i: u32) -> u32 {
    i = (i & 0x55555555) << 1 | (i >> 1) & 0x55555555;
    i = (i & 0x33333333) << 2 | (i >> 2) & 0x33333333;
    i = (i & 0x0f0f0f0f) << 4 | (i >> 4) & 0x0f0f0f0f;
    (i << 24) | ((i & 0xff00) << 8) | ((i >> 8) & 0xff00) | (i >> 24)
}
