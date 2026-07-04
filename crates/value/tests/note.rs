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

#[test]
fn remove_takes_the_exact_duplicate_not_an_arbitrary_equal_one() {
    // Two notes share (position, pitch) — the Ord key — but differ in payload. Removing one must remove
    // THAT one (TS removes by identity); an arbitrary equal-run removal desyncs the box mirror.
    use value::event::EventCollection;
    use value::note::NoteEvent;
    let short = NoteEvent::new(0.0, 100.0, 60, 0.0, 0.5);
    let long = NoteEvent::new(0.0, 400.0, 60, 0.0, 1.0);
    let mut collection = EventCollection::new();
    collection.add(short);
    collection.add(long);
    assert!(collection.remove(&short), "the exact payload is found");
    assert_eq!(collection.len(), 1);
    let kept = collection.as_slice()[0];
    assert_eq!(kept.duration, 400.0, "the OTHER duplicate survives untouched");
    assert_eq!(kept.velocity, 1.0);
}

#[test]
fn duplicates_keep_insertion_order() {
    // TS appends + stable-sorts, so equal (position, pitch) notes iterate in insertion order — the chance
    // RNG roll order depends on it.
    use value::event::EventCollection;
    use value::note::NoteEvent;
    let first = NoteEvent::new(0.0, 100.0, 60, 0.0, 0.1);
    let second = NoteEvent::new(0.0, 200.0, 60, 0.0, 0.2);
    let third = NoteEvent::new(0.0, 300.0, 60, 0.0, 0.3);
    let mut collection = EventCollection::new();
    collection.add(first);
    collection.add(second);
    collection.add(third);
    let velocities: Vec<f32> = collection.as_slice().iter().map(|note| note.velocity).collect();
    assert_eq!(velocities, vec![0.1, 0.2, 0.3], "insertion order within the equal run");
}
