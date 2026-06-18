//! Loopable-region math, mirroring lib-dsp `LoopableRegion`. A region spans `[position, complete)` on
//! the global timeline and loops content of length `loop_duration` beginning at `loop_offset`.
//! `locate_loops` yields the loop cycles overlapping a global `[from, to)` window; each cycle exposes
//! its raw span (the full, unclipped loop cycle), its span clipped to the region, and its span clipped
//! to the search window, plus the unit fractions where the result span starts/ends within the cycle.
//!
//! Returned as a lazy iterator (no per-block allocation): the sequencer queries it every render block.

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
        if self.raw_start >= self.seek_max {
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
