//! A box record and the box-type registry. Mirrors lib-box `box.ts`: a box serializes as
//! `creationIndex(int) + name(string) + uuid(16 raw) + FLDS`. Reading needs the schema for the
//! box's name, so `read` takes a registry (name → field schema).

use alloc::collections::BTreeMap;
use alloc::string::String;
use crate::address::{read_uuid, write_uuid, Uuid};
use crate::bytes::{ByteReader, ByteWriter};
use crate::field::{read_fields, write_fields, Fields, Schema};
use crate::Error;

pub type Registry = BTreeMap<String, Schema>;

#[derive(Clone, Debug, PartialEq)]
pub struct GraphBox {
    pub creation_index: i32,
    pub name: String,
    pub uuid: Uuid,
    pub fields: Fields,
}

impl GraphBox {
    pub fn serialize(&self, writer: &mut ByteWriter) {
        writer.write_int(self.creation_index);
        writer.write_string(&self.name);
        write_uuid(writer, &self.uuid);
        write_fields(writer, &self.fields);
    }

    pub fn read(reader: &mut ByteReader, registry: &Registry) -> Result<GraphBox, Error> {
        let creation_index = reader.read_int()?;
        let name = reader.read_string()?;
        let uuid = read_uuid(reader)?;
        let schema = registry.get(&name).ok_or(Error::UnknownBox)?;
        let fields = read_fields(reader, schema)?;
        Ok(GraphBox {creation_index, name, uuid, fields})
    }
}
