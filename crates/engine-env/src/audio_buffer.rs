//! The stereo render-quantum audio buffer, the Rust counterpart of lib-dsp `AudioBuffer`. Fixed size,
//! no allocation: every `AudioGenerator` owns one and reuses it each render. Audio routing is by
//! reference to these buffers (see `processor-port-map.md`), never through the graph.
//!
//! `SharedAudioBuffer` is kept here as the buffer's strongly-coupled shared handle.

use alloc::rc::Rc;
use core::cell::RefCell;
use crate::RENDER_QUANTUM;

pub struct AudioBuffer {
    pub left: [f32; RENDER_QUANTUM],
    pub right: [f32; RENDER_QUANTUM]
}

impl AudioBuffer {
    pub fn new() -> Self {
        Self {left: [0.0; RENDER_QUANTUM], right: [0.0; RENDER_QUANTUM]}
    }

    pub fn clear(&mut self) {
        self.left = [0.0; RENDER_QUANTUM];
        self.right = [0.0; RENDER_QUANTUM];
    }

    /// Zero `[from, to)`. A processor clears only the current block's range so earlier sub-blocks of
    /// the same render quantum (e.g. before a loop wrap) survive.
    pub fn clear_range(&mut self, from: usize, to: usize) {
        for index in from..to {
            self.left[index] = 0.0;
            self.right[index] = 0.0;
        }
    }

    /// Sum `other[from, to)` into `self`. Used to mix one source's output into a downstream input.
    pub fn add_range(&mut self, other: &AudioBuffer, from: usize, to: usize) {
        for index in from..to {
            self.left[index] += other.left[index];
            self.right[index] += other.right[index];
        }
    }
}

impl Default for AudioBuffer {
    fn default() -> Self {
        Self::new()
    }
}

/// A reference-counted, interior-mutable audio buffer: the Rust stand-in for TS's shared mutable
/// `AudioBuffer` object. An `AudioGenerator` owns one as its output; consumers hold cloned handles
/// (via `set_audio_source`) and read it during render. The engine is single-threaded, so `Rc` +
/// `RefCell` are right: no atomics, cheap borrow checks, and clones happen only at wiring time (never
/// on the audio thread). Bridges to the device offset-ABI by taking the backing array's address.
pub type SharedAudioBuffer = Rc<RefCell<AudioBuffer>>;

/// Allocate a fresh shared output buffer (at construction / wiring time, never during render).
pub fn shared_audio_buffer() -> SharedAudioBuffer {
    Rc::new(RefCell::new(AudioBuffer::new()))
}
