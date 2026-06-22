//! Loopable-region math, porting lib-dsp `LoopableRegion.test.ts` (cut-and-move keeps the sample
//! offset via loopOffset) plus multi-cycle, window-clipping, and global_to_local edge cases.

use value::region::{global_to_local, locate_loops, LoopCycle};

const BAR: f64 = 3840.0;

fn cycles(position: f64, complete: f64, loop_offset: f64, loop_duration: f64, from: f64, to: f64) -> Vec<LoopCycle> {
    locate_loops(position, complete, loop_offset, loop_duration, from, to).collect()
}

#[test]
fn split_region_keeps_its_sample_content_offset_via_loop_offset() {
    let result = cycles(6.0 * BAR, 10.0 * BAR, 6.0 * BAR, 16.0 * BAR, 6.0 * BAR, 10.0 * BAR);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].raw_start, 0.0); // position - loopOffset
    assert_eq!(result[0].result_start, 6.0 * BAR);
    assert_eq!(result[0].result_end, 10.0 * BAR);
}

#[test]
fn moved_region_with_position_below_loop_offset_yields_negative_raw_start() {
    let result = cycles(5.0 * BAR, 9.0 * BAR, 6.0 * BAR, 16.0 * BAR, 5.0 * BAR, 9.0 * BAR);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].raw_start, -BAR); // 5*bar - 6*bar
    assert_eq!(result[0].result_start, 5.0 * BAR);
    assert_eq!(result[0].result_end, 9.0 * BAR);
}

#[test]
fn region_moved_to_zero_yields_raw_start_of_negative_loop_offset() {
    let result = cycles(0.0, 4.0 * BAR, 6.0 * BAR, 16.0 * BAR, 0.0, 4.0 * BAR);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].raw_start, -6.0 * BAR);
    assert_eq!(result[0].result_start, 0.0);
}

#[test]
fn a_region_longer_than_its_loop_yields_one_cycle_per_repeat() {
    // 4-bar region looping a 1-bar phrase: four cycles, contiguous, clipped to the region.
    let result = cycles(0.0, 4.0 * BAR, 0.0, BAR, 0.0, 4.0 * BAR);
    assert_eq!(result.len(), 4);
    for (index, cycle) in result.iter().enumerate() {
        assert_eq!(cycle.index, index as i32);
        assert_eq!(cycle.raw_start, index as f64 * BAR);
        assert_eq!(cycle.raw_end, (index as f64 + 1.0) * BAR);
        assert_eq!(cycle.result_start, index as f64 * BAR);
        assert_eq!(cycle.result_end, (index as f64 + 1.0) * BAR);
    }
}

#[test]
fn cycles_are_clipped_to_the_search_window() {
    // window starts mid-cycle-1 and ends mid-cycle-2 -> two partial cycles with fractional values.
    let result = cycles(0.0, 4.0 * BAR, 0.0, BAR, 1.5 * BAR, 2.5 * BAR);
    assert_eq!(result.len(), 2);
    assert_eq!(result[0].raw_start, BAR);
    assert_eq!(result[0].result_start, 1.5 * BAR); // clipped to window start
    assert_eq!(result[0].result_end, 2.0 * BAR);
    assert_eq!(result[0].result_start_value, 0.5); // halfway into the cycle
    assert_eq!(result[1].raw_start, 2.0 * BAR);
    assert_eq!(result[1].result_end, 2.5 * BAR); // clipped to window end
    assert_eq!(result[1].result_end_value, 0.5);
}

#[test]
fn a_window_outside_the_region_yields_no_cycles() {
    let result = cycles(2.0 * BAR, 4.0 * BAR, 0.0, BAR, 0.0, BAR);
    assert!(result.is_empty(), "window [0,bar) ends before the region starts at 2*bar");
}

#[test]
fn global_to_local_wraps_within_the_loop_duration() {
    // region at 0, loop 1 bar from offset 0: positions wrap modulo the bar.
    assert_eq!(global_to_local(0.0, 0.0, 0.0, BAR), 0.0);
    assert_eq!(global_to_local(1.5 * BAR, 0.0, 0.0, BAR), 0.5 * BAR);
    assert_eq!(global_to_local(3.0 * BAR, 0.0, 0.0, BAR), 0.0);
    // a loop offset shifts the local origin.
    assert_eq!(global_to_local(0.0, 0.0, 0.25 * BAR, BAR), 0.25 * BAR);
}

// ---- RegionCollection: sorted-by-position, span-aware binary-search range query (mirrors lib-dsp). ----

use value::region::{RegionCollection, Span};

#[derive(Clone, Copy, PartialEq, Debug)]
struct TestRegion {
    id: u32,
    position: f64,
    duration: f64
}

impl Span for TestRegion {
    fn position(&self) -> f64 { self.position }
    fn duration(&self) -> f64 { self.duration }
}

fn region(id: u32, position: f64, duration: f64) -> TestRegion {
    TestRegion {id, position, duration}
}

fn ids(collection: &RegionCollection<TestRegion>, from: f64, to: f64) -> Vec<u32> {
    collection.iterate_range(from, to).map(|region| region.id).collect()
}

#[test]
fn add_keeps_regions_sorted_by_position() {
    let mut collection = RegionCollection::new();
    collection.add(region(2, 200.0, 100.0));
    collection.add(region(0, 0.0, 100.0));
    collection.add(region(1, 100.0, 100.0));
    // the whole timeline, in position order regardless of insert order
    assert_eq!(ids(&collection, 0.0, 1000.0), vec![0, 1, 2]);
}

#[test]
fn iterate_range_yields_only_overlapping_regions() {
    let mut collection = RegionCollection::new();
    collection.add(region(0, 0.0, 100.0));   // [0, 100)
    collection.add(region(1, 100.0, 100.0)); // [100, 200)
    collection.add(region(2, 200.0, 100.0)); // [200, 300)
    // a window inside region 1 only
    assert_eq!(ids(&collection, 120.0, 180.0), vec![1]);
    // a window spanning the 1/2 boundary
    assert_eq!(ids(&collection, 180.0, 220.0), vec![1, 2]);
    // a window before everything
    assert!(ids(&collection, -50.0, -10.0).is_empty());
}

#[test]
fn iterate_range_skips_a_region_that_already_ended() {
    let mut collection = RegionCollection::new();
    collection.add(region(0, 0.0, 100.0));   // ends at 100
    collection.add(region(1, 300.0, 100.0)); // [300, 400)
    // [150, 350): region 0 (the one at/before `from`) ended at 100 -> skipped; region 1 overlaps.
    assert_eq!(ids(&collection, 150.0, 350.0), vec![1]);
}

#[test]
fn iterate_range_includes_a_long_region_still_active_at_from() {
    let mut collection = RegionCollection::new();
    collection.add(region(0, 0.0, 1000.0)); // [0, 1000): starts before `from`, still active
    // the region at/before `from` is still playing, so it must be included
    assert_eq!(ids(&collection, 400.0, 500.0), vec![0]);
}

#[test]
fn moving_a_region_then_resorting_reorders_it() {
    let mut collection = RegionCollection::new();
    collection.add(region(0, 0.0, 100.0));
    collection.add(region(1, 100.0, 100.0));
    collection.add(region(2, 200.0, 100.0));
    // Move region 0 to the end (position 500) and re-sort, as the engine does on a position edit.
    for r in collection.iter_mut() {
        if r.id == 0 { r.position = 500.0; }
    }
    collection.resort();
    assert_eq!(ids(&collection, 0.0, 1000.0), vec![1, 2, 0], "the moved region is now last");
    // and a window now finds it at its new place, not its old one
    assert_eq!(ids(&collection, 510.0, 560.0), vec![0]);
    assert!(ids(&collection, 10.0, 60.0).is_empty(), "nothing remains at the old position");
}
