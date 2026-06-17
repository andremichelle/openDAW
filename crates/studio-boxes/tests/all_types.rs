//! Coverage guarantee: build a default instance of EVERY box type in the registry (from its
//! schema) and round-trip them all through the graph. Proves every type's field layout — including
//! nested objects, arrays, pointers and hooks — serializes and deserializes correctly in Rust.

use boxgraph::boxes::GraphBox;
use boxgraph::field::{FieldType, FieldValue, Fields, Schema};
use boxgraph::graph::BoxGraph;
use studio_boxes::registry;

fn default_value(field_type: &FieldType) -> FieldValue {
    match field_type {
        FieldType::Int32 => FieldValue::Int32(0),
        FieldType::Float32 => FieldValue::Float32(0.0),
        FieldType::Boolean => FieldValue::Boolean(false),
        FieldType::String => FieldValue::String(String::new()),
        FieldType::Bytes => FieldValue::Bytes(Vec::new()),
        FieldType::Pointer => FieldValue::Pointer(None),
        FieldType::Hook => FieldValue::Hook,
        FieldType::Object(schema) => FieldValue::Object(default_fields(schema)),
        FieldType::Array {element, length} =>
            FieldValue::Array((0..*length).map(|_| default_value(element)).collect())
    }
}

fn default_fields(schema: &Schema) -> Fields {
    schema.iter().map(|(key, field_type)| (*key, default_value(field_type))).collect()
}

fn uuid_for(index: usize) -> [u8; 16] {
    let mut uuid = [0u8; 16];
    uuid[0..4].copy_from_slice(&(index as u32 + 1).to_be_bytes());
    uuid
}

#[test]
fn every_box_type_round_trips() {
    let registry = registry();
    let boxes: Vec<GraphBox> = registry.iter()
        .enumerate()
        .map(|(index, (name, schema))| GraphBox {
            creation_index: index as i32,
            name: name.clone(),
            uuid: uuid_for(index),
            fields: default_fields(schema)
        })
        .collect();
    let graph = BoxGraph::from_boxes(boxes.clone());
    assert_eq!(graph.box_count(), registry.len());
    let bytes = graph.to_bytes();
    let reloaded = BoxGraph::from_bytes(&bytes, &registry).expect("reload all box types");
    assert_eq!(reloaded.box_count(), registry.len());
    for original in &boxes {
        assert_eq!(reloaded.find_box(&original.uuid), Some(original),
            "round-trip mismatch for box type {}", original.name);
    }
    assert_eq!(reloaded.to_bytes(), bytes, "re-encoded bytes unstable");
}
