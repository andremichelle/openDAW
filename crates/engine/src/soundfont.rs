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

/// The engine's table of soundfonts, one slot per `SoundfontFileBox`. A handle is an index into `slots`; a
/// freed slot becomes `None` and its index is never reused, so a stale handle held by a device resolves to
/// `None`.
#[derive(Default)]
pub struct SoundfontResource {
    slots: Vec<Option<Slot>>,
    pending: Vec<u32> // handles in `Requested` state, awaiting a load request to the host
}

impl SoundfontResource {
    pub const fn new() -> Self {
        Self {slots: Vec::new(), pending: Vec::new()}
    }

    /// Ensure a slot exists for `uuid`, deduplicating so several devices sharing one soundfont build it once. A
    /// new soundfont is queued as pending for the host to load. Returns the handle either way.
    pub fn request(&mut self, uuid: Uuid) -> u32 {
        if let Some(handle) = self.handle_of(uuid) {
            return handle;
        }
        let handle = self.slots.len() as u32;
        self.slots.push(Some(Slot {uuid, storage: Vec::new(), byte_len: 0, state: State::Requested}));
        self.pending.push(handle);
        handle
    }

    fn handle_of(&self, uuid: Uuid) -> Option<u32> {
        self.slots.iter().position(|slot| slot.as_ref().is_some_and(|slot| slot.uuid == uuid)).map(|index| index as u32)
    }

    /// Pop the next soundfont awaiting a host load request, returning its `(handle, uuid)`, or `None`.
    pub fn take_pending(&mut self) -> Option<(u32, Uuid)> {
        while let Some(handle) = self.pending.pop() {
            if let Some(Some(slot)) = self.slots.get(handle as usize) {
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
        let Some(Some(slot)) = self.slots.get_mut(handle as usize) else {
            return 0;
        };
        slot.storage = vec![0u8; byte_len];
        slot.byte_len = byte_len as u32;
        slot.state = State::Allocated;
        slot.storage.as_ptr() as u32
    }

    /// Mark the slot ready once the host has written the blob.
    pub fn set_ready(&mut self, handle: u32) {
        if let Some(Some(slot)) = self.slots.get_mut(handle as usize) {
            slot.state = State::Ready;
        }
    }

    /// Resolve a handle to its blob (pointer + byte length), but ONLY when ready.
    pub fn resolve(&self, handle: u32) -> Option<SoundfontRef> {
        let slot = self.slots.get(handle as usize)?.as_ref()?;
        if slot.state != State::Ready {
            return None;
        }
        Some(SoundfontRef {ptr: slot.storage.as_ptr() as u32, len: slot.byte_len})
    }

    /// Free the soundfont for `uuid` (its box was removed): drop the slot's storage and empty the slot.
    pub fn free(&mut self, uuid: Uuid) {
        if let Some(handle) = self.handle_of(uuid) {
            self.slots[handle as usize] = None;
        }
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
    fn free_drops_the_slot_and_reuses_no_index() {
        let mut resource = SoundfontResource::new();
        let handle = resource.request(uuid(3));
        resource.allocate(handle, 16);
        resource.set_ready(handle);
        assert!(resource.resolve(handle).is_some());
        resource.free(uuid(3));
        assert!(resource.resolve(handle).is_none(), "a freed soundfont no longer resolves");
        assert_ne!(resource.request(uuid(3)), handle, "re-requesting a freed uuid gets a new handle");
    }
}
