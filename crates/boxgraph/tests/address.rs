use std::collections::BTreeSet;
use boxgraph::address::{filter_ends_with, filter_equals, filter_starts_with, uuid_parse, uuid_to_string, Address, Uuid};
use boxgraph::bytes::{ByteReader, ByteWriter};

fn uuids() -> (Uuid, Uuid, Uuid, Uuid, Uuid) {
    (
        uuid_parse("11111111-1111-4000-8000-000000000000").unwrap(),
        uuid_parse("22222222-2222-4000-8000-000000000000").unwrap(),
        uuid_parse("33333333-3333-4000-8000-000000000000").unwrap(),
        uuid_parse("44444444-4444-4000-8000-000000000000").unwrap(),
        uuid_parse("55555555-5555-4000-8000-000000000000").unwrap()
    )
}

#[test]
fn uuid_string_round_trips_and_is_canonical() {
    let text = "33333333-3333-4000-8000-000000000000";
    assert_eq!(uuid_to_string(&uuid_parse(text).unwrap()), text);
    assert_eq!(uuid_parse("not-a-uuid"), None);
    assert_eq!(uuid_parse(""), None);
}

#[test]
fn compose_with_uuid_only_and_with_fields() {
    let (a, b, ..) = uuids();
    let only = Address::box_of(a);
    assert_eq!(only.uuid, a);
    assert_eq!(only.field_keys.len(), 0);
    let with_fields = Address::of(b, vec![1, 2]);
    assert_eq!(with_fields.uuid, b);
    assert_eq!(with_fields.field_keys, vec![1, 2]);
}

#[test]
fn is_box_and_is_content() {
    let (a, b, ..) = uuids();
    assert!(Address::box_of(a).is_box());
    assert!(!Address::box_of(a).is_content());
    assert!(!Address::of(b, vec![1]).is_box());
    assert!(Address::of(b, vec![1]).is_content());
}

#[test]
fn compare_across_different_uuids() {
    let (a, b, c, ..) = uuids();
    assert_ne!(Address::of(a, vec![1, 2]), Address::of(b, vec![1, 2]));
    assert!(Address::of(a, vec![1, 2]) < Address::of(b, vec![1, 2]));
    assert!(Address::of(b, vec![1, 2]) < Address::of(c, vec![1, 2]));
    assert!(Address::of(c, vec![1, 2]) > Address::of(a, vec![1, 2]));
}

#[test]
fn compare_same_uuid_different_fields() {
    let (a, ..) = uuids();
    assert!(Address::of(a, vec![1, 2]) < Address::of(a, vec![1, 3]));
    assert!(Address::of(a, vec![1, 2]) < Address::of(a, vec![1, 2, 4]));
    assert_ne!(Address::of(a, vec![1, 2]), Address::of(a, vec![1, 3]));
}

#[test]
fn append_field_key() {
    let (a, ..) = uuids();
    assert_eq!(Address::box_of(a).append(1).field_keys, vec![1]);
}

#[test]
fn starts_with_across_uuids_and_paths() {
    let (a, b, ..) = uuids();
    let base_a = Address::of(a, vec![1]);
    let extended_a = Address::of(a, vec![1, 2]);
    assert!(extended_a.starts_with(&base_a));
    assert!(!extended_a.starts_with(&Address::of(b, vec![1])));
    assert!(!extended_a.starts_with(&Address::of(a, vec![2])));
    assert!(base_a.starts_with(&base_a));
}

#[test]
fn serialize_round_trip() {
    let (a, b, c, ..) = uuids();
    for address in [Address::of(a, vec![1]), Address::of(b, vec![1, 2]), Address::of(c, vec![1, 2, 3]), Address::box_of(a)] {
        let mut writer = ByteWriter::new();
        address.write(&mut writer);
        let bytes = writer.into_bytes();
        let mut reader = ByteReader::new(&bytes);
        assert_eq!(Address::read(&mut reader).unwrap(), address);
        assert_eq!(reader.remaining(), 0);
    }
}

#[test]
fn wire_layout_exact() {
    let (a, ..) = uuids();
    let mut writer = ByteWriter::new();
    Address::box_of(a).write(&mut writer);
    let bytes = writer.into_bytes();
    assert_eq!(bytes.len(), 17);
    assert_eq!(bytes[16], 0x00);
    let mut writer = ByteWriter::new();
    Address::box_of(a).append(3).write(&mut writer);
    assert_eq!(&writer.into_bytes()[16..], &[0x01, 0x00, 0x03]);
}

#[test]
fn decode_and_to_string_round_trip() {
    let text = "33333333-3333-4000-8000-000000000000/1/2/3";
    assert_eq!(Address::decode(text).unwrap().to_string(), text);
    assert!(Address::decode("").is_none());
    let (a, ..) = uuids();
    assert_eq!(Address::box_of(a).to_string(), "11111111-1111-4000-8000-000000000000");
}

#[test]
fn box_range_is_contiguous_when_sorted() {
    let (a, b, c, ..) = uuids();
    let set: BTreeSet<Address> = BTreeSet::from([
        Address::of(a, vec![1]),
        Address::of(b, vec![1]),
        Address::of(b, vec![2]),
        Address::of(c, vec![1])
    ]);
    assert_eq!(set.range(Address::box_of(b)..Address::box_of(c)).count(), 2);
}

#[test]
fn addressable_helpers() {
    let (a, b, c, d, e) = uuids();
    let items = vec![
        Address::of(a, vec![1]),
        Address::of(b, vec![1]),
        Address::of(b, vec![1, 2]),
        Address::of(c, vec![1]),
        Address::of(d, vec![1, 2]),
        Address::of(e, vec![1, 2, 3])
    ];
    let mut sorted = items.clone();
    sorted.sort();
    assert_eq!(sorted.first().unwrap().uuid, a);
    assert_eq!(sorted.last().unwrap().uuid, e);
    assert_eq!(filter_equals(&items[1], &items).len(), 1);
    let starts = filter_starts_with(&Address::of(b, vec![1]), &items);
    assert_eq!(starts.len(), 2);
    assert!(starts.iter().all(|address| address.uuid == b));
    let ends = filter_ends_with(&Address::of(e, vec![1, 2, 3]), &items);
    assert_eq!(ends.len(), 1);
    assert_eq!(ends[0].uuid, e);
}
