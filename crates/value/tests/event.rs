//! EventCollection: sorted insertion, binary-search index lookups (floor/ceil, lower/greater),
//! iterate_from windowing, and removal.

use value::event::EventCollection;
use value::value::{Interpolation, ValueEvent};

fn at(position: f64, index: i32) -> ValueEvent {
    ValueEvent::new(position, index, 0.0, Interpolation::Linear)
}

fn collection(positions: &[(f64, i32)]) -> EventCollection<ValueEvent> {
    let mut events = EventCollection::new();
    for &(position, index) in positions {
        events.add(at(position, index));
    }
    events
}

#[test]
fn add_keeps_sorted_by_position_then_index() {
    let events = collection(&[(30.0, 0), (10.0, 0), (20.0, 1), (20.0, 0)]);
    let order: Vec<(f64, i32)> = events.as_slice().iter().map(|event| (event.position, event.index)).collect();
    assert_eq!(order, vec![(10.0, 0), (20.0, 0), (20.0, 1), (30.0, 0)]);
}

#[test]
fn basic_accessors() {
    let events = collection(&[(10.0, 0), (20.0, 0), (30.0, 0)]);
    assert_eq!(events.len(), 3);
    assert!(!events.is_empty());
    assert_eq!(events.first().unwrap().position, 10.0);
    assert_eq!(events.last().unwrap().position, 30.0);
    assert_eq!(events.at(1).unwrap().position, 20.0);
    assert!(events.at(3).is_none());
    assert!(EventCollection::<ValueEvent>::new().is_empty());
}

#[test]
fn floor_last_index() {
    let events = collection(&[(10.0, 0), (20.0, 0), (20.0, 1), (30.0, 0)]);
    assert_eq!(events.floor_last_index(5.0), -1, "before all");
    assert_eq!(events.floor_last_index(10.0), 0, "exact on first");
    assert_eq!(events.floor_last_index(15.0), 0, "between");
    assert_eq!(events.floor_last_index(20.0), 2, "equal positions -> rightmost");
    assert_eq!(events.floor_last_index(100.0), 3, "after all -> last");
}

#[test]
fn ceil_first_index() {
    let events = collection(&[(10.0, 0), (20.0, 0), (20.0, 1), (30.0, 0)]);
    assert_eq!(events.ceil_first_index(5.0), 0, "before all -> 0");
    assert_eq!(events.ceil_first_index(20.0), 1, "equal positions -> leftmost");
    assert_eq!(events.ceil_first_index(25.0), 3, "between -> next");
    assert_eq!(events.ceil_first_index(100.0), 4, "after all -> len");
}

#[test]
fn lower_and_greater_equal() {
    let events = collection(&[(10.0, 0), (20.0, 0), (30.0, 0)]);
    assert!(events.lower_equal(5.0).is_none());
    assert_eq!(events.lower_equal(25.0).unwrap().position, 20.0);
    assert_eq!(events.greater_equal(25.0).unwrap().position, 30.0);
    assert!(events.greater_equal(100.0).is_none());
}

#[test]
fn iterate_from_includes_event_at_or_before() {
    let events = collection(&[(10.0, 0), (20.0, 0), (30.0, 0)]);
    let from_before: Vec<f64> = events.iterate_from(0.0).map(|event| event.position).collect();
    assert_eq!(from_before, vec![10.0, 20.0, 30.0], "before first -> all");
    let from_middle: Vec<f64> = events.iterate_from(25.0).map(|event| event.position).collect();
    assert_eq!(from_middle, vec![20.0, 30.0], "starts at the event before the position");
    let from_exact: Vec<f64> = events.iterate_from(20.0).map(|event| event.position).collect();
    assert_eq!(from_exact, vec![20.0, 30.0], "includes the event on the position");
}

#[test]
fn schedule_queries_mirror_ts() {
    // positions 12 / 28 / 36 / 50, from lib-dsp events.test.ts "basic operations".
    let events = collection(&[(12.0, 0), (28.0, 0), (36.0, 0), (50.0, 0)]);
    assert_eq!(events.greater_equal(0.0).unwrap().position, 12.0);
    assert_eq!(events.greater_equal(8.0).unwrap().position, 12.0);
    assert_eq!(events.greater_equal(13.0).unwrap().position, 28.0);
    assert_eq!(events.greater_equal(29.0).unwrap().position, 36.0);
    assert_eq!(events.greater_equal(50.0).unwrap().position, 50.0);
    assert!(events.greater_equal(51.0).is_none());
    assert!(events.lower_equal(10.0).is_none());
    assert_eq!(events.lower_equal(12.0).unwrap().position, 12.0);
    assert_eq!(events.lower_equal(35.0).unwrap().position, 28.0);
    assert_eq!(events.lower_equal(70.0).unwrap().position, 50.0);
    let from5: Vec<f64> = events.iterate_from(5.0).map(|event| event.position).collect();
    assert_eq!(from5, vec![12.0, 28.0, 36.0, 50.0]);
    let from28: Vec<f64> = events.iterate_from(28.0).map(|event| event.position).collect();
    assert_eq!(from28, vec![28.0, 36.0, 50.0]);
    let from38: Vec<f64> = events.iterate_from(38.0).map(|event| event.position).collect();
    assert_eq!(from38, vec![36.0, 50.0]);
}

#[test]
fn iterate_range_mirrors_ts() {
    let events = collection(&[(12.0, 0), (28.0, 0), (36.0, 0), (50.0, 0)]);
    let range = |from: f64, to: f64| -> Vec<f64> {
        events.iterate_range(from, to).map(|event| event.position).collect()
    };
    assert_eq!(range(12.0, 51.0), vec![12.0, 28.0, 36.0, 50.0]);
    assert_eq!(range(15.0, 35.0), vec![28.0]);
    assert_eq!(range(30.0, 37.0), vec![36.0]);
    assert_eq!(range(31.0, 32.0), Vec::<f64>::new());
}

#[test]
fn remove() {
    let mut events = collection(&[(10.0, 0), (20.0, 0), (30.0, 0)]);
    assert!(events.remove(&at(20.0, 0)));
    assert_eq!(events.len(), 2);
    let positions: Vec<f64> = events.as_slice().iter().map(|event| event.position).collect();
    assert_eq!(positions, vec![10.0, 30.0]);
    assert!(!events.remove(&at(99.0, 0)), "removing a missing event returns false");
}
