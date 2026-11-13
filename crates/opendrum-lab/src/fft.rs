use std::f64::consts::PI;

/// Power spectrum (`size / 2 + 1` bins) of `input` from `start`, Hann windowed, zero padded to `size`.
pub fn power_spectrum(input: &[f64], start: usize, length: usize, size: usize) -> Vec<f64> {
    assert!(size.is_power_of_two() && length <= size);
    let mut re = vec![0.0; size];
    let mut im = vec![0.0; size];
    for index in 0..length {
        let sample = input.get(start + index).copied().unwrap_or(0.0);
        let window = 0.5 - 0.5 * (2.0 * PI * index as f64 / length as f64).cos();
        re[index] = sample * window;
    }
    transform(&mut re, &mut im);
    (0..=size / 2).map(|bin| re[bin] * re[bin] + im[bin] * im[bin]).collect()
}

fn transform(re: &mut [f64], im: &mut [f64]) {
    let size = re.len();
    let shift = usize::BITS - size.trailing_zeros();
    for index in 0..size {
        let swapped = index.reverse_bits() >> shift;
        if swapped > index {
            re.swap(index, swapped);
            im.swap(index, swapped);
        }
    }
    let mut span = 2;
    while span <= size {
        let angle = -2.0 * PI / span as f64;
        for block in (0..size).step_by(span) {
            for offset in 0..span / 2 {
                let (sin, cos) = (angle * offset as f64).sin_cos();
                let (upper, lower) = (block + offset, block + offset + span / 2);
                let product_re = re[lower] * cos - im[lower] * sin;
                let product_im = re[lower] * sin + im[lower] * cos;
                re[lower] = re[upper] - product_re;
                im[lower] = im[upper] - product_im;
                re[upper] += product_re;
                im[upper] += product_im;
            }
        }
        span <<= 1;
    }
}
