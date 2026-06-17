//! Big-endian byte I/O mirroring `@opendaw/lib-std` `data.ts` (ByteArrayOutput / ByteArrayInput).
//! The format is the contract: big-endian primitives, booleans as one byte, strings as an `int`
//! UTF-16-code-unit count followed by UTF-16 BE code units, byte arrays as an `int` length + raw.

use alloc::string::String;
use alloc::vec::Vec;

pub struct ByteWriter {
    bytes: Vec<u8>,
}

impl ByteWriter {
    pub fn new() -> Self {
        Self {bytes: Vec::new()}
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.bytes
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }

    pub fn write_byte(&mut self, value: i8) {
        self.bytes.push(value as u8)
    }

    pub fn write_bool(&mut self, value: bool) {
        self.bytes.push(if value {1} else {0})
    }

    pub fn write_short(&mut self, value: i16) {
        self.bytes.extend_from_slice(&value.to_be_bytes())
    }

    pub fn write_int(&mut self, value: i32) {
        self.bytes.extend_from_slice(&value.to_be_bytes())
    }

    pub fn write_long(&mut self, value: i64) {
        self.bytes.extend_from_slice(&value.to_be_bytes())
    }

    pub fn write_float(&mut self, value: f32) {
        self.bytes.extend_from_slice(&value.to_be_bytes())
    }

    pub fn write_double(&mut self, value: f64) {
        self.bytes.extend_from_slice(&value.to_be_bytes())
    }

    /// Raw bytes, no length prefix — mirrors `DataOutput.writeBytes`. Length-prefixed byte arrays
    /// (ByteArrayField, box framing) compose `write_int` + `write_raw` at the caller.
    pub fn write_raw(&mut self, value: &[u8]) {
        self.bytes.extend_from_slice(value)
    }

    pub fn write_string(&mut self, value: &str) {
        let units = value.encode_utf16();
        self.write_int(value.encode_utf16().count() as i32);
        for unit in units {
            self.write_short(unit as i16)
        }
    }
}

impl Default for ByteWriter {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ByteError {
    UnexpectedEnd,
}

pub struct ByteReader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> ByteReader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self {bytes, position: 0}
    }

    pub fn position(&self) -> usize {
        self.position
    }

    pub fn remaining(&self) -> usize {
        self.bytes.len() - self.position
    }

    pub fn is_empty(&self) -> bool {
        self.remaining() == 0
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], ByteError> {
        if self.position + count > self.bytes.len() {
            return Err(ByteError::UnexpectedEnd);
        }
        let slice = &self.bytes[self.position..self.position + count];
        self.position += count;
        Ok(slice)
    }

    fn take_array<const N: usize>(&mut self) -> Result<[u8; N], ByteError> {
        let mut array = [0u8; N];
        array.copy_from_slice(self.take(N)?);
        Ok(array)
    }

    pub fn read_byte(&mut self) -> Result<i8, ByteError> {
        Ok(self.take_array::<1>()?[0] as i8)
    }

    pub fn read_bool(&mut self) -> Result<bool, ByteError> {
        Ok(self.take_array::<1>()?[0] != 0)
    }

    pub fn read_short(&mut self) -> Result<i16, ByteError> {
        Ok(i16::from_be_bytes(self.take_array()?))
    }

    pub fn read_int(&mut self) -> Result<i32, ByteError> {
        Ok(i32::from_be_bytes(self.take_array()?))
    }

    pub fn read_long(&mut self) -> Result<i64, ByteError> {
        Ok(i64::from_be_bytes(self.take_array()?))
    }

    pub fn read_float(&mut self) -> Result<f32, ByteError> {
        Ok(f32::from_be_bytes(self.take_array()?))
    }

    pub fn read_double(&mut self) -> Result<f64, ByteError> {
        Ok(f64::from_be_bytes(self.take_array()?))
    }

    /// Raw bytes, no length prefix — mirrors `DataInput.readBytes` (caller supplies the count).
    pub fn read_raw(&mut self, count: usize) -> Result<Vec<u8>, ByteError> {
        Ok(self.take(count)?.to_vec())
    }

    pub fn read_string(&mut self) -> Result<String, ByteError> {
        let count = self.read_int()? as usize;
        let mut units = Vec::with_capacity(count);
        for _ in 0..count {
            units.push(self.read_short()? as u16)
        }
        Ok(String::from_utf16_lossy(&units))
    }
}
