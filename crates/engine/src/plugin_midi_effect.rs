//! The `PluginMidiEffect` bridge: a MIDI-effect device's host-side identity.
//!
//! Unlike `PluginInstrument` / `PluginAudioEffect`, a MIDI fx is NOT an audio-graph `Processor` node — it
//! produces no audio and is never scheduled. It is a lazily-PULLED link in a unit's event pull chain
//! (`PullLink::MidiFx`): when something downstream pulls it for a pulse range, the host invokes the
//! device's `process_events` (passing its per-instance state), and the device pulls its OWN upstream (over
//! a range it chooses) and returns the transformed events. This type owns that identity — the device's
//! table slot, its instance state, and its bound parameters — and exposes the operations. The pull-chain
//! descend/restore that routes the device's own upstream pull (and swaps its params into the pull context)
//! lives in the engine's `host_pull_events`, not here.

use crate::param_automation::ParamHandle;
use crate::{call_device_process_events, DeviceReg};
use alloc::vec;
use alloc::vec::Vec;
use alloc::boxed::Box;
use core::cell::{Cell, RefCell};

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

/// The host bridge for one MIDI-effect device instance: its `process_events` table slot, its instance state,
/// and its bound parameters. Held in an `Rc` inside `PullLink::MidiFx`, so chain clones share the one
/// instance (and its params). The params + clock-armed state use interior mutability (the instance is shared
/// behind an `Rc`, so there is no `&mut`); the engine swaps them into the pull context during the fx's pull.
pub(crate) struct PluginMidiEffect {
    process_index: u32, // the device's `process_events` slot in the shared function table
    state: DeviceState,
    params: RefCell<Vec<ParamHandle>>,
    clock_armed: Cell<bool>,
    // Note activity ([0] = a monotonic count of events this fx EMITTED; the UI diffs it to flash an
    // indicator). A broadcast slot: the table points at it, `Weak`-owned so a teardown sweeps the entry.
    activity: alloc::rc::Rc<RefCell<[f32; 4]>>
}

impl PluginMidiEffect {
    pub(crate) fn new(device: DeviceReg) -> Self {
        Self {
            process_index: device.process_index,
            state: DeviceState::new(device.state_size as usize),
            params: RefCell::new(Vec::new()),
            clock_armed: Cell::new(false),
            activity: alloc::rc::Rc::new(RefCell::new([0.0; 4]))
        }
    }

    /// The note-activity broadcast slot (see the field docs).
    pub(crate) fn activity_slot(&self) -> alloc::rc::Rc<RefCell<[f32; 4]>> {
        self.activity.clone()
    }

    pub(crate) fn bump_activity(&self, count: u32) {
        if count > 0 {
            self.activity.borrow_mut()[0] += count as f32;
        }
    }

    /// The address of this device's state block, for the engine's `init` / `parameter_changed` calls.
    pub(crate) fn state_ptr(&self) -> u32 {
        self.state.ptr()
    }

    /// Replace this fx's bound parameters; `clock_armed` is true iff one is automated (so the fx fragments
    /// its `process_events` at the update grid). Interior mutability: the instance is shared behind an `Rc`.
    pub(crate) fn set_params(&self, params: Vec<ParamHandle>, clock_armed: bool) {
        *self.params.borrow_mut() = params;
        self.clock_armed.set(clock_armed);
    }

    pub(crate) fn clock_armed(&self) -> bool {
        self.clock_armed.get()
    }

    /// Swap this fx's parameters with the pull context's, so the fx's `host_update_parameters` resolves ITS
    /// params during `process_events`. Called once to swap in (before the pull) and again to swap back out.
    pub(crate) fn swap_params(&self, pull_params: &mut Vec<ParamHandle>) {
        core::mem::swap(pull_params, &mut self.params.borrow_mut());
    }

    /// Invoked when something downstream pulls this fx for `[from, to)`: run the device's `process_events`
    /// with its instance state, writing the produced events to `out_ptr` and returning the count. The device
    /// pulls its own upstream from inside this call (the engine has pointed the pull context at it).
    pub(crate) fn process_events(&self, from: f64, to: f64, flags: u32, out_ptr: u32, max: u32) -> u32 {
        call_device_process_events(self.process_index, from, to, flags, self.state.ptr(), out_ptr, max)
    }
}
