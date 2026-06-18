//! ValueEvent automation primitive: sorted event collections + curve interpolation, mirroring
//! lib-dsp `value.ts` and lib-std `curve.ts`. Pure (`no_std` + alloc), native-tested.
//!
//! The collection is a sorted `Vec` with binary search (eager-sorted insert), the idiomatic and
//! cache-friendly Rust equivalent of the TS lazy-sorted array. Curve math uses `libm` so host tests
//! and the wasm build compute identically.

#![cfg_attr(not(test), no_std)]

extern crate alloc;

pub mod event;
pub mod note;
pub mod region;
pub mod retainer;
pub mod value;
