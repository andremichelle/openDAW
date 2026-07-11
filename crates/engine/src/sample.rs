//! The sample resource (Route F): decoded audio frames resident in the engine's shared linear memory, keyed
//! by the `AudioFileBox` uuid and addressed by a `u32` handle. The handshake (driven by the worklet + the
//! main-thread loader, wired separately) is: the engine REQUESTS a sample on seeing the box, the loader
//! fetches + decodes it and reports the byte length, the engine ALLOCATES exactly that and hands back the
//! pointer, the loader writes the PLANAR f32 frames there, and the engine marks the slot READY.
//!
//! A device resolves a handle to a [`SampleRef`] (frames pointer + frame/channel count + sample rate) each
//! block; an unready handle resolves to `None` and the device skips it. Frames are PLANAR: channel `c` lives
//! at `frames_ptr + c * frame_count * 4`. The PCM storage is talc-owned and kept alive in the slot, so the
//! pointer is stable until the sample is freed (its box removed).

use alloc::vec;
use alloc::vec::Vec;
use abi::SampleRef;
use boxgraph::address::Uuid;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    Requested, // seen, awaiting a host load request
    Allocated, // storage reserved, awaiting the host's frame write
    Ready      // frames written, resolvable
}

struct Slot {
    uuid: Uuid,
    storage: Vec<u8>, // planar f32 PCM; empty until `allocate`
    frame_count: u32,
    channel_count: u32,
    sample_rate: f32,
    state: State
}

// A handle is `generation << 16 | index`: the INDEX addresses the slot and IS REUSED after a free (a
// tombstoned index per freed sample would grow the table forever under box delete/recreate cycles, e.g. a
// sync-log rewind), while the GENERATION invalidates stale handles — `free` bumps the slot's generation, so
// a handle a device kept across the free resolves to `None` instead of the recycled slot's new sample. The
// generation is masked to 15 bits so an encoded handle stays positive as the i32 that crosses the JS
// boundary (`sample_take_request` returns -1 for "none").
pub(crate) const HANDLE_INDEX_BITS: u32 = 16;
pub(crate) const HANDLE_INDEX_MASK: u32 = (1 << HANDLE_INDEX_BITS) - 1;
pub(crate) const HANDLE_GENERATION_MASK: u32 = 0x7FFF;

pub(crate) fn encode_handle(index: u32, generation: u32) -> u32 {
    ((generation & HANDLE_GENERATION_MASK) << HANDLE_INDEX_BITS) | (index & HANDLE_INDEX_MASK)
}

pub(crate) fn decode_handle(handle: u32) -> (u32, u32) {
    (handle & HANDLE_INDEX_MASK, handle >> HANDLE_INDEX_BITS)
}

// One slot table entry: the slot payload plus the generation its CURRENT handles carry (bumped at free).
struct Entry {
    generation: u32,
    slot: Option<Slot>
}

/// The engine's table of samples, one slot per `AudioFileBox`, addressed by generation-tagged handles (see
/// the handle layout above): freed slots are recycled through `free_indices`, and a stale handle held by a
/// device resolves to `None` via its outdated generation.
#[derive(Default)]
pub struct SampleResource {
    entries: Vec<Entry>,
    free_indices: Vec<u32>, // freed slot indices awaiting reuse
    pending: Vec<u32> // handles in `Requested` state, awaiting a load request to the host
}

impl SampleResource {
    pub const fn new() -> Self {
        Self {entries: Vec::new(), free_indices: Vec::new(), pending: Vec::new()}
    }

    /// Ensure a slot exists for `uuid`, deduplicating so many regions sharing one file allocate once. A new
    /// sample is queued as pending for the host to load. Returns the handle either way.
    pub fn request(&mut self, uuid: Uuid) -> u32 {
        if let Some(handle) = self.handle_of(uuid) {
            return handle;
        }
        let slot = Slot {uuid, storage: Vec::new(), frame_count: 0, channel_count: 0, sample_rate: 0.0, state: State::Requested};
        let index = match self.free_indices.pop() {
            Some(index) => {
                self.entries[index as usize].slot = Some(slot);
                index
            }
            None => {
                let index = self.entries.len() as u32;
                debug_assert!(index <= HANDLE_INDEX_MASK, "sample slot index space exhausted");
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

    /// Pop the next sample awaiting a host load request, returning its `(handle, uuid)`, or `None`. The
    /// worklet drains these after applying a transaction and dispatches each to the loader.
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

    /// Reserve `byte_len` zeroed bytes for the slot's planar f32 frames and return the pointer the host
    /// writes into. The storage lives in the slot, so the pointer is stable until the sample is freed.
    pub fn allocate(&mut self, handle: u32, byte_len: usize) -> u32 {
        let Some(slot) = self.slot_mut(handle) else {
            return 0;
        };
        slot.storage = vec![0u8; byte_len];
        slot.state = State::Allocated;
        slot.storage.as_ptr() as u32
    }

    /// Mark the slot ready once the host has written its frames: `channel_count` planes of `frame_count`
    /// f32 each, at `sample_rate`.
    pub fn set_ready(&mut self, handle: u32, frame_count: u32, channel_count: u32, sample_rate: f32) {
        if let Some(slot) = self.slot_mut(handle) {
            slot.frame_count = frame_count;
            slot.channel_count = channel_count;
            slot.sample_rate = sample_rate;
            slot.state = State::Ready;
        }
    }

    /// Resolve an `AudioFileBox` uuid directly to its frames when ready (for an engine-side reader, e.g. the
    /// audio-region player, that holds a region's file uuid rather than a device handle). `None` when the file
    /// is unknown or not yet resident.
    /// The current handle for `uuid`, if a slot exists (any state).
    pub fn handle_by_uuid(&self, uuid: Uuid) -> Option<u32> {
        self.entries.iter().enumerate().find_map(|(index, entry)| {
            entry.slot.as_ref().filter(|slot| slot.uuid == uuid)
                .map(|_| encode_handle(index as u32, entry.generation))
        })
    }

    pub fn resolve_uuid(&self, uuid: Uuid) -> Option<SampleRef> {
        self.resolve(self.handle_of(uuid)?)
    }

    /// Resolve a handle to its frames, but ONLY when ready (a device skips an unready sample for the block).
    pub fn resolve(&self, handle: u32) -> Option<SampleRef> {
        let slot = self.slot(handle)?;
        if slot.state != State::Ready {
            return None;
        }
        Some(SampleRef {
            frames_ptr: slot.storage.as_ptr() as u32,
            frame_count: slot.frame_count,
            channel_count: slot.channel_count,
            sample_rate: slot.sample_rate
        })
    }

    /// Diagnostic slot-table sizes for leak probes: (table entries, live slots). The table must not grow
    /// across box delete/recreate cycles (freed indices are recycled).
    pub fn debug_counts(&self) -> (u32, u32) {
        (self.entries.len() as u32, self.entries.iter().filter(|entry| entry.slot.is_some()).count() as u32)
    }

    /// Free the sample for `uuid` (its box was removed): drop the slot's storage, bump the generation (so
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
    use super::SampleResource;

    fn uuid(tag: u8) -> [u8; 16] {
        let mut bytes = [0u8; 16];
        bytes[0] = tag;
        bytes
    }

    #[test]
    fn request_dedupes_by_uuid_and_queues_once() {
        let mut resource = SampleResource::new();
        let first = resource.request(uuid(1));
        let again = resource.request(uuid(1));
        let other = resource.request(uuid(2));
        assert_eq!(first, again, "the same file resolves to the same handle");
        assert_ne!(first, other);
        assert_eq!(resource.take_pending().map(|(handle, _)| handle), Some(other), "newest pending first");
        assert_eq!(resource.take_pending().map(|(handle, _)| handle), Some(first));
        assert!(resource.take_pending().is_none(), "each sample is queued once");
    }

    #[test]
    fn resolves_only_after_ready_and_carries_planar_metadata() {
        let mut resource = SampleResource::new();
        let handle = resource.request(uuid(7));
        assert!(resource.resolve(handle).is_none(), "not resolvable while merely requested");
        let pointer = resource.allocate(handle, 2 * 100 * 4); // 2 channels, 100 frames, f32
        assert_ne!(pointer, 0);
        assert!(resource.resolve(handle).is_none(), "not resolvable until the frames are written");
        resource.set_ready(handle, 100, 2, 48_000.0);
        let sample = resource.resolve(handle).expect("ready resolves");
        assert_eq!(sample.frames_ptr, pointer, "resolves to the allocated storage");
        assert_eq!((sample.frame_count, sample.channel_count, sample.sample_rate), (100, 2, 48_000.0));
    }

    #[test]
    fn free_drops_the_slot_and_a_stale_handle_resolves_to_none() {
        let mut resource = SampleResource::new();
        let handle = resource.request(uuid(3));
        resource.allocate(handle, 16);
        resource.set_ready(handle, 4, 1, 44_100.0);
        assert!(resource.resolve(handle).is_some());
        resource.free(uuid(3));
        assert!(resource.resolve(handle).is_none(), "a freed sample no longer resolves");
        let fresh = resource.request(uuid(3));
        assert_ne!(fresh, handle, "re-requesting a freed uuid gets a new handle (bumped generation)");
    }

    #[test]
    fn freed_slots_are_recycled_and_stale_handles_never_see_the_new_tenant() {
        let mut resource = SampleResource::new();
        let mut stale = resource.request(uuid(1));
        // Many delete/recreate cycles (the sync-log rewind pattern) must not grow the table.
        for round in 0..100u8 {
            resource.free(uuid(1));
            assert!(resource.resolve(stale).is_none(), "round {round}: the freed handle is dead");
            let fresh = resource.request(uuid(1));
            assert_ne!(fresh, stale, "round {round}: the recycled slot carries a new generation");
            resource.allocate(fresh, 16);
            resource.set_ready(fresh, 4, 1, 48_000.0);
            assert!(resource.resolve(stale).is_none(), "round {round}: the stale handle never resolves the new tenant");
            assert!(resource.resolve(fresh).is_some());
            stale = fresh;
        }
        assert_eq!(resource.debug_counts(), (1, 1), "one uuid occupies ONE recycled slot, forever");
    }
}
