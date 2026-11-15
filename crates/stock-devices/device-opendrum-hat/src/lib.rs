//! openDrum Hat as a device: the Hat engine of `crates/opendrum` behind the shared openDrum device glue.

#![cfg_attr(target_family = "wasm", no_std)]

opendrum_device::export_device!(opendrum::hat::Hat);
