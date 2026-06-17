//! ValueEvent evaluation: the Interpolation.curve collapse, interpolate per mode, value_at across
//! all positional cases (empty / before / after / on-event / between linear|none|curve), next_event,
//! and iterate_window (mirroring lib-dsp value.test.ts, including the rightmost-equal-position case).

use value::event::EventCollection;
use value::value::{interpolate, iterate_window, next_event, value_at, Interpolation, ValueEvent};

const EPS: f32 = 1e-4;

fn event(position: f64, value: f32, interpolation: Interpolation) -> ValueEvent {
    ValueEvent::new(position, 0, value, interpolation)
}

fn collection(events: &[ValueEvent]) -> EventCollection<ValueEvent> {
    let mut collection = EventCollection::new();
    for event in events {
        collection.add(*event);
    }
    collection
}

#[test]
fn curve_of_half_collapses_to_linear() {
    assert_eq!(Interpolation::curve(0.5), Interpolation::Linear);
    assert_eq!(Interpolation::curve(0.3), Interpolation::Curve(0.3));
}

#[test]
fn interpolate_per_mode() {
    let a_none = event(0.0, 10.0, Interpolation::None);
    let a_linear = event(0.0, 10.0, Interpolation::Linear);
    let a_curve = event(0.0, 10.0, Interpolation::Curve(0.25));
    let b = event(100.0, 20.0, Interpolation::Linear);
    assert_eq!(interpolate(&a_none, &b, 50.0), 10.0, "none holds a.value");
    assert!((interpolate(&a_linear, &b, 50.0) - 15.0).abs() < EPS, "linear midpoint");
    let curved = interpolate(&a_curve, &b, 50.0);
    assert!(curved > 10.0 && curved < 20.0, "curve stays within the segment");
    assert!((curved - 15.0).abs() > EPS, "curve (slope 0.25) differs from the linear midpoint");
}

#[test]
fn value_at_empty_returns_fallback() {
    let events = collection(&[]);
    assert_eq!(value_at(&events, 100.0, -1.0), -1.0);
}

#[test]
fn value_at_holds_before_first_and_after_last() {
    let events = collection(&[event(100.0, 5.0, Interpolation::Linear), event(200.0, 9.0, Interpolation::Linear)]);
    assert_eq!(value_at(&events, 0.0, -1.0), 5.0, "before first holds first value");
    assert_eq!(value_at(&events, 300.0, -1.0), 9.0, "after last holds last value");
}

#[test]
fn value_at_on_an_event_returns_its_value() {
    let events = collection(&[event(100.0, 5.0, Interpolation::Linear), event(200.0, 9.0, Interpolation::Linear)]);
    assert_eq!(value_at(&events, 100.0, -1.0), 5.0);
}

#[test]
fn value_at_between_linear() {
    let events = collection(&[event(0.0, 0.0, Interpolation::Linear), event(100.0, 10.0, Interpolation::Linear)]);
    assert!((value_at(&events, 25.0, -1.0) - 2.5).abs() < EPS);
    assert!((value_at(&events, 50.0, -1.0) - 5.0).abs() < EPS);
}

#[test]
fn value_at_between_none_is_a_step() {
    let events = collection(&[event(0.0, 0.0, Interpolation::None), event(100.0, 10.0, Interpolation::Linear)]);
    assert_eq!(value_at(&events, 50.0, -1.0), 0.0, "none holds the previous value until the next event");
    assert_eq!(value_at(&events, 100.0, -1.0), 10.0);
}

#[test]
fn value_at_between_curve_matches_curve_module() {
    let events = collection(&[event(0.0, 0.0, Interpolation::Curve(0.25)), event(100.0, 10.0, Interpolation::Linear)]);
    let expected = math::curve::value_at(0.25, 100.0, 0.0, 10.0, 50.0);
    assert!((value_at(&events, 50.0, -1.0) - expected).abs() < EPS);
}

#[test]
fn value_at_multi_event() {
    let events = collection(&[
        event(0.0, 0.0, Interpolation::Linear),
        event(100.0, 10.0, Interpolation::None),
        event(200.0, 20.0, Interpolation::Linear)
    ]);
    assert!((value_at(&events, 50.0, -1.0) - 5.0).abs() < EPS, "linear in first segment");
    assert_eq!(value_at(&events, 150.0, -1.0), 10.0, "none-step in second segment");
}

#[test]
fn next_event_walks_then_ends() {
    let a = event(0.0, 0.0, Interpolation::Linear);
    let b = event(100.0, 1.0, Interpolation::Linear);
    let events = collection(&[a, b]);
    assert_eq!(next_event(&events, &a).map(|event| event.position), Some(100.0));
    assert!(next_event(&events, &b).is_none(), "last event has no successor");
}

// --- iterate_window, mirroring lib-dsp value.test.ts ---

const BAR: f64 = 3840.0;
const QUARTER: f64 = 960.0;

#[test]
fn window_empty() {
    let events = collection(&[]);
    assert_eq!(iterate_window(&events, 0.0, 1.0).count(), 0);
}

#[test]
fn window_one() {
    let only = event(0.0, 0.0, Interpolation::Linear);
    let events = collection(&[only]);
    let window: Vec<f64> = iterate_window(&events, 0.0, 1.0).map(|event| event.position).collect();
    assert_eq!(window, vec![0.0]);
}

#[test]
fn window_two_out_picks_rightmost_equal_position() {
    // A0 and A1 share position 0; B is far out. From Bar, floor lands on the rightmost (A1).
    let a0 = ValueEvent::new(0.0, 0, 0.0, Interpolation::Linear);
    let a1 = ValueEvent::new(0.0, 1, 0.0, Interpolation::Linear);
    let b = ValueEvent::new(BAR * 3.0, 0, 0.0, Interpolation::Linear);
    let events = collection(&[a1, a0, b]);
    let window: Vec<(f64, i32)> = iterate_window(&events, BAR, BAR * 2.0).map(|event| (event.position, event.index)).collect();
    assert_eq!(window, vec![(0.0, 1), (BAR * 3.0, 0)]);
}

#[test]
fn window_two_in() {
    let a = event(QUARTER, 0.0, Interpolation::Linear);
    let b = event(QUARTER * 3.0, 0.0, Interpolation::Linear);
    let events = collection(&[b, a]);
    let window: Vec<f64> = iterate_window(&events, 0.0, BAR).map(|event| event.position).collect();
    assert_eq!(window, vec![QUARTER, QUARTER * 3.0]);
}
