// The cached per-box checksum must equal the full rolling XOR fold over every box in uuid order, whatever the box sizes
use std::collections::BTreeMap;
use boxgraph::address::{Address, Uuid};
use boxgraph::boxes::{GraphBox, Registry};
use boxgraph::bytes::ByteWriter;
use boxgraph::checksum::{checksum_fields, Checksum};
use boxgraph::field::{write_fields, FieldType, FieldValue, Fields, Schema};
use boxgraph::graph::BoxGraph;
use boxgraph::updates::Update;

fn uuid(index: u8) -> Uuid {
    let mut uuid = [0u8; 16];
    uuid[0] = index;
    uuid[15] = 0x5A;
    uuid
}

fn registry() -> Registry {
    Registry::from([("Blob".to_string(), Schema::from([(0, FieldType::Int32), (1, FieldType::String)]))])
}

fn fields(value: i32, text: &str) -> Fields {
    BTreeMap::from([(0, FieldValue::Int32(value)), (1, FieldValue::String(text.to_string()))])
}

fn settings(fields: &Fields) -> Vec<u8> {
    let mut writer = ByteWriter::new();
    write_fields(&mut writer, fields);
    writer.into_bytes()
}

// the reference: every box's fields through one Checksum, in uuid order
fn full(graph: &BoxGraph, uuids: &[Uuid]) -> [u8; 32] {
    let mut sorted = uuids.to_vec();
    sorted.sort();
    let mut checksum = Checksum::new();
    for uuid in sorted {
        if let Some(graph_box) = graph.find_box(&uuid) { checksum_fields(&mut checksum, &graph_box.fields); }
    }
    checksum.result()
}

#[test]
fn cached_checksum_matches_the_full_fold() {
    let registry = registry();
    let texts = ["", "a", "odd length text", &"x".repeat(31), &"y".repeat(33), &"state".repeat(4097)];
    let mut uuids: Vec<Uuid> = Vec::new();
    let initial: Vec<GraphBox> = (0..4u8).map(|index| {
        uuids.push(uuid(index * 2));
        GraphBox {creation_index: index as i32, name: "Blob".to_string(), uuid: uuid(index * 2), fields: fields(index as i32, texts[index as usize])}
    }).collect();
    let mut graph = BoxGraph::from_boxes(initial);
    assert_eq!(graph.checksum(), full(&graph, &uuids));
    for (step, text) in texts.iter().enumerate() {
        let created = uuid(step as u8 * 2 + 1);
        graph.transaction(&[Update::New {uuid: created, name: "Blob".to_string(), settings: settings(&fields(step as i32, text))}], &registry).unwrap();
        uuids.push(created);
        assert_eq!(graph.checksum(), full(&graph, &uuids), "after creating box {step}");
        let target = uuids[step % uuids.len()];
        let old = graph.find_box(&target).unwrap().fields[&1].clone();
        graph.transaction(&[Update::Primitive {
            address: Address::of(target, vec![1]), old, new: FieldValue::String(texts[(step + 3) % texts.len()].to_string())
        }], &registry).unwrap();
        assert_eq!(graph.checksum(), full(&graph, &uuids), "after editing box {step}");
    }
    let removed = uuids[1];
    let removed_fields = graph.find_box(&removed).unwrap().fields.clone();
    let deletion = [Update::Delete {uuid: removed, name: "Blob".to_string(), settings: settings(&removed_fields)}];
    graph.transaction(&deletion, &registry).unwrap();
    assert_eq!(graph.checksum(), full(&graph, &uuids), "after deleting");
    graph.abort(&deletion, &registry).unwrap();
    assert_eq!(graph.checksum(), full(&graph, &uuids), "after rolling the deletion back");
}

#[test]
#[ignore]
fn fold_speed_of_a_large_state() {
    let state = fields(1, &"ODV3".repeat(280_000));
    let started = std::time::Instant::now();
    for _ in 0..20 {
        let mut checksum = Checksum::new();
        checksum_fields(&mut checksum, &state);
        std::hint::black_box(checksum.result());
    }
    println!("fold of a {} byte string: {:?} per fold", 4 * 280_000, started.elapsed() / 20);
}

// a deliberately naive reference: the payload is serialized, every byte folded one by one
fn naive(fields: &Fields) -> [u8; 32] {
    let mut stream: Vec<u8> = Vec::new();
    stream.extend_from_slice(&0x464c_4453u32.to_le_bytes());
    stream.extend_from_slice(&(fields.len() as u16).to_le_bytes());
    // write_fields: magic, count, then per field key, payload length and payload, all big-endian
    let serialized = settings(fields);
    let mut cursor = 6;
    for key in fields.keys() {
        let length = u32::from_be_bytes(serialized[cursor + 2..cursor + 6].try_into().unwrap()) as usize;
        let payload = &serialized[cursor + 6..cursor + 6 + length];
        stream.extend_from_slice(&key.to_le_bytes());
        stream.extend_from_slice(&(length as u32).to_le_bytes());
        stream.extend_from_slice(payload);
        cursor += 6 + length;
    }
    let mut result = [0u8; 32];
    for (index, byte) in stream.iter().enumerate() { result[index % 32] ^= byte; }
    result
}

#[test]
fn fold_matches_the_naive_reference() {
    let samples: Vec<String> = (0..70).map(|length| (0..length).map(|index| (b'A' + (index * 7 % 26) as u8) as char).collect())
        .chain(["grüße", "😀 emoji", "\u{FFFF}x", "mixed ascii and ü"].iter().map(|text| text.to_string()))
        .chain([ "s".repeat(1000), "ODV3".repeat(4097)])
        .collect();
    for (index, text) in samples.iter().enumerate() {
        let state = fields(index as i32, text);
        let mut checksum = Checksum::new();
        checksum_fields(&mut checksum, &state);
        assert_eq!(checksum.result(), naive(&state), "string of {} chars", text.chars().count());
    }
}

#[test]
fn string_fields_round_trip_through_the_fast_paths() {
    let registry = registry();
    for text in ["", "plain ascii", &"ODV3".repeat(4097), "grüße", "😀 emoji", "\u{7F}\u{80}"] {
        let state = fields(1, text);
        let bytes = settings(&state);
        let mut reader = boxgraph::bytes::ByteReader::new(&bytes);
        let read = boxgraph::field::read_fields(&mut reader, &registry["Blob"]).unwrap();
        assert_eq!(read, state, "{text:?}");
    }
}
