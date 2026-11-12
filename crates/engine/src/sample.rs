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

use alloc::vec::Vec;
use abi::SampleRef;
use math::Pcm;
use boxgraph::address::Uuid;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    Requested, // seen, awaiting a host load request
    Allocated, // storage reserved, awaiting the host's frame write
    Ready      // frames written, resolvable
}

struct Slot {
    uuid: Uuid,
    storage: Vec<u8>, // planar PCM in `format`; empty until `allocate`
    floats: Vec<f32>, // the float copy of 16 bit frames, built once a reader that needs floats asks
    floats_wanted: bool,
    format: u32,
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

// `vec![0; n]` aborts the engine when the memory cannot grow, this returns `None` instead
pub(crate) fn try_filled<T: Clone>(len: usize, value: T) -> Option<Vec<T>> {
    let mut storage = Vec::new();
    storage.try_reserve_exact(len).ok()?;
    storage.resize(len, value);
    Some(storage)
}

// One slot table entry: the slot payload plus the generation its CURRENT handles carry (bumped at free).
struct Entry {
    generation: u32,
    slot: Option<Slot>
}

/// The engine's table of samples, one slot per `AudioFileBox`, addressed by generation-tagged handles (see
/// the handle layout above): freed slots are recycled through `free_indices`, and a stale handle held by a
/// device resolves to `None` via its outdated generation.
pub struct SampleResource {
    entries: Vec<Entry>,
    free_indices: Vec<u32>, // freed slot indices awaiting reuse
    pending: Vec<u32>, // handles in `Requested` state, awaiting a load request to the host
    float_budget: usize // values turned into floats per render block, `usize::MAX` for all at once
}

impl Default for SampleResource {
    fn default() -> Self {Self::new()}
}

/// What a render block may spend on float copies: about 30 microseconds.
pub const FLOAT_BUDGET: usize = 1 << 15;

// Converts up to `budget` more values of a wanted float copy, returning how many it did.
fn convert(slot: &mut Slot, budget: usize) -> usize {
    let total = slot.frame_count as usize * slot.channel_count as usize;
    let done = slot.floats.len();
    if !slot.floats_wanted || done >= total || slot.floats.capacity() < total {
        return 0;
    }
    let count = budget.min(total - done);
    let source = unsafe { core::slice::from_raw_parts(slot.storage.as_ptr() as *const i16, total) };
    slot.floats.extend(source[done..done + count].iter().map(|value| value.to_f32()));
    count
}

impl SampleResource {
    pub const fn new() -> Self {
        Self {entries: Vec::new(), free_indices: Vec::new(), pending: Vec::new(), float_budget: FLOAT_BUDGET}
    }

    /// An offline render passes `usize::MAX`: it has no quantum to keep and must not start without its samples.
    pub fn set_float_budget(&mut self, values: usize) {
        self.float_budget = values;
    }

    /// As `resolve` with f32 frames: a 16 bit sample resolves once its shared float copy is complete.
    pub fn resolve_floats(&mut self, handle: u32) -> Option<SampleRef> {
        let at_once = self.float_budget == usize::MAX;
        let slot = self.slot_mut(handle)?;
        if slot.state != State::Ready {
            return None;
        }
        let total = slot.frame_count as usize * slot.channel_count as usize;
        if slot.format == abi::SAMPLE_FORMAT_I16 {
            slot.floats_wanted = true;
            if slot.floats.capacity() < total {
                let _ = slot.floats.try_reserve_exact(total - slot.floats.len());
            }
            if at_once {
                convert(slot, usize::MAX);
            }
            if slot.floats.len() < total {
                return None;
            }
        }
        Some(SampleRef {
            frames_ptr: if slot.format == abi::SAMPLE_FORMAT_I16 {slot.floats.as_ptr()} else {slot.storage.as_ptr() as *const f32} as u32,
            frame_count: slot.frame_count,
            channel_count: slot.channel_count,
            sample_rate: slot.sample_rate,
            format: abi::SAMPLE_FORMAT_F32
        })
    }

    // native pointers do not fit the u32 a handle's frames are addressed by, so tests reach the buffers here
    #[cfg(test)]
    fn buffers(&mut self, handle: u32) -> (&mut Vec<u8>, &Vec<f32>) {
        let slot = self.slot_mut(handle).expect("a live slot");
        (&mut slot.storage, &slot.floats)
    }

    /// Advances the float copies readers asked for, by the budget of one render block in total.
    pub fn convert_floats(&mut self) {
        let mut budget = self.float_budget;
        for entry in self.entries.iter_mut() {
            if budget == 0 {
                break;
            }
            if let Some(slot) = entry.slot.as_mut() {
                budget -= convert(slot, budget);
            }
        }
    }

    /// Ensure a slot exists for `uuid`, deduplicating so many regions sharing one file allocate once. A new
    /// sample is queued as pending for the host to load. Returns the handle either way.
    pub fn request(&mut self, uuid: Uuid) -> u32 {
        if let Some(handle) = self.handle_of(uuid) {
            return handle;
        }
        let slot = Slot {uuid, storage: Vec::new(), floats: Vec::new(), floats_wanted: false, format: abi::SAMPLE_FORMAT_F32, frame_count: 0, channel_count: 0, sample_rate: 0.0, state: State::Requested};
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
        if slot.state != State::Requested {
            return 0;
        }
        let Some(storage) = try_filled(byte_len, 0u8) else {
            return 0;
        };
        slot.storage = storage;
        slot.state = State::Allocated;
        slot.storage.as_ptr() as u32
    }

    /// Mark the slot ready once the host has written its frames: `channel_count` planes of `frame_count`
    /// f32 each, at `sample_rate`.
    pub fn set_ready(&mut self, handle: u32, frame_count: u32, channel_count: u32, sample_rate: f32) {
        self.set_ready_as(handle, frame_count, channel_count, sample_rate, abi::SAMPLE_FORMAT_F32);
    }

    /// As [`Self::set_ready`], the planes written in `format` (`abi::SAMPLE_FORMAT_*`).
    pub fn set_ready_as(&mut self, handle: u32, frame_count: u32, channel_count: u32, sample_rate: f32, format: u32) {
        if let Some(slot) = self.slot_mut(handle) {
            if slot.state != State::Allocated {
                return;
            }
            let width = if format == abi::SAMPLE_FORMAT_I16 {2} else {4};
            let bytes = frame_count as usize * channel_count as usize * width;
            assert!(bytes <= slot.storage.len(), "sample frames ({bytes} bytes) exceed the allocation ({} bytes)", slot.storage.len());
            slot.format = format;
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
        let slot = self.slot(handle)?;
        if slot.state != State::Ready {
            return None;
        }
        Some(SampleRef {
            frames_ptr: slot.storage.as_ptr() as u32,
            frame_count: slot.frame_count,
            channel_count: slot.channel_count,
            sample_rate: slot.sample_rate,
            format: slot.format
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
    fn a_float_sample_resolves_as_float() {
        let mut resource = SampleResource::new();
        let handle = resource.request(uuid(30));
        resource.allocate(handle, 100 * 4);
        resource.set_ready(handle, 100, 1, 48_000.0);
        assert_eq!(resource.resolve(handle).expect("ready resolves").format, abi::SAMPLE_FORMAT_F32);
    }

    #[test]
    fn a_sixteen_bit_sample_takes_two_bytes_per_value_and_resolves_as_such() {
        let mut resource = SampleResource::new();
        let handle = resource.request(uuid(31));
        let pointer = resource.allocate(handle, 2 * 100 * 2);
        resource.set_ready_as(handle, 100, 2, 44_100.0, abi::SAMPLE_FORMAT_I16);
        let sample = resource.resolve(handle).expect("ready resolves");
        assert_eq!(sample.format, abi::SAMPLE_FORMAT_I16);
        assert_eq!((sample.frames_ptr, sample.frame_count, sample.channel_count, sample.sample_rate), (pointer, 100, 2, 44_100.0));
    }

    #[test]
    #[should_panic(expected = "exceed the allocation")]
    fn float_frames_do_not_fit_an_allocation_sized_for_sixteen_bit() {
        let mut resource = SampleResource::new();
        let handle = resource.request(uuid(32));
        resource.allocate(handle, 100 * 2);
        resource.set_ready(handle, 100, 1, 48_000.0);
    }

    #[test]
    fn a_recycled_slot_forgets_the_format_of_its_last_sample() {
        let mut resource = SampleResource::new();
        let first = resource.request(uuid(33));
        resource.allocate(first, 10 * 2);
        resource.set_ready_as(first, 10, 1, 48_000.0, abi::SAMPLE_FORMAT_I16);
        resource.free(uuid(33));
        let second = resource.request(uuid(34));
        resource.allocate(second, 10 * 4);
        resource.set_ready(second, 10, 1, 48_000.0);
        assert_eq!(resource.resolve(second).expect("ready resolves").format, abi::SAMPLE_FORMAT_F32);
    }

    // a ready 16 bit sample holding `values`, mono
    fn sixteen_bit(resource: &mut SampleResource, tag: u8, values: &[i16]) -> u32 {
        let handle = resource.request(uuid(tag));
        resource.allocate(handle, values.len() * 2);
        let bytes: Vec<u8> = values.iter().flat_map(|value| value.to_le_bytes()).collect();
        resource.buffers(handle).0.copy_from_slice(&bytes);
        resource.set_ready_as(handle, values.len() as u32, 1, 48_000.0, abi::SAMPLE_FORMAT_I16);
        handle
    }

    fn floats_of(resource: &mut SampleResource, handle: u32) -> Vec<f32> {resource.buffers(handle).1.clone()}

    #[test]
    fn a_float_sample_resolves_as_floats_at_once_without_a_copy() {
        let mut resource = SampleResource::new();
        let handle = resource.request(uuid(40));
        let pointer = resource.allocate(handle, 100 * 4);
        resource.set_ready(handle, 100, 1, 48_000.0);
        let sample = resource.resolve_floats(handle).expect("float frames need no copy");
        assert_eq!((sample.frames_ptr, sample.format), (pointer, abi::SAMPLE_FORMAT_F32));
    }

    #[test]
    fn a_sixteen_bit_sample_resolves_as_floats_once_its_copy_is_complete() {
        let mut resource = SampleResource::new();
        let values: Vec<i16> = (0..super::FLOAT_BUDGET as i32 + 10).map(|index| (index % 30_000) as i16).collect();
        let handle = sixteen_bit(&mut resource, 41, &values);
        assert!(resource.resolve_floats(handle).is_none(), "the first ask only starts the copy");
        resource.convert_floats();
        assert!(resource.resolve_floats(handle).is_none(), "one block is not enough for more than its budget");
        resource.convert_floats();
        let sample = resource.resolve_floats(handle).expect("the copy is complete");
        assert_eq!((sample.format, sample.frame_count, sample.channel_count, sample.sample_rate), (abi::SAMPLE_FORMAT_F32, values.len() as u32, 1, 48_000.0));
        let expected: Vec<f32> = values.iter().map(|value| *value as f32 / 32768.0).collect();
        assert_eq!(floats_of(&mut resource, handle), expected);
        assert_eq!(resource.resolve(handle).expect("still 16 bit for the others").format, abi::SAMPLE_FORMAT_I16);
    }

    #[test]
    fn nothing_is_copied_for_a_sample_nobody_asked_floats_of() {
        let mut resource = SampleResource::new();
        let handle = sixteen_bit(&mut resource, 42, &[1, 2, 3]);
        resource.convert_floats();
        resource.convert_floats();
        assert!(resource.resolve_floats(handle).is_none(), "the copy starts with the first ask, not before");
        resource.convert_floats();
        assert!(resource.resolve_floats(handle).is_some());
    }

    #[test]
    fn one_block_shares_its_budget_between_all_copies() {
        let mut resource = SampleResource::new();
        let half = vec![7i16; super::FLOAT_BUDGET / 2 + 100];
        let first = sixteen_bit(&mut resource, 43, &half);
        let second = sixteen_bit(&mut resource, 44, &half);
        resource.resolve_floats(first);
        resource.resolve_floats(second);
        resource.convert_floats();
        assert!(resource.resolve_floats(first).is_some(), "the first copy fits the block");
        assert!(resource.resolve_floats(second).is_none(), "the second got only what was left");
        resource.convert_floats();
        assert!(resource.resolve_floats(second).is_some());
    }

    #[test]
    fn without_a_budget_the_copy_is_there_at_the_first_ask() {
        let mut resource = SampleResource::new();
        resource.set_float_budget(usize::MAX);
        let values: Vec<i16> = (0..200_000).map(|index| (index % 60_000 - 30_000) as i16).collect();
        let handle = sixteen_bit(&mut resource, 45, &values);
        assert!(resource.resolve_floats(handle).is_some(), "an offline render has it at once");
        let floats = floats_of(&mut resource, handle);
        assert_eq!((floats.len(), floats[199_999]), (200_000, values[199_999] as f32 / 32768.0));
    }

    #[test]
    fn everybody_who_asks_gets_the_same_copy() {
        let mut resource = SampleResource::new();
        resource.set_float_budget(usize::MAX);
        let handle = sixteen_bit(&mut resource, 46, &[5, -5, 9]);
        let first = resource.resolve_floats(handle).unwrap();
        let second = resource.resolve_floats(handle).unwrap();
        assert_eq!(first.frames_ptr, second.frames_ptr);
    }

    #[test]
    fn a_freed_sample_takes_its_float_copy_along() {
        let mut resource = SampleResource::new();
        resource.set_float_budget(usize::MAX);
        let handle = sixteen_bit(&mut resource, 47, &[5, -5, 9]);
        assert!(resource.resolve_floats(handle).is_some());
        resource.free(uuid(47));
        assert!(resource.resolve_floats(handle).is_none());
        let next = sixteen_bit(&mut resource, 48, &[1, 2]);
        assert!(resource.resolve_floats(next).is_some());
        assert_eq!(floats_of(&mut resource, next), [1.0 / 32768.0, 2.0 / 32768.0]);
    }

    #[test]
    fn an_unready_sample_has_no_floats() {
        let mut resource = SampleResource::new();
        let handle = resource.request(uuid(49));
        assert!(resource.resolve_floats(handle).is_none());
        resource.allocate(handle, 8);
        assert!(resource.resolve_floats(handle).is_none());
    }

    #[test]
    fn a_second_allocate_never_replaces_live_storage() {
        let mut resource = SampleResource::new();
        let handle = resource.request(uuid(8));
        let pointer = resource.allocate(handle, 2 * 100 * 4);
        assert_eq!(resource.allocate(handle, 2 * 100 * 4), 0, "an allocated slot refuses a second allocation");
        resource.set_ready(handle, 100, 2, 48_000.0);
        assert_eq!(resource.allocate(handle, 4), 0, "a ready slot refuses a new allocation");
        let sample = resource.resolve(handle).expect("ready resolves");
        assert_eq!(sample.frames_ptr, pointer, "the first storage stays in place");
        assert_eq!(sample.frame_count, 100);
    }

    #[test]
    fn a_refused_allocation_returns_zero_and_keeps_the_slot_requested() {
        let mut resource = SampleResource::new();
        let handle = resource.request(uuid(10));
        assert_eq!(resource.allocate(handle, usize::MAX), 0, "an allocation that cannot be satisfied returns 0");
        assert!(resource.resolve(handle).is_none());
        resource.set_ready(handle, 1, 1, 48_000.0);
        assert!(resource.resolve(handle).is_none(), "set_ready after a refused allocation is ignored");
        let pointer = resource.allocate(handle, 4);
        assert_ne!(pointer, 0, "the slot still takes a smaller allocation");
        resource.set_ready(handle, 1, 1, 48_000.0);
        assert_eq!(resource.resolve(handle).map(|sample| sample.frames_ptr), Some(pointer));
    }

    #[test]
    fn set_ready_only_completes_an_allocation() {
        let mut resource = SampleResource::new();
        let handle = resource.request(uuid(9));
        resource.set_ready(handle, 100, 2, 48_000.0);
        assert!(resource.resolve(handle).is_none(), "set_ready before allocate is ignored");
        resource.allocate(handle, 2 * 100 * 4);
        resource.set_ready(handle, 100, 2, 48_000.0);
        resource.set_ready(handle, 1000, 2, 48_000.0);
        assert_eq!(resource.resolve(handle).map(|sample| sample.frame_count), Some(100), "a ready slot keeps its metadata");
    }

    #[test]
    #[should_panic(expected = "exceed")]
    fn set_ready_panics_when_the_frames_exceed_the_allocation() {
        let mut resource = SampleResource::new();
        let handle = resource.request(uuid(10));
        resource.allocate(handle, 2 * 100 * 4);
        resource.set_ready(handle, 101, 2, 48_000.0);
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
