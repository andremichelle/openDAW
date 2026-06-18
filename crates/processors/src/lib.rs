//! Processors: the Rust counterpart of core-processors. Turns the timeline (note regions + event
//! collections) into audio. `sequencer` schedules note lifecycle events per render block; `buffer`
//! re-exports the engine-env stereo render-quantum buffer; `instrument` renders scheduled notes into it
//! with sine voices. Pure (`no_std` + alloc), native-tested.
//!
//! NOTE: this crate is being superseded by the faithful TS port in `engine-env` (see
//! `plans/wasm-audio/processor-port-map.md`); its pieces move out as that port lands.

#![cfg_attr(not(test), no_std)]

extern crate alloc;

pub mod buffer;
pub mod instrument;
pub mod sequencer;
