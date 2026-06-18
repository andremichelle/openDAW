//! One render block (`Block` in TS, core-processors `processing.ts`): a pulse range `[p0, p1)` mapped
//! to a sample range `[s0, s1)` at a given `bpm`, with `flags`. `index` identifies the block within
//! the render quantum.

use crate::block_flags::BlockFlags;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Block {
    pub index: u32,
    pub p0: f64,
    pub p1: f64,
    pub s0: usize,
    pub s1: usize,
    pub bpm: f32,
    pub flags: BlockFlags
}
