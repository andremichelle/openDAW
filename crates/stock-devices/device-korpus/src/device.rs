//! The Korpus 2 device: parameter binding/mapping and the `Instrument` wiring around the voice
//! pool. Fields 10..26 per the frozen Korpus 2 table (exciter / object A / object B / out).

use abi::{float_value, int_value, Block, EventRecord, FieldValue, Instrument, ParamValue, EVENT_NOTE_ON};
use dsp::midi_to_hz_base;
use math::value_mapping::{Decibel, Linear, LinearInteger};
use voicing::{Voicing, VoicingMode};

use crate::engine::pluck::build_body;
use crate::voice::{Exciter, KorpusShared, KorpusVoice};

const POLY_VOICES: usize = 8;
const MONO_STACK: usize = 16;
const PRESET_EPOCH_FIELD: [u16; 1] = [27];
const DECLICK_DECAY: f32 = 0.985; // ~1.5ms at 48k: the cut's step eases to zero instead of popping

const EXCITER_MAPPING: LinearInteger = LinearInteger {min: 0, max: 4};
const OBJECT_A_MAPPING: LinearInteger = LinearInteger {min: 0, max: 5};
const OBJECT_B_MAPPING: LinearInteger = LinearInteger {min: 0, max: 6};
const TUNE_MAPPING: LinearInteger = LinearInteger {min: -24, max: 24};
const ROUTING_MAPPING: LinearInteger = LinearInteger {min: 0, max: 1};
const DETUNE_MAPPING: Linear = Linear {min: -25.0, max: 25.0};
const UNIPOLAR: Linear = Linear::unipolar();
const VOLUME_MAPPING: Decibel = Decibel::default_volume();

pub mod param {
    pub const EXCITER: usize = 0;
    pub const INTENSITY: usize = 1;
    pub const POSITION: usize = 2;
    pub const VIBRATO: usize = 3;
    pub const OBJECT_A: usize = 4;
    pub const DAMPING_A: usize = 5;
    pub const TUNE_A: usize = 6;
    pub const WIDTH_A: usize = 7;
    pub const OBJECT_B: usize = 8;
    pub const DAMPING_B: usize = 9;
    pub const TUNE_B: usize = 10;
    pub const DETUNE_B: usize = 11;
    pub const WIDTH_B: usize = 12;
    pub const LEVEL_B: usize = 13;
    pub const ROUTING: usize = 14;
    pub const COUPLE: usize = 15;
    pub const VOLUME: usize = 16;
    pub const COUNT: usize = 17;
}

pub struct State {
    voicing: Voicing<KorpusVoice, POLY_VOICES, MONO_STACK>,
    shared: KorpusShared,
    gain: f32,
    ids: [u32; param::COUNT],
    preset_epoch_id: u32,
    preset_epoch: i32,
    last: (f32, f32),
    declick: (f32, f32),
}

pub struct Device;

impl Instrument for Device {
    type State = State;

    // The zeroed state block is the initial voicing state; only the small shared fields and the
    // body table are written here (no large stack temporaries — see the wasm shadow-stack note).
    fn init(state: &mut State, sample_rate: f32) {
        state.voicing.set_mode(VoicingMode::Polyphonic);
        state.shared = KorpusShared {sample_rate, ..KorpusShared::silent()};
        build_body(&mut state.shared.body, sample_rate);
        state.gain = dsp::db_to_gain(-9.0);
        for index in 0..param::COUNT {
            state.ids[index] = abi::bind_parameter(&[10 + index as u16]);
        }
        state.preset_epoch = i32::MIN;
        state.preset_epoch_id = abi::observe_field(&PRESET_EPOCH_FIELD);
    }

    fn handle_event(state: &mut State, event: &EventRecord) {
        if event.kind == EVENT_NOTE_ON {
            let frequency = midi_to_hz_base(event.pitch as f32 + event.cent / 100.0, abi::base_frequency());
            state.voicing.start(event, frequency, 1.0, 0.0, 1, &state.shared);
        } else {
            state.voicing.stop(event.id as i32, 0.0);
        }
    }

    fn process_audio(state: &mut State, output: [&mut [f32]; 2], block: &Block) {
        let [out_left, out_right] = output;
        state.voicing.process([&mut *out_left, &mut *out_right], block, &state.shared);
        let (mut declick_l, mut declick_r) = state.declick;
        for index in 0..out_left.len() {
            out_left[index] = out_left[index] * state.gain + declick_l;
            out_right[index] = out_right[index] * state.gain + declick_r;
            declick_l *= DECLICK_DECAY;
            declick_r *= DECLICK_DECAY;
        }
        state.declick = (declick_l, declick_r);
        if let (Some(left), Some(right)) = (out_left.last(), out_right.last()) {
            state.last = (*left, *right);
        }
    }

    fn field_changed(state: &mut State, id: u32, value: FieldValue) {
        if id != state.preset_epoch_id {
            return;
        }
        let FieldValue::Int(epoch) = value else {
            panic!("preset-epoch must be an int field");
        };
        // The init catch-up only records the epoch; later changes are preset loads or their undo.
        if state.preset_epoch != i32::MIN && epoch != state.preset_epoch {
            state.voicing.reset();
            state.declick = state.last;
        }
        state.preset_epoch = epoch;
    }

    fn parameter_changed(state: &mut State, id: u32, value: ParamValue) {
        let Some(index) = state.ids.iter().position(|bound| *bound == id) else {
            return;
        };
        match index {
            param::EXCITER => state.shared.exciter = Exciter::from_index(int_value(value, &EXCITER_MAPPING)),
            param::INTENSITY => state.shared.intensity = float_value(value, &UNIPOLAR),
            param::POSITION => state.shared.position = float_value(value, &UNIPOLAR),
            param::VIBRATO => state.shared.vibrato = float_value(value, &UNIPOLAR),
            param::OBJECT_A => state.shared.object_a = int_value(value, &OBJECT_A_MAPPING),
            param::DAMPING_A => state.shared.damping_a = float_value(value, &UNIPOLAR),
            param::TUNE_A => state.shared.tune_a = int_value(value, &TUNE_MAPPING),
            param::WIDTH_A => state.shared.width_a = float_value(value, &UNIPOLAR),
            param::OBJECT_B => state.shared.object_b = int_value(value, &OBJECT_B_MAPPING),
            param::DAMPING_B => state.shared.damping_b = float_value(value, &UNIPOLAR),
            param::TUNE_B => state.shared.tune_b = int_value(value, &TUNE_MAPPING),
            param::DETUNE_B => state.shared.detune_b = float_value(value, &DETUNE_MAPPING),
            param::WIDTH_B => state.shared.width_b = float_value(value, &UNIPOLAR),
            param::LEVEL_B => state.shared.level_b = float_value(value, &UNIPOLAR),
            param::ROUTING => state.shared.routing = int_value(value, &ROUTING_MAPPING),
            param::COUPLE => state.shared.couple = float_value(value, &UNIPOLAR),
            param::VOLUME => state.gain = dsp::db_to_gain(float_value(value, &VOLUME_MAPPING)),
            _ => {}
        }
    }

    fn reset(state: &mut State) {
        state.voicing.reset();
    }
}
