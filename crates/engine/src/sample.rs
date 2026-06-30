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

/// The engine's table of samples, one slot per `AudioFileBox`. A handle is an index into `slots`; a freed
/// slot becomes `None` and its index is never reused, so a stale handle held by a device resolves to `None`.
#[derive(Default)]
pub struct SampleResource {
    slots: Vec<Option<Slot>>,
    pending: Vec<u32> // handles in `Requested` state, awaiting a load request to the host
}

impl SampleResource {
    pub const fn new() -> Self {
        Self {slots: Vec::new(), pending: Vec::new()}
    }

    /// Ensure a slot exists for `uuid`, deduplicating so many regions sharing one file allocate once. A new
    /// sample is queued as pending for the host to load. Returns the handle either way.
    pub fn request(&mut self, uuid: Uuid) -> u32 {
        if let Some(handle) = self.handle_of(uuid) {
            return handle;
        }
        let handle = self.slots.len() as u32;
        self.slots.push(Some(Slot {uuid, storage: Vec::new(), frame_count: 0, channel_count: 0, sample_rate: 0.0, state: State::Requested}));
        self.pending.push(handle);
        handle
    }

    fn handle_of(&self, uuid: Uuid) -> Option<u32> {
        self.slots.iter().position(|slot| slot.as_ref().is_some_and(|slot| slot.uuid == uuid)).map(|index| index as u32)
    }

    /// Pop the next sample awaiting a host load request, returning its `(handle, uuid)`, or `None`. The
    /// worklet drains these after applying a transaction and dispatches each to the loader.
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

    /// Reserve `byte_len` zeroed bytes for the slot's planar f32 frames and return the pointer the host
    /// writes into. The storage lives in the slot, so the pointer is stable until the sample is freed.
    pub fn allocate(&mut self, handle: u32, byte_len: usize) -> u32 {
        let Some(Some(slot)) = self.slots.get_mut(handle as usize) else {
            return 0;
        };
        slot.storage = vec![0u8; byte_len];
        slot.state = State::Allocated;
        slot.storage.as_ptr() as u32
    }

    /// Mark the slot ready once the host has written its frames: `channel_count` planes of `frame_count`
    /// f32 each, at `sample_rate`.
    pub fn set_ready(&mut self, handle: u32, frame_count: u32, channel_count: u32, sample_rate: f32) {
        if let Some(Some(slot)) = self.slots.get_mut(handle as usize) {
            slot.frame_count = frame_count;
            slot.channel_count = channel_count;
            slot.sample_rate = sample_rate;
            slot.state = State::Ready;
        }
    }

    /// Resolve an `AudioFileBox` uuid directly to its frames when ready (for an engine-side reader, e.g. the
    /// audio-region player, that holds a region's file uuid rather than a device handle). `None` when the file
    /// is unknown or not yet resident.
    pub fn resolve_uuid(&self, uuid: Uuid) -> Option<SampleRef> {
        self.resolve(self.handle_of(uuid)?)
    }

    /// Resolve a handle to its frames, but ONLY when ready (a device skips an unready sample for the block).
    pub fn resolve(&self, handle: u32) -> Option<SampleRef> {
        let slot = self.slots.get(handle as usize)?.as_ref()?;
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

    /// Free the sample for `uuid` (its box was removed): drop the slot's storage and empty the slot. A later
    /// request for the same uuid gets a fresh handle.
    pub fn free(&mut self, uuid: Uuid) {
        if let Some(handle) = self.handle_of(uuid) {
            self.slots[handle as usize] = None;
        }
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
        assert_ne!(fresh, handle, "re-requesting a freed uuid gets a new handle, never the old index");
    }
}
