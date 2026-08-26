use signalsmith::fft::Fft;

fn naive_dft(re: &[f32], im: &[f32]) -> (Vec<f32>, Vec<f32>) {
    let size = re.len();
    let mut out_re = vec![0.0f32; size];
    let mut out_im = vec![0.0f32; size];
    for bin in 0..size {
        let mut sum_re = 0.0f64;
        let mut sum_im = 0.0f64;
        for index in 0..size {
            let angle = -2.0 * std::f64::consts::PI * bin as f64 * index as f64 / size as f64;
            let (sin, cos) = angle.sin_cos();
            sum_re += re[index] as f64 * cos - im[index] as f64 * sin;
            sum_im += re[index] as f64 * sin + im[index] as f64 * cos;
        }
        out_re[bin] = sum_re as f32;
        out_im[bin] = sum_im as f32;
    }
    (out_re, out_im)
}

fn pseudo_random(seed: &mut u64) -> f32 {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 7;
    *seed ^= *seed << 17;
    ((*seed >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0) as f32
}

#[test]
fn matches_naive_dft() {
    for size in [8usize, 64, 1024] {
        let fft = Fft::new(size);
        let mut seed = 0x2545F4914F6CDD1Du64;
        let src_re: Vec<f32> = (0..size).map(|_| pseudo_random(&mut seed)).collect();
        let src_im: Vec<f32> = (0..size).map(|_| pseudo_random(&mut seed)).collect();
        let (want_re, want_im) = naive_dft(&src_re, &src_im);
        let mut re = src_re.clone();
        let mut im = src_im.clone();
        fft.forward(&mut re, &mut im);
        let tolerance = 1e-3 * (size as f32).sqrt();
        for bin in 0..size {
            assert!((re[bin] - want_re[bin]).abs() < tolerance, "size {size} bin {bin} re: {} vs {}", re[bin], want_re[bin]);
            assert!((im[bin] - want_im[bin]).abs() < tolerance, "size {size} bin {bin} im: {} vs {}", im[bin], want_im[bin]);
        }
    }
}

#[test]
fn inverse_returns_the_input() {
    let size = 512;
    let fft = Fft::new(size);
    let mut seed = 0x9E3779B97F4A7C15u64;
    let src: Vec<f32> = (0..size).map(|_| pseudo_random(&mut seed)).collect();
    let mut re = src.clone();
    let mut im = vec![0.0f32; size];
    fft.forward(&mut re, &mut im);
    fft.inverse(&mut re, &mut im);
    for index in 0..size {
        assert!((re[index] - src[index]).abs() < 1e-4, "index {index}: {} vs {}", re[index], src[index]);
        assert!(im[index].abs() < 1e-4);
    }
}

#[test]
fn parseval_energy_is_preserved() {
    let size = 256;
    let fft = Fft::new(size);
    let mut seed = 0xD1B54A32D192ED03u64;
    let src: Vec<f32> = (0..size).map(|_| pseudo_random(&mut seed)).collect();
    let time_energy: f64 = src.iter().map(|value| (*value as f64) * (*value as f64)).sum();
    let mut re = src.clone();
    let mut im = vec![0.0f32; size];
    fft.forward(&mut re, &mut im);
    let freq_energy: f64 = (0..size).map(|bin| (re[bin] as f64).powi(2) + (im[bin] as f64).powi(2)).sum::<f64>() / size as f64;
    assert!((time_energy - freq_energy).abs() / time_energy < 1e-5, "{time_energy} vs {freq_energy}");
}

#[test]
fn sine_lands_in_its_bin() {
    let size = 1024;
    let fft = Fft::new(size);
    let bin = 37;
    let mut re: Vec<f32> = (0..size).map(|index| (2.0 * std::f64::consts::PI * bin as f64 * index as f64 / size as f64).sin() as f32).collect();
    let mut im = vec![0.0f32; size];
    fft.forward(&mut re, &mut im);
    let magnitude = |index: usize| ((re[index] as f64).powi(2) + (im[index] as f64).powi(2)).sqrt();
    let peak = magnitude(bin);
    assert!((peak - size as f64 / 2.0).abs() / (size as f64 / 2.0) < 1e-4, "sine magnitude {peak}");
    for other in 0..size {
        if other != bin && other != size - bin {
            assert!(magnitude(other) < peak * 1e-3, "leak at bin {other}: {}", magnitude(other));
        }
    }
}
