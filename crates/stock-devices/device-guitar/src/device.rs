//! The Guitar device: the step pattern strums the chord track (Chords mode) and played notes land on the
//! strings (both modes). A stroke is an internal note event placed by the SDK at its sample, it then queues
//! one pluck per string at the strum spacing. Parameters are fields 10..25, 27..29, 36 and 37, the pattern lanes 30..34.

use abi::{float_value, int_value, Block, BlockFlags, EventRecord, FieldValue, Instrument, ParamValue, EVENT_NOTE_ON, EVENT_NOTE_OFF};
use libm::{floor, round};
use math::value_mapping::{Decibel, Linear, LinearInteger};

use crate::body::{Body, BODY_COUNT};
use crate::fretting::{self, Tab, MUTED, STRINGS};
use crate::string::{self, GuitarString, Pick, Pluck, Touch, MAX_DELAY};
use crate::strum::{self, STEP_COUNT};

const STROKE_MARK: u32 = 0xC000_0000;
const QUEUE: usize = 96;
const PENDING: usize = 16;
const SCRATCH: usize = 128;
const KEYS_MIN_FRET: i32 = 0;
const KEYS_MAX_FRET: i32 = 19;
const HUMANIZE: f32 = 0.012;

const MODE_MAPPING: LinearInteger = LinearInteger {min: 0, max: 1};
const RATE_MAPPING: LinearInteger = LinearInteger {min: 0, max: 2};
const POSITION_MAPPING: LinearInteger = LinearInteger {min: 0, max: 5};
const TUNING_MAPPING: LinearInteger = LinearInteger {min: 0, max: 3};
const BODY_MAPPING: LinearInteger = LinearInteger {min: 0, max: BODY_COUNT as i32 - 1};
const PICK_MAPPING: LinearInteger = LinearInteger {min: 0, max: 3};
const UNIPOLAR: Linear = Linear::unipolar();
const VOLUME_MAPPING: Decibel = Decibel::default_volume();

pub mod param {
    pub const MODE: usize = 0;
    pub const RATE: usize = 1;
    pub const SPEED: usize = 2;
    pub const SPEED_VARIATION: usize = 3;
    pub const VELOCITY: usize = 4;
    pub const VELOCITY_VARIATION: usize = 5;
    pub const SWING: usize = 6;
    pub const ACCENT: usize = 7;
    pub const POSITION: usize = 8;
    pub const TUNING: usize = 9;
    pub const BODY: usize = 10;
    pub const DAMPING: usize = 11;
    pub const DAMPING_VARIATION: usize = 12;
    pub const PLUCK: usize = 13;
    pub const PLUCK_VARIATION: usize = 14;
    pub const TENSION: usize = 15;
    pub const SPOT: usize = 16;
    pub const CHARACTER: usize = 17;
    pub const SPREAD: usize = 18;
    pub const VOLUME: usize = 19;
    pub const PICK: usize = 20;
    pub const COUNT: usize = 21;
}

// WASM CONTRACT: GuitarDeviceBox field keys (studio-boxes)
const PARAM_FIELDS: [u16; param::COUNT] = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 36, 27, 28, 29, 37];
const LANE_FIELDS: [u16; 4] = [30, 31, 32, 33];
const LENGTH_FIELD: u16 = 34;

const CHORDS_MODE: i32 = 0;

#[derive(Clone, Copy)]
struct Scheduled {
    due: u64,
    string: u8,
    pitch: f32,
    velocity: f32,
    touch: Touch,
    up: bool,
    seed: u32,
    key: u32
}

#[derive(Clone, Copy)]
struct Pending {
    id: u32,
    pitch: i32,
    velocity: f32
}

pub struct Settings {
    pub mode: i32,
    pub rate: i32,
    pub speed: f32,
    pub speed_variation: f32,
    pub velocity: f32,
    pub velocity_variation: f32,
    pub swing: f32,
    pub accent: f32,
    pub position: i32,
    pub tuning: i32,
    pub damping: f32,
    pub damping_variation: f32,
    pub pluck: f32,
    pub pluck_variation: f32,
    pub tension: f32,
    pub spot: f32,
    pub character: f32,
    pub pick: i32,
    pub spread: f32,
    pub gain: f32
}

pub struct State {
    strings: [GuitarString; STRINGS],
    body: Body,
    character: [f32; MAX_DELAY],
    pub settings: Settings,
    kinds: [i32; STEP_COUNT],
    masks: [i32; STEP_COUNT],
    velocities: [f32; STEP_COUNT],
    speeds: [f32; STEP_COUNT],
    length: usize,
    queue: [Scheduled; QUEUE],
    queued: usize,
    pending: [Pending; PENDING],
    pending_count: usize,
    keys: [u32; STRINGS],
    now: u64,
    tab: Tab,
    display: Tab,
    tab_key: (i32, i32, i32, i32),
    chord_root: i32,
    step: i32,
    lit: i32,
    dc: [(f32, f32); 2],
    pickup: [[f32; 4]; 2],
    sample_rate: f32,
    ids: [u32; param::COUNT],
    lane_ids: [u32; 4],
    length_id: u32,
    broadcast: u32
}

impl State {
    pub fn init_in_place(&mut self, sample_rate: f32) {
        self.sample_rate = sample_rate;
        for string in &mut self.strings {
            string.init(sample_rate);
        }
        self.body.init(sample_rate);
        self.settings = Settings {
            mode: CHORDS_MODE, rate: 1, speed: 0.3, speed_variation: 0.2, velocity: 0.8, velocity_variation: 0.15,
            swing: 0.0, accent: 0.3, position: 0, tuning: 0, damping: 0.33, damping_variation: 0.5, pluck: 0.5,
            pluck_variation: 0.5, tension: 0.0, spot: 0.2, character: 0.5, pick: 3, spread: 0.6,
            gain: dsp::db_to_gain(-6.0)
        };
        let mut noise = 65535u32;
        for value in self.character.iter_mut() {
            noise = noise.wrapping_mul(1664525).wrapping_add(1013904223);
            *value = (noise >> 8) as f32 / 8388608.0 - 1.0;
        }
        self.kinds = [strum::REST; STEP_COUNT];
        self.masks = [0b111111; STEP_COUNT];
        self.velocities = [0.8; STEP_COUNT];
        self.speeds = [0.5; STEP_COUNT];
        self.length = 16;
        self.tab = [MUTED; STRINGS];
        self.display = [MUTED; STRINGS];
        self.tab_key = (-1, 0, 0, 0);
        self.chord_root = -1;
        self.step = -1;
        self.keys = [0; STRINGS];
    }

    pub fn display(&self) -> Tab {self.display}

    pub fn set_lane(&mut self, lane: usize, values: &[i32]) {
        for (step, value) in values.iter().take(STEP_COUNT).enumerate() {
            match lane {
                0 => self.kinds[step] = (*value).clamp(strum::REST, strum::STOP),
                1 => self.masks[step] = *value & 0b111111,
                2 => self.velocities[step] = (*value).clamp(0, 100) as f32 / 100.0,
                _ => self.speeds[step] = (*value).clamp(0, 100) as f32 / 100.0
            }
        }
    }

    pub fn set_length(&mut self, length: i32) {
        self.length = length.clamp(1, STEP_COUNT as i32) as usize;
    }

    fn chord_tab(&mut self, root: i32, voicing: i32) -> Tab {
        let key = (root, voicing, self.settings.tuning, self.settings.position);
        if key != self.tab_key {
            self.tab_key = key;
            self.tab = fretting::tab(root, voicing, self.settings.tuning as usize, self.settings.position as usize);
        }
        self.tab
    }

    fn spacing(&self, factor: f32, seed: u32, salt: i64) -> f32 {
        let jitter = 1.0 + strum::bipolar(seed, salt, 11) * self.settings.speed_variation * 0.6;
        (0.003 + 0.12 * self.settings.speed * self.settings.speed) * factor * jitter.max(0.1) * self.sample_rate
    }

    fn enqueue(&mut self, item: Scheduled) {
        if self.queued < QUEUE {
            self.queue[self.queued] = item;
            self.queued += 1;
        }
    }

    fn release_all(&mut self) {
        for string in &mut self.strings {
            string.release();
        }
        self.queued = 0;
        self.keys = [0; STRINGS];
    }

    // One stroke of the pattern at the current sample: the chord at its position, its strings, their plucks.
    fn stroke(&mut self, event: &EventRecord) {
        let kind = event.pitch as i32;
        if kind == strum::STOP {
            self.release_all();
            return;
        }
        let Some((root, voicing)) = abi::harmony_at(event.position).chord else {
            self.chord_root = -1;
            return;
        };
        self.chord_root = root;
        let tab = self.chord_tab(root, voicing);
        self.display = tab;
        let mask = event.duration as i32;
        let (strings, count) = strum::order(kind, mask, &tab);
        let seed = event.id;
        let factor = if kind == strum::CHUCK {0.35} else {0.25 + event.cent * 1.5};
        let touch = match kind {
            strum::MUTE => Touch::Palm,
            strum::CHUCK => Touch::Chuck,
            _ => Touch::Open
        };
        if kind == strum::CHUCK {
            for string in 0..STRINGS {
                if tab[string] < 0 {
                    self.strings[string].release();
                }
            }
        }
        self.lit = 0;
        let mut delay = (0.5 + 0.5 * strum::bipolar(seed, 0, 13)) * self.settings.speed_variation * HUMANIZE * self.sample_rate;
        for (index, string) in strings[..count].iter().enumerate() {
            if index > 0 && kind != strum::PICK {
                delay += self.spacing(factor, seed, index as i64);
            }
            let pitch = fretting::pitch(self.settings.tuning as usize, *string, tab[*string]) as f32;
            self.enqueue(Scheduled {
                due: self.now + delay as u64, string: *string as u8, pitch, velocity: event.velocity, touch, up: kind == strum::UP,
                seed: strum::hash(seed, *string as i64, 3), key: 0
            });
            self.lit |= 1 << *string;
        }
    }

    // The notes that arrived together go to free strings near the Position, strummed from low to high.
    fn assign_pending(&mut self) {
        if self.pending_count == 0 {
            return;
        }
        let mut notes = self.pending;
        let count = self.pending_count;
        self.pending_count = 0;
        notes[..count].sort_unstable_by_key(|note| note.pitch);
        let tuning = self.settings.tuning as usize;
        let low = fretting::POSITION_FRETS[self.settings.position.clamp(0, 5) as usize];
        let mut taken = [false; STRINGS];
        let mut chosen = [(0usize, 0i32, 0u32, 0.0f32); PENDING];
        let mut placed = 0;
        for note in &notes[..count] {
            let fret_on = |string: usize| note.pitch - fretting::TUNINGS[tuning][string];
            let playable = |string: usize| (KEYS_MIN_FRET..=KEYS_MAX_FRET).contains(&fret_on(string));
            let in_window = |string: usize| fret_on(string) == 0 || (low - 1..=low + 4).contains(&fret_on(string));
            let string = (0..STRINGS).find(|string| !taken[*string] && playable(*string) && in_window(*string))
                .or_else(|| (0..STRINGS).filter(|string| !taken[*string] && playable(*string)).min_by_key(|string| fret_on(*string)))
                .or_else(|| (0..STRINGS).filter(|string| playable(*string)).min_by_key(|string| fret_on(*string)));
            let Some(string) = string else {continue};
            taken[string] = true;
            chosen[placed] = (string, note.pitch, note.id, note.velocity);
            placed += 1;
        }
        chosen[..placed].sort_unstable_by_key(|entry| entry.0);
        self.lit = 0;
        let mut delay = 0.0f32;
        for (index, (string, pitch, id, velocity)) in chosen[..placed].iter().copied().enumerate() {
            if index > 0 {
                delay += self.spacing(1.0, id, index as i64);
            }
            self.keys[string] = id;
            self.display[string] = (pitch - fretting::TUNINGS[tuning][string]) as i8;
            self.enqueue(Scheduled {
                due: self.now + delay as u64, string: string as u8, pitch: pitch as f32,
                velocity: velocity * (0.4 + self.settings.velocity * 0.8), touch: Touch::Open, up: false, seed: strum::hash(id, string as i64, 5),
                key: id
            });
            self.lit |= 1 << string;
        }
    }

    // The original variation laws: the damping variation only ever opens the string, the plug filter spreads around its value.
    fn fire(&mut self, item: Scheduled) {
        let settings = &self.settings;
        let bipolar = |salt: u32| strum::bipolar(item.seed, 0, salt);
        let unit = |salt: u32| 0.5 + 0.5 * bipolar(salt);
        let brightness = self.body.strings();
        let decay = string::overtone_decay(settings.damping, item.pitch) * (1.0 - 0.5 * unit(2) * settings.damping_variation)
            / (brightness * brightness * brightness);
        let plug = 0.1 + 0.8 * settings.pluck;
        let spread = settings.pluck_variation * 0.5;
        let (low, high) = (plug - (plug - 0.1) * spread, plug + (0.9 - plug) * spread);
        let pluck = Pluck {
            pitch: item.pitch,
            velocity: (item.velocity * (1.0 + bipolar(1) * settings.velocity_variation * 0.5)).clamp(0.02, 1.2),
            decay,
            plug: ((low + unit(4) * (high - low)) * brightness).min(0.95),
            position: 0.04 + 0.46 * settings.spot + bipolar(6) * 0.03 * settings.character,
            tension: settings.tension,
            character: settings.character,
            touch: item.touch,
            pick: Pick::from_index(settings.pick),
            up: item.up,
            noise_seed: item.seed
        };
        let base_frequency = abi::base_frequency();
        let string = item.string as usize;
        self.strings[string].pluck(&pluck, &self.body, &self.character, base_frequency);
        if item.key != 0 && self.keys[string] != item.key {
            self.strings[string].release();
        }
    }

    fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        let mut mono = [0.0f32; SCRATCH];
        let spread = self.settings.spread;
        let body = &self.body;
        for (index, string) in self.strings.iter_mut().enumerate() {
            let length = left.len();
            mono[..length].fill(0.0);
            if !string.render(&mut mono[..length], body) {
                continue;
            }
            let pan = spread * (index as f32 - 2.5) * 0.32;
            let (gain_left, gain_right) = ((1.0 - pan) * 0.5, (1.0 + pan) * 0.5);
            for sample in 0..length {
                left[sample] += mono[sample] * gain_left;
                right[sample] += mono[sample] * gain_right;
            }
        }
    }

    fn broadcast(&self) {
        let slot = abi::broadcast_ptr(self.broadcast);
        if slot == 0 {
            return;
        }
        let values = unsafe {core::slice::from_raw_parts_mut(slot as *mut i32, 9)};
        values[0] = self.step;
        values[1] = self.chord_root;
        for string in 0..STRINGS {
            values[2 + string] = self.display[string] as i32;
        }
        values[8] = self.lit;
    }
}

/// The pattern's strokes for `[from, to)`: one internal note-on per non-rest step, carrying its kind, lane
/// strings, level and strum speed. The pattern restarts with every bar of the signature track.
pub fn generate(state: &mut State, from: f64, to: f64, flags: BlockFlags, bar_at: fn(f64) -> abi::Bar,
                out: &mut [EventRecord]) -> usize {
    if state.settings.mode != CHORDS_MODE || !flags.transporting() {
        state.step = -1;
        state.broadcast();
        return 0;
    }
    let step_length = strum::step_length(state.settings.rate);
    let swing = state.settings.swing as f64 * 0.5 * step_length;
    let mut index = floor((from - swing) / step_length) as i64;
    let mut count = 0;
    loop {
        let grid = index as f64 * step_length;
        if grid >= to {
            break;
        }
        let position = if index.rem_euclid(2) == 1 {grid + swing} else {grid};
        let grid_index = index;
        index += 1;
        if position < from || position >= to || count >= out.len() {
            continue;
        }
        let bar = bar_at(grid);
        let per_bar = round(bar.length / step_length).max(1.0) as i64;
        let local = round((grid - bar.start) / step_length) as i64;
        let bars = round(bar.start / bar.length.max(1.0)) as i64;
        let span = (round(state.length as f64 / per_bar as f64) as i64).max(1);
        let step = (bars.rem_euclid(span) * per_bar + local).rem_euclid(state.length as i64) as usize;
        state.step = step as i32;
        let kind = state.kinds[step];
        if kind == strum::REST {
            continue;
        }
        let downbeat = local == 0;
        let on_beat = bar.beat > 0.0 && ((grid - bar.start) % bar.beat).abs() < 1.0e-6;
        let accent = if downbeat {1.0 + state.settings.accent * 0.6} else if on_beat {1.0 + state.settings.accent * 0.2} else {1.0};
        let level = (state.velocities[step] * (0.4 + state.settings.velocity * 0.8) * accent).min(1.2);
        out[count] = EventRecord {
            position, offset: 0, kind: EVENT_NOTE_ON, id: STROKE_MARK | (grid_index as u32 & 0x3FFF_FFFF), pitch: kind as u32,
            velocity: level, cent: state.speeds[step], duration: state.masks[step] as f64
        };
        count += 1;
    }
    state.broadcast();
    count
}

pub fn handle(state: &mut State, event: &EventRecord) {
    if event.kind == EVENT_NOTE_ON && event.id & STROKE_MARK == STROKE_MARK {
        state.stroke(event);
        state.broadcast();
    } else if event.kind == EVENT_NOTE_ON {
        if state.pending_count < PENDING {
            state.pending[state.pending_count] = Pending {id: event.id, pitch: event.pitch as i32, velocity: event.velocity};
            state.pending_count += 1;
        }
    } else if event.kind == EVENT_NOTE_OFF {
        if let Some(index) = state.pending[..state.pending_count].iter().position(|note| note.id == event.id) {
            state.pending.copy_within(index + 1..state.pending_count, index);
            state.pending_count -= 1;
        }
        for string in 0..STRINGS {
            if state.keys[string] == event.id && event.id != 0 {
                state.keys[string] = 0;
                if !state.queue[..state.queued].iter().any(|item| item.key == event.id) {
                    state.strings[string].release();
                }
            }
        }
    }
}

#[inline]
fn dc_block(state: &mut (f32, f32), input: f32) -> f32 {
    let output = input - state.0 + 0.995 * state.1;
    *state = (input, output);
    output
}

// The pickup's resonant lowpass (a biquad, direct form 1) in place.
fn resonate(coefficients: &[f32; 5], memory: &mut [f32; 4], signal: &mut [f32]) {
    let [b0, b1, b2, a1, a2] = *coefficients;
    for sample in signal.iter_mut() {
        let [x1, x2, y1, y2] = *memory;
        let output = b0 * *sample + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        *memory = [*sample, x1, output, y1];
        *sample = output;
    }
}

pub fn render(state: &mut State, output: [&mut [f32]; 2]) {
    state.assign_pending();
    let [out_left, out_right] = output;
    let length = out_left.len().min(out_right.len());
    let mut done = 0;
    while done < length {
        let mut index = 0;
        while index < state.queued {
            if state.queue[index].due <= state.now {
                let item = state.queue[index];
                state.queue[index] = state.queue[state.queued - 1];
                state.queued -= 1;
                state.fire(item);
            } else {
                index += 1;
            }
        }
        let next = state.queue[..state.queued].iter().map(|item| item.due).min().unwrap_or(u64::MAX);
        let chunk = ((length - done) as u64).min(next - state.now).min(SCRATCH as u64).max(1) as usize;
        let mut left = [0.0f32; SCRATCH];
        let mut right = [0.0f32; SCRATCH];
        state.render(&mut left[..chunk], &mut right[..chunk]);
        if let Some(coefficients) = state.body.resonance() {
            resonate(&coefficients, &mut state.pickup[0], &mut left[..chunk]);
            resonate(&coefficients, &mut state.pickup[1], &mut right[..chunk]);
        }
        let gain = state.settings.gain;
        for sample in 0..chunk {
            out_left[done + sample] += dc_block(&mut state.dc[0], left[sample]) * gain;
            out_right[done + sample] += dc_block(&mut state.dc[1], right[sample]) * gain;
        }
        state.now += chunk as u64;
        done += chunk;
    }
}

pub fn apply_parameter(state: &mut State, index: usize, value: ParamValue) {
    let settings = &mut state.settings;
    match index {
        param::MODE => settings.mode = int_value(value, &MODE_MAPPING),
        param::RATE => settings.rate = int_value(value, &RATE_MAPPING),
        param::SPEED => settings.speed = float_value(value, &UNIPOLAR),
        param::SPEED_VARIATION => settings.speed_variation = float_value(value, &UNIPOLAR),
        param::VELOCITY => settings.velocity = float_value(value, &UNIPOLAR),
        param::VELOCITY_VARIATION => settings.velocity_variation = float_value(value, &UNIPOLAR),
        param::SWING => settings.swing = float_value(value, &UNIPOLAR),
        param::ACCENT => settings.accent = float_value(value, &UNIPOLAR),
        param::POSITION => settings.position = int_value(value, &POSITION_MAPPING),
        param::TUNING => settings.tuning = int_value(value, &TUNING_MAPPING),
        param::BODY => state.body.select(int_value(value, &BODY_MAPPING).max(0) as usize),
        param::DAMPING => settings.damping = float_value(value, &UNIPOLAR),
        param::DAMPING_VARIATION => settings.damping_variation = float_value(value, &UNIPOLAR),
        param::PLUCK => settings.pluck = float_value(value, &UNIPOLAR),
        param::PLUCK_VARIATION => settings.pluck_variation = float_value(value, &UNIPOLAR),
        param::TENSION => settings.tension = float_value(value, &UNIPOLAR),
        param::SPOT => settings.spot = float_value(value, &UNIPOLAR),
        param::CHARACTER => settings.character = float_value(value, &UNIPOLAR),
        param::SPREAD => settings.spread = float_value(value, &UNIPOLAR),
        param::VOLUME => settings.gain = dsp::db_to_gain(float_value(value, &VOLUME_MAPPING)),
        param::PICK => settings.pick = int_value(value, &PICK_MAPPING),
        _ => {}
    }
}

pub struct Device;

impl Instrument for Device {
    type State = State;

    fn init(state: &mut State, sample_rate: f32) {
        state.init_in_place(sample_rate);
        for index in 0..param::COUNT {
            state.ids[index] = abi::bind_parameter(&[PARAM_FIELDS[index]]);
        }
        for (lane, field) in LANE_FIELDS.iter().enumerate() {
            state.lane_ids[lane] = abi::observe_field(&[*field]);
        }
        state.length_id = abi::observe_field(&[LENGTH_FIELD]);
        state.broadcast = abi::bind_broadcast_int_array(&[0], 9);
    }

    fn handle_event(state: &mut State, event: &EventRecord) {
        handle(state, event);
    }

    fn generate_events(state: &mut State, from: f64, to: f64, flags: BlockFlags, out: &mut [EventRecord]) -> usize {
        generate(state, from, to, flags, abi::bar_at, out)
    }

    fn process_audio(state: &mut State, output: [&mut [f32]; 2], _block: &Block) {
        render(state, output);
    }

    fn parameter_changed(state: &mut State, id: u32, value: ParamValue) {
        if let Some(index) = state.ids.iter().position(|bound| *bound == id) {
            apply_parameter(state, index, value);
        }
    }

    fn field_changed(state: &mut State, id: u32, value: FieldValue) {
        if id == state.length_id {
            if let FieldValue::Int(length) = value {
                state.set_length(length);
            }
        } else if let Some(lane) = state.lane_ids.iter().position(|bound| *bound == id) {
            if let FieldValue::Ints(values) = value {
                state.set_lane(lane, values);
            }
        }
    }

    fn reset(state: &mut State) {
        for string in &mut state.strings {
            string.reset();
        }
        state.dc = [(0.0, 0.0); 2];
        state.pickup = [[0.0; 4]; 2];
        state.queued = 0;
        state.pending_count = 0;
        state.keys = [0; STRINGS];
        state.step = -1;
        state.lit = 0;
        state.display = [MUTED; STRINGS];
    }
}
