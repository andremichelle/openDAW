//! A pull-based source of note-lifecycle events (`NoteEventSource` in TS): given a pulse range and the
//! block flags, it emits note-on / note-off `Event`s (ppqn positions) into a sink. The note sequencer
//! and every MIDI effect implement it; a MIDI effect chains by pulling its upstream source. Rust has
//! no generators, so TS's `yield` becomes a sink callback, alloc-free and still pull-ordered.

use crate::block_flags::BlockFlags;
use crate::event::Event;

pub trait NoteEventSource {
    fn process_notes(&mut self, from: f64, to: f64, flags: BlockFlags, sink: &mut dyn FnMut(Event));
}
