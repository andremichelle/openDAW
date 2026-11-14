//! openDrum Shaker as a device: the Shaker engine of `crates/opendrum` behind the shared openDrum device glue.

#![cfg_attr(target_family = "wasm", no_std)]

opendrum_device::export_device!(opendrum::shaker::Shaker);
