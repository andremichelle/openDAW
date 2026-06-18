//! Consumes a single audio source (`AudioInput` in TS): an effect points at its upstream's output. A
//! summing node (a bus) instead keeps its own list of sources (TS `addAudioSource`). On re-wire the
//! source is replaced / the list rebuilt, so no `Terminable` is needed yet.

use crate::audio_buffer::SharedAudioBuffer;

pub trait AudioInput {
    fn set_audio_source(&mut self, source: SharedAudioBuffer);
}
