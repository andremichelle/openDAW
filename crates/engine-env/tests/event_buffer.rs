//! The runtime Event enum + EventBuffer (ported from core-processors `EventBuffer`): events bucket by
//! block index, preserve insertion order within a bucket, `get` on an empty index yields nothing, and
//! `position()` reads through every variant.

use engine_env::event::Event;
use engine_env::event_buffer::EventBuffer;

fn note_start(id: u64, position: f64, pitch: u8) -> Event {
    Event::NoteStart {id, position, duration: 240.0, pitch, cent: 0.0, velocity: 0.8}
}

#[test]
fn position_reads_through_every_variant() {
    assert_eq!(note_start(1, 120.0, 60).position(), 120.0);
    assert_eq!(Event::NoteComplete {id: 1, position: 360.0, pitch: 60}.position(), 360.0);
    assert_eq!(Event::Update {position: 480.0}.position(), 480.0);
}

#[test]
fn events_bucket_by_block_index_in_insertion_order() {
    let mut buffer = EventBuffer::new();
    buffer.add(0, Event::NoteComplete {id: 7, position: 0.0, pitch: 60}); // note-offs before note-ons
    buffer.add(0, note_start(8, 0.0, 64));
    buffer.add(1, Event::Update {position: 960.0});

    let block0 = buffer.get(0);
    assert_eq!(block0.len(), 2);
    assert!(matches!(block0[0], Event::NoteComplete {id: 7, ..}), "insertion order preserved");
    assert!(matches!(block0[1], Event::NoteStart {id: 8, ..}));
    assert_eq!(buffer.get(1).len(), 1);
}

#[test]
fn get_on_an_unused_index_is_empty() {
    let buffer = EventBuffer::new();
    assert!(buffer.get(3).is_empty());
    assert!(buffer.is_empty());
}

#[test]
fn for_each_visits_each_block_bucket() {
    let mut buffer = EventBuffer::new();
    buffer.add(0, note_start(1, 0.0, 60));
    buffer.add(2, note_start(2, 1920.0, 67));
    let mut visited = Vec::new();
    buffer.for_each(|index, events| visited.push((index, events.len())));
    assert_eq!(visited, vec![(0, 1), (2, 1)]);
}

#[test]
fn clear_empties_the_buffer() {
    let mut buffer = EventBuffer::new();
    buffer.add(0, note_start(1, 0.0, 60));
    buffer.clear();
    assert!(buffer.is_empty());
    assert!(buffer.get(0).is_empty());
    let mut visited = 0;
    buffer.for_each(|_, _| visited += 1);
    assert_eq!(visited, 0, "for_each skips emptied buckets");
}

#[test]
fn clear_keeps_the_bucket_storage_for_reuse() {
    // The render path clears once per quantum; the bucket Vec must be REUSED (same storage), never
    // freed and re-allocated. The slice pointer proves it: it only changes on a re-allocation.
    let mut buffer = EventBuffer::new();
    buffer.add(0, note_start(1, 0.0, 60));
    let before = buffer.get(0).as_ptr();
    buffer.clear();
    buffer.add(0, note_start(2, 0.0, 64));
    assert_eq!(buffer.get(0).as_ptr(), before, "the emptied bucket's storage is reused");
}
