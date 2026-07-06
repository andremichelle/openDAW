//! The MIDI OUTPUT instrument, ENGINE-SIDE like the tape (TS `MIDIOutputDeviceProcessor` +
//! `MIDITransportClock`): it produces no audio — it pulls the unit's note stream per block, converts the
//! lifecycle events to raw MIDI messages timed with the TS formula, and queues them for the worklet to
//! drain into the studio's unchanged `MIDISender` SAB ring (`midi_out_count` / `midi_out_take`).
//! The transport clock mirrors `MIDITransportClock`: scheduled Start / Stop / SongPosition on the engine's
//! play / stop / seek paths plus 24-ppq Clock ticks over transporting blocks, gated by the `MIDIOutputBox`es
//! connected to `RootBox.outputMidiDevices` (`sendTransportMessages` set and a non-empty `id`).

use alloc::boxed::Box;
use alloc::rc::Rc;
use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;
use core::cell::{Cell, RefCell};
use abi::{Block, EventRecord, EVENT_NOTE_OFF, EVENT_NOTE_ON};
use boxgraph::address::Uuid;
use boxgraph::subscription::SubscriptionId;
use engine_env::audio_buffer::{shared_audio_buffer, SharedAudioBuffer};
use engine_env::audio_generator::AudioGenerator;
use engine_env::event_buffer::EventBuffer;
use engine_env::event_receiver::EventReceiver;
use engine_env::process_info::ProcessInfo;
use engine_env::processor::Processor;
use transport::transport::RENDER_QUANTUM;
use crate::param_automation::ParamHandle;
use crate::{PullLink, DEVICE_MAX_EVENTS, PULL};

// WASM CONTRACT: lib-midi `MidiData.Command` status bytes.
const NOTE_ON: u8 = 0x90;
const NOTE_OFF: u8 = 0x80;
const CONTROLLER: u8 = 0xB0;
const START: u8 = 0xFA;
const STOP: u8 = 0xFC;
const CLOCK: u8 = 0xF8;
const POSITION: u8 = 0xF2;

// WASM CONTRACT: `MIDITransportClock.ClockRate = PPQN.fromSignature(1, 24 * 4)` = 40 pulses (24 ppq).
const CLOCK_RATE: f64 = 40.0;
// WASM CONTRACT: lib-dsp `UpdateClockRate = PPQN.fromSignature(1, 384)` = 10 pulses — the grid the TS
// `UpdateClock` feeds automated parameters with (`AbstractProcessor.updateParameters`).
const UPDATE_CLOCK_RATE: f64 = 10.0;

// The queue is drained every quantum by the worklet; a host that never drains (a render without the MIDI
// channel attached) must not grow the engine heap unbounded, so the queue drops beyond this (like the TS
// `MIDISender` ring returning `false` when full).
const MAX_QUEUE: usize = 8192;

/// One queued MIDI message: the record `midi_out_take` serializes for the worklet, which feeds it into the
/// TS `MIDISender` ring unchanged (`send(deviceId, data, timeMs)` — the sender truncates `timeMs | 0`).
pub(crate) struct MidiMsg {
    pub(crate) device: u32, // index into `device_ids` (resolved to the `MIDIOutputBox.id` string)
    pub(crate) status: u8,
    pub(crate) data1: u8,
    pub(crate) data2: u8,
    pub(crate) len: u8,
    pub(crate) time_ms: f64
}

/// The live fields of one `MIDIOutputBox`, kept current by targeted field subscriptions so the render path
/// never reads the graph. `device_num` is -1 while the box's `id` is EMPTY (TS's transport clock filters
/// `id !== ""`; note/CC sends to an empty id would be dropped by the main thread anyway, so the engine
/// skips queueing them — a surfaced deviation from TS, which still writes them into the ring).
pub(crate) struct MidiTargetCells {
    pub(crate) device_num: Cell<i32>,
    pub(crate) delay_ms: Cell<f64>,
    pub(crate) send_transport: Cell<bool>
}

struct MidiTarget {
    uuid: Uuid,
    cells: Rc<MidiTargetCells>,
    subs: Vec<SubscriptionId>
}

/// The engine's shared MIDI-out state: the message queue, the device-id string table (`device` index ->
/// `MIDIOutputBox.id`), the scheduled transport messages, and the registered `MIDIOutputBox` targets.
/// Lives behind an `Rc<RefCell>` on the `Engine` (no static), shared with the per-unit nodes and the
/// graph subscriptions.
pub(crate) struct MidiOut {
    queue: Vec<MidiMsg>,
    device_ids: Vec<String>,
    pending_transport: Vec<([u8; 3], u8)>,
    targets: Vec<MidiTarget>,
    // `RootBox.outputMidiDevices` hub / lifecycle observers cannot subscribe (no `&mut graph` there); they
    // record joins / leaves here and `Engine::sync_midi_targets` realizes them after the transaction.
    pending_add: Vec<Uuid>,
    pending_remove: Vec<Uuid>
}

pub(crate) type SharedMidiOut = Rc<RefCell<MidiOut>>;

pub(crate) fn shared_midi_out() -> SharedMidiOut {
    Rc::new(RefCell::new(MidiOut {
        queue: Vec::with_capacity(64),
        device_ids: Vec::new(),
        pending_transport: Vec::with_capacity(4),
        targets: Vec::new(),
        pending_add: Vec::new(),
        pending_remove: Vec::new()
    }))
}

impl MidiOut {
    pub(crate) fn push(&mut self, msg: MidiMsg) {
        if self.queue.len() < MAX_QUEUE {
            self.queue.push(msg);
        }
    }

    /// Map a `MIDIOutputBox.id` string to its stable device number (first-seen order, the number the
    /// worklet resolves back through `midi_out_device_id`). An EMPTY id maps to -1 (inactive).
    pub(crate) fn intern(&mut self, id: &str) -> i32 {
        if id.is_empty() {
            return -1;
        }
        match self.device_ids.iter().position(|existing| existing == id) {
            Some(index) => index as i32,
            None => {
                self.device_ids.push(String::from(id));
                (self.device_ids.len() - 1) as i32
            }
        }
    }

    pub(crate) fn device_id(&self, num: u32) -> Option<&str> {
        self.device_ids.get(num as usize).map(|id| id.as_str())
    }

    /// Schedule a transport message for the next quantum's delivery (TS `MIDITransportClock.schedule`).
    pub(crate) fn schedule(&mut self, bytes: [u8; 3], len: u8) {
        self.pending_transport.push((bytes, len));
    }

    /// The live cells of the `MIDIOutputBox` with `uuid`, if it is registered.
    pub(crate) fn resolve(&self, uuid: &Uuid) -> Option<Rc<MidiTargetCells>> {
        self.targets.iter().find(|target| &target.uuid == uuid).map(|target| target.cells.clone())
    }

    pub(crate) fn record_add(&mut self, uuid: Uuid) {
        self.pending_add.push(uuid);
    }

    pub(crate) fn record_remove(&mut self, uuid: Uuid) {
        self.pending_remove.push(uuid);
    }

    pub(crate) fn take_pending(&mut self) -> (Vec<Uuid>, Vec<Uuid>) {
        (core::mem::take(&mut self.pending_add), core::mem::take(&mut self.pending_remove))
    }

    pub(crate) fn add_target(&mut self, uuid: Uuid, cells: Rc<MidiTargetCells>, subs: Vec<SubscriptionId>) {
        self.targets.push(MidiTarget {uuid, cells, subs});
    }

    pub(crate) fn remove_target(&mut self, uuid: &Uuid) -> Vec<SubscriptionId> {
        match self.targets.iter().position(|target| &target.uuid == uuid) {
            Some(index) => self.targets.swap_remove(index).subs,
            None => Vec::new()
        }
    }

    pub(crate) fn queue_len(&self) -> usize {
        self.queue.len()
    }

    pub(crate) fn drain_queue(&mut self, mut consume: impl FnMut(&MidiMsg)) -> u32 {
        let count = self.queue.len() as u32;
        for msg in self.queue.drain(..) {
            consume(&msg);
        }
        count
    }

    #[cfg(test)]
    pub(crate) fn queued(&self) -> &[MidiMsg] {
        &self.queue
    }
}

fn floor_i32(value: f64) -> i32 {
    let truncated = value as i64;
    let truncated = if (truncated as f64) > value {truncated - 1} else {truncated};
    truncated as i32
}

fn ceil_i64(value: f64) -> i64 {
    let truncated = value as i64;
    if (truncated as f64) < value {truncated + 1} else {truncated}
}

/// WASM CONTRACT: `MidiData.positionInPPQN` — `midiBeats = Math.floor(pulses / 96)` (the TS constant,
/// kept although a MIDI beat = 1/16 note = 240 pulses at Quarter 960), 7-bit LSB/MSB with JS 32-bit ops
/// (a negative count-in position wraps exactly like `& 0x7F` / `>> 7` on an i32).
pub(crate) fn position_in_ppqn(pulses: f64) -> [u8; 3] {
    let beats = floor_i32(pulses / 96.0);
    [POSITION, (beats & 0x7F) as u8, ((beats >> 7) & 0x7F) as u8]
}

pub(crate) fn start_message() -> ([u8; 3], u8) {
    ([START, 0, 0], 1)
}

pub(crate) fn stop_message() -> ([u8; 3], u8) {
    ([STOP, 0, 0], 1)
}

pub(crate) fn position_message(pulses: f64) -> ([u8; 3], u8) {
    (position_in_ppqn(pulses), 3)
}

/// Mirrors TS `MIDITransportClock.process`, run once per quantum from `Engine::render`: deliver the
/// scheduled Start / Stop / SongPosition messages (timestamp = the box delay only), then emit 24-ppq Clock
/// ticks over the TRANSPORTING blocks with the note timing formula. Gating mirrors TS exactly: with no
/// `MIDIOutputBox`es, or none passing `sendTransportMessages && id !== ""`, the scheduled queue is dropped.
/// TS QUIRK mirrored: TS clears the scheduled queue INSIDE its per-box loop, so only the FIRST filtered
/// box receives the scheduled messages; every filtered box receives the Clock ticks.
pub(crate) fn process_transport_clock(midi_out: &SharedMidiOut, blocks: &[Block], sample_rate: f32) {
    let mut shared = midi_out.borrow_mut();
    let MidiOut {queue, device_ids: _, pending_transport, targets, ..} = &mut *shared;
    let passes = |cells: &MidiTargetCells| cells.send_transport.get() && cells.device_num.get() >= 0;
    if targets.is_empty() || !targets.iter().any(|target| passes(&target.cells)) {
        pending_transport.clear();
        return;
    }
    let mut delivered = false;
    for target in targets.iter() {
        if !passes(&target.cells) {
            continue;
        }
        if !delivered {
            for (bytes, len) in pending_transport.iter() {
                if queue.len() < MAX_QUEUE {
                    queue.push(MidiMsg {
                        device: target.cells.device_num.get() as u32,
                        status: bytes[0], data1: bytes[1], data2: bytes[2], len: *len,
                        time_ms: target.cells.delay_ms.get()
                    });
                }
            }
            pending_transport.clear();
            delivered = true;
        }
    }
    for block in blocks {
        if !block.flags.transporting() {
            continue;
        }
        let block_offset_seconds = block.s0 as f64 / sample_rate as f64;
        let mut index = ceil_i64(block.p0 / CLOCK_RATE); // TS Fragmentor.iterate: ceil, exclusive of p1
        loop {
            let position = index as f64 * CLOCK_RATE;
            if position >= block.p1 {
                break;
            }
            let event_offset_seconds = dsp::ppqn::pulses_to_seconds(position - block.p0, block.bpm);
            for target in targets.iter() {
                if !passes(&target.cells) {
                    continue;
                }
                let time_ms = (block_offset_seconds + event_offset_seconds) * 1000.0 + target.cells.delay_ms.get();
                if queue.len() < MAX_QUEUE {
                    queue.push(MidiMsg {device: target.cells.device_num.get() as u32, status: CLOCK, data1: 0, data2: 0, len: 1, time_ms});
                }
            }
            index += 1;
        }
    }
}

/// The live control fields of one MIDI-output unit (TS reads them off the box per block / per event; the
/// node reads these cells, kept current by the wiring's targeted subscriptions). `active_notes` mirrors
/// TS `#activeNotes` and is shared with the channel-change flush (which runs off-render).
pub(crate) struct MidiOutControls {
    pub(crate) enabled: Cell<bool>,
    pub(crate) channel: Cell<i32>,
    pub(crate) last_channel: Cell<i32>,
    pub(crate) target: Cell<Option<Uuid>>, // the `device` pointer's target MIDIOutputBox
    pub(crate) active_notes: RefCell<Vec<u8>>
}

impl MidiOutControls {
    pub(crate) fn new(channel: i32, target: Option<Uuid>) -> Rc<Self> {
        Rc::new(Self {
            enabled: Cell::new(true),
            channel: Cell::new(channel),
            last_channel: Cell::new(channel),
            target: Cell::new(target),
            active_notes: RefCell::new(Vec::with_capacity(16))
        })
    }
}

/// Mirrors the TS `box.channel.subscribe` handler: flush a note-off for every held note ON THE OLD channel
/// (timestamp = the device delay only), clear the held set, and adopt the new channel. Runs OFF-render
/// (a graph subscription).
pub(crate) fn flush_channel_change(controls: &MidiOutControls, midi_out: &SharedMidiOut, new_channel: i32) {
    let mut shared = midi_out.borrow_mut();
    let resolved = controls.target.get().and_then(|uuid| shared.resolve(&uuid));
    if let Some(cells) = resolved {
        if cells.device_num.get() >= 0 {
            let device = cells.device_num.get() as u32;
            let time_ms = cells.delay_ms.get();
            let status = NOTE_OFF | (controls.last_channel.get() as u8 & 0x0F);
            for pitch in controls.active_notes.borrow().iter() {
                shared.push(MidiMsg {device, status, data1: *pitch, data2: 0, len: 3, time_ms});
            }
        }
    }
    controls.active_notes.borrow_mut().clear();
    controls.last_channel.set(new_channel);
    controls.channel.set(new_channel);
}

/// One bound `MIDIOutputParameterBox` (TS `bindParameter` over its `value` field): the controller number
/// cell (kept live by a field subscription), the automation-aware value handle, and the last emitted value
/// (TS `AutomatableParameter.#value`, diffed so only changes emit a CC).
pub(crate) struct CcBinding {
    pub(crate) param: Uuid, // the MIDIOutputParameterBox uuid, the carry-over key across rebuilds
    pub(crate) controller: Rc<Cell<i32>>,
    pub(crate) handle: ParamHandle,
    pub(crate) last: Cell<f32>
}

/// The engine-side MIDI-output node (TS `MIDIOutputDeviceProcessor`): a graph processor whose audio output
/// stays SILENT (TS's untouched `AudioBuffer`) while `process` pulls the unit's note stream through the
/// midi-fx pull chain — marking the unit's note bits exactly like an instrument pull — and queues note-on /
/// note-off / CC messages with TS-identical timestamps.
pub(crate) struct MidiOutProcessor {
    sample_rate: f32,
    pull_chain: Option<PullLink>,
    controls: Rc<MidiOutControls>,
    midi_out: SharedMidiOut,
    output: SharedAudioBuffer,
    // The owning UNIT's note-bits slot (TS `NoteBroadcaster` at the unit address), passed by the wiring
    // (not the reconcile-scoped static): handed to the pull context so `host_pull_events` marks resolved
    // starts / completes — the note indicators light up.
    note_bits: Option<engine_env::telemetry::BroadcastSlot>,
    cc: Vec<CcBinding>,
    scratch: Box<[EventRecord]>,
    events: EventBuffer // unused (the node PULLS its notes); required by the Processor trait
}

impl MidiOutProcessor {
    pub(crate) fn new(sample_rate: f32, controls: Rc<MidiOutControls>, midi_out: SharedMidiOut,
                      note_bits: Option<engine_env::telemetry::BroadcastSlot>) -> Self {
        let blank = EventRecord {position: 0.0, offset: 0, kind: 0, id: 0, pitch: 0, velocity: 0.0, cent: 0.0, duration: 0.0};
        Self {
            sample_rate,
            pull_chain: None,
            controls,
            midi_out,
            output: shared_audio_buffer(),
            note_bits,
            cc: Vec::new(),
            scratch: vec![blank; DEVICE_MAX_EVENTS].into_boxed_slice(),
            events: EventBuffer::new()
        }
    }

    pub(crate) fn set_pull_chain(&mut self, chain: PullLink) {
        self.pull_chain = Some(chain);
    }

    pub(crate) fn set_cc(&mut self, cc: Vec<CcBinding>) {
        self.cc = cc;
    }

    /// The bound parameters' (box uuid, last emitted value) pairs, carried across a rebuild / re-bind so a
    /// surviving parameter never re-emits an unchanged CC.
    pub(crate) fn cc_snapshot(&self) -> Vec<(Uuid, f32)> {
        self.cc.iter().map(|cc| (cc.param, cc.last.get())).collect()
    }

    /// The resolved (device number, delay ms) of the pointed-at `MIDIOutputBox`, TS
    /// `optDevice.mapOr(box => box.delayInMs.getValue(), 0)` — no device resolves to (-1, 0).
    fn device(&self) -> (i32, f64) {
        let shared = self.midi_out.borrow();
        match self.controls.target.get().and_then(|uuid| shared.resolve(&uuid)) {
            Some(cells) => (cells.device_num.get(), cells.delay_ms.get()),
            None => (-1, 0.0)
        }
    }

    fn emit_cc(&self, controller: i32, value: f32, relative_block_time: f64) {
        // TS `parameterChanged`: skipped without a device pointer or while disabled. QUIRK mirrored: TS
        // computes `relativeBlockTime * 1000.0 * delayInMs` (a MULTIPLY where the notes path ADDS the delay).
        if !self.controls.enabled.get() {
            return;
        }
        let (device_num, delay) = self.device();
        if device_num < 0 {
            return;
        }
        let time_ms = relative_block_time * 1000.0 * delay;
        let status = CONTROLLER | (self.controls.channel.get() as u8 & 0x0F);
        let data1 = (controller & 0x7F) as u8;
        let data2 = ((value * 127.0 + 0.5) as i32 & 0x7F) as u8; // Math.round(value * 127) & 0x7F
        self.midi_out.borrow_mut().push(MidiMsg {device: device_num as u32, status, data1, data2, len: 3, time_ms});
    }

    /// Mirrors the TS constructor's `readAllParameters()`: seed every bound parameter's `last` from the
    /// FIELD value (TS `AutomatableParameter.#value` starts at `adapter.getValue()`) and emit its initial
    /// CC with `relativeBlockTime` 0.
    pub(crate) fn read_all_parameters(&self) {
        for cc in &self.cc {
            let value = cc.handle.field.get();
            cc.last.set(value);
            self.emit_cc(cc.controller.get(), value, 0.0);
        }
    }

    fn process_notes(&mut self, block: &Block, info: &ProcessInfo) {
        // TS `introduceBlock`: no source or disabled -> nothing pulled (the sequencer is not consumed).
        if !self.controls.enabled.get() || self.pull_chain.is_none() {
            return;
        }
        {
            // The full quantum's block array (like `PluginInstrument`), so a midi-fx in the pull chain can
            // resolve `host_pulse_to_offset` anywhere in the quantum.
            let pull = unsafe { PULL.get() };
            pull.current = self.pull_chain.clone();
            pull.blocks = info.blocks.as_ptr();
            pull.block_count = info.blocks.len();
            pull.sample_rate = self.sample_rate;
            pull.clock_armed = false;
            pull.note_bits = self.note_bits.clone(); // pulled notes mark THIS unit's note indicator
        }
        let out_ptr = self.scratch.as_ptr() as usize as u32; // wasm address; only a MIDI-fx device call reads it
        let count = crate::pull_events_into(block.p0, block.p1, block.flags.0,
            &mut self.scratch, out_ptr) as usize;
        {
            let pull = unsafe { PULL.get() };
            pull.current = None;
            pull.blocks = core::ptr::null();
            pull.block_count = 0;
            pull.note_bits = None;
        }
        let (device_num, delay) = self.device();
        let block_offset_seconds = block.s0 as f64 / self.sample_rate as f64;
        for index in 0..count {
            let record = self.scratch[index];
            if record.pitch > 127 {
                continue; // TS guards `pitch >= 0 && pitch <= 127`
            }
            let event_offset_seconds = dsp::ppqn::pulses_to_seconds(record.position - block.p0, block.bpm);
            let time_ms = (block_offset_seconds + event_offset_seconds) * 1000.0 + delay;
            let channel = self.controls.channel.get() as u8 & 0x0F;
            if record.kind == EVENT_NOTE_ON {
                let velocity = ((record.velocity * 127.0 + 0.5) as i32).clamp(0, 255) as u8; // Math.round
                self.controls.active_notes.borrow_mut().push(record.pitch as u8);
                if device_num >= 0 {
                    self.midi_out.borrow_mut().push(MidiMsg {
                        device: device_num as u32, status: NOTE_ON | channel,
                        data1: record.pitch as u8, data2: velocity, len: 3, time_ms
                    });
                }
            } else if record.kind == EVENT_NOTE_OFF {
                {
                    let mut active = self.controls.active_notes.borrow_mut();
                    if let Some(found) = active.iter().position(|pitch| *pitch == record.pitch as u8) {
                        active.remove(found);
                    }
                }
                if device_num >= 0 {
                    self.midi_out.borrow_mut().push(MidiMsg {
                        device: device_num as u32, status: NOTE_OFF | channel,
                        data1: record.pitch as u8, data2: 0, len: 3, time_ms
                    });
                }
            }
        }
    }

    fn process_cc(&self, block: &Block) {
        if self.cc.is_empty() {
            return;
        }
        // A PLAIN (un-automated) parameter mirrors the TS field subscription -> `parameterChanged(parameter)`
        // (default relativeBlockTime 0): the diff surfaces at the next block start, emitted at time 0.
        for cc in &self.cc {
            if cc.handle.track.is_none() {
                let value = cc.handle.field.get();
                if value != cc.last.get() {
                    cc.last.set(value);
                    self.emit_cc(cc.controller.get(), value, 0.0);
                }
            }
        }
        // AUTOMATED parameters update on the update-clock grid over TRANSPORTING blocks (TS `UpdateClock`
        // gating + `AbstractProcessor.updateParameters`), diffing the resolved value like
        // `AutomatableParameter.updateAutomation`.
        if !block.flags.transporting() || !self.cc.iter().any(|cc| cc.handle.track.is_some()) {
            return;
        }
        let block_offset_seconds = block.s0 as f64 / self.sample_rate as f64;
        let mut index = ceil_i64(block.p0 / UPDATE_CLOCK_RATE);
        loop {
            let position = index as f64 * UPDATE_CLOCK_RATE;
            if position >= block.p1 {
                break;
            }
            let relative_block_time = block_offset_seconds + dsp::ppqn::pulses_to_seconds(position - block.p0, block.bpm);
            for cc in &self.cc {
                if cc.handle.track.is_none() {
                    continue;
                }
                let (value, _) = cc.handle.resolve(position);
                if value != cc.last.get() {
                    cc.last.set(value); // updated regardless of device / enabled (TS updateAutomation)
                    self.emit_cc(cc.controller.get(), value, relative_block_time);
                }
            }
            index += 1;
        }
    }
}

impl AudioGenerator for MidiOutProcessor {
    fn audio_output(&self) -> SharedAudioBuffer {
        self.output.clone()
    }
}

impl EventReceiver for MidiOutProcessor {
    fn event_input(&mut self) -> &mut EventBuffer {
        &mut self.events
    }
}

impl Processor for MidiOutProcessor {
    fn reset(&mut self) {
        // TS `reset()` is empty; the wasm side also clears the unit's note indicator (our TS-side fix
        // clears its NoteBroadcaster on reset, and the engine's STOP clears every unit's bits anyway).
        if let Some(slot) = &self.note_bits {
            engine_env::telemetry::clear_note_bits(slot);
        }
    }

    fn process(&mut self, info: &ProcessInfo) {
        {
            // The output is a SILENT buffer (TS: an `AudioBuffer` nothing ever writes); keep it zeroed so
            // the unit's fx / strip / meters behave exactly like TS processing silence.
            let mut output = self.output.borrow_mut();
            output.left[..RENDER_QUANTUM].fill(0.0);
            output.right[..RENDER_QUANTUM].fill(0.0);
        }
        for block in info.blocks {
            self.process_notes(block, info);
            self.process_cc(block);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn position_in_ppqn_mirrors_the_ts_math() {
        // Math.floor(3840 / 96) = 40 -> lsb 40, msb 0.
        assert_eq!(position_in_ppqn(3840.0), [0xF2, 40, 0]);
        // Math.floor(96 * 200.5) / 96 = 200 -> lsb 200 & 0x7F = 72, msb 200 >> 7 = 1.
        assert_eq!(position_in_ppqn(96.0 * 200.5), [0xF2, 72, 1]);
        assert_eq!(position_in_ppqn(0.0), [0xF2, 0, 0]);
        // Negative (count-in): Math.floor(-1 / 96) = -1 -> JS (-1 & 0x7F) = 127, (-1 >> 7) & 0x7F = 127.
        assert_eq!(position_in_ppqn(-1.0), [0xF2, 127, 127]);
    }

    #[test]
    fn the_queue_caps_instead_of_growing_unbounded() {
        let shared = shared_midi_out();
        {
            let mut midi = shared.borrow_mut();
            for _ in 0..(MAX_QUEUE + 10) {
                midi.push(MidiMsg {device: 0, status: CLOCK, data1: 0, data2: 0, len: 1, time_ms: 0.0});
            }
            assert_eq!(midi.queue_len(), MAX_QUEUE);
        }
    }

    #[test]
    fn intern_assigns_stable_numbers_and_rejects_the_empty_id() {
        let shared = shared_midi_out();
        let mut midi = shared.borrow_mut();
        assert_eq!(midi.intern(""), -1);
        assert_eq!(midi.intern("device-a"), 0);
        assert_eq!(midi.intern("device-b"), 1);
        assert_eq!(midi.intern("device-a"), 0);
        assert_eq!(midi.device_id(1), Some("device-b"));
        assert_eq!(midi.device_id(7), None);
    }

    fn target(send_transport: bool, device_num: i32, delay: f64) -> Rc<MidiTargetCells> {
        Rc::new(MidiTargetCells {
            device_num: Cell::new(device_num),
            delay_ms: Cell::new(delay),
            send_transport: Cell::new(send_transport)
        })
    }

    fn playing_block(p0: f64, p1: f64, s0: u32, s1: u32, bpm: f32) -> Block {
        Block {index: 0, flags: abi::BlockFlags::create(true, false, true, false), p0, p1, s0, s1, bpm}
    }

    #[test]
    fn the_transport_clock_ticks_every_forty_pulses_with_the_note_timing_formula() {
        let shared = shared_midi_out();
        shared.borrow_mut().add_target([1; 16], target(true, 0, 10.0), Vec::new());
        // 120 bpm at 48 kHz: one 128-sample quantum spans 5.12 pulses -> grid hits at 0 only; use a
        // larger artificial range to count several ticks: [0, 100) -> ticks at 0, 40, 80.
        let blocks = [playing_block(0.0, 100.0, 0, 128, 120.0)];
        process_transport_clock(&shared, &blocks, 48000.0);
        let midi = shared.borrow();
        let queued = midi.queued();
        assert_eq!(queued.len(), 3);
        assert!(queued.iter().all(|msg| msg.status == CLOCK && msg.len == 1));
        // tick 0: (0/48000 + pulsesToSeconds(0, 120)) * 1000 + 10 = 10 ms
        assert_eq!(queued[0].time_ms, 10.0);
        // tick 40: pulsesToSeconds(40, 120) = 40 * 60 / 960 / 120 s = 20.833.. ms + 10
        let expected = dsp::ppqn::pulses_to_seconds(40.0, 120.0) * 1000.0 + 10.0;
        assert_eq!(queued[1].time_ms, expected);
    }

    #[test]
    fn scheduled_transport_messages_deliver_once_and_gate_on_the_filter() {
        let shared = shared_midi_out();
        // No targets: the scheduled queue is DROPPED (TS clears and returns).
        shared.borrow_mut().schedule([START, 0, 0], 1);
        process_transport_clock(&shared, &[], 48000.0);
        assert_eq!(shared.borrow().queue_len(), 0);
        // A target that does not pass the filter (sendTransportMessages false) also drops it.
        shared.borrow_mut().add_target([1; 16], target(false, 0, 10.0), Vec::new());
        shared.borrow_mut().schedule([START, 0, 0], 1);
        process_transport_clock(&shared, &[], 48000.0);
        assert_eq!(shared.borrow().queue_len(), 0);
        // Two passing targets: the scheduled message reaches only the FIRST (the mirrored TS quirk).
        shared.borrow_mut().add_target([2; 16], target(true, 1, 5.0), Vec::new());
        shared.borrow_mut().add_target([3; 16], target(true, 2, 7.0), Vec::new());
        shared.borrow_mut().schedule([STOP, 0, 0], 1);
        process_transport_clock(&shared, &[], 48000.0);
        let midi = shared.borrow();
        assert_eq!(midi.queue_len(), 1);
        assert_eq!(midi.queued()[0].device, 1);
        assert_eq!(midi.queued()[0].status, STOP);
        assert_eq!(midi.queued()[0].time_ms, 5.0);
    }

    #[test]
    fn an_empty_id_never_receives_transport_messages() {
        let shared = shared_midi_out();
        shared.borrow_mut().add_target([1; 16], target(true, -1, 10.0), Vec::new());
        shared.borrow_mut().schedule([START, 0, 0], 1);
        process_transport_clock(&shared, &[playing_block(0.0, 40.0, 0, 128, 120.0)], 48000.0);
        assert_eq!(shared.borrow().queue_len(), 0);
    }

    #[test]
    fn a_channel_change_flushes_note_offs_on_the_old_channel() {
        let shared = shared_midi_out();
        shared.borrow_mut().add_target([1; 16], target(false, 0, 10.0), Vec::new());
        let controls = MidiOutControls::new(2, Some([1; 16]));
        controls.active_notes.borrow_mut().extend_from_slice(&[60, 64]);
        flush_channel_change(&controls, &shared, 5);
        let midi = shared.borrow();
        assert_eq!(midi.queue_len(), 2);
        assert_eq!(midi.queued()[0].status, NOTE_OFF | 2, "note-off on the OLD channel");
        assert_eq!(midi.queued()[0].data1, 60);
        assert_eq!(midi.queued()[0].time_ms, 10.0, "flush timestamp = the device delay");
        assert_eq!(midi.queued()[1].data1, 64);
        assert!(controls.active_notes.borrow().is_empty());
        assert_eq!(controls.channel.get(), 5);
        assert_eq!(controls.last_channel.get(), 5);
    }
}
