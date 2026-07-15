#![cfg_attr(not(test), no_std)]

extern crate alloc;

pub mod fft;
mod approx;
mod simd;
mod stretch;
pub use stretch::SignalsmithStretch;
