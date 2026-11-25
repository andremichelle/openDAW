// Matchering - Audio Matching and Mastering
// Copyright (C) 2016-2022 Sergree, ported to Rust for openDAW
// Licensed under the GNU General Public License v3.0 or later, see lib.rs.

/// scipy `interp1d(x, y, "cubic")`: an interpolating cubic spline with not-a-knot end conditions.
/// Evaluating outside of `x` extrapolates with the outermost polynomial (`fill_value="extrapolate"`).
pub struct CubicSpline {
    x: Vec<f64>,
    y: Vec<f64>,
    slopes: Vec<f64>
}

impl CubicSpline {
    pub fn new(x: &[f64], y: &[f64]) -> Self {
        assert_eq!(x.len(), y.len());
        assert!(x.len() >= 4, "not-a-knot needs at least four points");
        let n = x.len();
        let h: Vec<f64> = x.windows(2).map(|pair| pair[1] - pair[0]).collect();
        let delta: Vec<f64> = (0..n - 1).map(|index| (y[index + 1] - y[index]) / h[index]).collect();
        let mut lower = vec![0.0; n];
        let mut diagonal = vec![0.0; n];
        let mut upper = vec![0.0; n];
        let mut rhs = vec![0.0; n];
        for index in 1..n - 1 {
            lower[index] = h[index];
            diagonal[index] = 2.0 * (h[index - 1] + h[index]);
            upper[index] = h[index - 1];
            rhs[index] = 3.0 * (h[index] * delta[index - 1] + h[index - 1] * delta[index]);
        }
        let sum = h[0] + h[1];
        diagonal[0] = h[1];
        upper[0] = sum;
        rhs[0] = ((h[0] + 2.0 * sum) * h[1] * delta[0] + h[0] * h[0] * delta[1]) / sum;
        let sum = h[n - 2] + h[n - 3];
        lower[n - 1] = sum;
        diagonal[n - 1] = h[n - 3];
        rhs[n - 1] = (h[n - 2] * h[n - 2] * delta[n - 3] + (2.0 * sum + h[n - 2]) * h[n - 3] * delta[n - 2]) / sum;
        let slopes = solve_tridiagonal(&lower, &mut diagonal, &upper, &mut rhs);
        Self {x: x.to_vec(), y: y.to_vec(), slopes}
    }

    pub fn evaluate(&self, value: f64) -> f64 {
        let n = self.x.len();
        let index = self.x.partition_point(|&knot| knot <= value).clamp(1, n - 1) - 1;
        let h = self.x[index + 1] - self.x[index];
        let t = value - self.x[index];
        let delta = (self.y[index + 1] - self.y[index]) / h;
        let c2 = (3.0 * delta - 2.0 * self.slopes[index] - self.slopes[index + 1]) / h;
        let c3 = (self.slopes[index] + self.slopes[index + 1] - 2.0 * delta) / (h * h);
        self.y[index] + t * (self.slopes[index] + t * (c2 + t * c3))
    }
}

fn solve_tridiagonal(lower: &[f64], diagonal: &mut [f64], upper: &[f64], rhs: &mut [f64]) -> Vec<f64> {
    let n = diagonal.len();
    for index in 1..n {
        let factor = lower[index] / diagonal[index - 1];
        diagonal[index] -= factor * upper[index - 1];
        rhs[index] -= factor * rhs[index - 1];
    }
    let mut result = vec![0.0; n];
    result[n - 1] = rhs[n - 1] / diagonal[n - 1];
    for index in (0..n - 1).rev() {
        result[index] = (rhs[index] - upper[index] * result[index + 1]) / diagonal[index];
    }
    result
}
