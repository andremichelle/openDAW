use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;
use boxgraph::address::{Address, Uuid};
use boxgraph::boxes::{GraphBox, Registry};
use boxgraph::bytes::{ByteReader, ByteWriter};
use boxgraph::subscription::Propagation;
use boxgraph::field::{write_fields, FieldType, FieldValue, Fields, Schema};
use boxgraph::graph::BoxGraph;
use boxgraph::updates::{decode_forward, Update};
use boxgraph::Error;

const A: Uuid = [0xA, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const B: Uuid = [0xB, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

// "Blob": bytes at key 0, int at key 1
fn registry() -> Registry {
    Registry::from([("Blob".to_string(), Schema::from([(0, FieldType::Bytes), (1, FieldType::Int32)]))])
}

fn blob(uuid: Uuid, bytes: &[u8]) -> GraphBox {
    GraphBox {
        creation_index: 0,
        name: "Blob".to_string(),
        uuid,
        fields: BTreeMap::from([(0, FieldValue::Bytes(bytes.to_vec())), (1, FieldValue::Int32(0))])
    }
}

fn blob_settings(bytes: &[u8]) -> Vec<u8> {
    let fields: Fields = BTreeMap::from([(0, FieldValue::Bytes(bytes.to_vec())), (1, FieldValue::Int32(0))]);
    let mut writer = ByteWriter::new();
    write_fields(&mut writer, &fields);
    writer.into_bytes()
}

fn splice(uuid: Uuid, offset: usize, delete: usize, bytes: &[u8]) -> Update {
    Update::BytesSplice {address: Address::of(uuid, vec![0]), offset, delete, bytes: bytes.to_vec()}
}

fn bytes_of(graph: &BoxGraph, uuid: Uuid) -> Vec<u8> {
    match graph.field_value(&Address::of(uuid, vec![0])) {
        Some(FieldValue::Bytes(bytes)) => bytes.clone(),
        other => panic!("no bytes: {other:?}")
    }
}

// the forward stream as serialize-update-tasks.ts writes an update-bytes task
fn wire(uuid: Uuid, offset: i32, delete: i32, bytes: &[u8]) -> Vec<u8> {
    let mut writer = ByteWriter::new();
    writer.write_int(1);
    writer.write_string("update-bytes");
    Address::of(uuid, vec![0]).write(&mut writer);
    writer.write_int(offset);
    writer.write_int(delete);
    writer.write_int(bytes.len() as i32);
    writer.write_raw(bytes);
    writer.into_bytes()
}

#[test]
fn a_splice_writes_inside_grows_and_shrinks() {
    let mut graph = BoxGraph::from_boxes(vec![blob(A, &[1, 2, 3, 4])]);
    graph.transaction(&[splice(A, 1, 2, &[9])], &registry()).unwrap();
    assert_eq!(bytes_of(&graph, A), vec![1, 9, 4]);
    graph.transaction(&[splice(A, 3, 0, &[5, 6])], &registry()).unwrap();
    assert_eq!(bytes_of(&graph, A), vec![1, 9, 4, 5, 6]);
    graph.transaction(&[splice(A, 0, 5, &[])], &registry()).unwrap();
    assert_eq!(bytes_of(&graph, A), Vec::<u8>::new());
    graph.transaction(&[splice(A, 0, 0, &[7])], &registry()).unwrap();
    assert_eq!(bytes_of(&graph, A), vec![7]);
}

#[test]
fn splices_in_one_transaction_each_see_the_ones_before() {
    let mut graph = BoxGraph::from_boxes(vec![blob(A, &[0; 10])]);
    graph.transaction(&[splice(A, 2, 0, &[1, 1]), splice(A, 0, 1, &[]), splice(A, 10, 1, &[3])], &registry()).unwrap();
    assert_eq!(bytes_of(&graph, A), vec![0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 3]);
}

#[test]
fn a_splice_lands_on_a_box_created_in_the_same_transaction() {
    let mut graph = BoxGraph::from_boxes(vec![]);
    graph.transaction(&[
        Update::New {uuid: B, name: "Blob".to_string(), settings: blob_settings(&[4, 4, 4])},
        splice(B, 1, 1, &[5, 5])
    ], &registry()).unwrap();
    assert_eq!(bytes_of(&graph, B), vec![4, 5, 5, 4]);
}

#[test]
fn a_splice_after_a_whole_value_in_the_same_transaction_reads_that_value() {
    let mut graph = BoxGraph::from_boxes(vec![blob(A, &[1])]);
    graph.transaction(&[
        Update::Primitive {address: Address::of(A, vec![0]), old: FieldValue::Bytes(vec![1]), new: FieldValue::Bytes(vec![8, 8, 8])},
        splice(A, 2, 1, &[9])
    ], &registry()).unwrap();
    assert_eq!(bytes_of(&graph, A), vec![8, 8, 9]);
}

#[test]
fn a_splice_outside_the_value_is_refused() {
    let mut graph = BoxGraph::from_boxes(vec![blob(A, &[1, 2])]);
    assert_eq!(graph.transaction(&[splice(A, 3, 0, &[1])], &registry()), Err(Error::BadSplice));
    assert_eq!(graph.transaction(&[splice(A, 1, 2, &[])], &registry()), Err(Error::BadSplice));
    assert_eq!(graph.transaction(&[splice(A, usize::MAX, 1, &[])], &registry()), Err(Error::BadSplice));
    assert_eq!(bytes_of(&graph, A), vec![1, 2]);
}

#[test]
fn a_splice_on_a_field_that_holds_no_bytes_is_refused() {
    let mut graph = BoxGraph::from_boxes(vec![blob(A, &[1])]);
    let int_field = Update::BytesSplice {address: Address::of(A, vec![1]), offset: 0, delete: 0, bytes: vec![1]};
    assert_eq!(graph.transaction(&[int_field], &registry()), Err(Error::BadSplice));
    assert_eq!(graph.transaction(&[splice(B, 0, 0, &[1])], &registry()), Err(Error::BadSplice));
}

#[test]
fn observers_see_the_whole_new_value_as_a_primitive() {
    let mut graph = BoxGraph::from_boxes(vec![blob(A, &[1, 2, 3])]);
    let seen: Rc<RefCell<Vec<(FieldValue, FieldValue)>>> = Rc::new(RefCell::new(Vec::new()));
    let sink = seen.clone();
    graph.subscribe_vertex(Propagation::This, Address::of(A, vec![0]), Box::new(move |_graph, update| {
        if let Update::Primitive {old, new, ..} = update {sink.borrow_mut().push((old.clone(), new.clone()))}
        assert!(!matches!(update, Update::BytesSplice {..}), "a splice must never reach an observer");
    }));
    graph.transaction(&[splice(A, 1, 1, &[7, 7])], &registry()).unwrap();
    assert_eq!(*seen.borrow(), vec![(FieldValue::Bytes(vec![1, 2, 3]), FieldValue::Bytes(vec![1, 7, 7, 3]))]);
}

#[test]
fn the_checksum_equals_the_one_of_the_same_value_set_whole() {
    let mut spliced = BoxGraph::from_boxes(vec![blob(A, &[1, 2, 3, 4])]);
    spliced.transaction(&[splice(A, 1, 2, &[9, 9, 9])], &registry()).unwrap();
    let whole = BoxGraph::from_boxes(vec![blob(A, &[1, 9, 9, 9, 4])]);
    assert_eq!(spliced.checksum(), whole.checksum());
}

#[test]
fn the_forward_stream_decodes_an_update_bytes_task() {
    let bytes = wire(A, 2, 1, &[5, 6]);
    let mut reader = ByteReader::new(&bytes);
    assert_eq!(decode_forward(&mut reader).unwrap(), vec![splice(A, 2, 1, &[5, 6])]);
    assert_eq!(reader.remaining(), 0);
}

#[test]
fn the_forward_stream_refuses_negative_offsets_lengths_and_a_cut_off_payload() {
    for bytes in [wire(A, -1, 0, &[]), wire(A, 0, -1, &[])] {
        assert_eq!(decode_forward(&mut ByteReader::new(&bytes)), Err(Error::BadSplice));
    }
    let mut cut = wire(A, 0, 0, &[1, 2, 3]);
    cut.truncate(cut.len() - 2);
    assert!(decode_forward(&mut ByteReader::new(&cut)).is_err());
}

#[test]
fn a_megabyte_with_one_byte_changed_applies_without_touching_the_rest() {
    let mut original: Vec<u8> = (0..1 << 20).map(|index| (index % 251) as u8).collect();
    let mut graph = BoxGraph::from_boxes(vec![blob(A, &original)]);
    graph.transaction(&[splice(A, 777_777, 1, &[0xEE])], &registry()).unwrap();
    original[777_777] = 0xEE;
    assert_eq!(bytes_of(&graph, A), original);
}
