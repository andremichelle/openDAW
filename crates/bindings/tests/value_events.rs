//! Read a single ValueEventBox into a ValueEvent via read_value_event: its primitive fields, the
//! three interpolation modes (none / linear / curve resolved from an attached ValueEventCurveBox),
//! and the panic when a mandatory field is missing. (Sorted membership is covered by the
//! ValueCollection tests, which drive read_value_event through the real incremental path.)

use boxgraph::address::{Address, Uuid};
use boxgraph::boxes::GraphBox;
use boxgraph::field::{FieldValue, Fields};
use boxgraph::graph::BoxGraph;
use bindings::value_events::read_value_event;
use value::value::Interpolation;

const EVENT: Uuid = [2u8; 16];
const CURVE: Uuid = [5u8; 16];

fn graph_box(uuid: Uuid, name: &str, fields: &[(u16, FieldValue)]) -> GraphBox {
    let mut map = Fields::new();
    for (key, value) in fields {
        map.insert(*key, value.clone());
    }
    GraphBox {creation_index: 0, name: name.to_string(), uuid, fields: map}
}

fn event_box(position: i32, value: f32, interpolation: i32) -> GraphBox {
    graph_box(EVENT, "ValueEventBox", &[
        (10, FieldValue::Int32(position)),
        (11, FieldValue::Int32(0)),
        (12, FieldValue::Int32(interpolation)),
        (13, FieldValue::Float32(value))
    ])
}

#[test]
fn reads_primitive_fields() {
    let graph = BoxGraph::from_boxes(vec![event_box(960, 110.0, 1)]);
    let event = read_value_event(&graph, EVENT);
    assert_eq!(event.position, 960.0);
    assert_eq!(event.value, 110.0);
    assert_eq!(event.index, 0);
}

#[test]
fn resolves_linear_and_none() {
    let linear = BoxGraph::from_boxes(vec![event_box(0, 100.0, 1)]);
    assert_eq!(read_value_event(&linear, EVENT).interpolation, Interpolation::Linear);
    let none = BoxGraph::from_boxes(vec![event_box(0, 100.0, 0)]);
    assert_eq!(read_value_event(&none, EVENT).interpolation, Interpolation::None);
}

#[test]
fn resolves_curve_from_attached_curve_box() {
    let graph = BoxGraph::from_boxes(vec![
        event_box(0, 100.0, 0), // interpolation field is 0, but a curve box is attached
        graph_box(CURVE, "ValueEventCurveBox", &[
            (1, FieldValue::Pointer(Some(Address::of(EVENT, vec![12])))),
            (2, FieldValue::Float32(0.3))
        ])
    ]);
    assert_eq!(read_value_event(&graph, EVENT).interpolation, Interpolation::Curve(0.3));
}

#[test]
#[should_panic(expected = "ValueEventBox.position (Int32)")]
fn missing_position_panics() {
    let mut malformed = Fields::new();
    malformed.insert(13, FieldValue::Float32(100.0)); // value present, position missing
    let graph = BoxGraph::from_boxes(vec![
        GraphBox {creation_index: 0, name: "ValueEventBox".to_string(), uuid: EVENT, fields: malformed}
    ]);
    let _ = read_value_event(&graph, EVENT);
}
