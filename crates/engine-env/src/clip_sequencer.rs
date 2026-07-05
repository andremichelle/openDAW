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
    cached_sections: [Option<(Option<ClipKey>, f64, f64)>; 3]
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
                changes.push((*uuid, Change::Stopped));
            }
            if matches!(state.waiting.as_ref(), Some(Some(waiting)) if waiting == uuid) {
                state.waiting = None;
                state.cached_range = None;
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
        states.push(TrackState {uuid: track, waiting: None, playing: None, cached_range: None, cached_sections: [None; 3]});
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
