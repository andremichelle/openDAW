//! stretch: the standalone time-stretch core (analysis + adaptive granular playback), matured in
//! isolation by `stretch-lab` before it replaces `engine/src/time_stretch.rs`. `no_std` + alloc, no
//! `engine-env`/`abi` dependency: slice-based I/O and an engine-agnostic `BlockInfo` so the lab drives
//! it natively and the engine adapter later maps `abi::Block`/`AudioBuffer` onto it in a few lines.
//! Every magic number lives in `Tuning`; `Tuning::legacy()` reproduces the shipped engine exactly
//! (the one-time parity anchor), `Tuning::adaptive()` is the descriptor-driven mode under development.

#![cfg_attr(not(test), no_std)]

extern crate alloc;

pub mod fft;
pub mod stft;
pub mod onset;
pub mod analyzer;
pub mod tuning;
pub mod descriptor;
pub mod warp;
pub mod voice;
pub mod sequencer;

pub use analyzer::{AnalyzedSample, Analyzer, AnalyzerConfig};
pub use descriptor::TransientDescriptor;
pub use sequencer::{BlockInfo, Source, Stretcher, StretchConfig, TransientPlayMode};
pub use tuning::Tuning;
