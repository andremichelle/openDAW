//! The clip-launch state machine (TS `ClipSequencingAudioContext`): per TRACK a `waiting` slot (a
//! scheduled clip, or a scheduled stop) and a `playing` slot. `iterate` splits a block's pulse range
//! into SECTIONS at the quantized handover point (the playing clip's duration, else one bar), swapping
//! `waiting` into `playing` there; a non-looping clip stops itself at its own duration boundary. Every
//! start / stop / obsolete transition queues the clip uuid for the UI back-channel (`take_changes`).
//!
//! The sequencer stores only clip UUIDS — the caller resolves duration / loop LIVE through `ClipInfo`
//! (the reactive binding), so a clip edit while scheduled or playing stays fresh, like the TS adapters.

use alloc::vec::Vec;
use math::floor;

/// A box uuid (`UUID.Bytes`).
pub type ClipKey = [u8; 16];
pub type TrackKey = [u8; 16];

/// TS `PPQN.Bar` — the schedule quantum when no clip is playing on the track yet.
const BAR: f64 = 3_840.0;

/// Resolve a clip's `(duration, looped)` from the live binding; `None` for a vanished clip.
pub trait ClipInfo {
    fn resolve(&self, clip: &ClipKey) -> Option<(f64, bool)>;
}

/// One section of a block's pulse range on one track: play `clip` (or the timeline regions when `None`)
/// for `[from, to)`. (TS `Section`.)
pub struct Section {
    pub clip: Option<ClipKey>,
    pub from: f64,
    pub to: f64
}

struct TrackState {
    uuid: TrackKey,
    // TS `Option<Option<clip>>`: `None` = nothing scheduled, `Some(None)` = a scheduled STOP,
    // `Some(Some(clip))` = a scheduled clip.
    waiting: Option<Option<ClipKey>>,
    playing: Option<ClipKey>,
    // The last computed block range + its sections: a REPLAY CACHE. Unlike TS (one sequencer per unit),
    // several sequencers can pull the same track per block (composite slots), so a repeated `iterate`
    // over the same range must replay without re-advancing the state machine.
    cached_range: Option<(f64, f64)>,
    cached_sections: [Option<(Option<ClipKey>, f64, f64)>; 3],
    shared: SharedRead
}

type CachedSections = [Option<(Option<ClipKey>, f64, f64)>; 3];

const SHARED_BLOCKS: usize = 8;
const SHARED_TRANSITIONS: usize = 8;
const SHARED_POINTS: usize = SHARED_TRANSITIONS + 4;

#[derive(Clone, Copy)]
struct Transition {
    position: f64,
    before: Option<ClipKey>
}

// What `advance` records for the pure `sections_shared` readers: the canonical blocks (exact replay), the
// clip handovers behind `cursor` (positions ascend, a discontinuity clears them) and how far it advanced.
#[derive(Clone, Copy)]
struct SharedRead {
    blocks: [Option<(f64, f64, CachedSections)>; SHARED_BLOCKS],
    block_write: usize,
    transitions: [Option<Transition>; SHARED_TRANSITIONS],
    cursor: Option<f64>
}

impl SharedRead {
    const fn new() -> Self {
        Self {blocks: [None; SHARED_BLOCKS], block_write: 0, transitions: [None; SHARED_TRANSITIONS], cursor: None}
    }

    fn push_block(&mut self, p0: f64, p1: f64, sections: CachedSections) {
        self.blocks[self.block_write] = Some((p0, p1, sections));
        self.block_write = (self.block_write + 1) % SHARED_BLOCKS;
    }

    fn find_block(&self, p0: f64, p1: f64) -> Option<&CachedSections> {
        (1..=SHARED_BLOCKS)
            .filter_map(|age| self.blocks[(self.block_write + SHARED_BLOCKS - age) % SHARED_BLOCKS].as_ref())
            .find(|(from, to, _)| *from == p0 && *to == p1)
            .map(|(_, _, sections)| sections)
    }

    fn push_transition(&mut self, transition: Transition) {
        if self.transitions[SHARED_TRANSITIONS - 1].is_some() {
            self.transitions.copy_within(1.., 0);
            self.transitions[SHARED_TRANSITIONS - 1] = None;
        }
        if let Some(slot) = self.transitions.iter_mut().find(|slot| slot.is_none()) {
            *slot = Some(transition);
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Change {
    Started,
    Stopped,
    Obsolete
}

fn quantize_floor(value: f64, interval: f64) -> f64 {
    floor(value / interval) * interval
}

pub struct ClipSequencer {
    states: Vec<TrackState>,
    changes: Vec<(ClipKey, Change)>
}

impl Default for ClipSequencer {
    fn default() -> Self {
        Self::new()
    }
}

impl ClipSequencer {
    pub fn new() -> Self {
        Self {states: Vec::new(), changes: Vec::with_capacity(16)}
    }

    /// Schedule `clip` on `track` (TS `schedulePlay`): replaces a previously waiting clip (reported
    /// OBSOLETE); a clip already playing on its track is ignored. Called off-render.
    pub fn schedule_play(&mut self, track: TrackKey, clip: ClipKey) {
        let changes = &mut self.changes;
        let state = Self::state(&mut self.states, track);
        if state.playing.as_ref() == Some(&clip) {
            return;
        }
        if let Some(Some(waiting)) = state.waiting.take() {
            changes.push((waiting, Change::Obsolete));
        }
        changes.retain(|(key, change)| !(*change == Change::Obsolete && key == &clip));
        state.waiting = Some(Some(clip));
    }

    /// Schedule a STOP on `track` (TS `scheduleStop`): obsoletes a waiting clip; arms the stop only
    /// when something is playing. Called off-render.
    pub fn schedule_stop(&mut self, track: TrackKey) {
        let changes = &mut self.changes;
        let state = Self::state(&mut self.states, track);
        if let Some(Some(waiting)) = state.waiting.take() {
            changes.push((waiting, Change::Obsolete));
        }
        if state.playing.is_some() {
            state.waiting = Some(None);
        }
    }

    /// A transport stop / engine reset (TS `reset`): waiting clips become OBSOLETE, playing clips STOP.
    pub fn reset(&mut self) {
        for state in &mut self.states {
            if let Some(Some(waiting)) = state.waiting.take() {
                self.changes.push((waiting, Change::Obsolete));
            }
            if let Some(playing) = state.playing.take() {
                self.changes.push((playing, Change::Stopped));
            }
        }
        self.states.clear();
    }

    /// A deleted box (clip or track) leaves the machine (TS delete handling): a playing clip stops,
    /// a waiting one is dropped silently, a deleted track drops its whole state.
    pub fn forget(&mut self, uuid: &[u8; 16]) {
        let changes = &mut self.changes;
        self.states.retain_mut(|state| {
            if &state.uuid == uuid {
                if let Some(playing) = state.playing.take() {
                    changes.push((playing, Change::Stopped));
                }
                return false;
            }
            if state.playing.as_ref() == Some(uuid) {
                state.playing = None;
                state.cached_range = None;
                state.shared = SharedRead::new();
                changes.push((*uuid, Change::Stopped));
            }
            if matches!(state.waiting.as_ref(), Some(Some(waiting)) if waiting == uuid) {
                state.waiting = None;
                state.cached_range = None;
                state.shared = SharedRead::new();
            }
            true
        });
    }

    /// Split `[p0, p1)` on `track` into play sections (TS `iterate`), advancing the state machine at
    /// the quantized handover. `info` resolves a clip's live `(duration, looped)`; a vanished clip
    /// plays nothing but still transitions. Runs per block, per track, in-render (no allocation
    /// beyond the change queue's reserve). Repeat calls for the SAME range replay the cached sections
    /// without re-advancing (several sequencers can pull one track per block).
    pub fn iterate(&mut self, track: &TrackKey, p0: f64, p1: f64, info: &dyn ClipInfo,
                   visit: &mut dyn FnMut(Section)) {
        let changes = &mut self.changes;
        let Some(state) = self.states.iter_mut().find(|state| &state.uuid == track) else {
            visit(Section {clip: None, from: p0, to: p1});
            return;
        };
        if state.cached_range == Some((p0, p1)) {
            for cached in state.cached_sections.iter().flatten() {
                let (clip, from, to) = *cached;
                visit(Section {clip, from, to});
            }
            return;
        }
        let mut sections: [Option<(Option<ClipKey>, f64, f64)>; 3] = [None; 3];
        let mut count = 0;
        let mut visit = |section: Section| {
            if count < sections.len() {
                sections[count] = Some((section.clip, section.from, section.to));
                count += 1;
            }
            visit(section);
        };
        let visit = &mut visit;
        if let Some(next) = state.waiting.clone() {
            let schedule_duration = state.playing
                .and_then(|playing| info.resolve(&playing))
                .map_or(BAR, |(duration, _)| duration);
            let schedule_end = quantize_floor(p1, schedule_duration);
            if schedule_end >= p0 {
                if p0 < schedule_end {
                    visit(Section {clip: state.playing, from: p0, to: schedule_end});
                }
                state.waiting = None;
                if let Some(playing) = state.playing.take() {
                    changes.push((playing, Change::Stopped));
                }
                if let Some(clip) = next {
                    state.playing = Some(clip);
                    changes.push((clip, Change::Started));
                }
                visit(Section {clip: state.playing, from: schedule_end, to: p1});
            } else {
                visit(Section {clip: state.playing, from: p0, to: p1});
            }
        } else if let Some(playing) = state.playing {
            let (duration, looped) = match info.resolve(&playing) {
                Some(resolved) => resolved,
                None => (BAR, true) // vanished mid-play: `forget` cleans up off-render
            };
            if looped {
                visit(Section {clip: state.playing, from: p0, to: p1});
            } else {
                let schedule_end = quantize_floor(p0, duration) + duration;
                if schedule_end <= p1 {
                    visit(Section {clip: state.playing, from: p0, to: schedule_end});
                    state.playing = None;
                    changes.push((playing, Change::Stopped));
                    if schedule_end < p1 {
                        visit(Section {clip: None, from: schedule_end, to: p1});
                    }
                } else {
                    visit(Section {clip: state.playing, from: p0, to: p1});
                }
            }
        } else {
            visit(Section {clip: None, from: p0, to: p1});
        }
        state.cached_range = Some((p0, p1));
        state.cached_sections = sections;
    }

    /// The ONE advance of a track whose readers are pure (`sections_shared`): runs `iterate` over the canonical
    /// block and records the block, the handovers and the cursor. A `discontinuous` block drops the handovers.
    pub fn advance(&mut self, track: &TrackKey, p0: f64, p1: f64, discontinuous: bool, info: &dyn ClipInfo) {
        let Some(state) = self.states.iter_mut().find(|state| &state.uuid == track) else { return };
        if discontinuous {
            state.cached_range = None; // a wrapped loop may repeat the previous window, it must still advance
        }
        let before = state.playing;
        let mut sections: CachedSections = [None; 3];
        let mut count = 0;
        self.iterate(track, p0, p1, info, &mut |section| {
            if count < sections.len() {
                sections[count] = Some((section.clip, section.from, section.to));
                count += 1;
            }
        });
        let Some(state) = self.states.iter_mut().find(|state| &state.uuid == track) else { return };
        if discontinuous {
            state.shared.transitions = [None; SHARED_TRANSITIONS];
        }
        let mut current = before;
        for (clip, from, _) in sections.iter().flatten() {
            if *clip != current {
                state.shared.push_transition(Transition {position: *from, before: current});
                current = *clip;
            }
        }
        if state.playing != current {
            state.shared.push_transition(Transition {position: p1, before: current});
        }
        state.shared.push_block(p0, p1, sections);
        state.shared.cursor = Some(p1);
    }

    /// The PURE read of a track driven by `advance`: never transitions, any window, any number of readers.
    /// A canonical block replays exactly. Otherwise the part behind the cursor resolves from the recorded
    /// handovers, the part ahead by the handover rule on a COPY of the live state.
    pub fn sections_shared(&self, track: &TrackKey, p0: f64, p1: f64, info: &dyn ClipInfo, visit: &mut dyn FnMut(Section)) {
        let Some(state) = self.states.iter().find(|state| &state.uuid == track) else {
            visit(Section {clip: None, from: p0, to: p1});
            return;
        };
        if let Some(sections) = state.shared.find_block(p0, p1) {
            for (clip, from, to) in sections.iter().flatten() {
                visit(Section {clip: *clip, from: *from, to: *to});
            }
            return;
        }
        let mut points: [(f64, Option<ClipKey>); SHARED_POINTS] = [(0.0, None); SHARED_POINTS];
        let mut count = 0;
        let mut push = |position: f64, clip: Option<ClipKey>| {
            if count < SHARED_POINTS {
                points[count] = (position, clip);
                count += 1;
            }
        };
        let behind_end = state.shared.cursor.map_or(p0, |cursor| cursor.min(p1));
        if p0 < behind_end {
            let mut clip = state.playing;
            for transition in state.shared.transitions.iter().rev().flatten() {
                if transition.position > p0 { clip = transition.before } else { break }
            }
            push(p0, clip);
            let mut index = 0;
            while index < SHARED_TRANSITIONS {
                if let Some(transition) = state.shared.transitions[index] {
                    if transition.position > p0 && transition.position < behind_end {
                        let after = state.shared.transitions.get(index + 1).copied().flatten()
                            .map_or(state.playing, |next| next.before);
                        push(transition.position, after);
                    }
                }
                index += 1;
            }
        }
        let ahead_start = behind_end.max(p0);
        if ahead_start < p1 {
            Self::predict(state.playing, state.waiting, ahead_start, p1, info, &mut push);
        }
        let mut index = 0;
        while index < count {
            let (from, clip) = points[index];
            let mut next = index + 1;
            while next < count && points[next].1 == clip {
                next += 1;
            }
            let to = if next < count { points[next].0 } else { p1 };
            if from < to {
                visit(Section {clip, from, to});
            }
            index = next;
        }
    }

    // The handover rule of `iterate` on a copy of `(playing, waiting)`: no transition, no change queued.
    fn predict(playing: Option<ClipKey>, waiting: Option<Option<ClipKey>>, p0: f64, p1: f64, info: &dyn ClipInfo,
               push: &mut dyn FnMut(f64, Option<ClipKey>)) {
        push(p0, playing);
        if let Some(next) = waiting {
            let schedule_duration = playing.and_then(|clip| info.resolve(&clip)).map_or(BAR, |(duration, _)| duration);
            let schedule_end = quantize_floor(p1, schedule_duration);
            if schedule_end >= p0 {
                push(schedule_end, next);
            }
        } else if let Some(clip) = playing {
            let (duration, looped) = info.resolve(&clip).unwrap_or((BAR, true));
            if !looped {
                let schedule_end = quantize_floor(p0, duration) + duration;
                if schedule_end <= p1 {
                    push(schedule_end, None);
                }
            }
        }
    }

    /// Drain the queued transitions for the UI back-channel (TS `changes()`).
    pub fn take_changes(&mut self, visit: &mut dyn FnMut(&ClipKey, Change)) {
        for (key, change) in self.changes.drain(..) {
            visit(&key, change);
        }
    }

    pub fn has_changes(&self) -> bool {
        !self.changes.is_empty()
    }

    pub fn changes_len(&self) -> usize {
        self.changes.len()
    }

    fn state(states: &mut Vec<TrackState>, track: TrackKey) -> &mut TrackState {
        if let Some(index) = states.iter().position(|state| state.uuid == track) {
            let state = &mut states[index];
            state.cached_range = None; // a schedule op invalidates the replay cache
            return state;
        }
        states.push(TrackState {uuid: track, waiting: None, playing: None, cached_range: None, cached_sections: [None; 3],
            shared: SharedRead::new()});
        states.last_mut().expect("just pushed")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRACK: TrackKey = [1; 16];
    const CLIP_A: ClipKey = [10; 16];
    const CLIP_B: ClipKey = [11; 16];

    struct Info(Vec<(ClipKey, f64, bool)>);

    impl ClipInfo for Info {
        fn resolve(&self, clip: &ClipKey) -> Option<(f64, bool)> {
            self.0.iter().find(|(key, ..)| key == clip).map(|(_, duration, looped)| (*duration, *looped))
        }
    }

    fn sections(sequencer: &mut ClipSequencer, p0: f64, p1: f64, info: &Info) -> Vec<(Option<ClipKey>, f64, f64)> {
        let mut out = Vec::new();
        sequencer.iterate(&TRACK, p0, p1, info, &mut |section| out.push((section.clip, section.from, section.to)));
        out
    }

    fn changes(sequencer: &mut ClipSequencer) -> Vec<(ClipKey, Change)> {
        let mut out = Vec::new();
        sequencer.take_changes(&mut |key, change| out.push((*key, change)));
        out
    }

    #[test]
    fn no_state_yields_the_timeline() {
        let mut sequencer = ClipSequencer::new();
        let info = Info(Vec::new());
        assert_eq!(sections(&mut sequencer, 0.0, 128.0, &info), [(None, 0.0, 128.0)]);
    }

    #[test]
    fn scheduled_clip_starts_at_the_next_bar() {
        let mut sequencer = ClipSequencer::new();
        let info = Info(alloc::vec![(CLIP_A, BAR, true)]);
        sequencer.schedule_play(TRACK, CLIP_A);
        // block inside the bar: nothing switches yet (schedule_end 0 < p0)
        assert_eq!(sections(&mut sequencer, 100.0, 200.0, &info), [(None, 100.0, 200.0)]);
        assert!(changes(&mut sequencer).is_empty());
        // block crossing the bar boundary: timeline to the boundary, clip after
        let result = sections(&mut sequencer, BAR - 50.0, BAR + 50.0, &info);
        assert_eq!(result, [(None, BAR - 50.0, BAR), (Some(CLIP_A), BAR, BAR + 50.0)]);
        assert_eq!(changes(&mut sequencer), [(CLIP_A, Change::Started)]);
        // looping: keeps playing
        assert_eq!(sections(&mut sequencer, BAR + 50.0, BAR + 150.0, &info), [(Some(CLIP_A), BAR + 50.0, BAR + 150.0)]);
    }

    #[test]
    fn handover_quantizes_to_the_playing_clips_duration() {
        let mut sequencer = ClipSequencer::new();
        let info = Info(alloc::vec![(CLIP_A, 960.0, true), (CLIP_B, BAR, true)]);
        sequencer.schedule_play(TRACK, CLIP_A);
        sections(&mut sequencer, 0.0, 1.0, &info); // starts CLIP_A at 0
        assert_eq!(changes(&mut sequencer), [(CLIP_A, Change::Started)]);
        sequencer.schedule_play(TRACK, CLIP_B);
        // handover at CLIP_A's duration grid (960), not at the bar
        let result = sections(&mut sequencer, 900.0, 1000.0, &info);
        assert_eq!(result, [(Some(CLIP_A), 900.0, 960.0), (Some(CLIP_B), 960.0, 1000.0)]);
        assert_eq!(changes(&mut sequencer), [(CLIP_A, Change::Stopped), (CLIP_B, Change::Started)]);
    }

    #[test]
    fn rescheduling_makes_the_waiting_clip_obsolete() {
        let mut sequencer = ClipSequencer::new();
        sequencer.schedule_play(TRACK, CLIP_A);
        sequencer.schedule_play(TRACK, CLIP_B);
        assert_eq!(changes(&mut sequencer), [(CLIP_A, Change::Obsolete)]);
    }

    #[test]
    fn scheduled_stop_ends_the_clip_at_the_boundary() {
        let mut sequencer = ClipSequencer::new();
        let info = Info(alloc::vec![(CLIP_A, 960.0, true)]);
        sequencer.schedule_play(TRACK, CLIP_A);
        sections(&mut sequencer, 0.0, 1.0, &info);
        changes(&mut sequencer);
        sequencer.schedule_stop(TRACK);
        let result = sections(&mut sequencer, 900.0, 1000.0, &info);
        assert_eq!(result, [(Some(CLIP_A), 900.0, 960.0), (None, 960.0, 1000.0)]);
        assert_eq!(changes(&mut sequencer), [(CLIP_A, Change::Stopped)]);
    }

    #[test]
    fn non_looping_clip_stops_itself() {
        let mut sequencer = ClipSequencer::new();
        let info = Info(alloc::vec![(CLIP_A, 960.0, false)]);
        sequencer.schedule_play(TRACK, CLIP_A);
        sections(&mut sequencer, 0.0, 1.0, &info);
        changes(&mut sequencer);
        let result = sections(&mut sequencer, 900.0, 1100.0, &info);
        assert_eq!(result, [(Some(CLIP_A), 900.0, 960.0), (None, 960.0, 1100.0)]);
        assert_eq!(changes(&mut sequencer), [(CLIP_A, Change::Stopped)]);
    }

    #[test]
    fn reset_stops_playing_and_obsoletes_waiting() {
        let mut sequencer = ClipSequencer::new();
        let info = Info(alloc::vec![(CLIP_A, 960.0, true)]);
        sequencer.schedule_play(TRACK, CLIP_A);
        sections(&mut sequencer, 0.0, 1.0, &info);
        changes(&mut sequencer);
        sequencer.schedule_play(TRACK, CLIP_B);
        sequencer.reset();
        assert_eq!(changes(&mut sequencer), [(CLIP_B, Change::Obsolete), (CLIP_A, Change::Stopped)]);
        assert_eq!(sections(&mut sequencer, 0.0, 128.0, &info), [(None, 0.0, 128.0)]);
    }

    #[test]
    fn repeated_iterate_over_the_same_range_replays_without_readvancing() {
        let mut sequencer = ClipSequencer::new();
        let info = Info(alloc::vec![(CLIP_A, BAR, true)]);
        sequencer.schedule_play(TRACK, CLIP_A);
        let first = sections(&mut sequencer, BAR - 50.0, BAR + 50.0, &info);
        let second = sections(&mut sequencer, BAR - 50.0, BAR + 50.0, &info);
        assert_eq!(first, second, "a second sequencer pulling the same block sees identical sections");
        assert_eq!(changes(&mut sequencer), [(CLIP_A, Change::Started)], "the transition fires exactly once");
    }

    fn shared(sequencer: &ClipSequencer, p0: f64, p1: f64, info: &Info) -> Vec<(Option<ClipKey>, f64, f64)> {
        let mut out = Vec::new();
        sequencer.sections_shared(&TRACK, p0, p1, info, &mut |section| out.push((section.clip, section.from, section.to)));
        out
    }

    #[test]
    fn shared_read_without_state_yields_the_timeline() {
        let sequencer = ClipSequencer::new();
        let info = Info(Vec::new());
        assert_eq!(shared(&sequencer, 0.0, 128.0, &info), [(None, 0.0, 128.0)]);
    }

    #[test]
    fn shared_read_replays_the_canonical_block_without_transitions() {
        let mut sequencer = ClipSequencer::new();
        let info = Info(alloc::vec![(CLIP_A, BAR, true)]);
        sequencer.schedule_play(TRACK, CLIP_A);
        sequencer.advance(&TRACK, BAR - 50.0, BAR + 50.0, false, &info);
        let expected = [(None, BAR - 50.0, BAR), (Some(CLIP_A), BAR, BAR + 50.0)];
        assert_eq!(shared(&sequencer, BAR - 50.0, BAR + 50.0, &info), expected);
        assert_eq!(shared(&sequencer, BAR - 50.0, BAR + 50.0, &info), expected, "a second layer sees the same");
        assert_eq!(changes(&mut sequencer), [(CLIP_A, Change::Started)], "only the canonical advance transitions");
    }

    #[test]
    fn shared_read_matches_iterate_for_every_canonical_block() {
        // The unwarped layer must see EXACTLY what a leaf unit's `iterate` yields, block by block.
        let info = Info(alloc::vec![(CLIP_A, 960.0, false), (CLIP_B, BAR, true)]);
        let mut leaf = ClipSequencer::new();
        let mut canonical = ClipSequencer::new();
        for sequencer in [&mut leaf, &mut canonical] {
            sequencer.schedule_play(TRACK, CLIP_A);
        }
        let mut position = 0.0;
        while position < 2.0 * BAR {
            let next = position + 37.0;
            if position > 1000.0 && position < 1040.0 {
                leaf.schedule_play(TRACK, CLIP_B);
                canonical.schedule_play(TRACK, CLIP_B);
            }
            let want = sections(&mut leaf, position, next, &info);
            canonical.advance(&TRACK, position, next, false, &info);
            assert_eq!(shared(&canonical, position, next, &info), want, "block at {position}");
            position = next;
        }
        assert_eq!(changes(&mut canonical), changes(&mut leaf));
    }

    #[test]
    fn shared_read_behind_the_cursor_resolves_from_the_log() {
        let mut sequencer = ClipSequencer::new();
        let info = Info(alloc::vec![(CLIP_A, BAR, true)]);
        sequencer.schedule_play(TRACK, CLIP_A);
        sequencer.advance(&TRACK, BAR - 50.0, BAR + 50.0, false, &info);
        sequencer.advance(&TRACK, BAR + 50.0, BAR + 150.0, false, &info);
        assert_eq!(shared(&sequencer, BAR - 80.0, BAR + 20.0, &info),
            [(None, BAR - 80.0, BAR), (Some(CLIP_A), BAR, BAR + 20.0)]);
        assert_eq!(shared(&sequencer, BAR - 100.0, BAR - 60.0, &info), [(None, BAR - 100.0, BAR - 60.0)]);
        assert_eq!(shared(&sequencer, BAR + 10.0, BAR + 90.0, &info), [(Some(CLIP_A), BAR + 10.0, BAR + 90.0)]);
    }

    #[test]
    fn shared_read_ahead_of_the_cursor_predicts_the_handover_without_mutating() {
        let mut sequencer = ClipSequencer::new();
        let info = Info(alloc::vec![(CLIP_A, BAR, true)]);
        sequencer.schedule_play(TRACK, CLIP_A);
        sequencer.advance(&TRACK, BAR - 100.0, BAR - 50.0, false, &info);
        let ahead = shared(&sequencer, BAR - 60.0, BAR + 40.0, &info);
        assert_eq!(ahead, [(None, BAR - 60.0, BAR), (Some(CLIP_A), BAR, BAR + 40.0)]);
        assert!(changes(&mut sequencer).is_empty(), "a prediction never transitions");
        sequencer.advance(&TRACK, BAR - 50.0, BAR + 50.0, false, &info);
        assert_eq!(changes(&mut sequencer), [(CLIP_A, Change::Started)]);
        assert_eq!(shared(&sequencer, BAR - 60.0, BAR + 40.0, &info), ahead, "the later advance records what was predicted");
    }

    #[test]
    fn shared_read_before_any_advance_predicts_from_the_live_state() {
        let mut sequencer = ClipSequencer::new();
        let info = Info(alloc::vec![(CLIP_A, BAR, true)]);
        sequencer.schedule_play(TRACK, CLIP_A);
        assert_eq!(shared(&sequencer, BAR - 10.0, BAR + 10.0, &info),
            [(None, BAR - 10.0, BAR), (Some(CLIP_A), BAR, BAR + 10.0)]);
    }

    #[test]
    fn shared_read_sees_a_non_looping_clip_end_ahead_and_behind() {
        let mut sequencer = ClipSequencer::new();
        let info = Info(alloc::vec![(CLIP_A, 960.0, false)]);
        sequencer.schedule_play(TRACK, CLIP_A);
        sequencer.advance(&TRACK, 0.0, 1.0, false, &info);
        sequencer.advance(&TRACK, 1.0, 900.0, false, &info);
        changes(&mut sequencer);
        let expected = [(Some(CLIP_A), 880.0, 960.0), (None, 960.0, 1000.0)];
        assert_eq!(shared(&sequencer, 880.0, 1000.0, &info), expected, "ahead");
        sequencer.advance(&TRACK, 900.0, 1100.0, false, &info);
        assert_eq!(changes(&mut sequencer), [(CLIP_A, Change::Stopped)]);
        assert_eq!(shared(&sequencer, 880.0, 1000.0, &info), expected, "behind");
    }

    #[test]
    fn shared_read_sees_a_clip_end_exactly_at_the_block_end() {
        let mut sequencer = ClipSequencer::new();
        let info = Info(alloc::vec![(CLIP_A, 960.0, false)]);
        sequencer.schedule_play(TRACK, CLIP_A);
        sequencer.advance(&TRACK, 0.0, 1.0, false, &info);
        sequencer.advance(&TRACK, 1.0, 960.0, false, &info);
        sequencer.advance(&TRACK, 960.0, 1000.0, false, &info);
        assert_eq!(shared(&sequencer, 940.0, 980.0, &info), [(Some(CLIP_A), 940.0, 960.0), (None, 960.0, 980.0)]);
    }

    #[test]
    fn shared_read_sees_a_scheduled_stop() {
        let mut sequencer = ClipSequencer::new();
        let info = Info(alloc::vec![(CLIP_A, 960.0, true)]);
        sequencer.schedule_play(TRACK, CLIP_A);
        sequencer.advance(&TRACK, 0.0, 1.0, false, &info);
        sequencer.schedule_stop(TRACK);
        let expected = [(Some(CLIP_A), 900.0, 960.0), (None, 960.0, 1000.0)];
        assert_eq!(shared(&sequencer, 900.0, 1000.0, &info), expected, "ahead");
        sequencer.advance(&TRACK, 1.0, 1000.0, false, &info);
        assert_eq!(shared(&sequencer, 900.0, 1000.0, &info), expected, "behind");
    }

    #[test]
    fn a_discontinuity_drops_the_log_but_keeps_the_quantums_blocks() {
        let mut sequencer = ClipSequencer::new();
        let info = Info(alloc::vec![(CLIP_A, BAR, true)]);
        sequencer.schedule_play(TRACK, CLIP_A);
        sequencer.advance(&TRACK, BAR - 50.0, BAR + 50.0, false, &info);
        sequencer.advance(&TRACK, 0.0, 50.0, true, &info); // the loop wrapped inside the quantum
        assert_eq!(shared(&sequencer, BAR - 50.0, BAR + 50.0, &info),
            [(None, BAR - 50.0, BAR), (Some(CLIP_A), BAR, BAR + 50.0)], "the pre-wrap block still replays exactly");
        assert_eq!(shared(&sequencer, 0.0, 50.0, &info), [(Some(CLIP_A), 0.0, 50.0)]);
        assert_eq!(shared(&sequencer, 10.0, 40.0, &info), [(Some(CLIP_A), 10.0, 40.0)], "no stale handover after the wrap");
    }

    #[test]
    fn a_recurring_block_window_replays_the_newest_pass() {
        let mut sequencer = ClipSequencer::new();
        let info = Info(alloc::vec![(CLIP_A, BAR, true)]);
        sequencer.advance(&TRACK, 0.0, 50.0, false, &info);
        sequencer.schedule_play(TRACK, CLIP_A);
        sequencer.advance(&TRACK, 0.0, 50.0, true, &info);
        assert_eq!(shared(&sequencer, 0.0, 50.0, &info), [(Some(CLIP_A), 0.0, 50.0)]);
    }

    #[test]
    fn forgetting_a_playing_clip_stops_it() {
        let mut sequencer = ClipSequencer::new();
        let info = Info(alloc::vec![(CLIP_A, 960.0, true)]);
        sequencer.schedule_play(TRACK, CLIP_A);
        sections(&mut sequencer, 0.0, 1.0, &info);
        changes(&mut sequencer);
        sequencer.forget(&CLIP_A);
        assert_eq!(changes(&mut sequencer), [(CLIP_A, Change::Stopped)]);
        assert_eq!(sections(&mut sequencer, 0.0, 128.0, &info), [(None, 0.0, 128.0)]);
    }
}
