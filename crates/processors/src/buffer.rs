//! The stereo render-quantum buffer now lives in `engine-env` (its canonical home). Re-exported here so
//! existing `processors::buffer::AudioBuffer` users keep working while this crate is superseded.

pub use engine_env::audio_buffer::AudioBuffer;
