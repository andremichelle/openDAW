//! The soundfont resource: a SIMPLIFIED soundfont BLOB resident in the engine's shared linear memory, keyed by
//! the `SoundfontFileBox` uuid and addressed by a `u32` handle. It mirrors [`crate::sample::SampleResource`]
//! (the Route F handshake), but the payload is an opaque byte blob (the flattened sample/region/preset tables +
//! normalized f32 PCM built on the main thread from the parsed `.sf2`) rather than audio frames — so a resolve
//! returns a pointer + byte length ([`abi::SoundfontRef`]), and the device reads the blob IN PLACE.
//!
//! The handshake: the engine REQUESTS a soundfont on seeing the device's `file` pointer target, the loader
//! builds the blob and reports its byte length, the engine ALLOCATES exactly that and hands back the pointer,
//! the loader writes the blob there, and the engine marks the slot READY. The storage is talc-owned and kept
//! alive in the slot, so the pointer is stable until the soundfont is freed (its box removed).

use alloc::vec;
use alloc::vec::Vec;
use abi::SoundfontRef;
use boxgraph::address::Uuid;
use crate::sample::{decode_handle, encode_handle, HANDLE_GENERATION_MASK, HANDLE_INDEX_MASK};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    Requested, // seen, awaiting a host load request
    Allocated, // storage reserved, awaiting the host's blob write
    Ready      // blob written, resolvable
}

struct Slot {
    uuid: Uuid,
    storage: Vec<u8>, // the simplified soundfont blob; empty until `allocate`
    byte_len: u32,
    state: State
}

// One slot table entry: the slot payload plus the generation its CURRENT handles carry (bumped at free).
struct Entry {
    generation: u32,
    slot: Option<Slot>
}

/// The engine's table of soundfonts, one slot per `SoundfontFileBox`, addressed by generation-tagged handles
/// (the layout in [`crate::sample`]): freed slots are recycled through `free_indices`, and a stale handle
/// held by a device resolves to `None` via its outdated generation.
#[derive(Default)]
pub struct SoundfontResource {
    entries: Vec<Entry>,
    free_indices: Vec<u32>, // freed slot indices awaiting reuse
    pending: Vec<u32> // handles in `Requested` state, awaiting a load request to the host
}

impl SoundfontResource {
    pub const fn new() -> Self {
        Self {entries: Vec::new(), free_indices: Vec::new(), pending: Vec::new()}
    }

    /// Ensure a slot exists for `uuid`, deduplicating so several devices sharing one soundfont build it once. A
    /// new soundfont is queued as pending for the host to load. Returns the handle either way.
    pub fn request(&mut self, uuid: Uuid) -> u32 {
        if let Some(handle) = self.handle_of(uuid) {
            return handle;
        }
        let slot = Slot {uuid, storage: Vec::new(), byte_len: 0, state: State::Requested};
        let index = match self.free_indices.pop() {
            Some(index) => {
                self.entries[index as usize].slot = Some(slot);
                index
            }
            None => {
                let index = self.entries.len() as u32;
                debug_assert!(index <= HANDLE_INDEX_MASK, "soundfont slot index space exhausted");
                self.entries.push(Entry {generation: 0, slot: Some(slot)});
                index
            }
        };
        let handle = encode_handle(index, self.entries[index as usize].generation);
        self.pending.push(handle);
        handle
    }

    fn handle_of(&self, uuid: Uuid) -> Option<u32> {
        self.entries.iter().enumerate().find_map(|(index, entry)|
            entry.slot.as_ref().filter(|slot| slot.uuid == uuid)
                .map(|_| encode_handle(index as u32, entry.generation)))
    }

    // Resolve a handle to its live slot: the entry must exist AND carry the handle's generation.
    fn slot(&self, handle: u32) -> Option<&Slot> {
        let (index, generation) = decode_handle(handle);
        let entry = self.entries.get(index as usize)?;
        if entry.generation & HANDLE_GENERATION_MASK != generation {
            return None;
        }
        entry.slot.as_ref()
    }

    fn slot_mut(&mut self, handle: u32) -> Option<&mut Slot> {
        let (index, generation) = decode_handle(handle);
        let entry = self.entries.get_mut(index as usize)?;
        if entry.generation & HANDLE_GENERATION_MASK != generation {
            return None;
        }
        entry.slot.as_mut()
    }

    /// Pop the next soundfont awaiting a host load request, returning its `(handle, uuid)`, or `None`.
    pub fn take_pending(&mut self) -> Option<(u32, Uuid)> {
        while let Some(handle) = self.pending.pop() {
            if let Some(slot) = self.slot(handle) {
                if slot.state == State::Requested {
                    return Some((handle, slot.uuid));
                }
            }
        }
        None
    }

    /// Reserve `byte_len` zeroed bytes for the slot's blob and return the pointer the host writes into. The
    /// storage lives in the slot, so the pointer is stable until the soundfont is freed.
    pub fn allocate(&mut self, handle: u32, byte_len: usize) -> u32 {
        let Some(slot) = self.slot_mut(handle) else {
            return 0;
        };
        slot.storage = vec![0u8; byte_len];
        slot.byte_len = byte_len as u32;
        slot.state = State::Allocated;
        slot.storage.as_ptr() as u32
    }

    /// Mark the slot ready once the host has written the blob.
    pub fn set_ready(&mut self, handle: u32) {
        if let Some(slot) = self.slot_mut(handle) {
            slot.state = State::Ready;
        }
    }

    /// Resolve a handle to its blob (pointer + byte length), but ONLY when ready.
    pub fn resolve(&self, handle: u32) -> Option<SoundfontRef> {
        let slot = self.slot(handle)?;
        if slot.state != State::Ready {
            return None;
        }
        Some(SoundfontRef {ptr: slot.storage.as_ptr() as u32, len: slot.byte_len})
    }

    /// Free the soundfont for `uuid` (its box was removed): drop the slot's storage, bump the generation (so
    /// every handle out there dies), and recycle the index for the next request.
    pub fn free(&mut self, uuid: Uuid) {
        let Some(handle) = self.handle_of(uuid) else { return };
        let (index, _) = decode_handle(handle);
        let entry = &mut self.entries[index as usize];
        entry.slot = None;
        entry.generation = (entry.generation + 1) & HANDLE_GENERATION_MASK;
        self.free_indices.push(index);
    }
}

#[cfg(test)]
mod tests {
    use super::SoundfontResource;

    fn uuid(tag: u8) -> [u8; 16] {
        let mut bytes = [0u8; 16];
        bytes[0] = tag;
        bytes
    }

    #[test]
    fn request_dedupes_and_resolves_only_when_ready() {
        let mut resource = SoundfontResource::new();
        let first = resource.request(uuid(1));
        assert_eq!(first, resource.request(uuid(1)), "the same soundfont resolves to the same handle");
        assert!(resource.resolve(first).is_none(), "not resolvable while merely requested");
        let pointer = resource.allocate(first, 128);
        assert_ne!(pointer, 0);
        assert!(resource.resolve(first).is_none(), "not resolvable until the blob is written + readied");
        resource.set_ready(first);
        let reference = resource.resolve(first).expect("ready resolves");
        assert_eq!((reference.ptr, reference.len), (pointer, 128));
    }

    #[test]
    fn free_recycles_the_slot_and_kills_the_stale_handle() {
        let mut resource = SoundfontResource::new();
        let handle = resource.request(uuid(3));
        resource.allocate(handle, 16);
        resource.set_ready(handle);
        assert!(resource.resolve(handle).is_some());
        resource.free(uuid(3));
        assert!(resource.resolve(handle).is_none(), "a freed soundfont no longer resolves");
        let fresh = resource.request(uuid(3));
        assert_ne!(fresh, handle, "re-requesting a freed uuid gets a new handle (bumped generation)");
        resource.allocate(fresh, 16);
        resource.set_ready(fresh);
        assert!(resource.resolve(handle).is_none(), "the stale handle never resolves the recycled slot's new tenant");
        assert!(resource.resolve(fresh).is_some());
    }
}
