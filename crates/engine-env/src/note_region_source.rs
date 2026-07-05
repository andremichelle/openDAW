//! The note content of an audio unit, the adapter analog the sequencer reads each block (TS reads
//! `adapter.tracks.collection` -> note tracks -> regions / clips). The source visits each NOTE track
//! with an accessor exposing its timeline regions (range query) and its launched-clip content, so the
//! sequencer can split the block into clip sections per track (TS `clipSequencing.iterate`) and read
//! the right content per section. The engine implements this over the box-graph bindings.

use value::event::EventCollection;
use value::note::NoteEvent;
use crate::note_region::NoteRegion;

pub trait NoteTrackAccess {
    /// Visit each active note region overlapping `[from, to)` with its loopable span and its
    /// region-local events; the sequencer resolves looping + retaining.
    fn for_each_region(&self, from: f64, to: f64, visit: &mut dyn FnMut(&NoteRegion, &EventCollection<NoteEvent>));
    /// A clip's live `(duration, looped)`; `None` when the clip vanished.
    fn clip_info(&self, clip: &[u8; 16]) -> Option<(f64, bool)>;
    /// Visit a clip's note events; an absent clip visits nothing.
    fn clip_events(&self, clip: &[u8; 16], visit: &mut dyn FnMut(&EventCollection<NoteEvent>));
}

pub trait NoteRegionSource {
    /// Visit each NOTE track: its `TrackBox` uuid plus the accessor for its content.
    fn for_each_track(&self, visit: &mut dyn FnMut(&[u8; 16], &dyn NoteTrackAccess));
}
