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

    // UTF-16 big-endian, an ASCII string (a base64 plugin state) without the encoder
    pub fn write_string(&mut self, value: &str) {
        if value.is_ascii() {
            self.write_int(value.len() as i32);
            self.bytes.reserve(value.len() * 2);
            for byte in value.bytes() {
                self.bytes.push(0);
                self.bytes.push(byte);
            }
            return;
        }
        let units: Vec<u16> = value.encode_utf16().collect();
        self.write_utf16(&units)
    }

    pub fn write_utf16(&mut self, units: &[u16]) {
        self.write_int(units.len() as i32);
        self.bytes.reserve(units.len() * 2);
        for unit in units {
            self.bytes.extend_from_slice(&unit.to_be_bytes())
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
        if count > self.bytes.len() - self.position {
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
        Ok(String::from_utf16_lossy(&self.read_utf16()?))
    }

    pub fn read_utf16(&mut self) -> Result<Vec<u16>, ByteError> {
        let count = self.read_int()? as usize;
        let bytes = self.take(count.checked_mul(2).ok_or(ByteError::UnexpectedEnd)?)?;
        Ok(bytes.chunks_exact(2).map(|unit| u16::from_be_bytes([unit[0], unit[1]])).collect())
    }

    // a string field: the units of an ASCII string (a base64 plugin state) become its bytes directly
    pub fn read_text(&mut self) -> Result<Result<String, Vec<u16>>, ByteError> {
        let count = self.read_int()? as usize;
        let bytes = self.take(count.checked_mul(2).ok_or(ByteError::UnexpectedEnd)?)?;
        if bytes.chunks_exact(2).all(|unit| unit[0] == 0 && unit[1] < 0x80) {
            let ascii: Vec<u8> = bytes.chunks_exact(2).map(|unit| unit[1]).collect();
            return Ok(Ok(String::from_utf8(ascii).expect("ascii is valid UTF-8")));
        }
        let units: Vec<u16> = bytes.chunks_exact(2).map(|unit| u16::from_be_bytes([unit[0], unit[1]])).collect();
        Ok(String::from_utf16(&units).map_err(|_| units))
    }
}
