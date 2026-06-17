//! Bindings: bridge the box-graph data model to the runtime structures the engine evaluates (the
//! Rust counterpart of TS `studio-adapters`). Each binder reads boxes via the edge model
//! (`incoming`/`target_of`) + field reads and MATERIALIZES owned runtime values, which the engine
//! caches and rebuilds on the relevant subscription.
//!
//! Why materialize instead of TS-style lazy adapters: a lazy adapter holding `&GraphBox` would block
//! the graph mutation the engine does every transaction, so it fights Rust ownership. Owned +
//! rebuilt-on-change is both idiomatic and the hot-path-safe pattern.
//!
//! Future binders (regions, devices, clips, ...) live here as sibling modules following the same
//! shape: resolve membership via edges, read fields, build owned runtime structs.

#![cfg_attr(not(test), no_std)]

extern crate alloc;

pub mod value_events;
pub mod value_collection;
