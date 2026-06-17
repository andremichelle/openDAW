//! Rolling 32-byte XOR checksum, mirroring lib-std `Checksum` (data.ts). Multi-byte values are
//! folded LITTLE-ENDIAN (note: the opposite of the big-endian wire serialization). `BoxGraph`
//! folds each box's fields (FLDS) in uuid order — used to validate the mirror after a transaction.

use crate::bytes::ByteWriter;
use crate::field::{write_value, Fields};

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

    fn write_bytes(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.write_byte(*byte)
        }
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
        let mut payload = ByteWriter::new();
        write_value(&mut payload, value);
        let bytes = payload.into_bytes();
        checksum.write_short(*key);
        checksum.write_int(bytes.len() as u32);
        checksum.write_bytes(&bytes);
    }
}
