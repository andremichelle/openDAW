//! Bridges a `NoteEventSource` into an instrument's `event_input` (TS `NoteEventInstrument`). Per block
//! `fill` pulls the source's note events for the block's pulse range, sorts them (note-off before
//! note-on at equal position, TS `NoteLifecycleEvent.Comparator`), and adds them under the block index.
//! An instrument calls this from its `introduce_block` hook. (TS also drives a note broadcaster for the
//! UI; that telemetry is deferred.)

use alloc::rc::Rc;
use alloc::vec::Vec;
use core::cell::RefCell;
use core::cmp::Ordering;
use crate::block::Block;
use crate::event::Event;
use crate::event_buffer::EventBuffer;
use crate::note_event_source::NoteEventSource;

pub type SharedNoteEventSource = Rc<RefCell<dyn NoteEventSource>>;

pub struct NoteEventInstrument {
    source: Option<SharedNoteEventSource>,
    scratch: Vec<Event>
}

impl NoteEventInstrument {
    pub fn new() -> Self {
        Self {source: None, scratch: Vec::with_capacity(64)} // pre-reserve: the first eventful block must not allocate mid-render
    }

    pub fn set_note_event_source(&mut self, source: SharedNoteEventSource) {
        self.source = Some(source);
    }

    /// The bound note source (a cheap `Rc` clone), or `None` if unset. The host hands this to the
    /// event-pull facade so a device can pull its own notes for a range.
    pub fn source(&self) -> Option<SharedNoteEventSource> {
        self.source.clone()
    }

    /// Pull the source's events for `block`, sort them, and add them to `event_input` under the block
    /// index. No-op when no source is set.
    pub fn fill(&mut self, block: &Block, event_input: &mut EventBuffer) {
        let source = match &self.source {
            Some(source) => source.clone(),
            None => return
        };
        self.scratch.clear();
        source.borrow_mut().process_notes(block.p0, block.p1, block.flags, &mut |event| self.scratch.push(event));
        self.scratch.sort_by(compare_lifecycle);
        for &event in &self.scratch {
            event_input.add(block.index, event);
        }
    }
}

impl Default for NoteEventInstrument {
    fn default() -> Self {
        Self::new()
    }
}

// TS `NoteLifecycleEvent.Comparator`: by position; at equal position a note-complete (off) sorts before
// a note-start (on). A note source never emits update events.
fn compare_lifecycle(a: &Event, b: &Event) -> Ordering {
    match a.position().partial_cmp(&b.position()) {
        Some(Ordering::Equal) | None => rank(a).cmp(&rank(b)),
        Some(order) => order
    }
}

fn rank(event: &Event) -> u8 {
    match event {
        Event::NoteComplete {..} => 0,
        _ => 1
    }
}
