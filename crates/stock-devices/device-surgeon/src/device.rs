//! The device wrapper: binds the engine core to the `SurgeonDeviceBox`. The box holds 101 live parameters (the
//! editor's controls, key 20) and 8 patterns of the same 101 plain values (key 30). The live parameters are the
//! selected pattern (key 13), the other patterns play their stored values. A live parameter that is automated or
//! modulated replaces that value in every pattern.

use crate::engine::{Engine, Slot, MAX_FRAMES, PATTERNS};
use crate::param::{Param, PARAMS};
use crate::pattern::{Lane, Pattern, PitchLoop, LANES};
use abi::{float_value, int_value, Block, BlockFlags, EventRecord, FieldValue, Instrument, ParamValue};
use math::value_mapping::{Decibel, Exponential, Linear, LinearInteger, ValueMapping, Values};

pub const VALUES: usize = 1 + 8 + LANES * 3 + PARAMS + PARAMS * LANES;
/// Bind order: tune, volume, slot, then the live values. `map_parameter` relies on it.
pub const PARAMETERS: usize = 3 + VALUES;

const TUNE: [u16; 1] = [10];
const VOLUME: [u16; 1] = [11];
const SLOT: [u16; 1] = [12];
const SELECTED: [u16; 1] = [13];
const LIVE: u16 = 20;
const STORED: u16 = 30;
const STATE: [u16; 1] = [0xFFF];
const NO_SLOT: i32 = -2;
const OFF: i32 = -1;
const SLOT_VALUES: [i32; 9] = [-1, 0, 1, 2, 3, 4, 5, 6, 7];
const TUNE_MAPPING: Exponential = Exponential {min: 20.0, max: 2000.0};
const VOLUME_MAPPING: Decibel = Decibel::default_volume();

#[derive(Clone, Copy)]
enum Kind {
    Int(i32, i32),
    Linear(f32, f32),
    Exponential(f32, f32)
}

// the box key and the mapping of a value, in the order rate, pitch loop, lanes, sound, amounts
fn spec(index: usize) -> (u16, Kind) {
    const UNIPOLAR: Kind = Kind::Linear(0.0, 1.0);
    const PITCH: [Kind; 8] = [Kind::Int(1, 32), Kind::Int(0, 99_999), UNIPOLAR, Kind::Linear(0.0, 36.0), UNIPOLAR, UNIPOLAR, UNIPOLAR, UNIPOLAR];
    const LANE: [Kind; 3] = [Kind::Int(1, 32), Kind::Int(0, 99_999), UNIPOLAR];
    const SOUND: [Kind; PARAMS] = [
        Kind::Exponential(0.25, 8.0), UNIPOLAR, Kind::Exponential(0.25, 16.0), Kind::Linear(0.0, 1.5), Kind::Int(0, 3),
        Kind::Linear(0.0, 4.0), Kind::Linear(0.0, 8.0), Kind::Exponential(0.02, 1.0), UNIPOLAR, Kind::Int(0, 1), UNIPOLAR,
        UNIPOLAR, Kind::Linear(0.0, 1.5), Kind::Int(0, 1), Kind::Linear(0.0, 0.3), UNIPOLAR
    ];
    match index {
        0 => (1, Kind::Int(0, 2)),
        1..=8 => (index as u16 + 1, PITCH[index - 1]),
        9..=20 => (index as u16 + 1, LANE[(index - 9) % 3]),
        21..=36 => (index as u16 + 9, SOUND[index - 21]),
        _ => (index as u16 + 63, Kind::Linear(-1.0, 1.0))
    }
}

fn resolve(kind: Kind, value: ParamValue) -> f32 {
    match kind {
        Kind::Int(min, max) => int_value(value, &LinearInteger {min, max}) as f32,
        Kind::Linear(min, max) => float_value(value, &Linear {min, max}),
        Kind::Exponential(min, max) => float_value(value, &Exponential {min, max})
    }
}

fn mapped(kind: Kind, unit: f32) -> f32 {
    match kind {
        Kind::Int(min, max) => LinearInteger {min, max}.y(unit) as f32,
        Kind::Linear(min, max) => Linear {min, max}.y(unit),
        Kind::Exponential(min, max) => Exponential {min, max}.y(unit)
    }
}

// the 0 to 1 position the engine core wants for a sound parameter given in box units
fn position(param: usize, value: f32) -> f32 {
    let (_, kind) = spec(21 + param);
    match kind {
        Kind::Int(min, max) => (value - min as f32 + 0.5) / (max - min + 1) as f32,
        Kind::Linear(min, max) => Linear {min, max}.x(value),
        Kind::Exponential(min, max) => Exponential {min, max}.x(value)
    }
}

fn pattern_of(values: &[f32; VALUES]) -> Pattern {
    let mut pattern = Pattern {
        rate: values[0] as u32,
        pitch: PitchLoop {
            steps: values[1] as u32, seed: values[2] as u32, mutate: values[3], range: values[4], density: values[5],
            tie: values[6], slide: values[7], accent: values[8]
        },
        ..Pattern::default()
    };
    for lane in 0..LANES {
        let at = 9 + lane * 3;
        pattern.lanes[lane] = Lane {steps: values[at] as u32, seed: values[at + 1] as u32, mutate: values[at + 2]};
    }
    for param in 0..PARAMS {
        pattern.base[param] = position(param, values[21 + param]);
        pattern.amounts[param].copy_from_slice(&values[37 + param * LANES..37 + (param + 1) * LANES]);
    }
    pattern
}

/// The device's per-instance state, interpreted from the engine-allocated (zeroed) block.
pub struct SurgeonState {
    engine: Engine,
    ids: [u32; PARAMETERS],
    field_ids: [[u32; VALUES]; PATTERNS],
    driven: [bool; VALUES],
    live: [f32; VALUES],
    stored: [[f32; VALUES]; PATTERNS],
    slot: i32,
    slot_changed: bool,
    selected: usize,
    selected_id: u32,
    playing: bool,
    dirty: bool,
    state_id: u32
}

impl SurgeonState {
    fn compose(&mut self) {
        for pattern in 0..PATTERNS {
            let mut values = self.stored[pattern];
            for index in 0..VALUES {
                if pattern == self.selected || self.driven[index] {values[index] = self.live[index];}
            }
            self.engine.patterns[pattern] = pattern_of(&values);
        }
        self.dirty = false;
    }

    fn slot(&self) -> Slot {
        if self.slot < 0 {Slot::Off} else {Slot::Pattern((self.slot as usize).min(PATTERNS - 1))}
    }
}

pub struct Surgeon;

impl Instrument for Surgeon {
    type State = SurgeonState;

    fn init(state: &mut SurgeonState, sample_rate: f32) {
        state.engine = Engine::new(sample_rate);
        state.ids[0] = abi::bind_parameter(&TUNE);
        state.ids[1] = abi::bind_parameter(&VOLUME);
        state.ids[2] = abi::bind_parameter(&SLOT);
        for index in 0..VALUES {
            let (key, _) = spec(index);
            state.ids[3 + index] = abi::bind_parameter(&[LIVE, key]);
        }
        for pattern in 0..PATTERNS {
            for index in 0..VALUES {
                let (key, _) = spec(index);
                state.field_ids[pattern][index] = abi::observe_field(&[STORED, pattern as u16, key]);
            }
        }
        state.selected_id = abi::observe_field(&SELECTED);
        state.state_id = abi::bind_broadcast_int_array(&STATE, 2);
        state.dirty = true;
    }

    fn handle_event(state: &mut SurgeonState, event: &EventRecord) {
        match event.kind {
            abi::EVENT_NOTE_ON => state.engine.note_on(event.id, event.pitch as f32 + event.cent / 100.0, event.velocity),
            abi::EVENT_NOTE_OFF | abi::EVENT_CHOKE => state.engine.note_off(event.id),
            _ => {}
        }
    }

    fn process_audio(state: &mut SurgeonState, output: [&mut [f32]; 2], block: &Block) {
        let [out_left, out_right] = output;
        if state.dirty {state.compose();}
        let playing = block.flags.has(BlockFlags::TRANSPORTING | BlockFlags::PLAYING);
        if state.slot_changed || (state.playing && !playing) {
            state.slot_changed = false;
            let slot = state.slot();
            if playing && state.playing && !block.flags.discontinuous() {state.engine.fire(slot);} else {state.engine.select(slot);}
        }
        state.playing = playing;
        let frames = out_left.len();
        let pulses_per_frame = if frames > 0 {(block.p1 - block.p0) / frames as f64} else {0.0};
        let mut scratch = [0.0f32; MAX_FRAMES];
        let mut done = 0;
        while done < frames {
            let count = (frames - done).min(MAX_FRAMES);
            let (p0, p1) = (block.p0 + done as f64 * pulses_per_frame, block.p0 + (done + count) as f64 * pulses_per_frame);
            let bar = abi::bar_at(p0);
            state.engine.process_bars(p0, p1, playing, done == 0 && block.flags.discontinuous(), bar.start, bar.length, &mut scratch[..count]);
            for (index, sample) in scratch[..count].iter().enumerate() {
                out_left[done + index] += *sample;
                out_right[done + index] += *sample;
            }
            done += count;
        }
        let shown = abi::broadcast_ptr(state.state_id);
        if shown != 0 {
            let number = |slot: Slot| match slot {
                Slot::Off => OFF,
                Slot::Pattern(index) => index as i32
            };
            let shown = unsafe { core::slice::from_raw_parts_mut(shown as *mut i32, 2) };
            shown[0] = number(state.engine.active());
            shown[1] = state.engine.fired().map_or(NO_SLOT, number);
        }
    }

    fn parameter_changed(state: &mut SurgeonState, id: u32, value: ParamValue) {
        let Some(index) = state.ids.iter().position(|bound| *bound == id) else {return;};
        match index {
            0 => state.engine.tune = 69.0 + 12.0 * libm::log2f(float_value(value, &TUNE_MAPPING) / 440.0),
            1 => state.engine.volume = math::db_to_gain(float_value(value, &VOLUME_MAPPING)),
            2 => {
                state.slot = int_value(value, &Values::new(&SLOT_VALUES));
                state.slot_changed = true;
            }
            _ => {
                let (_, kind) = spec(index - 3);
                state.driven[index - 3] = !matches!(value, ParamValue::Int(_) | ParamValue::Float(_) | ParamValue::Bool(_));
                state.live[index - 3] = resolve(kind, value);
                state.dirty = true;
            }
        }
    }

    fn field_changed(state: &mut SurgeonState, id: u32, value: FieldValue) {
        if id == state.selected_id {
            let FieldValue::Int(selected) = value else {panic!("Surgeon selected pattern kind mismatch")};
            state.selected = (selected.max(0) as usize).min(PATTERNS - 1);
            state.engine.sound = state.selected;
            state.dirty = true;
            return;
        }
        for pattern in 0..PATTERNS {
            let Some(index) = state.field_ids[pattern].iter().position(|bound| *bound == id) else {continue;};
            state.stored[pattern][index] = match value {
                FieldValue::Int(number) => number as f32,
                FieldValue::Float(number) => number,
                _ => panic!("Surgeon pattern field kind mismatch")
            };
            state.dirty = true;
            return;
        }
    }

    fn reset(state: &mut SurgeonState) {
        state.engine.stop();
        state.engine.select(state.slot());
        state.slot_changed = false;
        state.playing = false;
    }
}

/// The value a normalised automation value maps to, for the parameter bound as number `id`.
pub fn map(id: u32, unit: f32) -> f32 {
    match id as usize {
        0 => TUNE_MAPPING.y(unit),
        1 => VOLUME_MAPPING.y(unit),
        2 => Values::new(&SLOT_VALUES).y(unit) as f32,
        index if index < PARAMETERS => mapped(spec(index - 3).1, unit),
        _ => f32::NAN
    }
}

// the sound parameters are bound in the order the engine core numbers them
const _: () = assert!(Param::Velocity as usize == PARAMS - 1);
