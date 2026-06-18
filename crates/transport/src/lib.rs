//! Time & transport core: PPQN conversions + a fixed-bpm 128-sample block loop. Pure (`no_std`),
//! native-tested against the TS `lib-dsp` formulas. The engine wires bpm / loop region in from the
//! box graph; this crate stays free of the data model.

#![cfg_attr(not(test), no_std)]

pub mod transport;
