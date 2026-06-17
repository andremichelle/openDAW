use std::collections::BTreeMap;
use boxgraph::address::Address;
use boxgraph::bytes::{ByteReader, ByteWriter};
use boxgraph::field::{read_fields, write_fields, FieldType, FieldValue, Fields, Schema};
use boxgraph::Error;

const A: boxgraph::address::Uuid = [9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const FLDS_MAGIC: i32 = 0x464c_4453;

fn round_trip(schema: &Schema, fields: &Fields) -> Fields {
    let mut writer = ByteWriter::new();
    write_fields(&mut writer, fields);
    let bytes = writer.into_bytes();
    let mut reader = ByteReader::new(&bytes);
    let decoded = read_fields(&mut reader, schema).unwrap();
    assert_eq!(reader.remaining(), 0);
    decoded
}

#[test]
fn primitives_round_trip() {
    let schema: Schema = BTreeMap::from([
        (0, FieldType::Int32), (1, FieldType::Float32), (2, FieldType::Boolean),
        (3, FieldType::String), (4, FieldType::Bytes)
    ]);
    let fields: Fields = BTreeMap::from([
        (0, FieldValue::Int32(-42)),
        (1, FieldValue::Float32(0.125)),
        (2, FieldValue::Boolean(true)),
        (3, FieldValue::String("Hello 👻".to_string())),
        (4, FieldValue::Bytes(vec![1, 2, 3, 255]))
    ]);
    assert_eq!(round_trip(&schema, &fields), fields);
}

#[test]
fn hook_is_zero_width() {
    // A `Field.hook` serializes nothing: in the FLDS container it is key + len(0) + empty payload.
    let schema: Schema = BTreeMap::from([(0, FieldType::Int32), (5, FieldType::Hook)]);
    let fields: Fields = BTreeMap::from([(0, FieldValue::Int32(7)), (5, FieldValue::Hook)]);
    let decoded = round_trip(&schema, &fields);
    assert_eq!(decoded, fields);
}

#[test]
fn pointer_present_and_absent() {
    let schema: Schema = BTreeMap::from([(10, FieldType::Pointer)]);
    for target in [None, Some(Address::box_of(A)), Some(Address::box_of(A).append(1).append(3))] {
        let fields: Fields = BTreeMap::from([(10, FieldValue::Pointer(target.clone()))]);
        assert_eq!(round_trip(&schema, &fields), fields);
    }
}

#[test]
fn nested_object_round_trips() {
    let schema: Schema = BTreeMap::from([
        (1, FieldType::Object(BTreeMap::from([(0, FieldType::String), (1, FieldType::Int32)])))
    ]);
    let fields: Fields = BTreeMap::from([
        (1, FieldValue::Object(BTreeMap::from([
            (0, FieldValue::String("solo".to_string())),
            (1, FieldValue::Int32(7))
        ])))
    ]);
    assert_eq!(round_trip(&schema, &fields), fields);
}

#[test]
fn arrays_of_primitive_and_object_round_trip() {
    let schema: Schema = BTreeMap::from([
        (3, FieldType::Array {element: Box::new(FieldType::Boolean), length: 9}),
        (4, FieldType::Array {
            element: Box::new(FieldType::Object(BTreeMap::from([(3, FieldType::Int32)]))),
            length: 2
        })
    ]);
    let booleans = (0..9).map(|index| FieldValue::Boolean(index == 4)).collect();
    let objects = (0..2).map(|index|
        FieldValue::Object(BTreeMap::from([(3, FieldValue::Int32(index * 10))]))).collect();
    let fields: Fields = BTreeMap::from([(3, FieldValue::Array(booleans)), (4, FieldValue::Array(objects))]);
    assert_eq!(round_trip(&schema, &fields), fields);
}

#[test]
fn unknown_keys_are_skipped() {
    let fields: Fields = BTreeMap::from([
        (0, FieldValue::Int32(123)),
        (5, FieldValue::String("dropped".to_string()))
    ]);
    let mut writer = ByteWriter::new();
    write_fields(&mut writer, &fields);
    let bytes = writer.into_bytes();
    let read_schema: Schema = BTreeMap::from([(0, FieldType::Int32)]);
    let mut reader = ByteReader::new(&bytes);
    let decoded = read_fields(&mut reader, &read_schema).unwrap();
    assert_eq!(decoded, BTreeMap::from([(0, FieldValue::Int32(123))]));
    assert_eq!(reader.remaining(), 0);
}

#[test]
fn flds_magic_and_count_exact() {
    let fields: Fields = BTreeMap::from([(0, FieldValue::Int32(1))]);
    let mut writer = ByteWriter::new();
    write_fields(&mut writer, &fields);
    let bytes = writer.into_bytes();
    assert_eq!(&bytes[0..4], &[0x46, 0x4c, 0x44, 0x53]);
    assert_eq!(&bytes[4..6], &[0x00, 0x01]);
    assert_eq!(&bytes[6..8], &[0x00, 0x00]);
    assert_eq!(&bytes[8..12], &[0x00, 0x00, 0x00, 0x04]);
    assert_eq!(&bytes[12..16], &[0x00, 0x00, 0x00, 0x01]);
}

// ---- Ported from box.test.ts FooBox/FooObject fixture ----

fn foo_object_schema() -> BTreeMap<u16, FieldType> {
    BTreeMap::from([
        (0, FieldType::Boolean), (1, FieldType::String), (2, FieldType::Float32),
        (3, FieldType::Int32), (4, FieldType::Bytes)
    ])
}

fn foo_box_schema() -> Schema {
    BTreeMap::from([
        (1, FieldType::Object(foo_object_schema())),
        (2, FieldType::Pointer),
        (3, FieldType::Array {element: Box::new(FieldType::Boolean), length: 9}),
        (4, FieldType::Array {element: Box::new(FieldType::Object(foo_object_schema())), length: 9}),
        (5, FieldType::Array {element: Box::new(FieldType::Pointer), length: 9})
    ])
}

fn foo_object(solo: &str, number: i32) -> FieldValue {
    FieldValue::Object(BTreeMap::from([
        (0, FieldValue::Boolean(false)),
        (1, FieldValue::String(solo.to_string())),
        (2, FieldValue::Float32(core::f32::consts::PI)),
        (3, FieldValue::Int32(number)),
        (4, FieldValue::Bytes(vec![1, 2, 3]))
    ]))
}

#[test]
fn foo_box_fields_bytes_io() {
    let booleans = (0..9).map(|index| FieldValue::Boolean(index == 4)).collect();
    let foos = (0..9).map(|index| foo_object("", if index == 3 {42} else {0})).collect();
    let points = (0..9).map(|_| FieldValue::Pointer(None)).collect();
    let fields: Fields = BTreeMap::from([
        (1, foo_object("Hello 👻", 0)),
        (2, FieldValue::Pointer(None)),
        (3, FieldValue::Array(booleans)),
        (4, FieldValue::Array(foos)),
        (5, FieldValue::Array(points))
    ]);
    let decoded = round_trip(&foo_box_schema(), &fields);
    assert_eq!(decoded, fields);
    let FieldValue::Array(decoded_booleans) = &decoded[&3] else {panic!("key 3 not array")};
    assert_eq!(decoded_booleans[4], FieldValue::Boolean(true));
    let FieldValue::Object(decoded_foo) = &decoded[&1] else {panic!("key 1 not object")};
    assert_eq!(decoded_foo[&1], FieldValue::String("Hello 👻".to_string()));
    let FieldValue::Array(decoded_foos) = &decoded[&4] else {panic!("key 4 not array")};
    let FieldValue::Object(third) = &decoded_foos[3] else {panic!("foos[3] not object")};
    assert_eq!(third[&3], FieldValue::Int32(42));
}

// ---- Relentless edge cases ----

#[test]
fn bad_magic_errors() {
    let mut writer = ByteWriter::new();
    writer.write_int(0x1234_5678);
    writer.write_short(0);
    let bytes = writer.into_bytes();
    let mut reader = ByteReader::new(&bytes);
    assert_eq!(read_fields(&mut reader, &BTreeMap::new()), Err(Error::BadMagic));
}

#[test]
fn truncated_value_errors_not_panics() {
    let mut writer = ByteWriter::new();
    writer.write_int(FLDS_MAGIC);
    writer.write_short(1);
    writer.write_short(0);
    writer.write_int(2);
    writer.write_raw(&[0, 0]);
    let bytes = writer.into_bytes();
    let schema: Schema = BTreeMap::from([(0, FieldType::Int32)]);
    let mut reader = ByteReader::new(&bytes);
    assert_eq!(read_fields(&mut reader, &schema), Err(Error::UnexpectedEnd));
}

#[test]
fn deeply_nested_object_round_trips() {
    let schema: Schema = BTreeMap::from([
        (0, FieldType::Object(BTreeMap::from([
            (0, FieldType::Object(BTreeMap::from([(0, FieldType::Int32)])))
        ])))
    ]);
    let fields: Fields = BTreeMap::from([
        (0, FieldValue::Object(BTreeMap::from([
            (0, FieldValue::Object(BTreeMap::from([(0, FieldValue::Int32(123))])))
        ])))
    ]);
    assert_eq!(round_trip(&schema, &fields), fields);
}

#[test]
fn empty_string_and_bytes_round_trip() {
    let schema: Schema = BTreeMap::from([(0, FieldType::String), (1, FieldType::Bytes)]);
    let fields: Fields = BTreeMap::from([(0, FieldValue::String(String::new())), (1, FieldValue::Bytes(vec![]))]);
    assert_eq!(round_trip(&schema, &fields), fields);
}

#[test]
fn int_and_float_boundaries() {
    let schema: Schema = BTreeMap::from([(0, FieldType::Int32), (1, FieldType::Float32)]);
    for (int_value, float_value) in [(i32::MIN, f32::MIN_POSITIVE), (i32::MAX, core::f32::consts::PI), (0, -0.0)] {
        let fields: Fields = BTreeMap::from([(0, FieldValue::Int32(int_value)), (1, FieldValue::Float32(float_value))]);
        assert_eq!(round_trip(&schema, &fields), fields);
    }
    let fields: Fields = BTreeMap::from([(1, FieldValue::Float32(-0.0))]);
    let decoded = round_trip(&BTreeMap::from([(1, FieldType::Float32)]), &fields);
    let FieldValue::Float32(value) = decoded[&1] else {panic!("not float")};
    assert_eq!(value.to_bits(), (-0.0f32).to_bits());
}

#[test]
fn pointers_in_nested_object_and_array() {
    let target = Some(Address::box_of([7; 16]));
    let schema: Schema = BTreeMap::from([
        (0, FieldType::Object(BTreeMap::from([(0, FieldType::Pointer)]))),
        (1, FieldType::Array {element: Box::new(FieldType::Pointer), length: 2})
    ]);
    let fields: Fields = BTreeMap::from([
        (0, FieldValue::Object(BTreeMap::from([(0, FieldValue::Pointer(target.clone()))]))),
        (1, FieldValue::Array(vec![FieldValue::Pointer(target.clone()), FieldValue::Pointer(None)]))
    ]);
    assert_eq!(round_trip(&schema, &fields), fields);
}
