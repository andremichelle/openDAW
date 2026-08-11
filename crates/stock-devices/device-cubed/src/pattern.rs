//! The device's internal 16-step pattern, as a source of ordinary note events.
//!
//! The pattern is stored on `CubedDeviceBox` (field 30: a fixed array of 16 `CubedPattern` objects,
//! each with `length` and 64 packed steps) and selected by `pattern-index` (field 20). It emits the
//! selected pattern as NOTES, so pattern playback and live playing reach the voice down one
//! identical path.
//!
//! The 303's per-step bits survive as an encoding, which is exactly what the hardware does:
//!   accent -> VELOCITY at or above the reference sequencer's measured threshold (100/127)
//!   slide  -> OVERLAP with the next note, because a slide IS the gate never closing
//!   gate   -> DURATION of `GATE_FRACTION` of a step
//! `NoteMerger` reconstructs all three, so no side channel is needed.

use abi::{BlockFlags, EventRecord, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use dsp::ppqn::{BAR, SEMI_QUAVER};

pub const MAX_STEPS: usize = 64;
pub const PATTERN_COUNT: usize = 16;

/// Velocity for an unaccented step, comfortably under the accent threshold. The 303's accent is
/// BINARY, so this value carries no expression - it only has to stay below the line.
pub const PLAIN_VELOCITY: f32 = 0.5;
/// MIDI velocity 100 of 127: the reference sequencer's measured accent THRESHOLD, mirrored by
/// `NoteMerger`.
pub const ACCENT_THRESHOLD: f32 = 100.0 / 127.0;
/// Velocity emitted for an accented step: FULL, deliberately not the threshold itself.
///
/// Emitting exactly at the threshold makes the accent hinge on the last bit surviving the trip to
/// the voice. A round-trip through MIDI 0..127 alone loses it - 100/127 * 127 = 99.99 truncates to
/// 99, i.e. 0.7795, just under the line - and the accent silently never fires.
pub const ACCENT_VELOCITY: f32 = 1.0;
/// How long a sliding step is held, in steps. MUST exceed 1.0 so the next step's note-on lands while
/// this note is still held; otherwise the merger sees no legato and the slide silently becomes a
/// retrigger. The excess is inaudible because the next note-on takes the (monophonic) voice.
pub const SLIDE_HOLD_STEPS: f64 = 1.05;
/// 0.55 of a step. A CALIBRATED constant of the ar-303 voice model (`cal.gate_fraction`), not a user
/// setting: the accent and envelope behaviour was fitted around this gate length, so changing it
/// decalibrates the model rather than shortening a note.
pub const GATE_FRACTION: f64 = 0.551704;

/// Notes still waiting for their note-off. A slide overlaps its successor, so more than one can be
/// outstanding; four is beyond what the monophonic pattern can stack.
const RETAINED: usize = 4;

fn floor(value: f64) -> f64 {libm::floor(value)}
fn ceil(value: f64) -> f64 {-libm::floor(-value)}

/// One packed step, as `CubedDeviceBox` field 30 stores it: midi note (7 bits), gate, slide, accent.
/// The schema's born-default is the literal `60` - note 60 with every flag clear, i.e. SILENT.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Step {pub note: u8, pub gate: bool, pub slide: bool, pub accent: bool}

impl Step {
    pub fn unpack(word: i32) -> Self {
        Self {
            note: (word & 0x7f) as u8,
            gate: word & (1 << 7) != 0,
            slide: word & (1 << 8) != 0,
            accent: word & (1 << 9) != 0
        }
    }

    pub fn pack(self) -> i32 {
        self.note as i32 & 0x7f
            | (self.gate as i32) << 7
            | (self.slide as i32) << 8
            | (self.accent as i32) << 9
    }

    pub fn velocity(self) -> f32 {
        if self.accent {ACCENT_VELOCITY} else {PLAIN_VELOCITY}
    }

    /// Duration in STEPS. A slide outlasts its own step so the next note overlaps it.
    pub fn duration_steps(self) -> f64 {
        if self.slide {SLIDE_HOLD_STEPS} else {GATE_FRACTION}
    }
}

#[derive(Clone, Copy, Default)]
struct Retained {end: f64, id: u32, pitch: u32, live: bool}

pub struct Pattern {
    /// ALL 16 patterns, because the array is fixed and they always exist. Holding them means a
    /// `pattern-index` change is a selection, not a re-read.
    patterns: [[Step; MAX_STEPS]; PATTERN_COUNT],
    lengths: [usize; PATTERN_COUNT],
    index: usize,
    pending_index: Option<usize>,
    retained: [Retained; RETAINED],
    next_id: u32,
    step: i32
}

impl Default for Pattern {
    fn default() -> Self {Self::new()}
}

impl Pattern {
    pub fn new() -> Self {
        Self {patterns: [[Step {note: 0, gate: false, slide: false, accent: false}; MAX_STEPS]; PATTERN_COUNT],
              lengths: [16; PATTERN_COUNT], index: 0, pending_index: None,
              retained: [Retained::default(); RETAINED], next_id: 1, step: -1}
    }

    pub fn set_steps(&mut self, index: usize, words: &[i32]) {
        if index >= PATTERN_COUNT {return}
        let count = words.len().min(MAX_STEPS);
        for slot in 0..count {self.patterns[index][slot] = Step::unpack(words[slot]);}
        for slot in self.patterns[index][count..].iter_mut() {*slot = Step::default();}
    }

    pub fn set_length(&mut self, index: usize, length: usize) {
        if index >= PATTERN_COUNT {return}
        self.lengths[index] = length.clamp(1, MAX_STEPS);
    }

    /// Selecting a pattern must NOT reset the step phase: the sequencer keeps running and the new
    /// pattern takes over in place, which is how the hardware's pattern switch behaves.
    pub fn set_index(&mut self, index: usize) {
        self.index = index.min(PATTERN_COUNT - 1);
        self.pending_index = None;
    }

    /// Arms a manual selection for the next bar line. Re-selecting the playing pattern disarms.
    pub fn request_index(&mut self, index: usize) {
        let index = index.min(PATTERN_COUNT - 1);
        self.pending_index = if index == self.index {None} else {Some(index)};
    }

    pub fn commit_pending_index(&mut self) {
        if let Some(pending) = self.pending_index.take() {
            self.index = pending;
        }
    }

    pub fn index(&self) -> usize {self.index}
    pub fn pending_index(&self) -> Option<usize> {self.pending_index}
    pub fn length(&self) -> usize {self.lengths[self.index]}
    /// The currently-playing step, -1 when idle, for the editor's playhead row.
    pub fn step(&self) -> i32 {self.step}

    pub fn reset(&mut self) {
        self.retained = [Retained::default(); RETAINED];
        self.step = -1;
    }

    fn retain(&mut self, end: f64, id: u32, pitch: u32) {
        if let Some(slot) = self.retained.iter_mut().find(|slot| !slot.live) {
            *slot = Retained {end, id, pitch, live: true};
        }
    }

    fn note_off(position: f64, note: &Retained) -> EventRecord {
        EventRecord {position, offset: 0, kind: EVENT_NOTE_OFF, id: note.id, pitch: note.pitch,
                     velocity: 0.0, cent: 0.0, duration: 0.0}
    }

    /// Emit this block's note events. Mirrors a note sequencer: release what has ended first, so a
    /// stop or a loop wrap never leaves the monophonic voice gated with no note left to release it.
    pub fn generate(&mut self, from: f64, to: f64, flags: BlockFlags, out: &mut [EventRecord]) -> usize {
        let mut count = 0;
        let read = flags.has(BlockFlags::TRANSPORTING | BlockFlags::PLAYING);
        if !read || flags.discontinuous() {
            self.commit_pending_index();
        }
        self.step = if read {
            (floor(from / SEMI_QUAVER) as i64).rem_euclid(self.lengths[self.index] as i64) as i32
        } else {-1};
        for slot in 0..RETAINED {
            let note = self.retained[slot];
            if !note.live {continue}
            if !read || flags.discontinuous() {
                if count < out.len() {out[count] = Self::note_off(from, &note); count += 1;}
                self.retained[slot].live = false;
            } else if note.end <= to {
                let position = if note.end < from {from} else {note.end};
                if count < out.len() {out[count] = Self::note_off(position, &note); count += 1;}
                self.retained[slot].live = false;
            }
        }
        if !read {return count}
        // Every step boundary in the HALF-OPEN range [from, to). Half-open is what makes adjacent
        // blocks tile without gaps or overlap: a boundary belongs to exactly one block, so no step
        // is dropped at transport start and none is emitted twice (a doubled note-on would deplete
        // the accent cap twice, which is audible as a weak accent).
        let steps_per_bar = (BAR / SEMI_QUAVER) as i64;
        let first = ceil(from / SEMI_QUAVER) as i64;
        let last = floor(to / SEMI_QUAVER) as i64;
        for index in first..=last {
            let position = index as f64 * SEMI_QUAVER;
            if position < from || position >= to {continue}
            if index.rem_euclid(steps_per_bar) == 0 {
                self.commit_pending_index();
            }
            let step = self.patterns[self.index][(index.rem_euclid(self.lengths[self.index] as i64)) as usize];
            if !step.gate || count >= out.len() {continue}
            let duration = step.duration_steps() * SEMI_QUAVER;
            let id = self.next_id;
            self.next_id = self.next_id.wrapping_add(1).max(1);
            out[count] = EventRecord {position, offset: 0, kind: EVENT_NOTE_ON, id, pitch: step.note as u32,
                                      velocity: step.velocity(), cent: 0.0, duration};
            count += 1;
            self.retain(position + duration, id, step.note as u32);
        }
        count
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gated(note: u8, slide: bool, accent: bool) -> Step {
        Step {note, gate: true, slide, accent}
    }

    fn playing() -> BlockFlags {
        BlockFlags::create(true, false, true, false)
    }

    fn pattern_with(steps: &[Step], length: usize) -> Pattern {
        let mut pattern = Pattern::new();
        let words: Vec<i32> = steps.iter().map(|step| step.pack()).collect();
        pattern.set_steps(0, &words);
        pattern.set_length(0, length);
        pattern
    }

    fn collect(pattern: &mut Pattern, from: f64, to: f64) -> Vec<EventRecord> {
        collect_with(pattern, from, to, playing())
    }

    fn collect_with(pattern: &mut Pattern, from: f64, to: f64, flags: BlockFlags) -> Vec<EventRecord> {
        let mut out = [EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0,
                                    velocity: 0.0, cent: 0.0, duration: 0.0}; 32];
        let count = pattern.generate(from, to, flags, &mut out);
        out[..count].to_vec()
    }

    fn starts(events: &[EventRecord]) -> Vec<(f64, u32)> {
        events.iter().filter(|event| event.kind == EVENT_NOTE_ON)
            .map(|event| (event.position, event.pitch)).collect()
    }

    fn two_patterns() -> Pattern {
        let mut pattern = Pattern::new();
        pattern.set_steps(0, &[gated(36, false, false).pack()]);
        pattern.set_length(0, 1);
        pattern.set_steps(3, &[gated(48, false, false).pack()]);
        pattern.set_length(3, 1);
        pattern
    }

    #[test]
    fn the_born_default_step_is_a_silent_note_60() {
        let step = Step::unpack(60);
        assert_eq!(step, Step {note: 60, gate: false, slide: false, accent: false});
        assert_eq!(step.pack(), 60);
    }

    #[test]
    fn packing_round_trips_including_the_top_note() {
        let step = Step {note: 127, gate: true, slide: true, accent: true};
        assert_eq!(Step::unpack(step.pack()), step);
        assert_eq!(step.pack(), 127 | 1 << 7 | 1 << 8 | 1 << 9);
    }

    #[test]
    fn steps_land_on_semiquaver_boundaries() {
        let mut pattern = pattern_with(&[gated(36, false, false), gated(43, false, false)], 2);
        let events = collect(&mut pattern, 0.0, SEMI_QUAVER * 2.5);
        assert_eq!(starts(&events), vec![(0.0, 36), (SEMI_QUAVER, 43), (SEMI_QUAVER * 2.0, 36)]);
    }

    #[test]
    fn a_step_boundary_is_never_emitted_twice_across_adjacent_blocks() {
        let mut pattern = pattern_with(&[gated(36, false, false)], 1);
        let first = collect(&mut pattern, 0.0, SEMI_QUAVER);
        let second = collect(&mut pattern, SEMI_QUAVER, SEMI_QUAVER * 2.0);
        let count = |events: &[EventRecord]| events.iter()
            .filter(|event| event.kind == EVENT_NOTE_ON && event.position == SEMI_QUAVER).count();
        assert_eq!(count(&first) + count(&second), 1,
                   "a doubled note-on would deplete the accent cap twice");
    }

    #[test]
    fn an_accent_crosses_the_threshold_and_a_plain_step_does_not() {
        let mut pattern = pattern_with(&[gated(36, false, true), gated(38, false, false)], 2);
        let events = collect(&mut pattern, 0.0, SEMI_QUAVER * 2.5);
        let velocities: Vec<f32> = events.iter().filter(|event| event.kind == EVENT_NOTE_ON)
            .map(|event| event.velocity).collect();
        assert!(velocities[0] >= ACCENT_THRESHOLD, "step 0 is accented");
        assert!(velocities[1] < ACCENT_THRESHOLD, "step 1 is plain");
        assert!(velocities[0] - ACCENT_THRESHOLD > 0.1, "accent must clear the threshold, not sit on it");
    }

    #[test]
    fn a_slide_overlaps_the_next_step_and_a_plain_step_does_not() {
        let mut slide = pattern_with(&[gated(36, true, false)], 1);
        let mut plain = pattern_with(&[gated(36, false, false)], 1);
        let span = |events: &[EventRecord]| events.iter().find(|event| event.kind == EVENT_NOTE_ON)
            .expect("a note").duration;
        assert!(span(&collect(&mut slide, 0.0, SEMI_QUAVER * 1.5)) > SEMI_QUAVER,
                "a slide must outlast its step or it is a retrigger");
        assert!(span(&collect(&mut plain, 0.0, SEMI_QUAVER * 1.5)) < SEMI_QUAVER,
                "a plain step must end before the next begins");
    }

    #[test]
    fn a_note_completes_when_its_span_ends() {
        let mut pattern = pattern_with(&[gated(36, false, false)], 4);
        collect(&mut pattern, 0.0, SEMI_QUAVER * 1.5);
        let later = collect(&mut pattern, SEMI_QUAVER * 1.5, SEMI_QUAVER * 3.0);
        assert!(later.iter().any(|event| event.kind == EVENT_NOTE_OFF && event.pitch == 36));
    }

    #[test]
    fn a_transport_stop_releases_everything_held() {
        let mut pattern = pattern_with(&[gated(36, true, false)], 4);
        collect(&mut pattern, 0.0, SEMI_QUAVER * 1.2);
        let stopped = collect_with(&mut pattern, SEMI_QUAVER * 1.2, SEMI_QUAVER * 2.0,
                                   BlockFlags::create(false, false, false, false));
        assert!(stopped.iter().any(|event| event.kind == EVENT_NOTE_OFF),
                "the voice must not be left gated");
    }

    #[test]
    fn the_pattern_wraps_at_its_length_not_at_the_array() {
        let steps = [gated(36, false, false), gated(43, false, false), gated(99, false, false)];
        let mut pattern = pattern_with(&steps, 2);
        let events = collect(&mut pattern, 0.0, SEMI_QUAVER * 4.5);
        assert!(!starts(&events).iter().any(|(_, pitch)| *pitch == 99),
                "step 2 is outside the pattern length");
    }

    #[test]
    fn an_automated_index_selects_the_pattern_the_block_lands_on() {
        let mut pattern = two_patterns();
        assert_eq!(starts(&collect(&mut pattern, 0.0, SEMI_QUAVER * 0.5))[0].1, 36);
        pattern.set_index(3);
        let switched = collect(&mut pattern, SEMI_QUAVER * 4.0, SEMI_QUAVER * 4.5);
        assert_eq!(starts(&switched)[0].1, 48, "an automated selection does not wait for a bar");
        assert_eq!(pattern.index(), 3);
    }

    #[test]
    fn a_manual_pattern_change_waits_for_the_next_bar() {
        let mut pattern = two_patterns();
        collect(&mut pattern, 0.0, SEMI_QUAVER * 2.0);
        pattern.request_index(3);
        let rest_of_bar = collect(&mut pattern, SEMI_QUAVER * 2.0, SEMI_QUAVER * 15.0);
        assert!(!starts(&rest_of_bar).iter().any(|(_, pitch)| *pitch == 48),
                "the switch must not break the running bar");
        assert_eq!(pattern.index(), 0);
        assert_eq!(pattern.pending_index(), Some(3));
        let across = collect(&mut pattern, SEMI_QUAVER * 15.0, SEMI_QUAVER * 17.0);
        assert_eq!(starts(&across).iter().map(|(_, pitch)| *pitch).collect::<Vec<u32>>(), vec![36, 48],
                   "the new pattern starts exactly on the bar line");
        assert_eq!(pattern.pending_index(), None);
    }

    #[test]
    fn a_manual_pattern_change_takes_effect_at_once_while_stopped() {
        let mut pattern = two_patterns();
        pattern.request_index(3);
        collect_with(&mut pattern, SEMI_QUAVER * 2.0, SEMI_QUAVER * 3.0,
                     BlockFlags::create(false, false, false, false));
        assert_eq!(pattern.index(), 3, "stopped, there is no next bar to wait for");
        assert_eq!(starts(&collect(&mut pattern, SEMI_QUAVER * 3.0, SEMI_QUAVER * 4.0))[0].1, 48);
    }

    #[test]
    fn selecting_the_playing_pattern_again_disarms_an_armed_switch() {
        let mut pattern = two_patterns();
        pattern.request_index(3);
        pattern.request_index(0);
        assert_eq!(pattern.pending_index(), None);
        assert_eq!(starts(&collect(&mut pattern, SEMI_QUAVER * 16.0, SEMI_QUAVER * 17.0))[0].1, 36);
    }

    #[test]
    fn an_automated_index_drops_an_armed_switch() {
        let mut pattern = two_patterns();
        pattern.request_index(3);
        pattern.set_index(0);
        assert_eq!(pattern.pending_index(), None);
        assert_eq!(starts(&collect(&mut pattern, SEMI_QUAVER * 2.0, SEMI_QUAVER * 3.0))[0].1, 36);
    }

    #[test]
    fn the_playing_step_is_published_and_idles_at_minus_one() {
        let mut pattern = pattern_with(&[gated(36, false, false)], 4);
        collect(&mut pattern, SEMI_QUAVER * 2.0, SEMI_QUAVER * 2.5);
        assert_eq!(pattern.step(), 2);
        collect_with(&mut pattern, SEMI_QUAVER * 2.5, SEMI_QUAVER * 3.0,
                     BlockFlags::create(false, false, false, false));
        assert_eq!(pattern.step(), -1);
    }
}
