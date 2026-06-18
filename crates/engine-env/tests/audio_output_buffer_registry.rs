//! AudioOutputBufferRegistry (ported from core-processors): resolve returns the registered shared
//! buffer and its producer node, the buffer is genuinely shared (writes are visible through the
//! resolved handle), an unregistered address resolves to nothing, and remove unregisters.

use boxgraph::address::Address;
use engine_env::audio_buffer::shared_audio_buffer;
use engine_env::audio_output_buffer_registry::AudioOutputBufferRegistry;

fn address(byte: u8) -> Address {
    Address::box_of([byte; 16])
}

#[test]
fn resolve_returns_the_registered_buffer_and_producer() {
    let mut registry: AudioOutputBufferRegistry<u32> = AudioOutputBufferRegistry::new();
    let buffer = shared_audio_buffer();
    registry.register(address(1), buffer.clone(), 42);

    let entry = registry.resolve(&address(1)).expect("registered");
    assert_eq!(entry.processor, 42, "the producing node id is recorded");
    buffer.borrow_mut().left[5] = 0.7; // producer writes through its own handle
    assert_eq!(entry.buffer.borrow().left[5], 0.7, "resolved handle reads the same buffer");
}

#[test]
fn resolve_is_none_for_an_unregistered_address() {
    let registry: AudioOutputBufferRegistry<u32> = AudioOutputBufferRegistry::new();
    assert!(registry.resolve(&address(9)).is_none());
}

#[test]
fn remove_unregisters_the_address() {
    let mut registry: AudioOutputBufferRegistry<u32> = AudioOutputBufferRegistry::new();
    registry.register(address(2), shared_audio_buffer(), 1);
    assert!(registry.resolve(&address(2)).is_some());
    assert!(registry.remove(&address(2)).is_some());
    assert!(registry.resolve(&address(2)).is_none());
}
