//! A pull-based source of note-lifecycle events (`NoteEventSource` in TS): given a pulse range and the
//! block flags, it emits note-on / note-off `Event`s (ppqn positions) into a sink. The note sequencer
//! and every MIDI effect implement it; a MIDI effect chains by pulling its upstream source. Rust has
//! no generators, so TS's `yield` becomes a sink callback, alloc-free and still pull-ordered.

use crate::block_flags::BlockFlags;
use crate::event::Event;

pub trait NoteEventSource {
    fn process_notes(&mut self, from: f64, to: f64, flags: BlockFlags, sink: &mut dyn FnMut(Event));
    /// Live note injection (TS raw notes: the on-screen piano / pads / MIDI input). A raw note starts at the
    /// next block and sustains until its note-off. A source that cannot voice live notes ignores them.
    fn push_raw_note_on(&mut self, _pitch: u8, _velocity: f32) {}
    fn push_raw_note_off(&mut self, _pitch: u8) {}
    /// A scheduled one-shot preview note with a fixed duration in pulses (TS `auditionNote`).
    fn audition_note(&mut self, _pitch: u8, _duration: f64, _velocity: f32) {}
}
