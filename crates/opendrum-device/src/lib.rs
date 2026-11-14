//! The device glue every openDrum device shares: an [`Engine`] description plus [`export_device!`] is a device.

#![cfg_attr(target_family = "wasm", no_std)]

pub use abi;
use abi::{float_value, int_value, Block, EventRecord, Instrument, ParamValue, EVENT_CHOKE, EVENT_NOTE_ON};
use dsp::RENDER_QUANTUM;
use math::value_mapping::{Exponential, Linear, LinearInteger};
use opendrum::common::Play;

mod kick;
mod perc;
mod bell;
mod cymbal;
mod shaker;
mod hat;
mod rim;
mod tom;
mod clap;
mod snare;

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
// the editor's display draws a dot per sounding hit, the slot after the last holds -1
const POSITIONS_PATH: [u16; 1] = [1001];
const POSITION_SLOTS: usize = 16;
const ENDED_SLOTS: usize = 16;

/// How the automation value (0 to 1) maps to the parameter's value. Mirrors the adapter's `ValueMapping`.
#[derive(Clone, Copy)]
pub enum Mapping {
    Linear(f32, f32),
    Exponential(f32, f32),
    /// A choice of this many entries, the value is the index.
    Index(i32),
    Integer(i32, i32)
}

impl Mapping {
    pub fn value(&self, value: ParamValue) -> f32 {
        match *self {
            Mapping::Linear(min, max) => float_value(value, &Linear {min, max}),
            Mapping::Exponential(min, max) => float_value(value, &Exponential {min, max}),
            Mapping::Index(count) => int_value(value, &LinearInteger {min: 0, max: count - 1}) as f32,
            Mapping::Integer(min, max) => int_value(value, &LinearInteger {min, max}) as f32
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
    /// Writes the seconds since the start of every sounding hit, returns how many.
    fn positions(&self, output: &mut [f32]) -> usize;
    /// Cuts every sounding hit fast (its choke group fired).
    fn choke(&mut self);
    fn is_silent(&self) -> bool;
    /// Called once when the device stops rendering after a second of silence, for state that would outlast it.
    fn rest(&mut self) {}
}

/// Writes the `Engine` calls every openDrum engine answers alike, `bpm` for the engine that follows the tempo.
#[macro_export]
macro_rules! forward {
    ($engine:ident, $params:ident $(, $bpm:ident)?) => {
        fn create(sample_rate: f32) -> Self {$engine::new(sample_rate)}

        fn defaults() -> $params {$params::default()}

        fn note_on(&mut self, id: u32, velocity: f32, transpose: f32, params: &$params) {
            $engine::note_on(self, id, velocity, transpose, params)
        }

        fn note_off(&mut self, id: u32, params: &$params) {$engine::note_off(self, id, params)}

        fn process(&mut self, params: &$params, bpm: f32, output: &mut [f32]) {
            $crate::forward!(@process $engine, self, params, bpm, output $(, $bpm)?)
        }

        fn positions(&self, output: &mut [f32]) -> usize {$engine::positions(self, output)}

        fn choke(&mut self) {$engine::choke(self)}

        fn is_silent(&self) -> bool {$engine::is_silent(self)}
    };
    (@process $engine:ident, $self:ident, $params:ident, $bpm:ident, $output:ident, bpm) => {
        $engine::process($self, $params, $bpm, $output)
    };
    (@process $engine:ident, $self:ident, $params:ident, $bpm:ident, $output:ident) => {{
        let _ = $bpm;
        $engine::process($self, $params, $output)
    }};
}

pub struct DrumState<E: Engine> {
    engine: E,
    params: E::Params,
    ids: [u32; MAX_PARAMS],
    sample_rate: f32,
    mono: [f32; RENDER_QUANTUM],
    positions_id: u32,
    positions_ptr: u32,
    // notes that ended before they began (both at one offset), their hits are cut as soon as they start
    ended: [u32; ENDED_SLOTS],
    ended_count: usize,
    silent_frames: u32
}

pub struct Drum<E: Engine>(core::marker::PhantomData<E>);

impl<E: Engine> Instrument for Drum<E> {
    type State = DrumState<E>;

    fn init(state: &mut DrumState<E>, sample_rate: f32) {
        const {assert!(E::PARAMS.len() <= MAX_PARAMS, "more parameters than MAX_PARAMS")};
        state.engine = E::create(sample_rate);
        state.params = E::defaults();
        state.sample_rate = sample_rate;
        for (index, param) in E::PARAMS.iter().enumerate() {
            state.ids[index] = abi::bind_parameter(&[param.key]);
        }
        state.positions_id = abi::bind_broadcast(&POSITIONS_PATH, POSITION_SLOTS as u32);
    }

    fn finish(state: &mut DrumState<E>, _output: [&mut [f32]; 2]) {
        state.ended_count = 0;
        if state.positions_ptr == 0 {state.positions_ptr = abi::broadcast_ptr(state.positions_id);}
        if state.positions_ptr == 0 {return;}
        let slots = unsafe { core::slice::from_raw_parts_mut(state.positions_ptr as *mut f32, POSITION_SLOTS) };
        let count = state.engine.positions(slots);
        if count < POSITION_SLOTS {slots[count] = -1.0;}
    }

    fn process_audio(state: &mut DrumState<E>, output: [&mut [f32]; 2], block: &Block) {
        let [left, right] = output;
        if state.engine.is_silent() {
            let resting = state.silent_frames > state.sample_rate as u32;
            state.silent_frames = state.silent_frames.saturating_add(left.len() as u32);
            if resting {return;}
            if state.silent_frames > state.sample_rate as u32 {state.engine.rest();}
        } else {
            state.silent_frames = 0;
        }
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
        match event.kind {
            EVENT_NOTE_ON => {
                let tuning = 12.0 * libm::log2f(abi::base_frequency() / 440.0);
                let transpose = event.pitch as f32 - ROOT_KEY + event.cent / 100.0 + tuning;
                state.engine.note_on(event.id, event.velocity, transpose, &state.params);
                let count = state.ended_count;
                if let Some(index) = state.ended[..count].iter().position(|id| *id == event.id) {
                    state.ended.copy_within(index + 1..count, index);
                    state.ended_count -= 1;
                    state.engine.note_off(event.id, &state.params);
                }
            }
            EVENT_CHOKE => state.engine.choke(),
            _ => {
                state.engine.note_off(event.id, &state.params);
                if state.ended_count == ENDED_SLOTS {
                    state.ended.copy_within(1.., 0);
                    state.ended_count -= 1;
                }
                state.ended[state.ended_count] = event.id;
                state.ended_count += 1;
            }
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
                $crate::abi::with_state(state_ptr, |state: &mut State| {
                    <Device as $crate::abi::Instrument>::reset(state)
                })
            }
        }
    };
}
