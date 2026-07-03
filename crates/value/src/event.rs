//! A sorted event collection, mirroring lib-dsp `EventCollection` / `EventArrayImpl`. Backed by a
//! sorted `Vec` with binary-search position lookups (the cache-friendly Rust equivalent of the TS
//! lazy-sorted array). `floor_last_index` / `ceil_first_index` match `rightMost` / `leftMost`.

use alloc::vec::Vec;

pub trait Event {
    fn position(&self) -> f64;
}

/// An event with a duration (mirrors lib-dsp `EventSpan`). `complete` is its end position.
pub trait EventSpan: Event {
    fn duration(&self) -> f64;
    fn complete(&self) -> f64 {
        self.position() + self.duration()
    }
}

pub struct EventCollection<E: Event + Ord> {
    events: Vec<E>,
    // Lazily-cached maximum duration (TS `NoteEventCollectionBoxAdapter.#computedExtremas`): the sequencer
    // extends its range query by it (the lookback), so a long note starting before the window still ratchets.
    max_duration: core::cell::Cell<f64>,
    extremas_dirty: core::cell::Cell<bool>
}

impl<E: Event + Ord> EventCollection<E> {
    pub fn new() -> Self {
        Self {events: Vec::new(), max_duration: core::cell::Cell::new(0.0), extremas_dirty: core::cell::Cell::new(false)}
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn as_slice(&self) -> &[E] {
        &self.events
    }

    pub fn at(&self, index: usize) -> Option<&E> {
        self.events.get(index)
    }

    pub fn first(&self) -> Option<&E> {
        self.events.first()
    }

    pub fn last(&self) -> Option<&E> {
        self.events.last()
    }

    /// Insert keeping the array sorted by `Ord` (position then any tiebreak the event defines).
    pub fn add(&mut self, event: E) {
        let index = self.events.binary_search(&event).unwrap_or_else(|insertion| insertion);
        self.events.insert(index, event);
        self.extremas_dirty.set(true);
    }

    pub fn remove(&mut self, event: &E) -> bool {
        match self.events.binary_search(event) {
            Ok(index) => {
                self.events.remove(index);
                self.extremas_dirty.set(true);
                true
            }
            Err(_) => false
        }
    }

    /// Rightmost index whose position is `<= position`, or -1 if none (mirrors `floorLastIndex`).
    pub fn floor_last_index(&self, position: f64) -> isize {
        self.events.partition_point(|event| event.position() <= position) as isize - 1
    }

    /// Leftmost index whose position is `>= position` (== len if none) (mirrors `ceilFirstIndex`).
    pub fn ceil_first_index(&self, position: f64) -> usize {
        self.events.partition_point(|event| event.position() < position)
    }

    pub fn lower_equal(&self, position: f64) -> Option<&E> {
        let index = self.floor_last_index(position);
        if index < 0 {
            None
        } else {
            self.events.get(index as usize)
        }
    }

    pub fn greater_equal(&self, position: f64) -> Option<&E> {
        self.events.get(self.ceil_first_index(position))
    }

    /// Iterate from the event at or before `from` (or from index 0 if none precedes it), in order.
    /// Matches `iterateFrom`: an event on or before `from` is included.
    pub fn iterate_from(&self, from: f64) -> core::slice::Iter<'_, E> {
        let floor = self.floor_last_index(from);
        let start = if floor < 0 {0} else {floor as usize};
        self.events[start..].iter()
    }

    /// Iterate events with position in `[from, to)` (first index `>= from`, stop at `>= to`).
    /// Matches `iterateRange`.
    pub fn iterate_range(&self, from: f64, to: f64) -> impl Iterator<Item = &E> {
        let start = self.ceil_first_index(from);
        self.events.get(start..).unwrap_or(&[]).iter().take_while(move |event| event.position() < to)
    }
}

impl<E: Event + Ord + EventSpan> EventCollection<E> {
    /// The longest event duration, lazily recomputed after an edit (TS `maxDuration` via `#computeExtremas`).
    pub fn max_duration(&self) -> f64 {
        if self.extremas_dirty.get() {
            let mut max = 0.0f64;
            for event in &self.events {
                if event.duration() > max {
                    max = event.duration();
                }
            }
            self.max_duration.set(max);
            self.extremas_dirty.set(false);
        }
        self.max_duration.get()
    }
}

impl<E: Event + Ord> Default for EventCollection<E> {
    fn default() -> Self {
        Self::new()
    }
}
