//! EventSpanRetainer: descending-by-completion retention, linear release of completed spans (strict
//! `complete < position`, stopping at the first still-sounding span), full drain, and overlap query.

use value::event::{Event, EventSpan};
use value::retainer::EventSpanRetainer;

#[derive(Clone, Copy, Debug, PartialEq)]
struct Span {
    position: f64,
    duration: f64,
    tag: u32
}

impl Event for Span {
    fn position(&self) -> f64 {self.position}
}
impl EventSpan for Span {
    fn duration(&self) -> f64 {self.duration}
}

fn span(position: f64, duration: f64, tag: u32) -> Span {
    Span {position, duration, tag}
}

fn tags(spans: &[Span]) -> Vec<u32> {
    spans.iter().map(|span| span.tag).collect()
}

#[test]
fn releases_completed_spans_soonest_first_and_stops_at_a_sounding_span() {
    let mut retainer = EventSpanRetainer::new();
    retainer.add_and_retain(span(0.0, 10.0, 1)); // completes at 10
    retainer.add_and_retain(span(5.0, 20.0, 2)); // completes at 25
    retainer.add_and_retain(span(15.0, 5.0, 3)); // completes at 20
    assert_eq!(retainer.len(), 3);
    // at 11 only the span completing at 10 releases (20 and 25 still sound).
    assert_eq!(tags(&retainer.release_linear_completed(11.0)), vec![1]);
    // at 21 the span completing at 20 releases; the one completing at 25 stays.
    assert_eq!(tags(&retainer.release_linear_completed(21.0)), vec![3]);
    // strict: at exactly 25 the span completing at 25 does NOT release.
    assert!(retainer.release_linear_completed(25.0).is_empty());
    // past 25 it releases.
    assert_eq!(tags(&retainer.release_linear_completed(26.0)), vec![2]);
    assert!(retainer.is_empty());
}

#[test]
fn overlapping_yields_spans_sounding_at_a_position() {
    let mut retainer = EventSpanRetainer::new();
    retainer.add_and_retain(span(0.0, 10.0, 1)); // [0,10)
    retainer.add_and_retain(span(5.0, 20.0, 2)); // [5,25)
    retainer.add_and_retain(span(15.0, 5.0, 3)); // [15,20)
    let mut at8: Vec<u32> = retainer.overlapping(8.0).map(|span| span.tag).collect();
    at8.sort();
    assert_eq!(at8, vec![1, 2]);
    // at exactly 20: span [5,25) still sounds (20 < 25); [15,20) does not (20 == complete).
    let at20: Vec<u32> = retainer.overlapping(20.0).map(|span| span.tag).collect();
    assert_eq!(at20, vec![2]);
}

#[test]
fn release_all_drains_everything_including_infinite_spans() {
    let mut retainer = EventSpanRetainer::new();
    retainer.add_and_retain(span(0.0, f64::INFINITY, 1)); // a held (gate-open) note
    retainer.add_and_retain(span(5.0, 10.0, 2));
    assert_eq!(retainer.release_all().len(), 2);
    assert!(retainer.is_empty());
}
