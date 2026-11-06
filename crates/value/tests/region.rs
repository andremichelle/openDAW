//! Loopable-region math, porting lib-dsp `LoopableRegion.test.ts` (cut-and-move keeps the sample
//! offset via loopOffset) plus multi-cycle, window-clipping, and global_to_local edge cases.

use value::region::{global_to_local, locate_grooved_loops, locate_loops, GroovedPass, LoopCycle};

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

#[test]
fn a_zero_loop_duration_yields_nothing_instead_of_hanging() {
    // A 0-duration loop (field unset / degenerate region) drove raw_start to NaN, and `NaN >= seek_max`
    // never terminated the iterator: an audio-thread hang. It must yield no cycles at all.
    assert!(cycles(0.0, 4.0 * BAR, 0.0, 0.0, 0.0, 4.0 * BAR).is_empty());
    assert!(cycles(0.0, 4.0 * BAR, 0.0, -1.0, 0.0, 4.0 * BAR).is_empty());
    assert!(cycles(0.0, 4.0 * BAR, 0.0, f64::NAN, 0.0, 4.0 * BAR).is_empty());
}

// Live 1140 layout: a long region reaching over later ones. Documents what the engine actually plays.
#[test]
fn a_long_region_under_later_regions_is_found_only_until_the_next_one_starts() {
    let mut collection = RegionCollection::new();
    collection.add(region(0, 0.0, 1000.0));  // [0, 1000) reaches over both below
    collection.add(region(1, 100.0, 100.0)); // [100, 200)
    collection.add(region(2, 300.0, 100.0)); // [300, 400)
    assert_eq!(ids(&collection, 10.0, 20.0), vec![0], "alone before the next region starts");
    assert_eq!(ids(&collection, 90.0, 110.0), vec![0, 1], "both in the block where the next one starts");
    assert_eq!(ids(&collection, 120.0, 180.0), vec![1], "gone once the next one has started");
    assert_eq!(ids(&collection, 220.0, 280.0), Vec::<u32>::new(), "and it does not come back in the gap");
    assert_eq!(ids(&collection, 500.0, 600.0), Vec::<u32>::new(), "nor after the last region");
}

#[allow(clippy::too_many_arguments)]
fn passes(position: f64, complete: f64, loop_offset: f64, loop_duration: f64, from: f64, to: f64,
          warp: impl Fn(f64) -> f64, unwarp: impl Fn(f64) -> f64) -> Vec<GroovedPass> {
    locate_grooved_loops(position, complete, loop_offset, loop_duration, from, to, warp, unwarp).collect()
}

fn pass(raw_start: f64, content_start: f64, content_end: f64, result_start: f64, result_end: f64) -> GroovedPass {
    GroovedPass {raw_start, content_start, content_end, result_start, result_end}
}

// a swing on eighth notes: the second eighth of every quarter starts 120 later
const QUARTER: f64 = 960.0;
fn swing(position: f64) -> f64 {
    let base = (position / QUARTER).floor() * QUARTER;
    let local = position - base;
    base + if local < 480.0 {local * 600.0 / 480.0} else {600.0 + (local - 480.0) * 360.0 / 480.0}
}
fn unswing(position: f64) -> f64 {
    let base = (position / QUARTER).floor() * QUARTER;
    let local = position - base;
    base + if local < 600.0 {local * 480.0 / 600.0} else {480.0 + (local - 600.0) * 480.0 / 360.0}
}

#[test]
fn without_a_groove_the_passes_are_the_loop_cycles() {
    let configs = [
        (0.0, 4.0 * BAR, 0.0, BAR), (6.0 * BAR, 10.0 * BAR, 6.0 * BAR, 16.0 * BAR), (5.0 * BAR, 9.0 * BAR, 6.0 * BAR, 16.0 * BAR),
        (100.0, 3000.0, 250.0, 700.0), (0.0, f64::INFINITY, 0.0, 1920.0)];
    let windows = [(0.0, 128.0), (90.0, 2000.0), (3500.0, 4100.0), (6.0 * BAR, 7.5 * BAR), (0.0, 40.0 * BAR)];
    for (position, complete, loop_offset, loop_duration) in configs {
        for (from, to) in windows {
            let expected: Vec<GroovedPass> = cycles(position, complete, loop_offset, loop_duration, from, to).iter()
                .filter(|cycle| cycle.result_start < cycle.result_end)
                .map(|cycle| pass(cycle.raw_start, cycle.result_start - cycle.raw_start, cycle.result_end - cycle.raw_start,
                    cycle.result_start, cycle.result_end)).collect();
            assert_eq!(passes(position, complete, loop_offset, loop_duration, from, to, |x| x, |x| x), expected,
                "region {position} {complete} {loop_offset} {loop_duration} window {from} {to}");
        }
    }
}

#[test]
fn an_offset_groove_reads_the_content_later_and_leaves_the_region_start_silent() {
    let late = |x: f64| x + 240.0;
    let early = |x: f64| x - 240.0;
    // a one bar region, the content starts sounding 240 after the region start
    assert_eq!(passes(0.0, BAR, 0.0, BAR, 0.0, 128.0, late, early), vec![]);
    assert_eq!(passes(0.0, BAR, 0.0, BAR, 0.0, 480.0, late, early), vec![pass(0.0, 0.0, 240.0, 240.0, 480.0)]);
    // the last 240 of the content would sound past the region end and is not played
    assert_eq!(passes(0.0, BAR, 0.0, BAR, 3000.0, BAR, late, early), vec![pass(0.0, 2760.0, 3600.0, 3000.0, BAR)]);
}

#[test]
fn an_early_groove_leaves_the_region_end_silent() {
    let early = |x: f64| x - 240.0;
    let late = |x: f64| x + 240.0;
    // the content's first 240 would sound before the region start
    assert_eq!(passes(0.0, BAR, 0.0, BAR, 0.0, 480.0, early, late), vec![pass(0.0, 240.0, 720.0, 0.0, 480.0)]);
    // the content ends 240 before the region end
    assert_eq!(passes(0.0, BAR, 0.0, BAR, 3000.0, BAR, early, late), vec![pass(0.0, 3240.0, BAR, 3000.0, 3600.0)]);
}

#[test]
fn the_groove_runs_on_across_loop_passes() {
    let late = |x: f64| x + 100.0;
    let early = |x: f64| x - 100.0;
    // a 1000 loop played four times: every wrap happens 100 later than the straight pass boundary
    let result = passes(0.0, 4000.0, 0.0, 1000.0, 900.0, 1200.0, late, early);
    assert_eq!(result, vec![pass(0.0, 800.0, 1000.0, 900.0, 1100.0), pass(1000.0, 0.0, 100.0, 1100.0, 1200.0)]);
}

#[test]
fn the_groove_starts_where_the_loop_starts() {
    let late = |x: f64| x + 100.0;
    let early = |x: f64| x - 100.0;
    // a region cut at 2 bars into its content: the content keeps its grooved timing
    let result = passes(2.0 * BAR, 3.0 * BAR, 2.0 * BAR, 4.0 * BAR, 2.0 * BAR, 2.0 * BAR + 300.0, late, early);
    assert_eq!(result, vec![pass(0.0, 2.0 * BAR, 2.0 * BAR + 200.0, 2.0 * BAR + 100.0, 2.0 * BAR + 300.0)]);
}

#[test]
fn a_swing_moves_the_second_eighth() {
    let result = passes(0.0, BAR, 0.0, BAR, 0.0, QUARTER, swing, unswing);
    assert_eq!(result, vec![pass(0.0, 0.0, QUARTER, 0.0, QUARTER)]);
    // the second eighth sounds from 600 on
    let result = passes(0.0, BAR, 0.0, BAR, 600.0, QUARTER, swing, unswing);
    assert_eq!(result, vec![pass(0.0, 480.0, QUARTER, 600.0, QUARTER)]);
    // a loop of one quarter wraps at the grooved boundary, which a swing leaves in place
    let result = passes(0.0, BAR, 0.0, QUARTER, 900.0, 1100.0, swing, unswing);
    assert_eq!(result.len(), 2);
    assert_eq!((result[0].result_end, result[1].result_start), (QUARTER, QUARTER));
    assert!((result[1].content_end - unswing(140.0)).abs() < 1e-9);
}

#[test]
fn a_clip_runs_the_groove_on_the_timeline_grid() {
    let late = |x: f64| x + 100.0;
    let early = |x: f64| x - 100.0;
    let result = passes(0.0, f64::INFINITY, 0.0, 1920.0, 5.0 * 1920.0 + 50.0, 5.0 * 1920.0 + 150.0, late, early);
    assert_eq!(result, vec![pass(4.0 * 1920.0, 1870.0, 1920.0, 9650.0, 9700.0), pass(5.0 * 1920.0, 0.0, 50.0, 9700.0, 9750.0)]);
}

#[test]
fn a_degenerate_loop_or_window_yields_nothing() {
    assert!(passes(0.0, BAR, 0.0, 0.0, 0.0, BAR, |x| x, |x| x).is_empty());
    assert!(passes(0.0, BAR, 0.0, f64::NAN, 0.0, BAR, |x| x, |x| x).is_empty());
    assert!(passes(0.0, BAR, 0.0, BAR, 500.0, 500.0, |x| x, |x| x).is_empty());
    assert!(passes(0.0, BAR, 0.0, BAR, BAR, 2.0 * BAR, |x| x, |x| x).is_empty());
}
