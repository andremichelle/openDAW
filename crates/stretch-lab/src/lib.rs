//! stretch-lab: the self-judging harness for the time-stretch v2 work (`plans/stretch/README.md`).
//! std, native-only — never built for wasm, never a dependency of shipped code. It renders a corpus
//! (synthetic probes with parametric ideals + real fixtures) through the FROZEN baseline engine and
//! the `stretch` crate, measures both with deterministic homebrew metrics, and gates every change:
//! a run only counts as improved when a target metric moves AND every guard holds simultaneously.

extern crate alloc;

pub mod wav;
pub mod baseline;
pub mod render;
pub mod corpus;
pub mod metrics;
pub mod scores;
pub mod thresholds;
pub mod report;
#[cfg(feature = "analyzer")]
pub mod second_opinion;
