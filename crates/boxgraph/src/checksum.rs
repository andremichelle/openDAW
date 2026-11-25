//! Rolling 32-byte XOR checksum, mirroring lib-std `Checksum` (data.ts). Multi-byte values are
//! folded LITTLE-ENDIAN (note: the opposite of the big-endian wire serialization). `BoxGraph`
//! folds each box's fields (FLDS) in uuid order — used to validate the mirror after a transaction.

use crate::bytes::ByteWriter;
use crate::field::{write_value, FieldValue, Fields};

const MAGIC: u32 = 0x464c_4453; // "FLDS"

pub struct Checksum {
    result: [u8; 32],
    cursor: usize
}

impl Checksum {
    pub fn new() -> Self {
        Self {result: [0; 32], cursor: 0}
    }

    pub fn result(&self) -> [u8; 32] {
        self.result
    }

    /// The bytes written so far, modulo the 32-byte width.
    pub fn position(&self) -> usize {
        self.cursor % 32
    }

    /// Folds another fold that started at position 0 in at the current position, as if its bytes were written here.
    pub fn append(&mut self, fold: &[u8; 32], length: usize) {
        let offset = self.cursor % 32;
        for (index, byte) in fold.iter().enumerate() {
            self.result[(offset + index) % 32] ^= byte;
        }
        self.cursor = (offset + length) % 32;
    }

    fn write_byte(&mut self, value: u8) {
        if self.cursor >= self.result.len() {
            self.cursor = 0;
        }
        self.result[self.cursor] ^= value;
        self.cursor += 1;
    }

    fn write_short(&mut self, value: u16) {
        self.write_byte((value & 0xff) as u8);
        self.write_byte((value >> 8) as u8);
    }

    fn write_int(&mut self, value: u32) {
        self.write_byte((value & 0xff) as u8);
        self.write_byte(((value >> 8) & 0xff) as u8);
        self.write_byte(((value >> 16) & 0xff) as u8);
        self.write_byte(((value >> 24) & 0xff) as u8);
    }

    // an ASCII string's UTF-16 units are (0, byte): the zero folds to nothing, the byte lands one position later
    fn write_ascii_units(&mut self, bytes: &[u8]) {
        let mut position = self.cursor % 32;
        let mut index = 0;
        while index < bytes.len() && position != 0 {
            position = (position + 1) & 31;
            self.result[position] ^= bytes[index];
            position = (position + 1) & 31;
            index += 1;
        }
        let mut blocks = bytes[index..].chunks_exact(16);
        for block in &mut blocks {
            for (unit, byte) in block.iter().enumerate() {
                self.result[unit * 2 + 1] ^= byte;
            }
        }
        for byte in blocks.remainder() {
            position = (position + 1) & 31;
            self.result[position] ^= byte;
            position = (position + 1) & 31;
        }
        self.cursor = position;
    }

    fn write_bytes(&mut self, bytes: &[u8]) {
        let mut position = self.cursor % 32;
        let lead = ((32 - position) % 32).min(bytes.len());
        for byte in &bytes[..lead] {
            self.result[position] ^= byte;
            position = (position + 1) % 32;
        }
        let rest = &bytes[lead..];
        let mut blocks = rest.chunks_exact(32);
        for block in &mut blocks {
            for (target, byte) in self.result.iter_mut().zip(block) {
                *target ^= byte;
            }
        }
        for byte in blocks.remainder() {
            self.result[position] ^= byte;
            position = (position + 1) % 32;
        }
        self.cursor = position;
    }
}

impl Default for Checksum {
    fn default() -> Self {
        Self::new()
    }
}

/// Fold one box's fields into the checksum, replicating `Serializer.writeFields` written through a
/// `Checksum`: MAGIC + count, then per field key + payload-length + payload bytes (the payload is
/// the big-endian serialized field, fed byte-wise).
pub fn checksum_fields(checksum: &mut Checksum, fields: &Fields) {
    checksum.write_int(MAGIC);
    checksum.write_short(fields.len() as u16);
    for (key, value) in fields {
        if let FieldValue::String(text) = value {
            if text.is_ascii() {
                checksum.write_short(*key);
                checksum.write_int(4 + 2 * text.len() as u32);
                checksum.write_bytes(&(text.len() as u32).to_be_bytes());
                checksum.write_ascii_units(text.as_bytes());
                continue;
            }
        }
        let mut payload = ByteWriter::new();
        write_value(&mut payload, value);
        let bytes = payload.into_bytes();
        checksum.write_short(*key);
        checksum.write_int(bytes.len() as u32);
        checksum.write_bytes(&bytes);
    }
}
