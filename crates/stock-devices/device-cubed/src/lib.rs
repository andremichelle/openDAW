//! TB-303 instrument device.
//!
//! The voice is a transcription of the ar-303 v3 reference model at tag `final` (52 constants,
//! calibrated against the reference over 49 A/B pairs) and is gated by a sample-for-sample parity test
//! against that model. See `plans/device-cubed.md`.
//!
//! Heap-free, like the other stock devices: per-instance state lives in the engine-assigned state
//! block. The one exception is the wavetable bank, which is ~160 KB, IDENTICAL for every instance,
//! and therefore kept once in module memory rather than duplicated per device.
//!
//! Math goes through `libm` UNCONDITIONALLY, not just under `no_std`. If native builds used std's
//! transcendentals while wasm used `libm`, the parity test would be validating arithmetic that is
//! not what ships.

// no_std only on wasm (the deployed cdylib); native builds stay std for the test harness.
#![cfg_attr(target_family = "wasm", no_std)]

pub mod device;
pub mod generated;
pub mod merger;
pub mod pattern;
pub mod tables;
pub mod voice;

/// Bytes the engine must allocate (zeroed) for one instance. Rate-independent: the voice holds no
/// rate-sized buffer, and the wavetables are shared rather than per-instance.
#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<device::State>() as u32
}

/// What the host wires this device as: an instrument that voices notes into audio.
#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_INSTRUMENT
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe {abi::Ports::<device::State>::from_descriptor(desc_ptr)};
    abi::render_instrument::<device::Device>(ports);
}

/// Boot hook, called once when the device is wired. Builds the state IN PLACE: unlike the simpler
/// stock devices, a zeroed block is NOT a valid `Voice303` (charges start at 1.0).
#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe {abi::with_state(state_ptr, |state| <device::Device as abi::Instrument>::init(state, sample_rate))}
}

pub use merger::{NoteMerger, Source, VoiceCommand};
pub use voice::{Params, Tables, Voice303};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &core::panic::PanicInfo) -> ! {
    abi::panic_to_host(info)
}

fn fill_bank(bank: &mut Tables) {
    bank.fill(&generated::SAW_AMPLITUDE, &generated::SAW_PHASE,
              &generated::SQUARE_AMPLITUDE, &generated::SQUARE_PHASE);
}

/// The shared wavetable bank, built once on first use.
///
/// On wasm this is a plain static: the engine drives every device from ONE audio thread and the
/// bank is only ever written during `init`, never during render. Natively it is a `OnceLock`,
/// because `cargo test` runs tests on parallel threads - the first version of this was a bare
/// `static mut` and two tests promptly raced on a half-filled bank, which showed up as a bogus
/// parity failure. The wasm path is the deployed one; the native path exists so the gate that
/// guards it is itself sound.
#[cfg(target_family = "wasm")]
static mut TABLE_BANK: Tables = Tables::zeroed();

#[cfg(not(target_family = "wasm"))]
static TABLE_BANK: std::sync::OnceLock<Tables> = std::sync::OnceLock::new();

/// Returns the shared bank, building it on first call. Idempotent, so several device instances each
/// calling `init` cost one build.
///
/// # Safety
/// On wasm, must not be called concurrently with rendering; `init` is a boot hook called outside
/// `process`. The native path is sound regardless.
#[cfg(target_family = "wasm")]
pub unsafe fn ensure_tables() -> &'static Tables {
    let bank = &raw mut TABLE_BANK;
    if !(*bank).is_filled() {fill_bank(&mut *bank);}
    &*bank
}

#[cfg(not(target_family = "wasm"))]
pub unsafe fn ensure_tables() -> &'static Tables {
    TABLE_BANK.get_or_init(|| {
        let mut bank = Tables::zeroed();
        fill_bank(&mut bank);
        bank
    })
}

/// Deliver an observed box field (the pattern arrays). Without this EXPORT the engine sees a device
/// with no `field_changed` and the pattern data never arrives.
#[no_mangle]
pub extern "C" fn field_changed(state_ptr: u32, id: u32, kind: u32, bits: u32, len: u32) {
    unsafe {
        abi::with_state(state_ptr, |state| <device::Device as abi::Instrument>::field_changed(
            state, id, abi::FieldValue::from_wire(kind, bits, len)))
    }
}

/// Apply a parameter value the host resolved (initial / edit / automation), by the id `init` got
/// back. Without this EXPORT the engine sees a device with no `parameter_changed` and silently
/// delivers nothing - the device sounds, but every knob is inert.
#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32, modulation: f32) {
    unsafe {
        abi::with_state(state_ptr, |state| <device::Device as abi::Instrument>::parameter_changed(
            state, id, abi::ParamValue::from_wire(kind, value, modulation)))
    }
}

/// Transport STOP: release held notes and silence the voice, so playback starts clean.
#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, |state| <device::Device as abi::Instrument>::reset(state)) }
}
