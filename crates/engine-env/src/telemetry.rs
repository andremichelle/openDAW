//! TELEMETRY SLOTS: the shared-memory cells the engine's broadcast table exposes to the worklet, which
//! mirrors each onto the studio's `LiveStreamBroadcaster` as a Float32Array VIEW over wasm memory. A slot
//! is EXACTLY as long as its content — one float for an automated parameter's unit value, four for a
//! meter (peak L/R + RMS L/R). The boxed slice never reallocates, so the raw pointer handed to JS stays
//! valid for the slot's life; the registry holds a `Weak` and sweeps entries whose owner died.

use alloc::boxed::Box;
use alloc::rc::Rc;
use core::cell::RefCell;

pub type BroadcastSlot = Rc<RefCell<Box<[f32]>>>;

pub fn broadcast_slot(len: usize) -> BroadcastSlot {
    Rc::new(RefCell::new(alloc::vec![0.0f32; len].into_boxed_slice()))
}
