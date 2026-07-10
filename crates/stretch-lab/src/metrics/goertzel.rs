//! Single-bin Goertzel over a Hann-windowed slice: the narrowband probe used for loop-rate lines in
//! envelopes and sideband/THD lines in sine renders. Full-slice analysis gives sub-Hz resolution.

/// Normalized magnitude of `signal` at `frequency`: a full-scale sine at exactly `frequency`
/// returns ~1.0 regardless of length.
pub fn magnitude(signal: &[f32], sample_rate: f64, frequency: f64) -> f64 {
    let count = signal.len();
    if count < 8 {
        return 0.0;
    }
    let omega = 2.0 * std::f64::consts::PI * frequency / sample_rate;
    let coeff = 2.0 * omega.cos();
    let mut s_prev = 0.0f64;
    let mut s_prev2 = 0.0f64;
    let mut window_sum = 0.0f64;
    for (index, sample) in signal.iter().enumerate() {
        let window = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * index as f64 / count as f64).cos();
        window_sum += window;
        let s = *sample as f64 * window + coeff * s_prev - s_prev2;
        s_prev2 = s_prev;
        s_prev = s;
    }
    let power = s_prev * s_prev + s_prev2 * s_prev2 - coeff * s_prev * s_prev2;
    2.0 * power.max(0.0).sqrt() / window_sum
}

pub fn db(value: f64) -> f64 {
    20.0 * (value + 1e-12).log10()
}

pub fn power_ratio_db(numerator: f64, denominator: f64) -> f64 {
    10.0 * ((numerator + 1e-24) / (denominator + 1e-24)).log10()
}
