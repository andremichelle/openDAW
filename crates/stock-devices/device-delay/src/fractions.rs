//! The Delay's tempo-sync fraction table, a port of `DelayDeviceBoxAdapter.Fractions` (already in ascending
//! value order, so the `.asAscendingArray()` is a no-op) plus `Fraction.toPPQN` (= `PPQN.fromSignature`). The
//! three sync-time parameters are a `linearInteger(0, len - 1)` index into this table; index 0 is "Off" (0).

use dsp::ppqn::from_signature;

pub const FRACTIONS: [(i32, i32); 21] = [
    (0, 1), (1, 128), (1, 96), (1, 64), (1, 48), (1, 32), (1, 24), (3, 64),
    (1, 16), (1, 12), (3, 32), (1, 8), (1, 6), (3, 16), (1, 4), (5, 16),
    (1, 3), (3, 8), (7, 16), (1, 2), (1, 1)
];

/// The fraction at `index` (clamped to the table) in pulses, mirroring `Fraction.toPPQN([n, d])`.
pub fn fraction_pulses(index: i32) -> f64 {
    let index = (index.max(0) as usize).min(FRACTIONS.len() - 1);
    let (numerator, denominator) = FRACTIONS[index];
    from_signature(numerator, denominator)
}
