//! UUID and Address. A UUID is 16 raw bytes. An Address identifies any vertex: a box UUID plus a
//! path of field keys (empty path = the box itself). Mirrors lib-box `address.ts`: on the wire an
//! Address is `uuid(16) + keyCount(byte) + keys(short…)`; ordering is UUID byte-wise then the
//! field-key path lexicographically (which `derive(Ord)` gives us, with `uuid` declared first).

use core::fmt;
use alloc::string::String;
use alloc::vec::Vec;
use crate::bytes::{ByteError, ByteReader, ByteWriter};

pub type Uuid = [u8; 16];

const HEX: &[u8; 16] = b"0123456789abcdef";

/// Standard hyphenated lowercase form (8-4-4-4-12), matching `UUID.toString`.
pub fn uuid_to_string(uuid: &Uuid) -> String {
    let mut text = String::with_capacity(36);
    for (index, byte) in uuid.iter().enumerate() {
        if index == 4 || index == 6 || index == 8 || index == 10 {
            text.push('-')
        }
        text.push(HEX[(byte >> 4) as usize] as char);
        text.push(HEX[(byte & 0x0f) as usize] as char);
    }
    text
}

pub fn uuid_parse(text: &str) -> Option<Uuid> {
    let hex: String = text.chars().filter(|character| *character != '-').collect();
    if hex.len() != 32 {
        return None;
    }
    let mut uuid = [0u8; 16];
    for index in 0..16 {
        uuid[index] = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(uuid)
}

pub fn read_uuid(reader: &mut ByteReader) -> Result<Uuid, ByteError> {
    let mut uuid = [0u8; 16];
    uuid.copy_from_slice(&reader.read_raw(16)?);
    Ok(uuid)
}

pub fn write_uuid(writer: &mut ByteWriter, uuid: &Uuid) {
    writer.write_raw(uuid)
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct Address {
    pub uuid: Uuid,
    pub field_keys: Vec<u16>,
}

impl fmt::Display for Address {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&uuid_to_string(&self.uuid))?;
        for key in &self.field_keys {
            write!(formatter, "/{key}")?;
        }
        Ok(())
    }
}

impl Address {
    pub fn box_of(uuid: Uuid) -> Self {
        Self {uuid, field_keys: Vec::new()}
    }

    pub fn of(uuid: Uuid, field_keys: Vec<u16>) -> Self {
        Self {uuid, field_keys}
    }

    pub fn is_box(&self) -> bool {
        self.field_keys.is_empty()
    }

    pub fn is_content(&self) -> bool {
        !self.field_keys.is_empty()
    }

    pub fn append(&self, key: u16) -> Self {
        let mut field_keys = self.field_keys.clone();
        field_keys.push(key);
        Self {uuid: self.uuid, field_keys}
    }

    /// True if `other` is a prefix of this address (same box, and its key path is a leading slice).
    pub fn starts_with(&self, other: &Address) -> bool {
        self.uuid == other.uuid
            && other.field_keys.len() <= self.field_keys.len()
            && other.field_keys
                .iter()
                .zip(self.field_keys.iter())
                .all(|(left, right)| left == right)
    }

    pub fn decode(text: &str) -> Option<Address> {
        let mut parts = text.split('/');
        let uuid = uuid_parse(parts.next()?)?;
        let mut field_keys = Vec::new();
        for part in parts {
            field_keys.push(part.parse::<u16>().ok()?);
        }
        Some(Address::of(uuid, field_keys))
    }

    pub fn write(&self, writer: &mut ByteWriter) {
        write_uuid(writer, &self.uuid);
        writer.write_byte(self.field_keys.len() as i8);
        for key in &self.field_keys {
            writer.write_short(*key as i16)
        }
    }

    pub fn read(reader: &mut ByteReader) -> Result<Self, ByteError> {
        let uuid = read_uuid(reader)?;
        let count = reader.read_byte()? as usize;
        let mut field_keys = Vec::with_capacity(count);
        for _ in 0..count {
            field_keys.push(reader.read_short()? as u16)
        }
        Ok(Self {uuid, field_keys})
    }
}

/// Query helpers over a collection of addresses (mirror lib-box `Addressable`).
pub fn filter_equals<'a>(target: &Address, items: &'a [Address]) -> Vec<&'a Address> {
    items.iter().filter(|item| *item == target).collect()
}

/// Items whose address starts with `prefix` (the prefix and its descendants).
pub fn filter_starts_with<'a>(prefix: &Address, items: &'a [Address]) -> Vec<&'a Address> {
    items.iter().filter(|item| item.starts_with(prefix)).collect()
}

/// Items that are ancestors of (prefixes of) `target`.
pub fn filter_ends_with<'a>(target: &Address, items: &'a [Address]) -> Vec<&'a Address> {
    items.iter().filter(|item| target.starts_with(item)).collect()
}
