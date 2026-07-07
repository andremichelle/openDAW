//! The Tidal LFO shaper, a port of lib-dsp `TidalComputer`. `compute(phase)` turns a phase in `0..1` into a
//! unit-range gain, shaped by `depth` / `slope` / `symmetry` (set via `set`). f64 throughout, mirroring the TS
//! `number` math, so the port matches up to float rounding; the device casts to f32 only at the sample multiply.

const SLOPE_MULT: f64 = 10.0;

/// `pow` for the shaper's hot loop: `exp2(exponent * log2(base))` — mathematically what `pow` computes,
/// minus libm's correctly-rounded dual-double slow path, which dominated Tidal's render cost. NOTE: the
/// polynomial `fast_exp2` is NOT a win here — its power-of-two scaling is an iterative loop, and Tidal's
/// exponent (`p_ex * log2(base)`, very negative near the trough) drives that loop to its 64-step clamp,
/// measurably slower than libm's constant-time `exp2`. libm `exp2`/`log2` stay. Accuracy ~1e-13 relative.
#[inline]
fn fast_pow(base: f64, exponent: f64) -> f64 {
    libm::exp2(exponent * libm::log2(base))
}

/// The shaped Tidal envelope. `set` reshapes it; `compute` evaluates it at a phase. Mirrors lib-dsp `TidalComputer`.
#[derive(Clone, Copy, Default)]
pub struct TidalComputer {
    depth: f64,
    slope: f64,
    symmetry: f64,
    p_ex: f64,
    inv_s0: f64,
    inv_s1: f64
}

impl TidalComputer {
    /// Reshape from `depth` (0..1), `slope` (-1..1), `symmetry` (0..1). Mirrors `TidalComputer.set`; the symmetry
    /// is nudged off the 0 / 1 edges (lib-std `linear(1e-5, 1 - 1e-5, symmetry)`) so the reciprocals stay finite.
    pub fn set(&mut self, depth: f64, slope: f64, symmetry: f64) {
        self.depth = depth;
        self.slope = slope * SLOPE_MULT;
        self.symmetry = 1.0e-5 + symmetry * ((1.0 - 1.0e-5) - 1.0e-5);
        self.p_ex = libm::pow(2.0, libm::fabs(self.slope));
        self.inv_s0 = 1.0 / self.symmetry;
        self.inv_s1 = 1.0 / (1.0 - self.symmetry);
    }

    /// The unit gain at `input` (its fractional part is taken, as in the TS). Mirrors `TidalComputer.compute`.
    pub fn compute(&self, input: f64) -> f64 {
        let p = input - libm::floor(input);
        let (x, sym, inv_s0, inv_s1) = if self.slope < 0.0 {
            (1.0 - p, 1.0 - self.symmetry, self.inv_s1, self.inv_s0)
        } else {
            (p, self.symmetry, self.inv_s0, self.inv_s1)
        };
        if x <= sym {
            1.0 - fast_pow(1.0 - x * inv_s0, self.p_ex) * self.depth
        } else {
            fast_pow((1.0 - x) * inv_s1, self.p_ex) * self.depth - self.depth + 1.0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::TidalComputer;

    fn computer(depth: f64, slope: f64, symmetry: f64) -> TidalComputer {
        let mut computer = TidalComputer::default();
        computer.set(depth, slope, symmetry);
        computer
    }

    #[test]
    fn zero_depth_is_a_constant_unity_gain() {
        let computer = computer(0.0, 0.3, 0.5);
        for step in 0..=8 {
            let phase = step as f64 / 8.0;
            assert!((computer.compute(phase) - 1.0).abs() < 1.0e-9, "depth 0 leaves the signal untouched");
        }
    }

    #[test]
    fn symmetric_full_depth_is_a_triangle() {
        // depth 1, symmetry 0.5, slope 0 (pEx = 1): a 0 -> 1 -> 0 triangle across the phase.
        let computer = computer(1.0, 0.0, 0.5);
        assert!(computer.compute(0.0).abs() < 1.0e-6, "trough at phase 0");
        assert!((computer.compute(0.25) - 0.5).abs() < 1.0e-6);
        assert!((computer.compute(0.5) - 1.0).abs() < 1.0e-6, "peak at the centre");
        assert!((computer.compute(0.75) - 0.5).abs() < 1.0e-6);
        assert!(computer.compute(1.0).abs() < 1.0e-6, "phase wraps: compute(1.0) == compute(0.0)");
    }

    #[test]
    fn slope_sign_mirrors_the_shape() {
        // A negative slope flips the ramp: compute_neg(x) should equal compute_pos(1 - x) for a symmetric shape.
        let positive = computer(1.0, 0.4, 0.5);
        let negative = computer(1.0, -0.4, 0.5);
        for step in 1..8 {
            let phase = step as f64 / 8.0;
            assert!((negative.compute(phase) - positive.compute(1.0 - phase)).abs() < 1.0e-9);
        }
    }
}
