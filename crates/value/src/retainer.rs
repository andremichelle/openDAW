//! EventSpanRetainer, mirroring lib-dsp. Holds spans (e.g. note-ons) that may outlive the block that
//! started them, kept sorted DESCENDING by completion (`position + duration`) so the soonest-to-finish
//! sit at the end. `release_linear_completed` pops from the end while the span has completed (O(k) in
//! the number released, stopping at the first still-sounding span); `release_all` drains everything
//! (including infinite-duration spans); `overlapping` yields the spans sounding at a position.

use alloc::vec::Vec;
use crate::event::EventSpan;

pub struct EventSpanRetainer<E: EventSpan> {
    events: Vec<E> // descending by complete()
}

impl<E: EventSpan> EventSpanRetainer<E> {
    pub fn new() -> Self {
        // Pre-reserve a polyphony's worth so holding notes across blocks never reallocs on the render path.
        Self {events: Vec::with_capacity(64)}
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    pub fn non_empty(&self) -> bool {
        !self.events.is_empty()
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn clear(&mut self) {
        self.events.clear();
    }

    /// Insert keeping the descending-by-completion order.
    pub fn add_and_retain(&mut self, event: E) {
        let complete = event.complete();
        let index = self.events.partition_point(|existing| existing.complete() > complete);
        self.events.insert(index, event);
    }

    /// Release completed spans (soonest-to-finish first), calling `f` for each, stopping at the first span
    /// still sounding. ALLOCATION-FREE — the render hot path calls this every block.
    pub fn drain_linear_completed(&mut self, position: f64, mut f: impl FnMut(E)) {
        while self.events.last().is_some_and(|event| event.complete() < position) {
            f(self.events.pop().unwrap());
        }
    }

    /// Drain every retained span into `f` (e.g. on a transport stop or loop wrap). Allocation-free, and
    /// `drain(..)` keeps the backing capacity so the next note does not re-grow it.
    pub fn drain_all(&mut self, mut f: impl FnMut(E)) {
        for event in self.events.drain(..) {
            f(event);
        }
    }

    /// Vec-returning convenience over `drain_linear_completed` (tests / non-hot-path callers only).
    pub fn release_linear_completed(&mut self, position: f64) -> Vec<E> {
        let mut released = Vec::new();
        self.drain_linear_completed(position, |event| released.push(event));
        released
    }

    /// Vec-returning convenience over `drain_all`.
    pub fn release_all(&mut self) -> Vec<E> {
        let mut released = Vec::new();
        self.drain_all(|event| released.push(event));
        released
    }

    /// The spans sounding at `position` (its start is at or before, its completion strictly after).
    pub fn overlapping(&self, position: f64) -> impl Iterator<Item = &E> {
        self.events.iter().filter(move |event| event.position() <= position && position < event.complete())
    }
}

impl<E: EventSpan> Default for EventSpanRetainer<E> {
    fn default() -> Self {
        Self::new()
    }
}
