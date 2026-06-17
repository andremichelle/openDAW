//! Standalone Rust mirror of openDAW's BoxGraph, built and tested in isolation before it goes near
//! the audio engine. `no_std` + `alloc` so it can later compile into the wasm engine; native
//! `cargo test` builds with std for exhaustive testing.

#![cfg_attr(not(test), no_std)]

extern crate alloc;

pub mod bytes;
pub mod address;
pub mod field;
pub mod boxes;
pub mod graph;
pub mod updates;
pub mod checksum;
pub mod subscription;

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    UnexpectedEnd,
    BadMagic,
    UnknownBox,
    UnknownUpdate,
    AddressNotFound,
}

impl From<bytes::ByteError> for Error {
    fn from(_: bytes::ByteError) -> Self {
        Error::UnexpectedEnd
    }
}
