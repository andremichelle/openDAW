//! The Cubed device's internal 16-step pattern as a `NoteEventSource`.
//!
//! The pattern is stored on `CubedDeviceBox` (field 30: a fixed array of 16 `CubedPattern` objects,
//! each with `length` and 64 packed steps) and selected by `pattern-index` (field 20). This turns
//! the selected pattern into ORDINARY NOTES, so pattern playback and live playing reach the device
//! down one identical path and nothing downstream needs to know a pattern exists.
//!
//! The 303's per-step bits survive as an encoding, which is exactly what the hardware does:
//!   accent -> VELOCITY at or above the reference sequencer's measured threshold (100/127)
//!   slide  -> OVERLAP with the next note, because a slide IS the gate never closing
//!   gate   -> DURATION of `gate_fraction` of a step (the calibrated 0.55)
//! The device's `NoteMerger` reconstructs all three, so no side channel is needed.
//!
//! Graph reading lives in the wiring layer; this type is a pure cache + emitter so its timing is
//! testable without a BoxGraph.

use engine_env::block_flags::BlockFlags;
use engine_env::event::Event;
use dsp::ppqn::SEMI_QUAVER;
use math::floor;
use value::retainer::EventSpanRetainer;

/// `no_std` on wasm: no f64 std methods. Mirrors the `metronome` helper.
fn ceil(value: f64) -> f64 {-floor(-value)}

pub const MAX_STEPS: usize = 64;
pub const PATTERN_COUNT: usize = 16;

/// Velocity for an unaccented step, comfortably under the accent threshold. The 303's accent is
/// BINARY, so this value carries no expression - it only has to stay below the line.
pub const PLAIN_VELOCITY: f32 = 0.5;
/// MIDI velocity 100 of 127: the reference sequencer's measured accent THRESHOLD, mirrored by the
/// device's `NoteMerger`.
pub const ACCENT_THRESHOLD: f32 = 100.0 / 127.0;
/// Velocity emitted for an accented step: FULL, deliberately not the threshold itself.
///
/// Emitting exactly at the threshold makes the accent hinge on the last bit surviving the trip to
/// the device. A round-trip through MIDI 0..127 alone loses it - 100/127 * 127 = 99.99 truncates to
/// 99, i.e. 0.7795, just under the line - and the accent silently never fires. The 303's accent is
/// BINARY, so full velocity is both the truest value and the unambiguous one.
pub const ACCENT_VELOCITY: f32 = 1.0;
/// How long a sliding step is held, in steps. MUST exceed 1.0 so the next step's note-on lands while
/// this note is still held; otherwise the device sees no legato and the slide silently becomes a
/// retrigger. The excess is inaudible because the next note-on takes the (monophonic) voice.
pub const SLIDE_HOLD_STEPS: f64 = 1.05;
/// 0.55 of a step. A CALIBRATED constant of the ar-303 voice model (`cal.gate_fraction`), not a user
/// setting: the accent and envelope behaviour was fitted around this gate length, so changing it
/// decalibrates the model rather than shortening a note.
pub const GATE_FRACTION: f64 = 0.551704;

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
    pub fn duration_steps(self, gate_fraction: f64) -> f64 {
        if self.slide {SLIDE_HOLD_STEPS} else {gate_fraction}
    }
}

struct RetainedNote {position: f64, duration: f64, id: u64, pitch: u8}

impl value::event::Event for RetainedNote {
    fn position(&self) -> f64 {self.position}
}

impl value::event::EventSpan for RetainedNote {
    fn duration(&self) -> f64 {self.duration}
}

pub struct CubedPatternSource {
    /// ALL 16 patterns, because the array is fixed and they always exist. Holding them means a
    /// `pattern-index` change is a selection, not a graph re-read, so the subscription callbacks
    /// stay pure value-pushes and nothing has to touch the BoxGraph off the wiring path.
    patterns: [[Step; MAX_STEPS]; PATTERN_COUNT],
    lengths: [usize; PATTERN_COUNT],
    index: usize,
    /// 0.55 of a step, a CALIBRATED constant of the voice model - not a user setting.
    gate_fraction: f64,
    enabled: bool,
    retainer: EventSpanRetainer<RetainedNote>,
    next_id: u64
}

impl CubedPatternSource {
    pub fn new(gate_fraction: f64) -> Self {
        Self {patterns: [[Step {note: 0, gate: false, slide: false, accent: false}; MAX_STEPS]; PATTERN_COUNT],
              lengths: [16; PATTERN_COUNT], index: 0, gate_fraction, enabled: true,
              retainer: EventSpanRetainer::new(), next_id: 1}
    }

    /// Replaces the cached pattern. Called from the wiring layer on catch-up and whenever the box
    /// fields or `pattern-index` change - never during render.
    pub fn set_pattern(&mut self, steps: &[Step], length: usize) {
        let index = self.index;
        self.set_pattern_at(index, steps, length);
    }

    pub fn set_pattern_at(&mut self, index: usize, steps: &[Step], length: usize) {
        if index >= PATTERN_COUNT {return}
        let count = steps.len().min(MAX_STEPS);
        self.patterns[index][..count].copy_from_slice(&steps[..count]);
        for slot in self.patterns[index][count..].iter_mut() {*slot = Step::default();}
        self.lengths[index] = length.clamp(1, MAX_STEPS);
    }

    /// Selecting a pattern must NOT reset the step phase: the sequencer keeps running and the new
    /// pattern takes over in place, which is how the hardware's pattern switch behaves.
    pub fn set_index(&mut self, index: usize) {
        self.index = index.min(PATTERN_COUNT - 1);
    }

    pub fn index(&self) -> usize {self.index}

    /// The pattern runs with the TRANSPORT: `process_notes` already gates on TRANSPORTING|PLAYING,
    /// and the schema carries no run/stop field, so there is nothing else that could start it.
    ///
    /// Consequence worth knowing: a Cubed that ALSO receives track notes plays both. That is the
    /// honest reading of a device whose sequencer has no off switch, and the merger handles the
    /// overlap by last-note priority rather than by doubling voices - but if the intent is that a
    /// track region should silence the internal pattern, that needs a schema field, not a guess here.
    pub fn set_enabled(&mut self, enabled: bool) {self.enabled = enabled;}

    pub fn is_enabled(&self) -> bool {self.enabled}

    pub fn length(&self) -> usize {self.lengths[self.index]}
}

impl engine_env::note_event_source::NoteEventSource for CubedPatternSource {
    fn process_notes(&mut self, from: f64, to: f64, flags: BlockFlags, sink: &mut dyn FnMut(Event)) {
        // Release held notes first, exactly like NoteSequencer: a stop or a loop wrap must not leave
        // the monophonic voice gated with no note left to release it.
        let read = flags.has(BlockFlags::TRANSPORTING | BlockFlags::PLAYING);
        if !read || flags.discontinuous() {
            self.retainer.drain_all(|retained|
                sink(Event::NoteComplete {id: retained.id, position: from, pitch: retained.pitch}));
        } else {
            self.retainer.drain_linear_completed(to, |retained| {
                let position = retained.position + retained.duration;
                let position = if position < from {from} else if position > to {to} else {position};
                sink(Event::NoteComplete {id: retained.id, position, pitch: retained.pitch});
            });
        }
        if !read || !self.enabled {return}
        let step_pulses = SEMI_QUAVER;
        // Every step boundary in the HALF-OPEN range [from, to). Half-open is what makes adjacent
        // blocks tile without gaps or overlap: a boundary belongs to exactly one block, so no step
        // is dropped at transport start and none is emitted twice (a doubled note-on would deplete
        // the accent cap twice, which is audible as a weak accent).
        let first = ceil(from / step_pulses) as i64;
        let last = floor(to / step_pulses) as i64;
        for index in first..=last {
            let position = index as f64 * step_pulses;
            if position < from || position >= to {continue}
            let step = self.patterns[self.index][(index.rem_euclid(self.lengths[self.index] as i64)) as usize];
            if !step.gate {continue}
            let duration = step.duration_steps(self.gate_fraction) * step_pulses;
            let id = self.next_id;
            self.next_id += 1;
            sink(Event::NoteStart {id, position, duration,
                                   pitch: step.note, cent: 0.0, velocity: step.velocity()});
            self.retainer.add_and_retain(RetainedNote {position, duration, id, pitch: step.note});
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine_env::note_event_source::NoteEventSource;

    fn gated(note: u8, slide: bool, accent: bool) -> Step {
        Step {note, gate: true, slide, accent}
    }

    fn playing() -> BlockFlags {
        BlockFlags::create(true, false, true, false)
    }

    fn collect(source: &mut CubedPatternSource, from: f64, to: f64) -> Vec<Event> {
        let mut out = Vec::new();
        source.process_notes(from, to, playing(), &mut |event| out.push(event));
        out
    }

    fn source_with(steps: &[Step], length: usize) -> CubedPatternSource {
        let mut source = CubedPatternSource::new(0.55);
        source.set_pattern(steps, length);
        source.set_enabled(true);
        source
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
    fn a_disabled_pattern_emits_nothing() {
        let mut source = source_with(&[gated(36, false, false)], 1);
        source.set_enabled(false);
        assert!(collect(&mut source, 0.0, SEMI_QUAVER * 4.0).is_empty());
    }

    #[test]
    fn steps_land_on_semiquaver_boundaries() {
        let mut source = source_with(&[gated(36, false, false), gated(43, false, false)], 2);
        let events = collect(&mut source, 0.0, SEMI_QUAVER * 2.5);
        let starts: Vec<(f64, u8)> = events.iter().filter_map(|event| match event {
            Event::NoteStart {position, pitch, ..} => Some((*position, *pitch)),
            _ => None
        }).collect();
        assert_eq!(starts, vec![(0.0, 36), (SEMI_QUAVER, 43), (SEMI_QUAVER * 2.0, 36)]);
    }

    #[test]
    fn a_step_boundary_is_never_emitted_twice_across_adjacent_blocks() {
        let mut source = source_with(&[gated(36, false, false)], 1);
        let first = collect(&mut source, 0.0, SEMI_QUAVER);
        let second = collect(&mut source, SEMI_QUAVER, SEMI_QUAVER * 2.0);
        let count = |events: &[Event]| events.iter()
            .filter(|event| matches!(event, Event::NoteStart {position, ..} if *position == SEMI_QUAVER))
            .count();
        assert_eq!(count(&first) + count(&second), 1,
                   "a doubled note-on would deplete the accent cap twice");
    }

    #[test]
    fn an_accent_crosses_the_threshold_and_a_plain_step_does_not() {
        let mut source = source_with(&[gated(36, false, true), gated(38, false, false)], 2);
        let events = collect(&mut source, 0.0, SEMI_QUAVER * 2.5);
        let velocities: Vec<f32> = events.iter().filter_map(|event| match event {
            Event::NoteStart {velocity, ..} => Some(*velocity),
            _ => None
        }).collect();
        assert!(velocities[0] >= ACCENT_THRESHOLD, "step 0 is accented");
        assert!(velocities[1] < ACCENT_THRESHOLD, "step 1 is plain");
        // and with margin, so a quantising hop cannot push it under the line
        assert!(velocities[0] - ACCENT_THRESHOLD > 0.1, "accent must clear the threshold, not sit on it");
    }

    #[test]
    fn a_slide_overlaps_the_next_step_and_a_plain_step_does_not() {
        let mut slide = source_with(&[gated(36, true, false)], 1);
        let mut plain = source_with(&[gated(36, false, false)], 1);
        let span = |events: &[Event]| events.iter().find_map(|event| match event {
            Event::NoteStart {duration, ..} => Some(*duration),
            _ => None
        }).expect("a note");
        assert!(span(&collect(&mut slide, 0.0, SEMI_QUAVER * 1.5)) > SEMI_QUAVER,
                "a slide must outlast its step or it is a retrigger");
        assert!(span(&collect(&mut plain, 0.0, SEMI_QUAVER * 1.5)) < SEMI_QUAVER,
                "a plain step must end before the next begins");
    }

    #[test]
    fn a_note_completes_when_its_span_ends() {
        let mut source = source_with(&[gated(36, false, false)], 4);
        collect(&mut source, 0.0, SEMI_QUAVER * 1.5);
        let later = collect(&mut source, SEMI_QUAVER * 1.5, SEMI_QUAVER * 3.0);
        assert!(later.iter().any(|event| matches!(event, Event::NoteComplete {pitch: 36, ..})));
    }

    #[test]
    fn a_transport_stop_releases_everything_held() {
        let mut source = source_with(&[gated(36, true, false)], 4);
        collect(&mut source, 0.0, SEMI_QUAVER * 1.2);
        let mut out = Vec::new();
        // not transporting: the voice must not be left gated
        source.process_notes(SEMI_QUAVER * 1.2, SEMI_QUAVER * 2.0,
                             BlockFlags::create(false, false, false, false), &mut |event| out.push(event));
        assert!(out.iter().any(|event| matches!(event, Event::NoteComplete {..})));
    }

    #[test]
    fn the_pattern_wraps_at_its_length_not_at_the_array() {
        let steps = [gated(36, false, false), gated(43, false, false), gated(99, false, false)];
        let mut source = source_with(&steps, 2);
        let events = collect(&mut source, 0.0, SEMI_QUAVER * 4.5);
        let pitches: Vec<u8> = events.iter().filter_map(|event| match event {
            Event::NoteStart {pitch, ..} => Some(*pitch),
            _ => None
        }).collect();
        assert!(!pitches.contains(&99), "step 2 is outside the pattern length");
    }
}

/// Field keys on `CubedDeviceBox` / `CubedPattern`.
pub const PATTERN_INDEX_KEY: u16 = 20;
pub const PATTERNS_KEY: u16 = 30;
pub const LENGTH_KEY: u16 = 1;
pub const STEPS_KEY: u16 = 2;

/// Loads ALL patterns and the selected index out of the box graph into `source`.
///
/// The array is fixed and every pattern always exists, so there is no membership to track and a
/// missing value can only mean a malformed box - those fall back to silence rather than a guess.
pub fn load_from_graph(graph: &boxgraph::graph::BoxGraph, uuid: boxgraph::address::Uuid,
                       source: &mut CubedPatternSource) {
    use boxgraph::address::Address;
    use boxgraph::field::FieldValue;
    let index = graph.field_value(&Address::of(uuid, alloc::vec![PATTERN_INDEX_KEY]))
        .and_then(FieldValue::as_int32).unwrap_or(0).max(0) as usize;
    source.set_index(index);
    for pattern in 0..PATTERN_COUNT {
        let key = pattern as u16;
        let length = graph.field_value(&Address::of(uuid, alloc::vec![PATTERNS_KEY, key, LENGTH_KEY]))
            .and_then(FieldValue::as_int32).unwrap_or(16).max(1) as usize;
        let steps: alloc::vec::Vec<Step> =
            match graph.field_value(&Address::of(uuid, alloc::vec![PATTERNS_KEY, key, STEPS_KEY])) {
                Some(FieldValue::Array(elements)) =>
                    elements.iter().filter_map(FieldValue::as_int32).map(Step::unpack).collect(),
                _ => alloc::vec::Vec::new()
            };
        source.set_pattern_at(pattern, &steps, length);
    }
}

/// The unit's track notes and the device's internal pattern, as ONE source.
///
/// Both are peers: the device's `NoteMerger` resolves them by last-note priority into its single
/// voice, which is exactly the agreed policy. Upstream is pulled FIRST so that when a track note and
/// a pattern step land on the same pulse, the pattern (the thing the user just started) wins the
/// voice, rather than the order depending on chain construction.
pub struct MergedNoteSource {
    upstream: alloc::rc::Rc<core::cell::RefCell<dyn engine_env::note_event_source::NoteEventSource>>,
    /// Shared so the field subscriptions can push edits in without re-wiring the chain (re-wiring
    /// mid-play would rebuild the note source and drop notes retained across blocks).
    pattern: alloc::rc::Rc<core::cell::RefCell<CubedPatternSource>>
}

impl MergedNoteSource {
    pub fn new(upstream: alloc::rc::Rc<core::cell::RefCell<dyn engine_env::note_event_source::NoteEventSource>>,
               pattern: alloc::rc::Rc<core::cell::RefCell<CubedPatternSource>>) -> Self {
        Self {upstream, pattern}
    }
}

impl engine_env::note_event_source::NoteEventSource for MergedNoteSource {
    fn process_notes(&mut self, from: f64, to: f64, flags: BlockFlags, sink: &mut dyn FnMut(Event)) {
        self.upstream.borrow_mut().process_notes(from, to, flags, sink);
        self.pattern.borrow_mut().process_notes(from, to, flags, sink);
    }
}
