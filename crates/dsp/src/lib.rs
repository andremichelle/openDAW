//! DSP primitives for the feature crates. The shared math now lives in the `math` crate (the
//! lib-std equivalent); this re-exports the pieces the feature crates already use (`fast_sin`,
//! `fabs`, `PI`) and will hold genuinely DSP-specific code as it appears. Tests for these live in
//! `math`.

#![cfg_attr(not(test), no_std)]

pub use math::{fabs, fast_sin, PI};
