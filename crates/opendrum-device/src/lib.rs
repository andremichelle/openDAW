//! The glue every openDrum device shares. A device crate describes its engine ([`Engine`]: its parameters with
//! their box keys and mappings, how a value lands in the engine's params, notes and rendering) and calls
//! [`export_device!`], which writes the device exports. The engine renders mono, the device writes it to both
//! channels. Notes are transposed by the key against 60 and the host's base tuning.

#![cfg_attr(target_family = "wasm", no_std)]

pub use abi;
use abi::{float_value, int_value, Block, EventRecord, Instrument, ParamValue, EVENT_NOTE_ON};
use dsp::RENDER_QUANTUM;
use math::value_mapping::{Exponential, Linear, LinearInteger};
use opendrum::kick::Play;

mod kick;

/// The play mode of a choice index: Mono, Poly, Gate.
fn play(value: f32) -> Play {
    match value as i32 {
        1 => Play::Poly,
        2 => Play::Gate,
        _ => Play::Mono
    }
}

/// The most parameters an openDrum device has.
pub const MAX_PARAMS: usize = 24;
const ROOT_KEY: f32 = 60.0;

/// How the automation value (0 to 1) maps to the parameter's value. Mirrors the adapter's `ValueMapping`.
#[derive(Clone, Copy)]
pub enum Mapping {
    Linear(f32, f32),
    Exponential(f32, f32),
    /// A choice of this many entries, the value is the index.
    Index(i32)
}

impl Mapping {
    pub fn value(&self, value: ParamValue) -> f32 {
        match *self {
            Mapping::Linear(min, max) => float_value(value, &Linear {min, max}),
            Mapping::Exponential(min, max) => float_value(value, &Exponential {min, max}),
            Mapping::Index(count) => int_value(value, &LinearInteger {min: 0, max: count - 1}) as f32
        }
    }
}

/// One automatable value: its field key in the device box and its mapping.
#[derive(Clone, Copy)]
pub struct Param {
    pub key: u16,
    pub mapping: Mapping
}

/// An openDrum engine as a device sees it. `Self` lives in the engine-allocated (zeroed) state block.
pub trait Engine: Sized {
    type Params: Copy;
    const PARAMS: &'static [Param];
    fn create(sample_rate: f32) -> Self;
    /// The engine's params before the host has delivered any value.
    fn defaults() -> Self::Params;
    /// Stores the value of `PARAMS[index]`.
    fn set(params: &mut Self::Params, index: usize, value: f32);
    fn note_on(&mut self, id: u32, velocity: f32, transpose: f32, params: &Self::Params);
    fn note_off(&mut self, id: u32, params: &Self::Params);
    /// Renders mono into `output` (overwriting it).
    fn process(&mut self, params: &Self::Params, bpm: f32, output: &mut [f32]);
}

pub struct DrumState<E: Engine> {
    engine: E,
    params: E::Params,
    ids: [u32; MAX_PARAMS],
    sample_rate: f32,
    // the key offset of the host's base tuning against A4 = 440 Hz, in semitones
    tuning: f32,
    mono: [f32; RENDER_QUANTUM]
}

pub struct Drum<E: Engine>(core::marker::PhantomData<E>);

impl<E: Engine> Instrument for Drum<E> {
    type State = DrumState<E>;

    fn init(state: &mut DrumState<E>, sample_rate: f32) {
        state.engine = E::create(sample_rate);
        state.params = E::defaults();
        state.sample_rate = sample_rate;
        state.tuning = 12.0 * libm::log2f(abi::base_frequency() / 440.0);
        for (index, param) in E::PARAMS.iter().enumerate() {
            state.ids[index] = abi::bind_parameter(&[param.key]);
        }
    }

    fn process_audio(state: &mut DrumState<E>, output: [&mut [f32]; 2], block: &Block) {
        let [left, right] = output;
        for start in (0..left.len()).step_by(RENDER_QUANTUM) {
            let end = (start + RENDER_QUANTUM).min(left.len());
            let mono = &mut state.mono[..end - start];
            state.engine.process(&state.params, block.bpm, mono);
            for (index, value) in mono.iter().enumerate() {
                left[start + index] += *value;
                right[start + index] += *value;
            }
        }
    }

    fn handle_event(state: &mut DrumState<E>, event: &EventRecord) {
        if event.kind == EVENT_NOTE_ON {
            let transpose = event.pitch as f32 - ROOT_KEY + event.cent / 100.0 + state.tuning;
            state.engine.note_on(event.id, event.velocity, transpose, &state.params);
        } else {
            state.engine.note_off(event.id, &state.params);
        }
    }

    fn reset(state: &mut DrumState<E>) {
        state.engine = E::create(state.sample_rate);
    }

    fn parameter_changed(state: &mut DrumState<E>, id: u32, value: ParamValue) {
        let count = E::PARAMS.len();
        let Some(index) = state.ids[..count].iter().position(|bound| *bound == id) else {return;};
        E::set(&mut state.params, index, E::PARAMS[index].mapping.value(value));
    }
}

/// The parameter's value for an automation value, in bind order (the parity probe).
pub fn map_parameter<E: Engine>(id: u32, unit: f32) -> f32 {
    E::PARAMS.get(id as usize).map_or(f32::NAN, |param| param.mapping.value(ParamValue::Unit(unit)))
}

/// Writes the device exports for the engine type `$engine` (an [`Engine`]).
#[macro_export]
macro_rules! export_device {
    ($engine:ty) => {
        #[cfg(target_family = "wasm")]
        #[panic_handler]
        fn panic(info: &core::panic::PanicInfo) -> ! {
            $crate::abi::panic_to_host(info)
        }

        type State = $crate::DrumState<$engine>;
        type Device = $crate::Drum<$engine>;

        #[no_mangle]
        pub extern "C" fn kind() -> u32 {
            $crate::abi::DEVICE_KIND_INSTRUMENT
        }

        #[no_mangle]
        pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
            core::mem::size_of::<State>() as u32
        }

        #[no_mangle]
        pub extern "C" fn process(desc_ptr: u32) {
            let ports = unsafe { $crate::abi::Ports::<State>::from_descriptor(desc_ptr) };
            $crate::abi::render_instrument::<Device>(ports);
        }

        #[no_mangle]
        pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
            unsafe {
                $crate::abi::with_state(state_ptr, |state: &mut State| {
                    <Device as $crate::abi::Instrument>::init(state, sample_rate)
                })
            }
        }

        #[no_mangle]
        pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32, modulation: f32) {
            let value = $crate::abi::ParamValue::from_wire(kind, value, modulation);
            unsafe {
                $crate::abi::with_state(state_ptr, |state: &mut State| {
                    <Device as $crate::abi::Instrument>::parameter_changed(state, id, value)
                })
            }
        }

        #[no_mangle]
        pub extern "C" fn map_parameter(id: u32, unit: f32) -> f32 {
            $crate::map_parameter::<$engine>(id, unit)
        }

        #[no_mangle]
        pub extern "C" fn reset(state_ptr: u32) {
            unsafe {
                $crate::abi::with_state(state_ptr, |state: &mut State| <Device as $crate::abi::Instrument>::reset(state))
            }
        }
    };
}
