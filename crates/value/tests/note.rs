//! NoteEvent: ordering (position then pitch), span completion, and use inside an EventCollection.

use value::event::{Event, EventCollection, EventSpan};
use value::note::NoteEvent;

#[test]
fn complete_is_position_plus_duration() {
    let note = NoteEvent::new(960.0, 240.0, 60, 0.0, 0.8);
    assert_eq!(note.position(), 960.0);
    assert_eq!(note.duration(), 240.0);
    assert_eq!(note.complete(), 1200.0);
}

#[test]
fn orders_by_position_then_pitch() {
    let mut collection = EventCollection::new();
    collection.add(NoteEvent::new(960.0, 240.0, 67, 0.0, 0.8));
    collection.add(NoteEvent::new(0.0, 240.0, 64, 0.0, 0.8));
    collection.add(NoteEvent::new(0.0, 240.0, 60, 0.0, 0.8)); // same position, lower pitch -> first
    let pitches: Vec<u8> = collection.as_slice().iter().map(|note| note.pitch).collect();
    assert_eq!(pitches, vec![60, 64, 67]);
}

#[test]
fn iterate_range_finds_notes_starting_in_the_window() {
    let mut collection = EventCollection::new();
    collection.add(NoteEvent::new(0.0, 240.0, 60, 0.0, 0.8));
    collection.add(NoteEvent::new(480.0, 240.0, 62, 0.0, 0.8));
    collection.add(NoteEvent::new(960.0, 240.0, 64, 0.0, 0.8));
    let pitches: Vec<u8> = collection.iterate_range(480.0, 961.0).map(|note| note.pitch).collect();
    assert_eq!(pitches, vec![62, 64]);
}
