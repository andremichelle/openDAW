//! The note content of an audio unit, the adapter analog the sequencer reads each block (TS reads
//! `adapter.tracks.collection` -> note tracks -> `regions.collection.iterateRange`). It visits each
//! active note region overlapping `[from, to)` with its loopable span and its region-local events; the
//! sequencer resolves looping + retaining. The engine implements this over the box-graph bindings.

use value::event::EventCollection;
use value::note::NoteEvent;
use crate::note_region::NoteRegion;

pub trait NoteRegionSource {
    fn for_each_region(&self, from: f64, to: f64, visit: &mut dyn FnMut(&NoteRegion, &EventCollection<NoteEvent>));
}
