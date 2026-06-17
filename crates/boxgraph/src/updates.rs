//! The delta stream that mutates the graph — mirrors lib-box `updates.ts` (`Updates.decode` + each
//! update's `write`). A stream is `count(int)` then per update a `type(string)` + payload. Applying
//! the stream makes the Rust graph a live mirror of the TS source; `revert` (the inverse of each
//! update) supports aborting a transaction. Wire format:
//!   new/delete : uuid(16) + name(string) + settingsLen(int) + settings(FLDS bytes)
//!   pointer    : address + optional oldAddress + optional newAddress
//!   primitive  : address + valueType(string) + oldValue + newValue

use alloc::string::String;
use alloc::vec::Vec;
use crate::address::{read_uuid, write_uuid, Address, Uuid};
use crate::bytes::{ByteReader, ByteWriter};
use crate::field::{read_value, write_value, FieldType, FieldValue};
use crate::Error;

#[derive(Clone, Debug, PartialEq)]
pub enum Update {
    New {uuid: Uuid, name: String, settings: Vec<u8>},
    Delete {uuid: Uuid, name: String, settings: Vec<u8>},
    Primitive {address: Address, old: FieldValue, new: FieldValue},
    Pointer {address: Address, old: Option<Address>, new: Option<Address>},
}

fn primitive_field_type(name: &str) -> Result<FieldType, Error> {
    match name {
        "int32" => Ok(FieldType::Int32),
        "float32" => Ok(FieldType::Float32),
        "boolean" => Ok(FieldType::Boolean),
        "string" => Ok(FieldType::String),
        "bytes" => Ok(FieldType::Bytes),
        _ => Err(Error::UnknownUpdate)
    }
}

fn primitive_type_name(value: &FieldValue) -> &'static str {
    match value {
        FieldValue::Int32(_) => "int32",
        FieldValue::Float32(_) => "float32",
        FieldValue::Boolean(_) => "boolean",
        FieldValue::String(_) => "string",
        FieldValue::Bytes(_) => "bytes",
        _ => "int32"
    }
}

fn read_optional_address(reader: &mut ByteReader) -> Result<Option<Address>, Error> {
    Ok(if reader.read_bool()? {Some(Address::read(reader)?)} else {None})
}

fn write_optional_address(writer: &mut ByteWriter, address: &Option<Address>) {
    match address {
        Some(address) => {
            writer.write_bool(true);
            address.write(writer)
        }
        None => writer.write_bool(false)
    }
}

pub fn decode(reader: &mut ByteReader) -> Result<Vec<Update>, Error> {
    let count = reader.read_int()? as usize;
    let mut updates = Vec::with_capacity(count);
    for _ in 0..count {
        let update_type = reader.read_string()?;
        let update = match update_type.as_str() {
            "new" => Update::New {
                uuid: read_uuid(reader)?,
                name: reader.read_string()?,
                settings: read_settings(reader)?
            },
            "delete" => Update::Delete {
                uuid: read_uuid(reader)?,
                name: reader.read_string()?,
                settings: read_settings(reader)?
            },
            "pointer" => Update::Pointer {
                address: Address::read(reader)?,
                old: read_optional_address(reader)?,
                new: read_optional_address(reader)?
            },
            "primitive" => {
                let address = Address::read(reader)?;
                let field_type = primitive_field_type(&reader.read_string()?)?;
                Update::Primitive {
                    address,
                    old: read_value(reader, &field_type)?,
                    new: read_value(reader, &field_type)?
                }
            },
            _ => return Err(Error::UnknownUpdate)
        };
        updates.push(update);
    }
    Ok(updates)
}

pub fn encode(writer: &mut ByteWriter, updates: &[Update]) {
    writer.write_int(updates.len() as i32);
    for update in updates {
        match update {
            Update::New {uuid, name, settings} => {
                writer.write_string("new");
                write_uuid(writer, uuid);
                writer.write_string(name);
                writer.write_int(settings.len() as i32);
                writer.write_raw(settings)
            }
            Update::Delete {uuid, name, settings} => {
                writer.write_string("delete");
                write_uuid(writer, uuid);
                writer.write_string(name);
                writer.write_int(settings.len() as i32);
                writer.write_raw(settings)
            }
            Update::Pointer {address, old, new} => {
                writer.write_string("pointer");
                address.write(writer);
                write_optional_address(writer, old);
                write_optional_address(writer, new)
            }
            Update::Primitive {address, old, new} => {
                writer.write_string("primitive");
                address.write(writer);
                writer.write_string(primitive_type_name(old));
                write_value(writer, old);
                write_value(writer, new)
            }
        }
    }
}

fn read_settings(reader: &mut ByteReader) -> Result<Vec<u8>, Error> {
    let length = reader.read_int()? as usize;
    Ok(reader.read_raw(length)?)
}
