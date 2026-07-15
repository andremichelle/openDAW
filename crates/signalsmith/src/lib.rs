#![cfg_attr(not(test), no_std)]

extern crate alloc;

pub mod fft;
mod approx;
mod stretch;
pub use stretch::SignalsmithStretch;
