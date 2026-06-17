use std::collections::BTreeMap;
use boxgraph::boxes::{GraphBox, Registry};
use boxgraph::bytes::{ByteReader, ByteWriter};
use boxgraph::field::{FieldType, FieldValue, Schema};
use boxgraph::Error;

#[test]
fn box_round_trips() {
    let registry: Registry = BTreeMap::from([
        ("Node".to_string(), Schema::from([(0, FieldType::Int32), (1, FieldType::String)]))
    ]);
    let original = GraphBox {
        creation_index: 7,
        name: "Node".to_string(),
        uuid: [3; 16],
        fields: BTreeMap::from([
            (0, FieldValue::Int32(99)),
            (1, FieldValue::String("box".to_string()))
        ])
    };
    let mut writer = ByteWriter::new();
    original.serialize(&mut writer);
    let bytes = writer.into_bytes();
    let mut reader = ByteReader::new(&bytes);
    assert_eq!(GraphBox::read(&mut reader, &registry).unwrap(), original);
    assert_eq!(reader.remaining(), 0);
}

#[test]
fn unknown_box_name_errors() {
    let registry: Registry = BTreeMap::new();
    let original = GraphBox {
        creation_index: 0, name: "Missing".to_string(), uuid: [0; 16], fields: BTreeMap::new()
    };
    let mut writer = ByteWriter::new();
    original.serialize(&mut writer);
    let bytes = writer.into_bytes();
    let mut reader = ByteReader::new(&bytes);
    assert_eq!(GraphBox::read(&mut reader, &registry), Err(Error::UnknownBox));
}
