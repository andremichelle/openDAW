//! AudioOutputBufferRegistry, ported from core-processors. Maps a box `Address` to that box's output:
//! its shared audio buffer and the producing processor. Routing that targets a box by address (a
//! sidechain or a bus input) resolves through this to get the buffer to read and the node to depend on
//! for ordering.
//!
//! TS stores the `Processor` object; our graph identifies a node by a key, so the producer is the
//! generic `P` (the graph vertex id, fixed when `EngineContext` lands). `AudioOutputBuffer` is the
//! registry's strongly-coupled entry type. TS `register` returns a `Terminable`; that is deferred, so
//! removal is an explicit `remove`.

use alloc::collections::BTreeMap;
use boxgraph::address::Address;
use crate::audio_buffer::SharedAudioBuffer;

pub struct AudioOutputBuffer<P> {
    pub address: Address,
    pub buffer: SharedAudioBuffer,
    pub processor: P
}

pub struct AudioOutputBufferRegistry<P> {
    outputs: BTreeMap<Address, AudioOutputBuffer<P>>
}

impl<P> AudioOutputBufferRegistry<P> {
    pub fn new() -> Self {
        Self {outputs: BTreeMap::new()}
    }

    pub fn register(&mut self, address: Address, buffer: SharedAudioBuffer, processor: P) {
        self.outputs.insert(address.clone(), AudioOutputBuffer {address, buffer, processor});
    }

    pub fn remove(&mut self, address: &Address) -> Option<AudioOutputBuffer<P>> {
        self.outputs.remove(address)
    }

    pub fn resolve(&self, address: &Address) -> Option<&AudioOutputBuffer<P>> {
        self.outputs.get(address)
    }

    pub fn len(&self) -> usize {
        self.outputs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.outputs.is_empty()
    }
}

impl<P> Default for AudioOutputBufferRegistry<P> {
    fn default() -> Self {
        Self::new()
    }
}
