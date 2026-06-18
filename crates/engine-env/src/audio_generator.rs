//! Produces audio into its own buffer (`AudioGenerator` in TS). Returns a shared handle to that buffer
//! so downstream nodes can read it; the graph itself never moves audio.

use crate::audio_buffer::SharedAudioBuffer;

pub trait AudioGenerator {
    fn audio_output(&self) -> SharedAudioBuffer;
}
