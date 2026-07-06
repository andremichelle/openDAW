//! Per-block event queue, ported from core-processors `EventBuffer` (an `ArrayMultimap<int, Event>`).
//! Events are bucketed by render-block index; a processor reads `get(index)` for the block it renders.
//! Insertion order within a bucket is preserved (note-offs are added before note-ons at the same
//! position by the sequencer, and the order matters to consumers).

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use crate::event::Event;

pub struct EventBuffer {
    buckets: BTreeMap<u32, Vec<Event>>
}

impl EventBuffer {
    pub fn new() -> Self {
        Self {buckets: BTreeMap::new()}
    }

    pub fn add(&mut self, index: u32, event: Event) {
        self.buckets.entry(index).or_default().push(event);
    }

    pub fn get(&self, index: u32) -> &[Event] {
        self.buckets.get(&index).map_or(&[], |events| events.as_slice())
    }

    pub fn for_each(&self, mut procedure: impl FnMut(u32, &[Event])) {
        for (index, events) in &self.buckets {
            if !events.is_empty() {
                procedure(*index, events);
            }
        }
    }

    /// Empties every bucket KEEPING its storage (and the map nodes): `clear` runs once per quantum on the
    /// render path, where dropping the buckets would free + re-allocate through talc on every eventful
    /// quantum. Bucket count is bounded by the block indices ever seen (a high-water, like every render
    /// scratch), so retained nodes never grow past one quantum's block count.
    pub fn clear(&mut self) {
        for events in self.buckets.values_mut() {
            events.clear();
        }
    }

    pub fn is_empty(&self) -> bool {
        self.buckets.values().all(|events| events.is_empty())
    }
}

impl Default for EventBuffer {
    fn default() -> Self {
        Self::new()
    }
}
