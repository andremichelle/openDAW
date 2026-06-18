//! A stereo render-quantum audio buffer (the Rust counterpart of lib-dsp `AudioBuffer`). Fixed size,
//! no allocation: reused every render.

use transport::transport::RENDER_QUANTUM;

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
}

impl Default for AudioBuffer {
    fn default() -> Self {
        Self::new()
    }
}
