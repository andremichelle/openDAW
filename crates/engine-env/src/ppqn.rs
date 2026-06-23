//! Pulses-per-quarter-note conversions. The implementation lives in `dsp::ppqn` (the single home, mirroring
//! lib-dsp `ppqn.ts`); the host reaches it through this re-export so engine and device share one set of the
//! WASM-contract formulas. See `dsp::ppqn` for the constants and conversions.

pub use dsp::ppqn::*;
