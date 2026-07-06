//! Transport over a 128-sample render quantum. `process_quantum` is the fixed-bpm fast path (one
//! block); `render_quantum` is the block loop: it splits the quantum at the nearest action — a
//! marker jump (the marker track's section repeats), the loop-area end, or a tempo-change grid
//! (where a `ValueEvent` bpm map changes the bpm). At a loop end or a marker jump it emits the
//! partial block, jumps the position back (loop start / section start), re-evaluates the bpm there
//! (the discontinuity), and keeps filling the quantum, so a wrap is sample-accurate with no gap.
//! Mirrors core-processors `BlockRenderer`, including its action precedence: markers are evaluated
//! first, the loop takes over only when strictly earlier, tempo only when strictly earlier than both.

use engine_env::ppqn::{pulses_to_samples, samples_to_pulses};
use value::event::EventCollection;
use value::value::{value_at, ValueEvent};

pub const RENDER_QUANTUM: usize = 128;

/// Tempo is re-evaluated on this pulse grid (`PPQN.fromSignature(1, 48)` = 80, a ~10 ms window).
pub const TEMPO_CHANGE_GRID: f64 = 80.0;

fn quantize_ceil(position: f64, grid: f64) -> f64 {
    let floored = (position / grid) as i64 as f64;
    if floored * grid < position {
        (floored + 1.0) * grid
    } else {
        floored * grid
    }
}

/// A processed slice of one quantum: pulse range `[p0, p1)` over sample range `[s0, s1)` at `bpm`.
/// `discontinuous` is true for the first block after a position jump (a loop wrap), the Rust analog
/// of the TS `BlockFlag.discontinuous`, so consumers can release state held across the jump.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Block {
    pub p0: f64,
    pub p1: f64,
    pub s0: usize,
    pub s1: usize,
    pub bpm: f32,
    pub discontinuous: bool,
}

/// A timeline marker (the `MarkerBox` essentials): a section start plus how often the section plays
/// before playback falls through to the next marker (`plays == 0` = forever, the TS `plays === 0`
/// branch). Passed per quantum as a position-sorted slice, so the crate stays zero-alloc like the
/// tempo events.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Marker {
    pub uuid: [u8; 16],
    pub position: f64,
    pub plays: i32,
}

/// The last marker index at or before `position` (TS `EventCollection.floorLastIndex`), -1 when all
/// markers are in the future.
fn floor_last_index(markers: &[Marker], position: f64) -> isize {
    markers.partition_point(|marker| marker.position <= position) as isize - 1
}

/// The nearest event that splits a sub-block: a marker boundary (the index into the marker slice the
/// action was evaluated from), a bpm change at a tempo grid, or the loop-area end.
enum Action {
    None,
    Marker(usize),
    Tempo(f32),
    Loop,
}

pub struct Transport {
    position: f64,     // pulses (ppqn) — f64 for sample-accuracy over a long timeline
    free_running: f64, // pulses — tracks `position` while playing, then free-runs (advances) while paused, so
                       // the paused quantum still has a real advancing range (mirrors TS `#freeRunningPosition`)
    bpm: f32,          // the live (effective) bpm: the nominal bpm, or the tempo map's value while automating
    nominal_bpm: f32,  // the configured bpm (TimelineBox.bpm); the live bpm when no tempo automation drives it
    sample_rate: f32,
    playing: bool,
    leap: bool, // a position JUMP happened (seek / stop-rewind); the next quantum's first block flags discontinuous (TS `TimeInfo.#leap`)
    loop_enabled: bool,
    loop_from: f64, // pulses
    loop_to: f64,   // pulses
    current_marker: Option<([u8; 16], i32)>, // the active marker + its plays SO FAR (TS `#currentMarker: [adapter, int]`)
    markers_dirty: bool, // the marker set was edited (TS `#someMarkersChanged`); the next block re-resolves the active marker
    marker_changed: bool, // the active marker state changed this quantum; the engine drains it into a switchMarkerState notification
}

impl Transport {
    pub fn new(sample_rate: f32, bpm: f32) -> Self {
        Self {position: 0.0, free_running: 0.0, bpm, nominal_bpm: bpm, sample_rate, playing: false, leap: false, loop_enabled: false, loop_from: 0.0, loop_to: 0.0,
            current_marker: None, markers_dirty: false, marker_changed: false}
    }

    pub fn position(&self) -> f64 {self.position}
    pub fn bpm(&self) -> f32 {self.bpm}
    pub fn sample_rate(&self) -> f32 {self.sample_rate}
    pub fn is_playing(&self) -> bool {self.playing}

    /// Set the configured tempo (TimelineBox.bpm). It becomes the live bpm immediately and the fallback
    /// the tempo map is evaluated against; while automating, the map overrides the live bpm per block.
    pub fn set_bpm(&mut self, bpm: f32) {self.bpm = bpm; self.nominal_bpm = bpm}
    pub fn set_loop_enabled(&mut self, enabled: bool) {self.loop_enabled = enabled}
    pub fn set_loop_from(&mut self, from: f64) {self.loop_from = from}
    pub fn set_loop_to(&mut self, to: f64) {self.loop_to = to}
    pub fn play(&mut self) {self.playing = true}

    /// The marker collection was edited (TS `markerTrack.subscribe` -> `#someMarkersChanged`): the next
    /// rendered block re-resolves the active marker at its start position.
    pub fn notify_markers_changed(&mut self) {self.markers_dirty = true}

    /// The active marker + its plays so far (the payload of TS `switchMarkerState([uuid, count])`).
    pub fn current_marker(&self) -> Option<([u8; 16], i32)> {self.current_marker}

    /// True when the active marker state changed during the last rendered quantum; reading resets the
    /// flag (TS notifies `switchMarkerState` once per `process` when `markerChanged` was raised).
    pub fn take_marker_changed(&mut self) -> bool {core::mem::replace(&mut self.marker_changed, false)}

    /// Forget the active marker (TS `BlockRenderer.reset`, run by the engine's STOP path). Silent by
    /// design: TS emits no `switchMarkerState` from `reset` either.
    pub fn reset_marker_state(&mut self) {
        self.current_marker = None;
        self.markers_dirty = false;
        self.marker_changed = false;
    }

    pub fn stop(&mut self, reset: bool) {
        self.playing = false;
        if reset {
            self.position = 0.0;
            self.free_running = 0.0;
            self.leap = true;
        }
    }

    pub fn seek(&mut self, position: f64) {
        self.position = position;
        self.free_running = position;
        self.leap = true; // the next quantum's first block flags discontinuous (TS sets `#leap` on any position set)
    }

    /// Build the free-running block for a PAUSED quantum: `position` stays frozen, but the pulse range
    /// keeps advancing (a real quantum length) so the graph renders one more block — active voices flush
    /// to release and effect tails ring out, while the NON-playing flags stop the sequencer reading new
    /// notes. Mirrors the `else` (not-transporting) branch of TS `BlockRenderer.process`, including its
    /// marker re-resolution: a seek or a marker edit while paused updates the active marker at the frozen
    /// `position` — only towards a FOUND marker (TS never clears to null here). Deviation: TS consumes the
    /// leap flag here; this transport keeps it so the first PLAYING block after a paused seek still flags
    /// discontinuous (the established seek semantics), re-resolving idempotently until then.
    pub fn render_paused(&mut self, markers: &[Marker]) -> Block {
        if self.markers_dirty || self.leap {
            self.markers_dirty = false;
            let index = floor_last_index(markers, self.position);
            if index >= 0 {
                let marker = markers[index as usize];
                if self.current_marker.map(|(uuid, _)| uuid) != Some(marker.uuid) {
                    self.current_marker = Some((marker.uuid, 0));
                    self.marker_changed = true;
                }
            }
        }
        let p0 = self.free_running;
        let p1 = p0 + samples_to_pulses(RENDER_QUANTUM as f64, self.bpm, self.sample_rate);
        self.free_running = p1;
        Block {p0, p1, s0: 0, s1: RENDER_QUANTUM, bpm: self.bpm, discontinuous: false}
    }

    /// Advance one 128-sample quantum and return its block. Fixed bpm with no events → exactly one
    /// block spanning the whole quantum (the no-event path of the TS block loop). The per-quantum
    /// accumulation matches TS's `timeInfo.advanceTo` step-by-step.
    pub fn process_quantum(&mut self) -> Block {
        let p0 = self.position;
        let p1 = p0 + samples_to_pulses(RENDER_QUANTUM as f64, self.bpm, self.sample_rate);
        self.position = p1;
        Block {p0, p1, s0: 0, s1: RENDER_QUANTUM, bpm: self.bpm, discontinuous: false}
    }

    /// Render one quantum into `emit`, splitting at the nearest action: a marker boundary (when the
    /// marker track is enabled), the loop-area end, or a tempo-grid bpm change from `tempo` (a bpm
    /// value map). With no events, no markers and no loop this emits a single fixed-bpm block.
    /// Advances the position and updates the live bpm. Slice/callback-based so the crate stays
    /// zero-alloc / no_std; `markers` must be sorted by position. The block after a loop wrap or a
    /// marker jump carries `discontinuous = true` so sequencers can release notes held across the jump.
    pub fn render_quantum<F: FnMut(&Block)>(&mut self, tempo: Option<&EventCollection<ValueEvent>>,
                                            markers: &[Marker], markers_enabled: bool, mut emit: F) {
        if !self.playing {
            return;
        }
        let mut p0 = self.position;
        let mut s0: usize = 0;
        let mut discontinuous = core::mem::replace(&mut self.leap, false);
        self.eval_tempo(tempo, p0);
        while s0 < RENDER_QUANTUM {
            // Re-resolve the active marker after a jump / seek or a marker edit (TS runs this at the top
            // of its block loop, REGARDLESS of the track's enabled flag): the marker at or before `p0`,
            // plays reset to 0. `discontinuous` stays raised for the marker check until a block consumed it.
            if self.markers_dirty || discontinuous {
                self.markers_dirty = false;
                let index = floor_last_index(markers, p0);
                let marker = if index >= 0 {Some(markers[index as usize])} else {None};
                if self.current_marker.map(|(uuid, _)| uuid) != marker.map(|marker| marker.uuid) {
                    self.current_marker = marker.map(|marker| (marker.uuid, 0));
                    self.marker_changed = true;
                }
            }
            let sn = RENDER_QUANTUM - s0;
            let p1 = p0 + samples_to_pulses(sn as f64, self.bpm, self.sample_rate);
            let mut action_position = f64::INFINITY;
            let mut action = Action::None;
            // --- MARKER --- (TS evaluates markers FIRST; later actions only take over when strictly earlier)
            if markers_enabled {
                let floor = floor_last_index(markers, p0);
                let start = if floor < 0 {0usize} else {floor as usize};
                if let Some(prev) = markers.get(start) {
                    match self.current_marker {
                        // This branch happens if all markers are in the future (TS `#currentMarker === null`)
                        None => {
                            if prev.position >= p0 && prev.position < p1 {
                                action_position = prev.position;
                                action = Action::Marker(start);
                            }
                        }
                        Some((current_uuid, _)) => {
                            if let Some(next) = markers.get(start + 1) {
                                if next.uuid != current_uuid // must be different from the current
                                    && prev.position < p0    // must be in the past
                                    && next.position < p1    // must be inside the block
                                {
                                    action_position = next.position;
                                    action = Action::Marker(start);
                                }
                            }
                        }
                    }
                }
            }
            // --- LOOP SECTION --- Markers win ties (TS: `loopTo < actionPosition`, strict). Against the
            // block end the loop keeps `<=` (deviation from TS's `p1 > loopTo`): a quantum boundary can
            // land EXACTLY on `loop_to` here (the pulse math is exact for round rates), and emitting the
            // full block would advance `p0` onto `loop_to`, so the wrap (`p0 < loop_to`) would never fire.
            if self.loop_enabled
                && self.loop_from < self.loop_to
                && p0 < self.loop_to
                && self.loop_to <= p1
                && self.loop_to < action_position
            {
                action_position = self.loop_to;
                action = Action::Loop;
            }
            // --- TEMPO AUTOMATION --- evaluated LAST, strictly-earlier only (TS order): the loop keeps
            // winning the grid-on-loop-end tie (applying the tempo change there would advance the position
            // onto `loop_to` and the wrap would never fire; bpm is re-evaluated at the loop start anyway).
            if let Some(events) = tempo {
                if !events.is_empty() {
                    let next_grid = quantize_ceil(p0, TEMPO_CHANGE_GRID);
                    if next_grid >= p0 && next_grid < p1 && next_grid < action_position {
                        let tempo_at = value_at(events, next_grid, self.bpm);
                        if tempo_at != self.bpm {
                            action_position = next_grid;
                            action = Action::Tempo(tempo_at);
                        }
                    }
                }
            }
            match action {
                Action::None => {
                    let s1 = s0 + sn;
                    emit(&Block {p0, p1, s0, s1, bpm: self.bpm, discontinuous});
                    discontinuous = false;
                    p0 = p1;
                    s0 = s1;
                }
                Action::Marker(start) => {
                    let prev = markers[start];
                    match self.current_marker {
                        Some((current_uuid, count)) if current_uuid == prev.uuid => {
                            // TS `++this.#currentMarker[1] < prev.plays || prev.plays === 0`
                            let count = count + 1;
                            if count < prev.plays || prev.plays == 0 {
                                // repeat the section: split at the boundary, jump back to its start
                                self.current_marker = Some((prev.uuid, count));
                                s0 = self.emit_until(action_position, p0, s0, discontinuous, &mut emit);
                                p0 = prev.position;
                                self.eval_tempo(tempo, p0);
                                discontinuous = true;
                            } else {
                                // plays exhausted: fall through into the next section, NO split / jump
                                self.current_marker = Some((markers[start + 1].uuid, 0));
                            }
                        }
                        // just entered `prev`'s section (TS: currentMarker null or a different marker)
                        _ => self.current_marker = Some((prev.uuid, 0))
                    }
                    self.marker_changed = true;
                }
                Action::Tempo(new_bpm) => {
                    let s1 = self.emit_until(action_position, p0, s0, discontinuous, &mut emit);
                    if s1 > s0 {
                        discontinuous = false; // a real block carried the flag; later blocks are continuous
                    }
                    s0 = s1;
                    p0 = action_position;
                    self.bpm = new_bpm;
                }
                Action::Loop => {
                    // the partial block up to the loop end carries the current flag; the next block,
                    // resuming at the loop start, is the discontinuity.
                    s0 = self.emit_until(action_position, p0, s0, discontinuous, &mut emit);
                    p0 = self.loop_from;
                    self.eval_tempo(tempo, p0);
                    discontinuous = true;
                }
            }
        }
        self.position = p0;
        self.free_running = p0;
    }

    /// Emit the block from `p0` to `action_position` (if it spans any samples) and return the new
    /// sample cursor. Shared by the tempo-change and loop-wrap splits.
    fn emit_until<F: FnMut(&Block)>(&self, action_position: f64, p0: f64, s0: usize, discontinuous: bool, emit: &mut F) -> usize {
        let s1 = s0 + pulses_to_samples(action_position - p0, self.bpm, self.sample_rate) as i64 as usize;
        if s1 > s0 {
            emit(&Block {p0, p1: action_position, s0, s1, bpm: self.bpm, discontinuous});
        }
        s1
    }

    /// Set the live bpm at `position`: the tempo map's value when automating (falling back to the
    /// nominal bpm), otherwise the nominal bpm itself. So with no tempo map the live bpm is always the
    /// configured `TimelineBox.bpm`, with no stale value left over from a previous automated pass.
    fn eval_tempo(&mut self, tempo: Option<&EventCollection<ValueEvent>>, position: f64) {
        self.bpm = match tempo {
            Some(events) if !events.is_empty() => value_at(events, position, self.nominal_bpm),
            _ => self.nominal_bpm
        };
    }
}
