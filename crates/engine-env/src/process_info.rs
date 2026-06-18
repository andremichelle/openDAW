//! The blocks of one render quantum handed to every processor (`ProcessInfo` in TS).

use crate::block::Block;

#[derive(Clone, Copy, Debug)]
pub struct ProcessInfo<'a> {
    pub blocks: &'a [Block]
}
