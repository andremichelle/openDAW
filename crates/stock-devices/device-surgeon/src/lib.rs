//! `device-surgeon`, the engine core of Surgeon (see `plans/surgeon.md`): a monophonic FM voice played by a pitch
//! loop and four lanes that are all computed from the song position. Heap free and valid when zeroed.
//! `hit_envelope` and `svf` are copies of the openDrum dsp blocks until those land in `dsp`.

#![cfg_attr(target_family = "wasm", no_std)]

pub mod engine;
pub mod hash;
pub mod hit_envelope;
pub mod param;
pub mod pattern;
pub mod svf;
pub mod voice;
