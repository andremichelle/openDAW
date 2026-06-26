//! Read a `ValueEventBox` into an owned `ValueEvent` for evaluation (the per-box reads `ValueCollection`
//! drives incrementally). An event box carries position (key 10, Int32), index (key 11), value
//! (key 13, Float32), and interpolation (key 12, Int32: 0 = None, 1 = Linear). A curve is a separate
//! `ValueEventCurveBox` whose `event` pointer (key 1) targets the event's interpolation field (key 12)
//! and whose `slope` (key 2, Float32) gives the curve shape.

use alloc::vec;
use alloc::vec::Vec;
use boxgraph::address::{Address, Uuid};
use boxgraph::field::FieldValue;
use boxgraph::graph::BoxGraph;
use value::value::{Interpolation, ValueEvent};

// WASM CONTRACT: generated box field keys (studio-boxes). Keep in lockstep with the forge schema.
pub const COLLECTION_EVENTS: u16 = 1; // ValueEventCollectionBox.events (hub)
const EVENT_POSITION: u16 = 10; // ValueEventBox.position (Int32 pulses)
const EVENT_INDEX: u16 = 11; // ValueEventBox.index (Int32)
pub const EVENT_INTERPOLATION: u16 = 12; // ValueEventBox.interpolation (Int32: 0 none, 1 linear); curve pointers attach here
const EVENT_VALUE: u16 = 13; // ValueEventBox.value (Float32)
const CURVE_EVENT: u16 = 1; // ValueEventCurveBox.event (pointer at an event's interpolation field)
const CURVE_SLOPE: u16 = 2; // ValueEventCurveBox.slope (Float32)
const INTERPOLATION_NONE: i32 = 0;

const CURVE_BOX: &str = "ValueEventCurveBox";

/// Read one member `ValueEventBox` into a `ValueEvent`. `position` and `value` are mandatory schema
/// fields, so a member missing them is a corrupt mirror and panics (rather than silently dropping the
/// event). `index` defaults to 0 (a harmless tiebreak) and `interpolation` to Linear. This is the
/// per-box read the incremental observer calls on each Added / property edit.
pub fn read_value_event(graph: &BoxGraph, event_uuid: Uuid) -> ValueEvent {
    let field = |key: u16| graph.field_value(&Address::of(event_uuid, vec![key]));
    let position = field(EVENT_POSITION).and_then(FieldValue::as_int32).expect("ValueEventBox.position (Int32)") as f64;
    let value = field(EVENT_VALUE).and_then(FieldValue::as_float32).expect("ValueEventBox.value (Float32)");
    let index = field(EVENT_INDEX).and_then(FieldValue::as_int32).unwrap_or(0);
    ValueEvent::new(position, index, value, read_interpolation(graph, event_uuid))
}

/// The `ValueEventCurveBox` uuids attached to an event's interpolation field (its incoming curve
/// pointers).
fn curves_of_event(graph: &BoxGraph, event_uuid: Uuid) -> Vec<Uuid> {
    let interpolation = Address::of(event_uuid, vec![EVENT_INTERPOLATION]);
    graph.incoming(&interpolation)
        .iter()
        .map(|source| source.uuid)
        .filter(|uuid| graph.find_box(uuid).map(|graph_box| graph_box.name.as_str()) == Some(CURVE_BOX))
        .collect()
}

/// If `uuid` is a `ValueEventCurveBox`, the event uuid its `event` pointer targets. Lets an observer
/// map a curve-box edit (e.g. a slope change) back to the event the curve shapes.
pub fn event_of_curve(graph: &BoxGraph, uuid: Uuid) -> Option<Uuid> {
    if graph.find_box(&uuid).map(|graph_box| graph_box.name.as_str()) != Some(CURVE_BOX) {
        return None;
    }
    graph.target_of(&Address::of(uuid, vec![CURVE_EVENT])).map(|target| target.uuid)
}

fn read_interpolation(graph: &BoxGraph, event_uuid: Uuid) -> Interpolation {
    for curve_uuid in curves_of_event(graph, event_uuid) {
        if let Some(slope) = graph.field_value(&Address::of(curve_uuid, vec![CURVE_SLOPE])).and_then(FieldValue::as_float32) {
            return Interpolation::curve(slope);
        }
    }
    match graph.field_value(&Address::of(event_uuid, vec![EVENT_INTERPOLATION])).and_then(FieldValue::as_int32) {
        Some(value) if value == INTERPOLATION_NONE => Interpolation::None,
        _ => Interpolation::Linear
    }
}
