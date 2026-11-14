//! The openDrum engines. Each engine is plain DSP over the common `dsp` blocks, without the device abi, so the
//! device crates, the reference lab and the /testing preview wasm all run the same code.

#![cfg_attr(not(test), no_std)]

pub mod bell;
pub mod clap;
pub mod common;
pub mod cymbal;
pub mod hat;
pub mod kick;
pub mod perc;
pub mod rim;
pub mod shaker;
pub mod snare;
pub mod tom;
