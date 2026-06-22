//! The `PluginMidiEffect` bridge: a MIDI-effect device's host-side identity.
//!
//! Unlike `PluginInstrument` / `PluginAudioEffect`, a MIDI fx is NOT an audio-graph `Processor` node — it
//! produces no audio and is never scheduled. It is a lazily-PULLED link in a unit's event pull chain
//! (`PullLink::MidiFx`): when something downstream pulls it for a pulse range, the host invokes the
//! device's `process_events` (passing its per-instance state), and the device pulls its OWN upstream (over
//! a range it chooses) and returns the transformed events. This type owns that identity — the device's
//! table slot and its instance state — and exposes the one operation. The pull-chain descend/restore that
//! routes the device's own upstream pull lives in the engine's `host_pull_events`, not here.

use crate::{call_device_process_events, DeviceReg};
use alloc::vec;
use alloc::boxed::Box;

/// A device's per-instance state block (talc-allocated, zeroed once, reused across calls), owned host-side
/// and addressed by the device through a raw pointer. `u64`-backed so the block is 8-aligned for any device
/// state struct (e.g. an arpeggiator state holding `f64` pulse positions); a 4-aligned block would be
/// misaligned for those.
pub(crate) struct DeviceState(Box<[u64]>);

impl DeviceState {
    pub(crate) fn new(bytes: usize) -> Self {
        Self(vec![0u64; bytes.div_ceil(8)].into_boxed_slice())
    }

    pub(crate) fn ptr(&self) -> u32 {
        self.0.as_ptr() as u32
    }
}

/// The host bridge for one MIDI-effect device instance: its `process_events` table slot plus its instance
/// state. Held in an `Rc` inside `PullLink::MidiFx`, so chain clones share the one instance state.
pub(crate) struct PluginMidiEffect {
    process_index: u32, // the device's `process_events` slot in the shared function table
    state: DeviceState
}

impl PluginMidiEffect {
    pub(crate) fn new(device: DeviceReg) -> Self {
        Self {process_index: device.process_index, state: DeviceState::new(device.state_size as usize)}
    }

    /// Invoked when something downstream pulls this fx for `[from, to)`: run the device's `process_events`
    /// with its instance state, writing the produced events to `out_ptr` and returning the count. The
    /// device pulls its own upstream from inside this call (the engine has pointed the pull context at it).
    pub(crate) fn process_events(&self, from: f64, to: f64, flags: u32, out_ptr: u32, max: u32) -> u32 {
        call_device_process_events(self.process_index, from, to, flags, self.state.ptr(), out_ptr, max)
    }
}
