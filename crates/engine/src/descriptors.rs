//! Transient-descriptor delivery, mirroring the sample resource exactly: the host analyzes a
//! sample OFF-THREAD (core-worker running `stretch-wasm`, cached as OPFS `markers.bin`), then
//! copies the 64-byte `MarkerRecord` array into engine shared memory via
//! `descriptors_allocate(sample_handle, count)` and flips it live with
//! `descriptors_set_ready(sample_handle)`. Records are keyed by the SAMPLE handle so their
//! lifecycle is the sample's. Until ready, stretch playback runs markerless (the stateless
//! pitch/warp read-head) and upgrades on the bind after readiness — never a wait, never a glitch.
//! Integration design: `plans/stretch/README.md` §6 (user-confirmed).

use alloc::vec::Vec;
use crate::sample::decode_handle;
pub(crate) use stretch::TransientDescriptor as MarkerRecord;


struct Slot {
    generation: u32,
    records: Vec<MarkerRecord>,
    ready: bool
}

/// Descriptor arrays indexed by the sample slot index, generation-checked against the sample
/// handle so records never outlive (or predate) their sample.
#[derive(Default)]
pub struct DescriptorResource {
    slots: Vec<Option<Slot>>
}

impl DescriptorResource {
    pub const fn new() -> Self {
        Self {slots: Vec::new()}
    }

    /// Reserve storage for `count` records tied to `sample_handle`; returns the write pointer for
    /// the host (0 when the handle is stale). Replaces any previous array for the sample (re-
    /// analysis after a marker edit or analyzer upgrade).
    pub fn allocate(&mut self, sample_handle: u32, count: usize) -> u32 {
        let (index, generation) = decode_handle(sample_handle);
        let index = index as usize;
        if self.slots.len() <= index {
            self.slots.resize_with(index + 1, || None);
        }
        let mut records = Vec::new();
        records.resize(count, MarkerRecord::bare(0.0));
        let pointer = records.as_ptr() as u32;
        self.slots[index] = Some(Slot {generation, records, ready: false});
        pointer
    }

    pub fn set_ready(&mut self, sample_handle: u32) {
        let (index, generation) = decode_handle(sample_handle);
        if let Some(Some(slot)) = self.slots.get_mut(index as usize) {
            if slot.generation == generation {
                slot.ready = true;
            }
        }
    }

    /// The records for a sample, once ready. `None` = play markerless (legacy stateless path).
    pub fn resolve(&self, sample_handle: u32) -> Option<&[MarkerRecord]> {
        let (index, generation) = decode_handle(sample_handle);
        match self.slots.get(index as usize) {
            Some(Some(slot)) if slot.generation == generation && slot.ready => Some(&slot.records),
            _ => None
        }
    }

    pub fn free(&mut self, sample_handle: u32) {
        let (index, generation) = decode_handle(sample_handle);
        if let Some(entry) = self.slots.get_mut(index as usize) {
            if entry.as_ref().map(|slot| slot.generation == generation).unwrap_or(false) {
                *entry = None;
            }
        }
    }
}
