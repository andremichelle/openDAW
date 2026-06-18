//! Processors: the Rust counterpart of core-processors. Turns the timeline (note regions + event
//! collections) into audio. `sequencer` schedules note lifecycle events per render block; `buffer` is
//! the stereo render-quantum buffer; `instrument` renders scheduled notes into it with sine voices.
//! Pure (`no_std` + alloc), native-tested.

#![cfg_attr(not(test), no_std)]

extern crate alloc;

pub mod buffer;
pub mod instrument;
pub mod sequencer;
