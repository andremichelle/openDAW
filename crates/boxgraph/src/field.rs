//! Generic, schema-driven field model mirroring lib-box `serializer.ts` + `primitive.ts` +
//! `pointer.ts`. A field container ("FLDS") is `MAGIC(int) + count(short)`, then per field
//! `key(short) + byteLen(int) + payload`. The `byteLen` lets a reader skip unknown keys (forward
//! compat / deprecated fields). The schema maps each key to a type so payloads decode correctly.

use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;
use crate::address::Address;
use crate::bytes::{ByteReader, ByteWriter};
use crate::Error;

const MAGIC: i32 = 0x464c4453; // "FLDS"

/// The declared layout of a field (the part not present in the byte stream). Mirrors the field
/// classes generated per box type in TS.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FieldType {
    Int32,
    Float32,
    Boolean,
    String,
    Bytes,
    Pointer,
    /// A pointer-target hook (`Field.hook`) — a referenceable vertex with no serialized value.
    Hook,
    Object(BTreeMap<u16, FieldType>),
    Array {element: Box<FieldType>, length: usize},
}

pub type Schema = BTreeMap<u16, FieldType>;

/// A decoded field value.
#[derive(Clone, Debug, PartialEq)]
pub enum FieldValue {
    Int32(i32),
    Float32(f32),
    Boolean(bool),
    String(String),
    Bytes(Vec<u8>),
    Pointer(Option<Address>),
    Hook,
    Object(Fields),
    Array(Vec<FieldValue>),
}

pub type Fields = BTreeMap<u16, FieldValue>;

fn write_value(writer: &mut ByteWriter, value: &FieldValue) {
    match value {
        FieldValue::Int32(value) => writer.write_int(*value),
        FieldValue::Float32(value) => writer.write_float(*value),
        FieldValue::Boolean(value) => writer.write_bool(*value),
        FieldValue::String(value) => writer.write_string(value),
        FieldValue::Bytes(value) => {
            writer.write_int(value.len() as i32);
            writer.write_raw(value)
        }
        FieldValue::Pointer(target) => match target {
            Some(address) => {
                writer.write_bool(true);
                address.write(writer)
            }
            None => writer.write_bool(false)
        },
        FieldValue::Hook => {} // a hook serializes nothing
        FieldValue::Object(fields) => write_fields(writer, fields),
        FieldValue::Array(elements) => elements.iter().for_each(|element| write_value(writer, element))
    }
}

fn read_value(reader: &mut ByteReader, field_type: &FieldType) -> Result<FieldValue, Error> {
    match field_type {
        FieldType::Int32 => Ok(FieldValue::Int32(reader.read_int()?)),
        FieldType::Float32 => Ok(FieldValue::Float32(reader.read_float()?)),
        FieldType::Boolean => Ok(FieldValue::Boolean(reader.read_bool()?)),
        FieldType::String => Ok(FieldValue::String(reader.read_string()?)),
        FieldType::Bytes => {
            let length = reader.read_int()? as usize;
            Ok(FieldValue::Bytes(reader.read_raw(length)?))
        }
        FieldType::Pointer => {
            let target = if reader.read_bool()? {Some(Address::read(reader)?)} else {None};
            Ok(FieldValue::Pointer(target))
        }
        FieldType::Hook => Ok(FieldValue::Hook),
        FieldType::Object(schema) => Ok(FieldValue::Object(read_fields(reader, schema)?)),
        FieldType::Array {element, length} => {
            let mut values = Vec::with_capacity(*length);
            for _ in 0..*length {
                values.push(read_value(reader, element)?)
            }
            Ok(FieldValue::Array(values))
        }
    }
}

pub fn write_fields(writer: &mut ByteWriter, fields: &Fields) {
    writer.write_int(MAGIC);
    writer.write_short(fields.len() as i16);
    for (key, value) in fields {
        let mut payload = ByteWriter::new();
        write_value(&mut payload, value);
        let bytes = payload.into_bytes();
        writer.write_short(*key as i16);
        writer.write_int(bytes.len() as i32);
        writer.write_raw(&bytes);
    }
}

pub fn read_fields(reader: &mut ByteReader, schema: &Schema) -> Result<Fields, Error> {
    if reader.read_int()? != MAGIC {
        return Err(Error::BadMagic);
    }
    let count = reader.read_short()? as usize;
    let mut fields = Fields::new();
    for _ in 0..count {
        let key = reader.read_short()? as u16;
        let length = reader.read_int()? as usize;
        let payload = reader.read_raw(length)?;
        if let Some(field_type) = schema.get(&key) {
            let mut sub = ByteReader::new(&payload);
            fields.insert(key, read_value(&mut sub, field_type)?);
        }
        // unknown/deprecated key: payload already consumed, skip it
    }
    Ok(fields)
}
