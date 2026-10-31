// Matchering - Audio Matching and Mastering
// Copyright (C) 2016-2022 Sergree, ported to Rust for openDAW
// Licensed under the GNU General Public License v3.0 or later, see lib.rs.

/// statsmodels `lowess(y, x, frac, it, delta)` for sorted `x`, returns the fitted values.
pub fn lowess(x: &[f64], y: &[f64], frac: f64, iterations: usize, delta: f64) -> Vec<f64> {
    assert_eq!(x.len(), y.len());
    assert!((0.0..=1.0).contains(&frac));
    let n = x.len();
    let k = ((frac * n as f64 + 1e-10) as usize).clamp(2, n.max(2)).min(n);
    let mut fitted = vec![0.0; n];
    let mut weights = vec![0.0; n];
    let mut residual_weights = vec![1.0; n];
    for _ in 0..=iterations {
        let mut index = 0;
        let mut last_fit: isize = -1;
        let mut left = 0;
        let mut right = k;
        for _ in 0..n {
            fitted[index] = 0.0;
            let value = x[index];
            weights.fill(0.0);
            while right < n && value > (x[left] + x[right]) / 2.0 {
                left += 1;
                right += 1;
            }
            let radius = (value - x[left]).max(x[right - 1] - value);
            if calculate_weights(x, &mut weights, &residual_weights, value, left, right, radius) {
                fitted[index] = fit(x, y, &weights, value, left, right);
            } else {
                fitted[index] = y[index];
            }
            if last_fit < index as isize - 1 {
                interpolate_skipped(x, &mut fitted, index, last_fit as usize);
            }
            let (next, fit_index) = update_indices(x, &mut fitted, delta, index);
            index = next;
            last_fit = fit_index as isize;
            if fit_index >= n - 1 {break;}
        }
        residual_weights = calculate_residual_weights(y, &fitted);
    }
    fitted
}

fn calculate_weights(x: &[f64], weights: &mut [f64], residual_weights: &[f64], value: f64,
                     left: usize, right: usize, radius: f64) -> bool {
    let mut sum = 0.0;
    let mut non_zero = 0;
    for index in left..right {
        let distance = (x[index] - value).abs() / radius;
        let cube = distance * distance * distance;
        let inverse = 1.0 - cube;
        weights[index] = inverse * inverse * inverse * residual_weights[index];
        sum += weights[index];
    }
    for index in left..right {
        if weights[index] > 1e-12 {non_zero += 1;}
    }
    if non_zero < 2 {return false;}
    for weight in &mut weights[left..right] {*weight /= sum;}
    true
}

fn fit(x: &[f64], y: &[f64], weights: &[f64], value: f64, left: usize, right: usize) -> f64 {
    let mut weighted_x = 0.0;
    for index in left..right {weighted_x += weights[index] * x[index];}
    let mut deviation = 0.0;
    for index in left..right {deviation += weights[index] * (x[index] - weighted_x) * (x[index] - weighted_x);}
    let deviation = deviation.max(1e-12);
    let mut result = 0.0;
    for index in left..right {
        result += weights[index] * (1.0 + (value - weighted_x) * (x[index] - weighted_x) / deviation) * y[index];
    }
    result
}

fn interpolate_skipped(x: &[f64], fitted: &mut [f64], index: usize, last_fit: usize) {
    let denominator = x[index] - x[last_fit];
    for skipped in last_fit + 1..index {
        let alpha = (x[skipped] - x[last_fit]) / denominator;
        fitted[skipped] = alpha * fitted[index] + (1.0 - alpha) * fitted[last_fit];
    }
}

fn update_indices(x: &[f64], fitted: &mut [f64], delta: f64, index: usize) -> (usize, usize) {
    let mut last_fit = index;
    let cut_point = x[last_fit] + delta;
    let mut probe = last_fit;
    for candidate in last_fit + 1..x.len() {
        probe = candidate;
        if x[candidate] > cut_point {break;}
        if x[candidate] == x[last_fit] {
            fitted[candidate] = fitted[last_fit];
            last_fit = candidate;
        }
    }
    ((probe.max(1) - 1).max(last_fit + 1), last_fit)
}

fn calculate_residual_weights(y: &[f64], fitted: &[f64]) -> Vec<f64> {
    let mut residuals: Vec<f64> = y.iter().zip(fitted).map(|(value, fit)| (value - fit).abs()).collect();
    let median = median(&residuals);
    for residual in &mut residuals {
        *residual = if median == 0.0 {if *residual > 0.0 {1.0} else {0.0}} else {*residual / (6.0 * median)};
        if *residual > 1.0 {*residual = 1.0;}
    }
    residuals.iter().map(|residual| {
        let inverse = 1.0 - residual * residual;
        inverse * inverse
    }).collect()
}

fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let middle = sorted.len() / 2;
    if sorted.len() % 2 == 0 {(sorted[middle - 1] + sorted[middle]) / 2.0} else {sorted[middle]}
}
