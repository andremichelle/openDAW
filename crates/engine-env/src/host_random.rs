//! Deterministic random values for the timeline: the same seed, position and key always give the same
//! value, independent of block size and playback start. The seed comes from `TimelineBox.seed`; a later
//! seed track resolves the seed per position here.
//!
//! The hash is part of every project's sound: changing it changes which notes play. Tests pin values.

use alloc::rc::Rc;
use core::cell::Cell;

#[derive(Clone)]
pub struct HostRandom {
    seed: Rc<Cell<u32>>
}

impl Default for HostRandom {
    fn default() -> Self {
        Self::new()
    }
}

impl HostRandom {
    pub fn new() -> Self {
        Self {seed: Rc::new(Cell::new(0))}
    }

    /// Share the engine's seed cell, so an edit of `TimelineBox.seed` reaches every user.
    pub fn bind_seed(&mut self, cell: Rc<Cell<u32>>) {
        self.seed = cell;
    }

    pub fn seed(&self) -> u32 {
        self.seed.get()
    }

    /// A value in [0, 1) for `key` at the global `position` (pulses, floored). `salt` separates several
    /// decisions of the same key and position.
    pub fn value(&self, position: f64, key: u64, salt: u32) -> f64 {
        hash_unit(self.seed.get(), position, key, salt)
    }
}

pub fn hash_unit(seed: u32, position: f64, key: u64, salt: u32) -> f64 {
    let mut hash = mix(seed as u64 ^ 0x9E37_79B9_7F4A_7C15);
    hash = mix(hash ^ key);
    hash = mix(hash ^ (math::floor(position) as i64 as u64));
    hash = mix(hash ^ salt as u64);
    (hash >> 11) as f64 / (1u64 << 53) as f64
}

// splitmix64 finalizer
fn mix(value: u64) -> u64 {
    let mut z = value;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}
