//! Loopable-region math, mirroring lib-dsp `LoopableRegion`. A region spans `[position, complete)` on
//! the global timeline and loops content of length `loop_duration` beginning at `loop_offset`.
//! `locate_loops` yields the loop cycles overlapping a global `[from, to)` window; each cycle exposes
//! its raw span (the full, unclipped loop cycle), its span clipped to the region, and its span clipped
//! to the search window, plus the unit fractions where the result span starts/ends within the cycle.
//!
//! Returned as a lazy iterator (no per-block allocation): the sequencer queries it every render block.

use alloc::vec::Vec;
use math::{floor, mod_euclid};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LoopCycle {
    pub index: i32,
    pub raw_start: f64,    // full loop cycle, independent of region/window
    pub raw_end: f64,
    pub region_start: f64, // raw clipped to the region
    pub region_end: f64,
    pub result_start: f64, // raw clipped to the search window
    pub result_end: f64,
    pub result_start_value: f32, // unit fraction of the cycle where result_start sits
    pub result_end_value: f32
}

/// A global position mapped to its local loop coordinate in `[0, loop_duration)`.
pub fn global_to_local(position: f64, region_position: f64, loop_offset: f64, loop_duration: f64) -> f64 {
    mod_euclid(position - region_position + loop_offset, loop_duration)
}

/// Iterate the loop cycles of a region overlapping `[from, to)`. See module docs.
pub fn locate_loops(position: f64, complete: f64, loop_offset: f64, loop_duration: f64, from: f64, to: f64) -> LoopCycles {
    let offset = position - loop_offset;
    let seek_min = if position > from {position} else {from};
    let seek_max = if complete < to {complete} else {to};
    // A degenerate loop duration (0, negative, or NaN from an unset field) would drive `raw_start` to
    // NaN and the `>= seek_max` termination test never fires: an audio-thread hang. Yield nothing.
    // (The negated comparison is deliberate: it is the NaN-rejecting form.)
    #[allow(clippy::neg_cmp_op_on_partial_ord)]
    if !(loop_duration > 0.0) {
        return LoopCycles {position, complete, loop_duration, seek_min, seek_max, raw_start: seek_max, index: 0};
    }
    let index = floor((seek_min - offset) / loop_duration);
    LoopCycles {
        position,
        complete,
        loop_duration,
        seek_min,
        seek_max,
        raw_start: offset + index * loop_duration,
        index: index as i32
    }
}

pub struct LoopCycles {
    position: f64,
    complete: f64,
    loop_duration: f64,
    seek_min: f64,
    seek_max: f64,
    raw_start: f64,
    index: i32
}

impl Iterator for LoopCycles {
    type Item = LoopCycle;

    fn next(&mut self) -> Option<LoopCycle> {
        // Inverted comparison so a NaN in either operand terminates instead of iterating forever.
        #[allow(clippy::neg_cmp_op_on_partial_ord)]
        if !(self.raw_start < self.seek_max) {
            return None;
        }
        let raw_start = self.raw_start;
        let raw_end = raw_start + self.loop_duration;
        let result_start = if raw_start > self.seek_min {raw_start} else {self.seek_min};
        let result_end = if raw_end < self.seek_max {raw_end} else {self.seek_max};
        let cycle = LoopCycle {
            index: self.index,
            raw_start,
            raw_end,
            region_start: if raw_start > self.position {raw_start} else {self.position},
            region_end: if raw_end < self.complete {raw_end} else {self.complete},
            result_start,
            result_end,
            result_start_value: if raw_start < result_start {((result_start - raw_start) / self.loop_duration) as f32} else {0.0},
            result_end_value: if raw_end > result_end {((result_end - raw_start) / self.loop_duration) as f32} else {1.0}
        };
        self.raw_start = raw_end;
        self.index += 1;
        Some(cycle)
    }
}

/// A timeline SPAN: an item at `position` lasting `duration` pulses (TS `EventSpan`). The orderable key
/// for a `RegionCollection`.
pub trait Span {
    fn position(&self) -> f64;
    fn duration(&self) -> f64;
}

/// A collection of spans kept sorted by `position`, range-queried span-aware (the Rust mirror of lib-dsp
/// `RegionCollection`). Backed by a `Vec`; `add` binary-inserts, `iterate_range` binary-searches the
/// window. Regions on a track do not overlap, so `iterate_range` (like TS) considers only the single
/// region at/before `from` as possibly still active, then yields forward while `position < to`.
pub struct RegionCollection<R: Span> {
    regions: Vec<R>
}

impl<R: Span> RegionCollection<R> {
    pub fn new() -> Self {
        Self {regions: Vec::new()}
    }

    pub fn len(&self) -> usize {
        self.regions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.regions.is_empty()
    }

    /// Insert keeping the `Vec` sorted by `position` (after any equal-position entries, a stable order).
    pub fn add(&mut self, region: R) {
        let index = self.regions.partition_point(|existing| existing.position() <= region.position());
        self.regions.insert(index, region);
    }

    /// Drop the regions for which `keep` is false, preserving sorted order (TS removal by predicate).
    pub fn retain(&mut self, keep: impl FnMut(&R) -> bool) {
        self.regions.retain(keep);
    }

    /// Mutable access to the regions, for updating a region in place (e.g. after its position changed).
    /// The caller MUST `resort` afterwards if it changed any `position` (TS `onIndexingChanged`).
    pub fn iter_mut(&mut self) -> core::slice::IterMut<'_, R> {
        self.regions.iter_mut()
    }

    /// Re-sort by `position` after positions changed (stable, so equal positions keep order). The lazy
    /// re-index a `RegionCollection` does on `onIndexingChanged`; we re-sort eagerly when a region moves.
    pub fn resort(&mut self) {
        self.regions.sort_by(|a, b| a.position().partial_cmp(&b.position()).unwrap_or(core::cmp::Ordering::Equal));
    }

    /// Rightmost index whose `position <= position`, or -1 if none (mirrors `floorLastIndex`).
    pub fn floor_last_index(&self, position: f64) -> isize {
        self.regions.partition_point(|region| region.position() <= position) as isize - 1
    }

    /// The region at `index`, or `None` if out of range (mirrors `optAt`). Used with `floor_last_index` to
    /// read the region covering a position.
    pub fn get(&self, index: usize) -> Option<&R> {
        self.regions.get(index)
    }

    /// Iterate the regions overlapping `[from, to)`: start at the region at/before `from` (binary search),
    /// skip it if it already ended (`position + duration <= from`), then yield forward while
    /// `position < to`. Mirrors lib-dsp `RegionCollection.iterateRange`.
    pub fn iterate_range(&self, from: f64, to: f64) -> impl Iterator<Item = &R> {
        let floor = self.floor_last_index(from);
        let mut start = if floor < 0 {0} else {floor as usize};
        if let Some(region) = self.regions.get(start) {
            if region.position() + region.duration() <= from {
                start += 1;
            }
        }
        self.regions.get(start..).unwrap_or(&[]).iter().take_while(move |region| region.position() < to)
    }
}

impl<R: Span> Default for RegionCollection<R> {
    fn default() -> Self {
        Self::new()
    }
}
