//! Mip-mapped wavetables, ported from `tb303-shared.js` (`buildMipTablesUncached`).
//!
//! Heap-free and fixed-size: the deployed cdylib is `no_std` with no allocator, so the tables are
//! plain arrays filled in place. They are also IDENTICAL for every instance (built from constant
//! measured spectra), so the device keeps one shared bank rather than 160 KB per voice.
//!
//! Table storage is f32 to match JS `Float32Array`; every read widens to f64 because JS arithmetic
//! is f64 throughout.

pub const TABLE_SIZE: usize = 2048;
/// 730 saw harmonics halve down to 10 levels; 12 leaves headroom if a spectrum is ever re-measured.
pub const MAX_LEVELS: usize = 12;

pub struct MipTables {
    pub levels: [[f32; TABLE_SIZE]; MAX_LEVELS],
    pub counts: [usize; MAX_LEVELS],
    pub level_count: usize
}

impl MipTables {
    /// Valid when zeroed, so it can live in a zeroed static / state block before `fill` runs.
    pub const fn zeroed() -> Self {
        Self {levels: [[0.0; TABLE_SIZE]; MAX_LEVELS], counts: [0; MAX_LEVELS], level_count: 0}
    }

    /// Fills in place from a measured spectrum. Mirrors `buildMipTablesUncached` including the
    /// final normalisation by the RICHEST table's peak (not per-table), which is what keeps the
    /// mip levels level-matched as the slew crossfades between them.
    pub fn fill(&mut self, amplitudes: &[f64], phases: &[f64]) {
        let mut level_count = 0;
        let mut harmonic_count = if amplitudes.len() < TABLE_SIZE / 2 - 1 {
            amplitudes.len()
        } else {
            TABLE_SIZE / 2 - 1
        };
        while harmonic_count >= 1 && level_count < MAX_LEVELS {
            self.counts[level_count] = harmonic_count;
            level_count += 1;
            harmonic_count >>= 1;
        }
        self.level_count = level_count;
        for level in 0..level_count {
            let count = self.counts[level];
            for i in 0..TABLE_SIZE {
                let p = i as f64 / TABLE_SIZE as f64;
                let mut value = 0.0f64;
                for n in 0..count {
                    value += amplitudes[n]
                        * libm::cos(2.0 * core::f64::consts::PI * (n + 1) as f64 * p + phases[n]);
                }
                self.levels[level][i] = value as f32;
            }
        }
        let mut peak = 0.0f64;
        for i in 0..TABLE_SIZE {
            let magnitude = (self.levels[0][i] as f64).abs();
            if magnitude > peak {peak = magnitude;}
        }
        let scale = if peak > 0.0 {1.0 / peak} else {1.0};
        for level in 0..level_count {
            for i in 0..TABLE_SIZE {
                self.levels[level][i] = (self.levels[level][i] as f64 * scale) as f32;
            }
        }
    }
}

/// Catmull-Rom read, mirroring `readCubic`. The expression order is preserved exactly: reassociating
/// it changes the low bits and the parity gate compares samples.
#[inline]
pub fn read_cubic(table: &[f32; TABLE_SIZE], index: usize, fraction: f64) -> f64 {
    let mask = TABLE_SIZE - 1;
    let p0 = table[(index + TABLE_SIZE - 1) & mask] as f64;
    let p1 = table[index & mask] as f64;
    let p2 = table[(index + 1) & mask] as f64;
    let p3 = table[(index + 2) & mask] as f64;
    p1 + 0.5 * fraction * (p2 - p0 + fraction * (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3 + fraction * (3.0 * (p1 - p2) + p3 - p0)))
}
