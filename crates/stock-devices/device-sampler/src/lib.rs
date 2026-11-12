//! Sampler, a multi-zone sample instrument, as a runtime-loadable device. A note plays every sample zone that
//! answers its key and velocity: zones on the same keys and velocities of a group are round robins and take
//! turns, overlapping zones crossfade, a group can choke others or play on the release. Each voice has an amp
//! envelope, a second envelope, two LFOs and a filter, wired by the modulation slots.
//!
//! The zones, groups and modulation slots are child boxes. The device observes them as tables
//! (`abi::observe_table`) and reads them straight from engine memory, so it holds no copy and knows no limit
//! on their number. A zone's sample arrives as a handle in its row and resolves once it is resident, a zone
//! whose sample is still loading stays silent.

#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{bool_value, float_value, int_value, Block, EventRecord, Instrument, ParamValue, Table, EVENT_CHOKE, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use dsp::panning::{panning_to_gains, Mixing};
use math::db_to_gain;
use math::random::Mulberry32;
use math::value_mapping::{Decibel, Exponential, Linear, LinearInteger, ValueMapping};

pub mod voice;
pub mod zones;

use voice::{fall_factor, Control, EnvelopeParams, LfoParams, SvfCoefficients, Voice, FILTER_OFF};
use zones::{fade_gain, midi_velocity, robin_pick, robin_position, Group, Zone, GROUP_COLUMNS, MODULATION_COLUMNS, ROBIN_OFF,
            ROBIN_RANDOM, TRIGGER_ATTACK, TRIGGER_RELEASE, ZONE_COLUMNS};

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info)
}

pub const MAX_VOICES: usize = 64; // the range of the `voices` parameter
const POOL: usize = MAX_VOICES + 16; // room for voices that still fall after they were stolen
const CONTROL_FRAMES: usize = 16;
const FAST_RELEASE_SECONDS: f32 = 0.005;
const KEYS: usize = 128;
const HELD_NOTES: usize = 16; // the keys one voice remembers to go back to, as the monophonic synths do
const POSITION_VOICES: usize = 16; // the editor paints up to 16 read heads
const POSITIONS_PATH: [u16; 1] = [1001];

// WASM CONTRACT: the field keys of `SamplerDeviceBox`.
const ZONES_HUB: [u16; 1] = [10];
const GROUPS_HUB: [u16; 1] = [11];
const MODULATIONS_HUB: [u16; 1] = [12];
const PARAMETER_PATHS: [&[u16]; PARAMETERS] = [
    &[20], &[21], &[22], &[23], &[24], &[25], &[30], &[31], &[32], &[40], &[41], &[42],
    &[50, 1], &[50, 2], &[50, 3], &[50, 4], &[50, 5], &[50, 6],
    &[51, 1], &[51, 2], &[51, 3], &[51, 4], &[51, 5], &[51, 6],
    &[60, 1], &[60, 2], &[60, 3], &[60, 4], &[60, 5], &[60, 6],
    &[61, 1], &[61, 2], &[61, 3], &[61, 4], &[61, 5], &[61, 6]
];
const PARAMETERS: usize = 36;
const VOICES: usize = 0;
const GLIDE: usize = 1;
const LEGATO: usize = 2;
const OCTAVE: usize = 3;
const TRANSPOSE: usize = 4;
const TUNE: usize = 5;
const FILTER_TYPE: usize = 6;
const CUTOFF: usize = 7;
const RESONANCE: usize = 8;
const VOLUME: usize = 9;
const PANNING: usize = 10;
const MONO: usize = 11;
const AMP_ENVELOPE: usize = 12;
const LFO_A: usize = 24;

const VOICES_MAPPING: LinearInteger = LinearInteger {min: 1, max: MAX_VOICES as i32};
const SECONDS_MAPPING: Linear = Linear {min: 0.0, max: 5.0};
const TIME_MAPPING: Exponential = Exponential {min: 0.001, max: 8.0};
const OCTAVE_MAPPING: LinearInteger = LinearInteger {min: -3, max: 3};
const TRANSPOSE_MAPPING: LinearInteger = LinearInteger {min: -12, max: 12};
const TUNE_MAPPING: Linear = Linear {min: -100.0, max: 100.0};
const FILTER_TYPE_MAPPING: LinearInteger = LinearInteger {min: 0, max: 3};
const CUTOFF_MAPPING: Exponential = Exponential {min: 20.0, max: 20_000.0};
const UNIPOLAR_MAPPING: Linear = Linear::unipolar();
const VOLUME_MAPPING: Decibel = Decibel::default_volume();
const PANNING_MAPPING: Linear = Linear::bipolar();
const SHAPE_MAPPING: LinearInteger = LinearInteger {min: 0, max: 3};
const RATE_MAPPING: Exponential = Exponential {min: 0.01, max: 30.0};

// WASM CONTRACT: `SamplerModulation.Source` and `SamplerModulation.Target` of the adapter.
const SOURCE_AMP_ENVELOPE: i32 = 0;
const SOURCE_MOD_ENVELOPE: i32 = 1;
const SOURCE_LFO_A: i32 = 2;
const SOURCE_LFO_B: i32 = 3;
const SOURCE_VELOCITY: i32 = 4;
const SOURCE_KEY: i32 = 5;
const SOURCE_RANDOM: i32 = 6;
const TARGET_PITCH: i32 = 0;
const TARGET_CUTOFF: i32 = 1;
const TARGET_RESONANCE: i32 = 2;
const TARGET_GAIN: i32 = 3;
const TARGET_PANNING: i32 = 4;
const TARGET_SAMPLE_START: i32 = 5;
const TARGET_LOOP_START: i32 = 6;
const TARGET_LFO_A_RATE: i32 = 7;
const TARGET_LFO_B_RATE: i32 = 8;
const TARGET_ENVELOPE_DEPTH: i32 = 9;
const PITCH_RANGE: f32 = 48.0; // semitones a full amount reaches
const CUTOFF_RANGE: f32 = 10.0; // octaves
const RATE_RANGE: f32 = 4.0; // octaves
const CENTER_KEY: f32 = 60.0;

// The lengths a synced LFO snaps to, in bars. WASM CONTRACT: `LfoModulatorBoxAdapter.Rates`.
const SYNC_BARS: [f32; 12] = [8.0, 4.0, 2.0, 1.0, 1.0 / 2.0, 1.0 / 4.0, 1.0 / 6.0, 1.0 / 8.0, 1.0 / 12.0, 1.0 / 16.0, 1.0 / 24.0, 1.0 / 32.0];

/// A key that is held while one voice plays another.
#[derive(Clone, Copy)]
struct HeldNote {
    id: u32,
    key: i32,
    pitch: f32,
    velocity: f32
}

/// What the modulation slots add up to for one voice at one moment.
#[derive(Clone, Copy, Default)]
struct Sums {
    pitch: f32,     // semitones
    cutoff: f32,    // octaves
    resonance: f32,
    gain: f32,      // 0 leaves the level, -1 silences
    panning: f32,
    start: f32,
    loop_start: f32,
    rates: [f32; 2] // octaves
}

pub struct SamplerState {
    voices: [Voice; POOL],
    zones: Table,
    groups: Table,
    modulations: Table,
    zones_id: u32,
    groups_id: u32,
    modulations_id: u32,
    parameter_ids: [u32; PARAMETERS],
    max_voices: i32,
    glide: f32,
    legato: bool,
    octave: i32,
    transpose: i32,
    tune: f32,
    filter_type: i32,
    cutoff: f32,
    resonance: f32,
    gain: f32,
    panning: f32,
    mono: f32,
    envelopes: [EnvelopeParams; 2],
    envelope_seconds: [[f32; 6]; 2],
    lfos: [LfoParams; 2],
    lfo_rates: [f32; 2],   // hertz as set, before sync
    lfo_sync: [bool; 2],
    lfo_restart: [bool; 2],
    lfo_phases: [f32; 2],  // free running, what a voice starts from when its LFO does not restart
    robins: [u8; KEYS],
    velocities: [u8; KEYS], // the velocity each held key was played with, a release trigger answers to it
    held: [HeldNote; HELD_NOTES],
    held_count: usize,
    positions_id: u32,
    positions_ptr: u32,
    last_pitch: f32,
    has_last_pitch: bool,
    fast_release: f32,
    random: Mulberry32,
    seq: u64,
    bpm: f32,
    sample_rate: f32
}

pub struct Sampler;

impl Instrument for Sampler {
    type State = SamplerState;

    fn init(state: &mut SamplerState, sample_rate: f32) {
        state.sample_rate = sample_rate;
        state.zones = Table::empty();
        state.groups = Table::empty();
        state.modulations = Table::empty();
        state.max_voices = 16;
        state.gain = 1.0;
        state.cutoff = 20_000.0;
        state.filter_type = FILTER_OFF;
        state.envelope_seconds = [[0.0, 0.001, 0.0, 0.5, 1.0, 0.25], [0.0, 0.001, 0.0, 0.5, 0.0, 0.25]];
        state.lfo_rates = [5.0, 0.5];
        state.lfo_restart = [true, true];
        state.lfos = [LfoParams {shape: 0, hertz: 5.0, delay: 0.0, fade: 0.0}, LfoParams {shape: 0, hertz: 0.5, delay: 0.0, fade: 0.0}];
        state.fast_release = fall_factor(FAST_RELEASE_SECONDS, sample_rate);
        state.random = Mulberry32::new(0x5A4D_504C);
        state.bpm = 120.0;
        update_envelope(state, 0);
        update_envelope(state, 1);
        for (index, path) in PARAMETER_PATHS.iter().enumerate() {
            state.parameter_ids[index] = abi::bind_parameter(path);
        }
        state.zones_id = abi::observe_table(&ZONES_HUB, &ZONE_COLUMNS);
        state.groups_id = abi::observe_table(&GROUPS_HUB, &GROUP_COLUMNS);
        state.modulations_id = abi::observe_table(&MODULATIONS_HUB, &MODULATION_COLUMNS);
        state.positions_id = abi::bind_broadcast(&POSITIONS_PATH, POSITION_VOICES as u32 * 2);
    }

    fn parameter_changed(state: &mut SamplerState, id: u32, value: ParamValue) {
        let Some(index) = state.parameter_ids.iter().position(|bound| *bound == id) else { return };
        apply_parameter(state, index, value);
    }

    // The ids are told apart by the order of `init`: natively every `observe_table` returns 0.
    fn table_changed(state: &mut SamplerState, id: u32, table: Table) {
        if id == state.modulations_id && table.columns() == MODULATION_COLUMNS.len() {
            state.modulations = table;
        } else if id == state.groups_id && table.columns() == GROUP_COLUMNS.len() {
            state.groups = table;
        } else if id == state.zones_id && table.columns() == ZONE_COLUMNS.len() {
            state.zones = table;
        }
    }

    fn handle_event(state: &mut SamplerState, event: &EventRecord) {
        if event.kind == EVENT_NOTE_ON {
            note_on(state, event);
        } else if event.kind == EVENT_NOTE_OFF {
            note_off(state, event);
        } else if event.kind == EVENT_CHOKE {
            state.voices.iter_mut().filter(|voice| voice.is_active()).for_each(Voice::fast_release);
        }
    }

    fn process_audio(state: &mut SamplerState, output: [&mut [f32]; 2], block: &Block) {
        let [out_left, out_right] = output;
        if block.bpm > 0.0 {state.bpm = block.bpm;}
        for lfo in 0..2 {
            state.lfos[lfo].hertz = lfo_hertz(state, lfo);
        }
        let frames = out_left.len();
        let mut from = 0;
        while from < frames {
            let to = (from + CONTROL_FRAMES).min(frames);
            render_interval(state, &mut out_left[from..to], &mut out_right[from..to]);
            from = to;
        }
        publish_positions(state);
    }

    fn reset(state: &mut SamplerState) {
        state.voices.iter_mut().for_each(Voice::stop);
        state.has_last_pitch = false;
        state.held_count = 0;
        publish_positions(state);
    }
}

fn update_envelope(state: &mut SamplerState, index: usize) {
    let [delay, attack, hold, decay, sustain, release] = state.envelope_seconds[index];
    let frames = |seconds: f32| (seconds * state.sample_rate) as u32;
    state.envelopes[index] = EnvelopeParams {
        delay: frames(delay), attack: frames(attack).max(1), hold: frames(hold),
        decay: fall_factor(decay, state.sample_rate), sustain, release: fall_factor(release, state.sample_rate)
    };
}

fn apply_parameter(state: &mut SamplerState, index: usize, value: ParamValue) {
    match index {
        VOICES => state.max_voices = int_value(value, &VOICES_MAPPING),
        GLIDE => state.glide = float_value(value, &SECONDS_MAPPING),
        LEGATO => state.legato = bool_value(value),
        OCTAVE => state.octave = int_value(value, &OCTAVE_MAPPING),
        TRANSPOSE => state.transpose = int_value(value, &TRANSPOSE_MAPPING),
        TUNE => state.tune = float_value(value, &TUNE_MAPPING),
        FILTER_TYPE => state.filter_type = int_value(value, &FILTER_TYPE_MAPPING),
        CUTOFF => state.cutoff = float_value(value, &CUTOFF_MAPPING),
        RESONANCE => state.resonance = float_value(value, &UNIPOLAR_MAPPING),
        VOLUME => state.gain = db_to_gain(float_value(value, &VOLUME_MAPPING)),
        PANNING => state.panning = float_value(value, &PANNING_MAPPING),
        MONO => state.mono = float_value(value, &UNIPOLAR_MAPPING),
        AMP_ENVELOPE..LFO_A => {
            let (envelope, field) = ((index - AMP_ENVELOPE) / 6, (index - AMP_ENVELOPE) % 6);
            state.envelope_seconds[envelope][field] = match field {
                0 | 2 => float_value(value, &SECONDS_MAPPING),
                4 => float_value(value, &UNIPOLAR_MAPPING),
                _ => float_value(value, &TIME_MAPPING)
            };
            update_envelope(state, envelope);
        }
        _ => {
            let (lfo, field) = ((index - LFO_A) / 6, (index - LFO_A) % 6);
            match field {
                0 => state.lfos[lfo].shape = int_value(value, &SHAPE_MAPPING),
                1 => state.lfo_rates[lfo] = float_value(value, &RATE_MAPPING),
                2 => state.lfos[lfo].delay = float_value(value, &SECONDS_MAPPING) * state.sample_rate,
                3 => state.lfos[lfo].fade = float_value(value, &SECONDS_MAPPING) * state.sample_rate,
                4 => state.lfo_sync[lfo] = bool_value(value),
                _ => state.lfo_restart[lfo] = bool_value(value)
            }
        }
    }
}

/// The rate an LFO runs at: its own, or the tempo division its rate knob points at when synced.
fn lfo_hertz(state: &SamplerState, lfo: usize) -> f32 {
    if !state.lfo_sync[lfo] {
        return state.lfo_rates[lfo];
    }
    synced_hertz(state.lfo_rates[lfo], state.bpm)
}

/// The rate of the note length that is nearest to `hertz` at this tempo, compared as musical intervals.
pub fn synced_hertz(hertz: f32, bpm: f32) -> f32 {
    let mut nearest = bpm / 240.0 / SYNC_BARS[0];
    for bars in SYNC_BARS.iter().skip(1) {
        let candidate = bpm / 240.0 / bars;
        if libm::fabsf(libm::log2f(candidate / hertz)) < libm::fabsf(libm::log2f(nearest / hertz)) {nearest = candidate;}
    }
    nearest
}

/// Publish the read heads to the `[1001]` float broadcast the editor paints on the waveform: for each voice
/// the row of its zone and its position in source frames, a row of `-1` ends the list. Skipped until the
/// engine has drained the slot.
fn publish_positions(state: &mut SamplerState) {
    if state.positions_ptr == 0 {
        state.positions_ptr = abi::broadcast_ptr(state.positions_id);
    }
    if state.positions_ptr == 0 {
        return;
    }
    let slots = unsafe { core::slice::from_raw_parts_mut(state.positions_ptr as *mut f32, POSITION_VOICES * 2) };
    write_positions(&state.voices, slots);
}

fn write_positions(voices: &[Voice], slots: &mut [f32]) {
    let mut count = 0usize;
    for voice in voices.iter().filter(|voice| voice.is_active()) {
        if count * 2 + 1 >= slots.len() {break}
        slots[count * 2] = voice.row as f32;
        slots[count * 2 + 1] = voice.position() as f32;
        count += 1;
    }
    if count * 2 < slots.len() {
        slots[count * 2] = -1.0;
    }
}

fn free_voice(state: &mut SamplerState) -> usize {
    if let Some(free) = state.voices.iter().position(|voice| !voice.is_active()) {
        return free;
    }
    let mut oldest = 0;
    for (index, voice) in state.voices.iter().enumerate() {
        if voice.seq < state.voices[oldest].seq {oldest = index;}
    }
    oldest
}

// More sounding voices than allowed: the oldest ones that are not falling already fall fast.
fn limit_voices(state: &mut SamplerState) {
    loop {
        let sounding = state.voices.iter().filter(|voice| voice.is_active() && !voice.is_released()).count() as i32;
        if sounding <= state.max_voices {return}
        let mut oldest: Option<usize> = None;
        for (index, voice) in state.voices.iter().enumerate() {
            if !voice.is_active() || voice.is_released() {continue}
            if oldest.is_none_or(|other| voice.seq < state.voices[other].seq) {oldest = Some(index);}
        }
        match oldest {
            Some(index) => state.voices[index].fast_release(),
            None => return
        }
    }
}

fn note_on(state: &mut SamplerState, event: &EventRecord) {
    let key = (event.pitch as i32).clamp(0, KEYS as i32 - 1);
    let pitch = key as f32 + event.cent / 100.0;
    state.velocities[key as usize] = midi_velocity(event.velocity) as u8;
    if state.max_voices == 1 {
        if state.held_count == HELD_NOTES {
            state.held.copy_within(1.., 0);
            state.held_count -= 1;
        }
        state.held[state.held_count] = HeldNote {id: event.id, key, pitch, velocity: event.velocity};
        state.held_count += 1;
    } else {
        state.held_count = 0;
    }
    // one voice and legato: a held note is carried to the new key instead of starting again
    if state.legato && state.max_voices == 1 {
        let glide = (state.glide * state.sample_rate) as u32;
        if let Some(voice) = state.voices.iter_mut().find(|voice| voice.is_active() && !voice.is_released()) {
            let from = voice.current_pitch();
            voice.id = event.id;
            voice.pitch = pitch;
            voice.glide(from, glide);
            state.last_pitch = pitch;
            state.has_last_pitch = true;
            return;
        }
    }
    trigger(state, event.id, key, pitch, event.velocity, TRIGGER_ATTACK);
    state.last_pitch = pitch;
    state.has_last_pitch = true;
}

// One voice: letting go of the last key that was pressed goes back to the one still held below it. Returns
// whether the note off was taken care of.
fn return_to_held(state: &mut SamplerState, id: u32) -> bool {
    let Some(position) = state.held[..state.held_count].iter().position(|note| note.id == id) else { return false };
    let was_top = position == state.held_count - 1;
    state.held.copy_within(position + 1..state.held_count, position);
    state.held_count -= 1;
    if !was_top || state.held_count == 0 || state.max_voices != 1 {
        return false;
    }
    let previous = state.held[state.held_count - 1];
    let glide = (state.glide * state.sample_rate) as u32;
    if state.legato {
        if let Some(voice) = state.voices.iter_mut().find(|voice| voice.is_active() && !voice.is_released()) {
            let from = voice.current_pitch();
            voice.id = previous.id;
            voice.pitch = previous.pitch;
            voice.glide(from, glide);
            state.last_pitch = previous.pitch;
            return true;
        }
    }
    state.voices.iter_mut().filter(|voice| voice.is_active() && voice.id == id && !voice.is_released()).for_each(Voice::note_off);
    trigger(state, previous.id, previous.key, previous.pitch, previous.velocity, TRIGGER_ATTACK);
    state.last_pitch = previous.pitch;
    true
}

fn note_off(state: &mut SamplerState, event: &EventRecord) {
    if return_to_held(state, event.id) {
        return;
    }
    let mut released: Option<(i32, f32)> = None;
    for voice in state.voices.iter_mut().filter(|voice| voice.is_active() && voice.id == event.id && !voice.is_released()) {
        released = Some((voice.key, voice.pitch));
        voice.note_off();
    }
    let key = released.map_or((event.pitch as i32).clamp(0, KEYS as i32 - 1), |(key, _)| key);
    let pitch = released.map_or(key as f32, |(_, pitch)| pitch);
    let velocity = state.velocities[key as usize] as f32 / 127.0;
    if velocity > 0.0 {trigger(state, event.id, key, pitch, velocity, TRIGGER_RELEASE);}
}

/// Start a voice for every zone that answers the key and velocity on this trigger.
fn trigger(state: &mut SamplerState, id: u32, key: i32, pitch: f32, velocity: f32, trigger: i32) {
    let zones = state.zones;
    let midi = midi_velocity(velocity);
    let robins = state.robins;
    let draw = (state.random.uniform() * 65_536.0) as u32;
    let random = state.random.uniform() * 2.0 - 1.0;
    let glide = (state.glide * state.sample_rate) as u32;
    let mut started = false;
    for row in 0..zones.rows() {
        let zone = Zone::read(&zones, row);
        if !zone.accepts(key, midi) {continue}
        let Some(sample) = zone.sample else {continue};
        let group = Group::find(&state.groups, zone.group);
        if group.trigger != trigger {continue}
        if group.round_robin != ROBIN_OFF {
            // one counter per stack, kept at its lowest key, so the stack takes turns across all its keys
            let slot = zone.key_low.clamp(0, KEYS as i32 - 1) as usize;
            let counter = robins[slot] as u32;
            let (rank, size) = robin_position(&zones, row, &zone);
            let pick = robin_pick(group.round_robin, size, counter, draw);
            if trigger == TRIGGER_ATTACK {
                state.robins[slot] = if size > 1 && group.round_robin == ROBIN_RANDOM {pick} else {counter.wrapping_add(1)} as u8;
            }
            if rank != pick {continue}
        }
        if group.choke > 0 {
            state.voices.iter_mut().filter(|voice| voice.is_active() && voice.choke == group.choke && voice.id != id)
                .for_each(Voice::fast_release);
        }
        let fade = fade_gain(&zones, row, &zone, key, midi);
        let phases = [if state.lfo_restart[0] {0.0} else {state.lfo_phases[0]}, if state.lfo_restart[1] {0.0} else {state.lfo_phases[1]}];
        let seq = state.seq;
        state.seq += 1;
        let index = free_voice(state);
        let has_last = state.has_last_pitch;
        let last = state.last_pitch;
        let voice = &mut state.voices[index];
        voice.start(id, seq, key, pitch, velocity, random, zone, sample, fade, group.choke, phases);
        voice.row = row as u32;
        if trigger == TRIGGER_RELEASE {voice.zone.one_shot = true;}
        if glide > 0 && has_last && trigger == TRIGGER_ATTACK {voice.glide(last, glide);}
        let sums = sums_of(state, index);
        state.voices[index].start_shift = sums.start;
        state.voices[index].loop_shift = sums.loop_start;
        started = true;
    }
    if started {limit_voices(state);}
}

fn source_value(state: &SamplerState, voice: &Voice, source: i32) -> f32 {
    match source {
        SOURCE_AMP_ENVELOPE => voice.amp.level(),
        SOURCE_MOD_ENVELOPE => voice.modulation.level(),
        SOURCE_LFO_A => voice.lfos[0].value(&state.lfos[0]),
        SOURCE_LFO_B => voice.lfos[1].value(&state.lfos[1]),
        SOURCE_VELOCITY => voice.velocity,
        SOURCE_KEY => ((voice.pitch - CENTER_KEY) / CENTER_KEY).clamp(-1.0, 1.0),
        SOURCE_RANDOM => voice.random,
        _ => 0.0
    }
}

fn is_bipolar(source: i32) -> bool {
    matches!(source, SOURCE_LFO_A | SOURCE_LFO_B | SOURCE_KEY | SOURCE_RANDOM)
}

/// Add up the modulation slots for one voice. Slots on Env Depth first scale what the second envelope does.
fn sums_of(state: &SamplerState, voice_index: usize) -> Sums {
    let voice = &state.voices[voice_index];
    let slots = &state.modulations;
    let mut depth = 1.0f32;
    for row in 0..slots.rows() {
        let (source, target) = (slots.int(row, 0), slots.int(row, 1));
        if target == TARGET_ENVELOPE_DEPTH && source != SOURCE_MOD_ENVELOPE {
            depth += slots.float(row, 2) * source_value(state, voice, source);
        }
    }
    let depth = depth.max(0.0);
    let mut sums = Sums::default();
    for row in 0..slots.rows() {
        let (source, target) = (slots.int(row, 0), slots.int(row, 1));
        let value = source_value(state, voice, source);
        let amount = slots.float(row, 2) * if source == SOURCE_MOD_ENVELOPE {depth} else {1.0};
        match target {
            TARGET_PITCH => sums.pitch += amount * value * PITCH_RANGE,
            TARGET_CUTOFF => sums.cutoff += amount * value * CUTOFF_RANGE,
            TARGET_RESONANCE => sums.resonance += amount * value,
            // a source at its top leaves the level alone, a negative amount turns the source around
            TARGET_GAIN => {
                let unit = if is_bipolar(source) {(value + 1.0) * 0.5} else {value};
                sums.gain += if amount >= 0.0 {amount * (unit - 1.0)} else {amount * unit};
            }
            TARGET_PANNING => sums.panning += amount * value,
            TARGET_SAMPLE_START => sums.start += amount * value,
            TARGET_LOOP_START => sums.loop_start += amount * value,
            TARGET_LFO_A_RATE => sums.rates[0] += amount * value * RATE_RANGE,
            TARGET_LFO_B_RATE => sums.rates[1] += amount * value * RATE_RANGE,
            _ => {}
        }
    }
    sums
}

fn render_interval(state: &mut SamplerState, left: &mut [f32], right: &mut [f32]) {
    let frames = left.len() as f32;
    for index in 0..POOL {
        if !state.voices[index].is_active() {continue}
        let Some(sample) = abi::resolve_sample(state.voices[index].sample) else {
            state.voices[index].stop();
            continue;
        };
        let sums = sums_of(state, index);
        let voice = &state.voices[index];
        let zone = &voice.zone;
        let semitones = (voice.current_pitch() - zone.root_key as f32) * zone.key_track
            + zone.transpose as f32 + zone.tune / 100.0
            + (state.octave * 12 + state.transpose) as f32 + state.tune / 100.0 + sums.pitch;
        let increment = (sample.sample_rate / state.sample_rate) as f64 * libm::exp2((semitones / 12.0) as f64);
        let cutoff = (state.cutoff * libm::exp2f(sums.cutoff)).clamp(20.0, 20_000.0);
        let resonance = (state.resonance + sums.resonance).clamp(0.0, 1.0);
        let q = core::f32::consts::FRAC_1_SQRT_2 * libm::powf(28.0, resonance);
        let level = (1.0 + sums.gain).clamp(0.0, 1.0);
        let gain = state.gain * db_to_gain(zone.gain) * voice.fade_gain * level * level;
        let [pan_left, pan_right] = panning_to_gains((state.panning + zone.panning + sums.panning).clamp(-1.0, 1.0), Mixing::Linear);
        let control = Control {
            increment,
            filter_type: state.filter_type,
            filter: SvfCoefficients::new(cutoff, q, state.sample_rate),
            filter_second: SvfCoefficients::new(cutoff, core::f32::consts::FRAC_1_SQRT_2, state.sample_rate),
            gain_left: gain * pan_left,
            gain_right: gain * pan_right,
            mono: state.mono
        };
        let planes = [sample.plane(0), sample.plane(if sample.channel_count > 1 {1} else {0})];
        let (amp, modulation, fast_release, sample_rate) = (state.envelopes[0], state.envelopes[1], state.fast_release, state.sample_rate);
        let hertz = [state.lfos[0].hertz * libm::exp2f(sums.rates[0]), state.lfos[1].hertz * libm::exp2f(sums.rates[1])];
        let voice = &mut state.voices[index];
        voice.render(planes, sample.sample_rate, &control, &amp, &modulation, fast_release, left, right);
        voice.lfos[0].advance(hertz[0], frames, sample_rate);
        voice.lfos[1].advance(hertz[1], frames, sample_rate);
    }
    for lfo in 0..2 {
        let phase = state.lfo_phases[lfo] + state.lfos[lfo].hertz * frames / state.sample_rate;
        state.lfo_phases[lfo] = phase - libm::floorf(phase);
    }
}

/// Render one chunk through the instrument path (events dispatched at their offsets), for native tests.
pub fn render(state: &mut SamplerState, events: &[EventRecord], out_left: &mut [f32], out_right: &mut [f32]) {
    out_left.fill(0.0);
    out_right.fill(0.0);
    let block = Block {index: 0, flags: abi::BlockFlags(0), p0: 0.0, p1: 0.0, anchor: 0.0, anchor_frame: 0, s0: 0, s1: out_left.len() as u32, bpm: 120.0};
    abi::dispatch_range::<Sampler>(state, [&mut *out_left, &mut *out_right], events, &block);
}

/// The number of voices that are sounding, for tests.
pub fn active_voices(state: &SamplerState) -> usize {
    state.voices.iter().filter(|voice| voice.is_active()).count()
}

// ---- The device ABI: shared with the engine, called wasm-to-wasm. ----

#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_INSTRUMENT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<SamplerState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { abi::Ports::<SamplerState>::from_descriptor(desc_ptr) };
    abi::render_instrument::<Sampler>(ports);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Sampler as Instrument>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32, modulation: f32) {
    unsafe { abi::with_state(state_ptr, |state| <Sampler as Instrument>::parameter_changed(state, id, ParamValue::from_wire(kind, value, modulation))) }
}

/// Take the snapshot of an observed table. The words stay in engine memory until the next one arrives.
#[no_mangle]
pub extern "C" fn table_changed(state_ptr: u32, id: u32, ptr: u32, rows: u32, columns: u32) {
    let table = unsafe { Table::from_wire(ptr, rows, columns) };
    unsafe { abi::with_state(state_ptr, |state| <Sampler as Instrument>::table_changed(state, id, table)) }
}

/// Parity probe: the REAL value stored for a UNIT automation value, ids in `init` bind order.
#[no_mangle]
pub extern "C" fn map_parameter(id: u32, unit: f32) -> f32 {
    let value = ParamValue::Unit(unit);
    let flag = |value: ParamValue| if bool_value(value) {1.0} else {0.0};
    match id as usize {
        VOICES => int_value(value, &VOICES_MAPPING) as f32,
        GLIDE => float_value(value, &SECONDS_MAPPING),
        LEGATO => flag(value),
        OCTAVE => int_value(value, &OCTAVE_MAPPING) as f32,
        TRANSPOSE => int_value(value, &TRANSPOSE_MAPPING) as f32,
        TUNE => float_value(value, &TUNE_MAPPING),
        FILTER_TYPE => int_value(value, &FILTER_TYPE_MAPPING) as f32,
        CUTOFF => float_value(value, &CUTOFF_MAPPING),
        RESONANCE | MONO => float_value(value, &UNIPOLAR_MAPPING),
        VOLUME => float_value(value, &VOLUME_MAPPING),
        PANNING => float_value(value, &PANNING_MAPPING),
        index @ AMP_ENVELOPE..LFO_A => match (index - AMP_ENVELOPE) % 6 {
            0 | 2 => float_value(value, &SECONDS_MAPPING),
            4 => float_value(value, &UNIPOLAR_MAPPING),
            _ => float_value(value, &TIME_MAPPING)
        },
        index @ LFO_A..PARAMETERS => match (index - LFO_A) % 6 {
            0 => int_value(value, &SHAPE_MAPPING) as f32,
            1 => float_value(value, &RATE_MAPPING),
            2 | 3 => float_value(value, &SECONDS_MAPPING),
            _ => flag(value)
        },
        _ => f32::NAN
    }
}

#[no_mangle]
pub extern "C" fn reset(state_ptr: u32) {
    unsafe { abi::with_state(state_ptr, |state| <Sampler as Instrument>::reset(state)) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::zones::tests::zone;

    fn voices(positions: &[(u32, usize)]) -> Vec<Voice> {
        let plane: Vec<f32> = vec![0.0; 64];
        positions.iter().map(|(row, frames)| {
            let mut voice: Voice = unsafe { core::mem::zeroed() };
            voice.start(1, 0, 60, 60.0, 1.0, 0.0, zone(), 1, 1.0, 0, [0.0, 0.0]);
            voice.row = *row;
            let open = SvfCoefficients::new(1_000.0, 0.707, 48_000.0);
            let control = Control {increment: 1.0, filter_type: FILTER_OFF, filter: open, filter_second: open, gain_left: 1.0, gain_right: 1.0, mono: 0.0};
            let envelope = EnvelopeParams {delay: 0, attack: 1, hold: 0, decay: 0.5, sustain: 1.0, release: 0.5};
            let (mut left, mut right) = (vec![0.0f32; *frames], vec![0.0f32; *frames]);
            voice.render([&plane, &plane], 48_000.0, &control, &envelope, &envelope, 0.5, &mut left, &mut right);
            voice
        }).collect()
    }

    #[test]
    fn positions_are_row_and_frame_pairs_ended_by_minus_one() {
        let mut slots = [9.0f32; 8];
        write_positions(&voices(&[(3, 5), (7, 12)]), &mut slots);
        assert_eq!(slots, [3.0, 5.0, 7.0, 12.0, -1.0, 9.0, 9.0, 9.0]);
    }

    #[test]
    fn no_voice_is_an_empty_list() {
        let mut slots = [9.0f32; 4];
        write_positions(&[], &mut slots);
        assert_eq!(slots[0], -1.0);
    }

    #[test]
    fn idle_voices_are_left_out() {
        let mut pool = voices(&[(1, 2), (2, 2), (3, 2)]);
        pool[1].stop();
        let mut slots = [9.0f32; 6];
        write_positions(&pool, &mut slots);
        assert_eq!(slots, [1.0, 2.0, 3.0, 2.0, -1.0, 9.0]);
    }

    #[test]
    fn more_voices_than_slots_fill_the_slots_without_an_end_mark() {
        let mut slots = [9.0f32; 4];
        write_positions(&voices(&[(1, 2), (2, 2), (3, 2)]), &mut slots);
        assert_eq!(slots, [1.0, 2.0, 2.0, 2.0]);
    }
}
