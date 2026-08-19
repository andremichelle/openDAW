//! Project-global modulator sources and their assignments (plans/modulations.md).

use alloc::rc::Rc;
use alloc::vec::Vec;
use core::cell::{Cell, RefCell};
use boxgraph::address::Uuid;
use boxgraph::subscription::SubscriptionId;
use dsp::fast_math::fast_sin_tau;

// WASM CONTRACT: LfoModulatorBox.shape (field 10), mirrored by LfoModulatorBoxAdapter's shape values.
pub(crate) const SHAPE_SINE: i32 = 0;
pub(crate) const SHAPE_TRIANGLE: i32 = 1;
pub(crate) const SHAPE_SAW_UP: i32 = 2;
pub(crate) const SHAPE_SAW_DOWN: i32 = 3;
pub(crate) const SHAPE_SQUARE: i32 = 4;

// WASM CONTRACT: LfoModulatorBox.rateSync (field 11) indexes THIS table (one cycle in pulses), mirrored by
// LfoModulatorBoxAdapter.RatePPQNs. Index 0 is off, the rest run slowest to fastest.
pub(crate) const RATES: [f64; 13] = [0.0, 30720.0, 15360.0, 7680.0, 3840.0, 1920.0, 960.0, 640.0, 480.0,
    320.0, 240.0, 160.0, 120.0];

fn cycle_pulses(rate: i32) -> f64 {
    RATES[(rate.max(0) as usize).min(RATES.len() - 1)]
}

fn sync_turns(rate: i32, position: f64) -> f64 {
    let pulses = cycle_pulses(rate);
    if pulses <= 0.0 {0.0} else {position / pulses}
}

// WASM CONTRACT: StepsModulatorBox.direction (field 16), mirrored by StepsModulatorBoxAdapter's StepsDirection.
pub(crate) const DIRECTION_FORWARD: i32 = 0;
pub(crate) const DIRECTION_BACKWARD: i32 = 1;
pub(crate) const DIRECTION_PING_PONG: i32 = 2;
pub(crate) const DIRECTION_ALTERNATE: i32 = 3;
pub(crate) const DIRECTION_RANDOM: i32 = 4;

pub(crate) const MAX_STEPS: usize = 64;

// WASM CONTRACT: mirrors `LfoModulatorBoxAdapter.ExponentRange`.
const EXPONENT_RANGE: f64 = 8.0;

pub(crate) struct LfoState {
    pub(crate) shape: Cell<i32>,
    pub(crate) rate_sync: Cell<i32>,
    pub(crate) rate_absolute: Cell<f32>,
    pub(crate) phase: Cell<f32>,
    pub(crate) amount: Cell<f32>,
    pub(crate) exponent: Cell<f32>,
    free_turns: Cell<f64>
}

impl LfoState {
    pub(crate) fn new() -> Self {
        Self {shape: Cell::new(SHAPE_SINE), rate_sync: Cell::new(4), rate_absolute: Cell::new(0.0),
            phase: Cell::new(0.0), amount: Cell::new(1.0), exponent: Cell::new(0.0),
            free_turns: Cell::new(0.0)}
    }

    fn turn_at(&self, position: f64) -> f64 {
        sync_turns(self.rate_sync.get(), position)
            + self.free_turns.get()
            + self.phase.get() as f64
    }

    fn value_at(&self, position: f64) -> f32 {
        let turn = self.turn_at(position);
        let shape = match self.shape.get() {
            SHAPE_TRIANGLE => triangle(turn),
            SHAPE_SAW_UP => saw_up(turn),
            SHAPE_SAW_DOWN => -saw_up(turn),
            SHAPE_SQUARE => square(turn),
            _ => fast_sin_tau(turn)
        };
        shaped(shape as f32, self.exponent.get()) * self.amount.get()
    }
}

pub(crate) struct StepsState {
    pub(crate) count: Cell<i32>,
    pub(crate) rate_sync: Cell<i32>,
    pub(crate) rate_absolute: Cell<f32>,
    pub(crate) phase: Cell<f32>,
    pub(crate) amount: Cell<f32>,
    pub(crate) smooth: Cell<f32>,
    pub(crate) direction: Cell<i32>,
    pub(crate) steps: [Cell<f32>; MAX_STEPS],
    free_turns: Cell<f64>
}

impl StepsState {
    pub(crate) fn new() -> Self {
        Self {count: Cell::new(16), rate_sync: Cell::new(10), rate_absolute: Cell::new(0.0),
            phase: Cell::new(0.0), amount: Cell::new(1.0), smooth: Cell::new(0.0),
            direction: Cell::new(DIRECTION_FORWARD), steps: core::array::from_fn(|_| Cell::new(0.0)),
            free_turns: Cell::new(0.0)}
    }

    fn step_position(&self, position: f64, count: i64) -> f64 {
        sync_turns(self.rate_sync.get(), position)
            + self.free_turns.get()
            + self.phase.get() as f64 * count as f64
    }

    fn playhead_at(&self, position: f64) -> f32 {
        let count = self.count.get().clamp(1, MAX_STEPS as i32) as i64;
        let step = self.step_position(position, count);
        let index = floor(step);
        let resolved = self.resolve_index(index as i64, count) as f32;
        let fraction = (step - index) as f32;
        resolved + if self.descending(index as i64, count) {1.0 - fraction} else {fraction}
    }

    fn descending(&self, index: i64, count: i64) -> bool {
        match self.direction.get() {
            DIRECTION_BACKWARD => true,
            DIRECTION_PING_PONG => index.div_euclid(count).rem_euclid(2) == 1,
            DIRECTION_ALTERNATE => count >= 3 && index.rem_euclid(count * 2 - 2) >= count - 1,
            _ => false
        }
    }

    fn value_at(&self, position: f64) -> f32 {
        let count = self.count.get().clamp(1, MAX_STEPS as i32) as i64;
        let step = self.step_position(position, count);
        let index = floor(step);
        let current = self.step_at(index as i64, count);
        let smooth = self.smooth.get();
        let value = if smooth <= 0.0 {
            current
        } else {
            let previous = self.step_at(index as i64 - 1, count);
            let ramp = (((step - index) / smooth as f64) as f32).min(1.0);
            previous + (current - previous) * ramp * ramp * (3.0 - 2.0 * ramp)
        };
        value * self.amount.get()
    }

    fn step_at(&self, index: i64, count: i64) -> f32 {
        self.steps[self.resolve_index(index, count) as usize].get()
    }

    fn resolve_index(&self, index: i64, count: i64) -> i64 {
        let cycle = index.div_euclid(count);
        let local = index.rem_euclid(count);
        match self.direction.get() {
            DIRECTION_BACKWARD => count - 1 - local,
            DIRECTION_PING_PONG => if cycle.rem_euclid(2) == 0 {local} else {count - 1 - local},
            DIRECTION_RANDOM => random_index(cycle, local, count),
            DIRECTION_ALTERNATE => alternate_index(index, count),
            _ => local
        }
    }
}

/// WASM CONTRACT: mirrors `StepsModulatorBoxAdapter.alternateIndex` (packages/studio/adapters).
fn alternate_index(index: i64, count: i64) -> i64 {
    if count < 3 {
        return index.rem_euclid(count);
    }
    let period = count * 2 - 2;
    let local = index.rem_euclid(period);
    if local < count {local} else {period - local}
}

/// WASM CONTRACT: mirrors `RandomModulatorBoxAdapter.draw` (packages/studio/adapters).
pub(crate) fn hash_bipolar(seed: i32, index: i64) -> f32 {
    let mut hash = seed.wrapping_mul(0x9E3779B1u32 as i32) ^ (index as i32).wrapping_mul(0x85EBCA77u32 as i32);
    hash = (hash ^ ((hash as u32) >> 15) as i32).wrapping_mul(0x2545F491u32 as i32);
    hash ^= ((hash as u32) >> 13) as i32;
    ((hash as u32) as f64 / 4294967295.0) as f32 * 2.0 - 1.0
}

/// WASM CONTRACT: mirrors `RandomModulatorBoxAdapter.quantize` (packages/studio/adapters).
fn quantize(value: f32, levels: i32) -> f32 {
    if levels < 2 {
        return value;
    }
    let steps = (levels - 1) as f32;
    (((value + 1.0) * 0.5 * steps + 0.5) as i32).clamp(0, levels - 1) as f32 / steps * 2.0 - 1.0
}

/// WASM CONTRACT: mirrors `StepsModulatorBoxAdapter.randomIndex` (packages/studio/adapters).
fn random_index(cycle: i64, step: i64, count: i64) -> i64 {
    let mut hash = (cycle as i32).wrapping_mul(0x9E3779B1u32 as i32) ^ (step as i32 + 1).wrapping_mul(0x85EBCA77u32 as i32);
    hash = (hash ^ ((hash as u32) >> 15) as i32).wrapping_mul(0x2545F491u32 as i32);
    let hash = ((hash ^ ((hash as u32) >> 13) as i32) as u32) as i64;
    hash % count
}

pub(crate) struct RandomState {
    pub(crate) loop_length: Cell<i32>,
    pub(crate) rate_sync: Cell<i32>,
    pub(crate) rate_absolute: Cell<f32>,
    pub(crate) phase: Cell<f32>,
    pub(crate) amount: Cell<f32>,
    pub(crate) smooth: Cell<f32>,
    pub(crate) seed: Cell<i32>,
    pub(crate) levels: Cell<i32>,
    free_turns: Cell<f64>
}

impl RandomState {
    pub(crate) fn new() -> Self {
        Self {loop_length: Cell::new(0), rate_sync: Cell::new(10), rate_absolute: Cell::new(0.0),
            phase: Cell::new(0.0), amount: Cell::new(1.0), smooth: Cell::new(0.0), seed: Cell::new(1),
            levels: Cell::new(0), free_turns: Cell::new(0.0)}
    }

    fn step_position(&self, position: f64) -> f64 {
        sync_turns(self.rate_sync.get(), position)
            + self.free_turns.get()
            + self.phase.get() as f64
    }

    fn playhead_at(&self, position: f64) -> f32 {
        let step = self.step_position(position);
        let index = floor(step);
        (self.local_index(index as i64) as f64 + (step - index)) as f32
    }

    fn value_at(&self, position: f64) -> f32 {
        let step = self.step_position(position);
        let index = floor(step);
        let current = self.draw(index as i64);
        let smooth = self.smooth.get();
        let value = if smooth <= 0.0 {
            current
        } else {
            let previous = self.draw(index as i64 - 1);
            let ramp = (((step - index) / smooth as f64) as f32).min(1.0);
            previous + (current - previous) * ramp * ramp * (3.0 - 2.0 * ramp)
        };
        value * self.amount.get()
    }

    /// The step the sequence actually draws: with a loop length it revisits the same few draws, which
    /// turns the noise into a repeating pattern.
    fn local_index(&self, index: i64) -> i64 {
        let length = self.loop_length.get() as i64;
        if length > 0 {index.rem_euclid(length)} else {index}
    }

    pub(crate) fn draw(&self, index: i64) -> f32 {
        quantize(hash_bipolar(self.seed.get(), self.local_index(index)), self.levels.get())
    }
}

pub(crate) struct MacroState {
    pub(crate) value: Cell<f32>
}

impl MacroState {
    pub(crate) fn new() -> Self {
        Self {value: Cell::new(0.0)}
    }
}

pub(crate) enum ModulatorKind {
    Lfo(LfoState),
    Steps(StepsState),
    Macro(MacroState),
    Random(RandomState)
}

pub(crate) struct ModulatorState {
    pub(crate) enabled: Cell<bool>,
    pub(crate) kind: ModulatorKind,
    pub(crate) broadcast: RefCell<Option<engine_env::telemetry::BroadcastSlot>>,
    pub(crate) broadcast_active: Rc<Cell<bool>>
}

impl ModulatorState {
    pub(crate) fn lfo() -> Self {
        Self {enabled: Cell::new(true), kind: ModulatorKind::Lfo(LfoState::new()),
            broadcast: RefCell::new(None), broadcast_active: Rc::new(Cell::new(false))}
    }

    pub(crate) fn steps() -> Self {
        Self {enabled: Cell::new(true), kind: ModulatorKind::Steps(StepsState::new()),
            broadcast: RefCell::new(None), broadcast_active: Rc::new(Cell::new(false))}
    }

    pub(crate) fn macro_knob() -> Self {
        Self {enabled: Cell::new(true), kind: ModulatorKind::Macro(MacroState::new()),
            broadcast: RefCell::new(None), broadcast_active: Rc::new(Cell::new(false))}
    }

    pub(crate) fn random() -> Self {
        Self {enabled: Cell::new(true), kind: ModulatorKind::Random(RandomState::new()),
            broadcast: RefCell::new(None), broadcast_active: Rc::new(Cell::new(false))}
    }

    pub(crate) fn value_at(&self, position: f64) -> f32 {
        match &self.kind {
            ModulatorKind::Lfo(lfo) => lfo.value_at(position),
            ModulatorKind::Steps(steps) => steps.value_at(position),
            ModulatorKind::Macro(knob) => knob.value.get(),
            ModulatorKind::Random(random) => random.value_at(position)
        }
    }

    /// The free rate integrates rather than reading a clock, so changing it bends the phase onwards
    /// instead of moving it.
    pub(crate) fn advance_free(&self, delta_seconds: f64) {
        match &self.kind {
            ModulatorKind::Lfo(lfo) =>
                lfo.free_turns.set(lfo.free_turns.get() + delta_seconds * lfo.rate_absolute.get() as f64),
            ModulatorKind::Steps(steps) =>
                steps.free_turns.set(steps.free_turns.get() + delta_seconds * steps.rate_absolute.get() as f64),
            ModulatorKind::Random(random) =>
                random.free_turns.set(random.free_turns.get() + delta_seconds * random.rate_absolute.get() as f64),
            ModulatorKind::Macro(_) => {}
        }
    }

    pub(crate) fn anchor_free(&self, seconds: f64) {
        match &self.kind {
            ModulatorKind::Lfo(lfo) => lfo.free_turns.set(seconds * lfo.rate_absolute.get() as f64),
            ModulatorKind::Steps(steps) => steps.free_turns.set(seconds * steps.rate_absolute.get() as f64),
            ModulatorKind::Random(random) => random.free_turns.set(seconds * random.rate_absolute.get() as f64),
            ModulatorKind::Macro(_) => {}
        }
    }

    pub(crate) fn publish_phase(&self, position: f64) {
        if !self.broadcast_active.get() {
            return;
        }
        let Some(slot) = self.broadcast.borrow().clone() else {return};
        let phase = match &self.kind {
            ModulatorKind::Lfo(lfo) => fract(lfo.turn_at(position)) as f32,
            ModulatorKind::Steps(steps) => steps.playhead_at(position),
            ModulatorKind::Random(random) => random.playhead_at(position),
            ModulatorKind::Macro(_) => 0.0
        };
        let mut values = slot.borrow_mut();
        if values.len() > 1 {
            values[0] = phase;
            values[1] = self.value_at(position);
        }
    }
}

/// The control is bipolar and reaches the exponent through `EXPONENT_RANGE^control`, so its centre is the
/// identity. It bends the shape without changing its sign, so a negative half stays a number.
fn shaped(value: f32, control: f32) -> f32 {
    if control == 0.0 {
        return value;
    }
    let exponent = math::pow(EXPONENT_RANGE, control as f64);
    let magnitude = math::pow(value.abs() as f64, exponent) as f32;
    if value < 0.0 {-magnitude} else {magnitude}
}

fn floor(value: f64) -> f64 {
    let truncated = (value as i64) as f64;
    if truncated > value {truncated - 1.0} else {truncated}
}

fn fract(turn: f64) -> f64 {
    turn - floor(turn)
}

fn triangle(turn: f64) -> f64 {
    let phase = fract(turn);
    if phase < 0.25 {
        phase * 4.0
    } else if phase < 0.75 {
        2.0 - phase * 4.0
    } else {
        phase * 4.0 - 4.0
    }
}

fn saw_up(turn: f64) -> f64 {
    fract(turn) * 2.0 - 1.0
}

fn square(turn: f64) -> f64 {
    if fract(turn) < 0.5 {1.0} else {-1.0}
}

pub(crate) struct BoundModulation {
    pub(crate) modulator: Rc<ModulatorState>,
    pub(crate) depth: Rc<Cell<f32>>,
    pub(crate) enabled: Rc<Cell<bool>>
}

pub(crate) type ModulationChain = Rc<[BoundModulation]>;

/// NaN, not 0.0, when nothing contributes: a zero sum would still send the parameter down the device's
/// modulated path, where the mapping round-trip can shift it by a float epsilon.
pub(crate) fn modulation_sum(chain: Option<&ModulationChain>, position: f64) -> f32 {
    let chain = match chain {
        Some(chain) => chain,
        None => return f32::NAN
    };
    let mut sum = 0.0;
    let mut contributes = false;
    for bound in chain.iter() {
        if !bound.enabled.get() || !bound.modulator.enabled.get() {
            continue;
        }
        sum += bound.depth.get() * bound.modulator.value_at(position);
        contributes = true;
    }
    if contributes {sum} else {f32::NAN}
}

/// How an automated modulator field turns back into its own unit: an automation curve delivers a `0..1`
/// value, so folding it needs the parameter's mapping.
/// WASM CONTRACT: the mappings mirror the `createParameter` calls in the modulator adapters
/// (packages/studio/adapters/src/modulation).
#[derive(Clone, Copy)]
pub(crate) enum ParamMapping {
    Float(math::value_mapping::Linear),
    Power(math::value_mapping::Power),
    Integer(math::value_mapping::LinearInteger)
}

/// One of a modulator's own parameters, bound the way a device's is: the handle carries the stored value,
/// the automation curve and the modulation chain, and `apply` writes the folded result into the state cell
/// the shape reads. Nothing recurses: the refresh pass runs once per quantum and `value_at` only reads
/// cells, so a modulator driving another modulator's parameter settles within a quantum rather than
/// re-entering.
pub(crate) struct BoundParam {
    pub(crate) handle: crate::param_automation::ParamHandle,
    pub(crate) mapping: ParamMapping,
    pub(crate) apply: fn(&ModulatorKind, f32)
}

impl BoundParam {
    /// The automation reads the SONG position, which stands still while paused, so a static curve there is
    /// the hold. The modulation reads the free-running one, so a modulator driving this parameter keeps
    /// moving with the transport stopped.
    pub(crate) fn refresh(&self, state: &ModulatorState, automation_position: f64, modulation_position: f64) {
        let (value, kind, modulation) =
            self.handle.resolve_split(automation_position, modulation_position);
        let folded = match &self.mapping {
            ParamMapping::Float(mapping) =>
                crate::audio_unit::params::host_float(value, kind, modulation, mapping),
            ParamMapping::Power(mapping) =>
                crate::audio_unit::params::host_float(value, kind, modulation, mapping),
            ParamMapping::Integer(mapping) =>
                abi::int_value(abi::ParamValue::from_wire(kind, value, modulation), mapping) as f32
        };
        (self.apply)(&state.kind, folded);
    }
}

pub(crate) struct ModulatorEntry {
    uuid: Uuid,
    state: Rc<ModulatorState>,
    subs: Vec<SubscriptionId>,
    params: Vec<BoundParam>,
    collections: Vec<bindings::value_collection::ValueCollection>
}

pub(crate) struct ModulatorTable {
    entries: Vec<ModulatorEntry>,
    pending_add: Vec<Uuid>,
    pending_remove: Vec<Uuid>,
    pending_rebind: Vec<Uuid>
}

impl ModulatorTable {
    pub(crate) fn new() -> Self {
        Self {entries: Vec::new(), pending_add: Vec::new(), pending_remove: Vec::new(),
            pending_rebind: Vec::new()}
    }

    pub(crate) fn record_add(&mut self, uuid: Uuid) {
        self.pending_add.push(uuid);
    }

    pub(crate) fn record_remove(&mut self, uuid: Uuid) {
        self.pending_remove.push(uuid);
    }

    /// An automation or assignment edit on a modulator's own parameter: the modulator binds again, keeping
    /// its state, so the shape does not glitch while the handles are replaced.
    pub(crate) fn record_rebind(&mut self, uuid: Uuid) {
        if !self.pending_rebind.contains(&uuid) {
            self.pending_rebind.push(uuid);
        }
    }

    pub(crate) fn take_pending(&mut self) -> (Vec<Uuid>, Vec<Uuid>, Vec<Uuid>) {
        (core::mem::take(&mut self.pending_add), core::mem::take(&mut self.pending_remove),
            core::mem::take(&mut self.pending_rebind))
    }

    pub(crate) fn resolve(&self, uuid: &Uuid) -> Option<Rc<ModulatorState>> {
        self.entries.iter().find(|entry| &entry.uuid == uuid).map(|entry| entry.state.clone())
    }

    pub(crate) fn add(&mut self, uuid: Uuid, state: Rc<ModulatorState>, subs: Vec<SubscriptionId>,
                      params: Vec<BoundParam>, collections: Vec<bindings::value_collection::ValueCollection>) {
        self.entries.push(ModulatorEntry {uuid, state, subs, params, collections});
    }

    pub(crate) fn remove(&mut self, uuid: &Uuid)
                         -> (Vec<SubscriptionId>, Vec<bindings::value_collection::ValueCollection>) {
        match self.entries.iter().position(|entry| &entry.uuid == uuid) {
            Some(index) => {
                let entry = self.entries.remove(index);
                (entry.subs, entry.collections)
            }
            None => (Vec::new(), Vec::new())
        }
    }

    /// Drop what a modulator was bound to, keeping its state and its place in the table.
    pub(crate) fn detach(&mut self, uuid: &Uuid)
                         -> (Vec<SubscriptionId>, Vec<bindings::value_collection::ValueCollection>) {
        match self.entries.iter_mut().find(|entry| &entry.uuid == uuid) {
            Some(entry) => {
                entry.params.clear();
                (core::mem::take(&mut entry.subs), core::mem::take(&mut entry.collections))
            }
            None => (Vec::new(), Vec::new())
        }
    }

    pub(crate) fn attach(&mut self, uuid: &Uuid, subs: Vec<SubscriptionId>, params: Vec<BoundParam>,
                         collections: Vec<bindings::value_collection::ValueCollection>) {
        if let Some(entry) = self.entries.iter_mut().find(|entry| &entry.uuid == uuid) {
            entry.subs = subs;
            entry.params = params;
            entry.collections = collections;
        }
    }

    /// Resolve every modulator's own parameters for this quantum: the automation reads the SONG position and
    /// holds while paused, the modulation the free-running one.
    pub(crate) fn refresh_params(&self, automation_position: f64, modulation_position: f64) {
        for entry in self.entries.iter() {
            for param in entry.params.iter() {
                param.refresh(&entry.state, automation_position, modulation_position);
            }
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub(crate) fn publish_phases(&self, position: f64) {
        for entry in self.entries.iter() {
            entry.state.publish_phase(position);
        }
    }

    pub(crate) fn advance_free(&self, delta_seconds: f64) {
        for entry in self.entries.iter() {
            entry.state.advance_free(delta_seconds);
        }
    }

    pub(crate) fn anchor_free(&self, seconds: f64) {
        for entry in self.entries.iter() {
            entry.state.anchor_free(seconds);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lfo(shape: i32, rate: i32) -> LfoState {
        let state = LfoState::new();
        state.shape.set(shape);
        state.rate_sync.set(rate);
        state
    }

    fn steps(values: &[f32]) -> StepsState {
        let state = StepsState::new();
        state.count.set(values.len() as i32);
        for (index, value) in values.iter().enumerate() {
            state.steps[index].set(*value);
        }
        state
    }

    const BAR: f64 = 3840.0;
    const ONE_BAR: i32 = 4;
    const QUARTER: i32 = 6;
    const SIXTEENTH: i32 = 10;
    const STEP: f64 = 240.0; // one sixteenth in pulses

    #[test]
    fn a_sine_walks_its_cycle_from_the_position_alone() {
        let state = lfo(SHAPE_SINE, ONE_BAR);
        assert!(state.value_at(0.0).abs() < 1.0e-6);
        assert!((state.value_at(BAR * 0.25) - 1.0).abs() < 1.0e-6);
        assert!(state.value_at(BAR * 0.5).abs() < 1.0e-6);
        assert!((state.value_at(BAR * 0.75) + 1.0).abs() < 1.0e-6);
        // Pure in the position: the value at bar 17 equals the value at bar 1, so a locate needs no seeding.
        assert!((state.value_at(BAR * 17.25) - state.value_at(BAR * 0.25)).abs() < 1.0e-6);
    }

    #[test]
    fn every_shape_starts_at_its_own_cycle_point_and_stays_bounded() {
        for shape in [SHAPE_SINE, SHAPE_TRIANGLE, SHAPE_SAW_UP, SHAPE_SAW_DOWN, SHAPE_SQUARE] {
            let state = lfo(shape, ONE_BAR);
            for step in 0..64 {
                let value = state.value_at(BAR * step as f64 / 64.0);
                assert!((-1.0..=1.0).contains(&value), "shape {shape} left the unit range: {value}");
            }
        }
        assert!((lfo(SHAPE_TRIANGLE, ONE_BAR).value_at(BAR * 0.25) - 1.0).abs() < 1.0e-6);
        assert!((lfo(SHAPE_SAW_UP, ONE_BAR).value_at(0.0) + 1.0).abs() < 1.0e-6);
        assert!((lfo(SHAPE_SAW_DOWN, ONE_BAR).value_at(0.0) - 1.0).abs() < 1.0e-6);
        for step in 0..64 {
            let position = BAR * step as f64 / 64.0;
            let up = lfo(SHAPE_SAW_UP, ONE_BAR).value_at(position);
            let down = lfo(SHAPE_SAW_DOWN, ONE_BAR).value_at(position);
            assert!((up + down).abs() < 1.0e-6, "the two saws mirror each other at {position}");
        }
        assert_eq!(lfo(SHAPE_SQUARE, ONE_BAR).value_at(BAR * 0.25), 1.0);
        assert_eq!(lfo(SHAPE_SQUARE, ONE_BAR).value_at(BAR * 0.75), -1.0);
    }

    #[test]
    fn the_exponent_bends_the_shape_without_flipping_its_sign() {
        let state = lfo(SHAPE_SAW_UP, ONE_BAR);
        let plain = state.value_at(BAR * 0.9);
        state.exponent.set(1.0 / 3.0); // 8^(1/3) = 2
        let bent = state.value_at(BAR * 0.9);
        assert!(bent > 0.0 && bent < plain, "a positive half flattens towards the middle, got {bent}");
        assert!((state.value_at(BAR * 0.1) + 0.64).abs() < 1.0e-5,
            "and a negative half bends by the same amount, got {}", state.value_at(BAR * 0.1));
        state.exponent.set(0.0);
        assert_eq!(state.value_at(BAR * 0.9), plain, "the centre is the identity");
    }

    #[test]
    fn phase_and_amount_shift_and_scale() {
        let shifted = lfo(SHAPE_SINE, ONE_BAR);
        shifted.phase.set(0.25);
        assert!((shifted.value_at(0.0) - 1.0).abs() < 1.0e-6, "a quarter-turn phase starts at the peak");
        let scaled = lfo(SHAPE_SINE, ONE_BAR);
        scaled.amount.set(0.5);
        assert!((scaled.value_at(BAR * 0.25) - 0.5).abs() < 1.0e-6);
    }

    #[test]
    fn the_rate_index_selects_the_cycle_length() {
        let quarter = lfo(SHAPE_SINE, QUARTER); // 1/4 = 960 pulses
        assert!((quarter.value_at(240.0) - 1.0).abs() < 1.0e-6, "a quarter of 960 pulses is the peak");
        assert_eq!(cycle_pulses(-3), RATES[0], "an out-of-range index clamps into the table");
        assert_eq!(cycle_pulses(99), RATES[RATES.len() - 1]);
        assert!(RATES[RATES.len() - 1] < RATES[1], "the highest index is the fastest cycle");
        let free = lfo(SHAPE_SINE, 0);
        assert_eq!(free.value_at(BAR * 0.25), free.value_at(BAR * 7.3),
            "the first entry stops the synced motion, leaving only the free rate");
    }

    #[test]
    fn the_free_rate_integrates_and_re_anchors_on_a_transport_event() {
        let state = ModulatorState::lfo();
        let ModulatorKind::Lfo(free) = &state.kind else {panic!("an LFO")};
        free.rate_sync.set(0);
        free.rate_absolute.set(1.0); // one turn per second
        state.advance_free(0.25);
        assert!((state.value_at(BAR * 3.0) - 1.0).abs() < 1.0e-6, "a quarter turn, wherever the transport stands");
        free.rate_absolute.set(2.0);
        assert!((state.value_at(0.0) - 1.0).abs() < 1.0e-6, "a rate change bends the phase, it does not move it");
        state.advance_free(0.25);
        assert!((state.value_at(0.0) + 1.0).abs() < 1.0e-6, "and it turns twice as fast from there");
        state.anchor_free(0.125);
        assert!((state.value_at(0.0) - 1.0).abs() < 1.0e-6, "a stop, resume or jump re-anchors to that time");
        let synced = lfo(SHAPE_SINE, ONE_BAR);
        assert_eq!(synced.rate_absolute.get(), 0.0, "the default leaves the LFO purely tempo-synced");
    }

    #[test]
    fn a_random_draw_is_reproducible_loops_and_quantizes() {
        let state = RandomState::new();
        state.rate_sync.set(SIXTEENTH);
        let first = state.value_at(0.0);
        assert_eq!(state.value_at(STEP * 0.5), first, "it holds for the whole step");
        assert_eq!(state.value_at(STEP * 4000.0), state.value_at(STEP * 4000.0), "and it is pure");
        assert!(state.value_at(STEP) != first, "the next step draws again");
        state.seed.set(7);
        assert!(state.value_at(0.0) != first, "the seed picks a different sequence");
        let seeded = state.value_at(0.0);
        state.loop_length.set(4);
        assert_eq!(state.value_at(STEP * 4.0), state.value_at(0.0), "a loop of four repeats every four steps");
        assert!(state.value_at(STEP * 2.0) != state.value_at(0.0), "but not within them");
        state.loop_length.set(0);
        assert_eq!(state.value_at(0.0), seeded, "and dropping the loop restores the endless sequence");
        state.levels.set(2);
        for step in 0..32 {
            let value = state.value_at(STEP * step as f64);
            assert!(value == -1.0 || value == 1.0, "two levels is a coin flip, got {value}");
        }
        state.levels.set(3);
        for step in 0..32 {
            let value = state.value_at(STEP * step as f64);
            assert!(value == -1.0 || value == 0.0 || value == 1.0, "three levels adds the centre, got {value}");
        }
    }

    #[test]
    fn a_step_holds_its_value_for_one_rate_unit_and_wraps() {
        let state = steps(&[1.0, -0.5, 0.25, 0.0]);
        state.rate_sync.set(SIXTEENTH);
        assert_eq!(state.value_at(0.0), 1.0);
        assert_eq!(state.value_at(STEP * 0.99), 1.0, "it holds to the very end of its step");
        assert_eq!(state.value_at(STEP), -0.5);
        assert_eq!(state.value_at(STEP * 2.0), 0.25);
        assert_eq!(state.value_at(STEP * 4.0), 1.0, "the sequence wraps after the count");
        // Pure in the position, exactly like the LFO: a locate replays the same step.
        assert_eq!(state.value_at(STEP * 400.0), state.value_at(0.0));
        // Steps before zero wrap backwards rather than clamping.
        assert_eq!(state.value_at(-STEP), 0.0);
    }

    #[test]
    fn the_direction_folds_the_step_order() {
        let values = [1.0, 0.5, -0.5, -1.0];
        let forward = steps(&values);
        let backward = steps(&values);
        backward.direction.set(DIRECTION_BACKWARD);
        let ping_pong = steps(&values);
        ping_pong.direction.set(DIRECTION_PING_PONG);
        for index in 0..4 {
            let position = STEP * index as f64;
            assert_eq!(forward.value_at(position), values[index]);
            assert_eq!(backward.value_at(position), values[3 - index]);
            assert_eq!(ping_pong.value_at(position), values[index], "the first pass runs forward");
            assert_eq!(ping_pong.value_at(position + STEP * 4.0), values[3 - index], "the second runs back");
        }
    }

    #[test]
    fn alternate_turns_around_without_repeating_the_ends() {
        let values = [0.0, 0.25, 0.5, 1.0];
        let state = steps(&values);
        state.direction.set(DIRECTION_ALTERNATE);
        // Four steps fold into a six-step round trip: 0 1 2 3 2 1, then around again.
        let played: Vec<f32> = (0..12).map(|index| state.value_at(STEP * index as f64)).collect();
        assert_eq!(played, alloc::vec![0.0, 0.25, 0.5, 1.0, 0.5, 0.25, 0.0, 0.25, 0.5, 1.0, 0.5, 0.25]);
        // Ping-pong plays the turning points twice, which is exactly what alternate avoids.
        let ping_pong = steps(&values);
        ping_pong.direction.set(DIRECTION_PING_PONG);
        assert_eq!(ping_pong.value_at(STEP * 3.0), ping_pong.value_at(STEP * 4.0));
        assert_ne!(state.value_at(STEP * 3.0), state.value_at(STEP * 4.0));
        // Two steps have no turning point to fold.
        let pair = steps(&[1.0, -1.0]);
        pair.direction.set(DIRECTION_ALTERNATE);
        assert_eq!(pair.value_at(0.0), 1.0);
        assert_eq!(pair.value_at(STEP), -1.0);
        assert_eq!(pair.value_at(STEP * 2.0), 1.0);
    }

    #[test]
    fn the_playhead_follows_the_step_the_sequence_is_on() {
        let state = steps(&[0.0, 0.0, 0.0, 0.0]);
        assert_eq!(state.playhead_at(0.0), 0.0);
        assert!((state.playhead_at(STEP * 1.5) - 1.5).abs() < 1.0e-5, "half way through step 1");
        assert!((state.playhead_at(STEP * 4.25) - 0.25).abs() < 1.0e-5, "and it wraps with the sequence");
        let backward = steps(&[0.0, 0.0, 0.0, 0.0]);
        backward.direction.set(DIRECTION_BACKWARD);
        // The last step, entered from its RIGHT edge, since backward crosses it right to left.
        assert!((backward.playhead_at(0.0) - 4.0).abs() < 1.0e-5, "backward starts on the last step");
        assert!((backward.playhead_at(STEP) - 3.0).abs() < 1.0e-5);
    }

    #[test]
    fn a_glide_always_comes_from_the_step_that_was_played_before() {
        // Backward plays 3, 2, 1, 0, so the glide into step 2 starts at step 3's value, NOT at step 1's.
        let backward = steps(&[0.0, 0.1, 0.2, 1.0]);
        backward.direction.set(DIRECTION_BACKWARD);
        backward.smooth.set(0.5);
        assert_eq!(backward.value_at(STEP), 1.0, "the glide leaves the step that just played");
        assert!((backward.value_at(STEP * 1.5) - 0.2).abs() < 1.0e-6, "and has arrived by the end of the glide");
        let middle = backward.value_at(STEP * 1.25);
        assert!(middle > 0.2 && middle < 1.0, "falling from 1.0 to 0.2, got {middle}");
        // Ping-pong at its turning point: the step plays twice, so the second pass glides from ITSELF.
        let ping_pong = steps(&[0.0, 0.5, 1.0]);
        ping_pong.direction.set(DIRECTION_PING_PONG);
        ping_pong.smooth.set(0.5);
        assert_eq!(ping_pong.value_at(STEP * 3.0), 1.0, "the repeated turning point holds its value");
    }

    #[test]
    fn the_playhead_stays_silent_until_the_ui_subscribes() {
        let state = ModulatorState::steps();
        let slot = engine_env::telemetry::broadcast_slot(2);
        *state.broadcast.borrow_mut() = Some(slot.clone());
        state.publish_phase(240.0);
        assert_eq!(slot.borrow()[0], 0.0, "nothing is written while no editor is listening");
        state.broadcast_active.set(true);
        state.publish_phase(240.0);
        assert_eq!(slot.borrow()[0], 1.0, "and the position appears once one is");
    }

    #[test]
    fn the_playhead_crosses_a_step_the_way_the_sequence_travels() {
        let forward = steps(&[0.0, 0.0, 0.0, 0.0]);
        assert!(forward.playhead_at(0.0) < forward.playhead_at(STEP * 0.5), "forward runs left to right");
        let backward = steps(&[0.0, 0.0, 0.0, 0.0]);
        backward.direction.set(DIRECTION_BACKWARD);
        // Step 3 is crossed right to left, and the next step picks up exactly where it left off.
        assert!((backward.playhead_at(0.0) - 4.0).abs() < 1.0e-5);
        assert!((backward.playhead_at(STEP * 0.5) - 3.5).abs() < 1.0e-5);
        assert!((backward.playhead_at(STEP * 0.999) - 3.0).abs() < 1.0e-2);
        assert!((backward.playhead_at(STEP) - 3.0).abs() < 1.0e-5, "no jump at the boundary");
        assert!((backward.playhead_at(STEP * 1.5) - 2.5).abs() < 1.0e-5);
        // Ping-pong turns around with the cycle, alternate one step earlier.
        let ping_pong = steps(&[0.0, 0.0, 0.0, 0.0]);
        ping_pong.direction.set(DIRECTION_PING_PONG);
        assert!(ping_pong.playhead_at(STEP * 0.5) < ping_pong.playhead_at(STEP * 1.5));
        assert!(ping_pong.playhead_at(STEP * 4.5) > ping_pong.playhead_at(STEP * 5.5));
    }

    #[test]
    fn the_random_direction_is_stable_per_cycle() {
        let state = steps(&[0.0, 0.25, 0.5, 0.75, 1.0, -0.25, -0.5, -1.0]);
        state.direction.set(DIRECTION_RANDOM);
        let cycle: Vec<f32> = (0..8).map(|index| state.value_at(STEP * index as f64)).collect();
        let replay: Vec<f32> = (0..8).map(|index| state.value_at(STEP * index as f64)).collect();
        assert_eq!(cycle, replay, "the same position always gives the same step");
        let next: Vec<f32> = (8..16).map(|index| state.value_at(STEP * index as f64)).collect();
        assert_ne!(cycle, next, "a later cycle shuffles differently");
        for index in 0..64 {
            let resolved = random_index(index / 8, index % 8, 8);
            assert!((0..8).contains(&resolved), "the shuffle stays inside the sequence: {resolved}");
        }
    }

    #[test]
    fn smoothing_glides_into_the_step_and_zero_leaves_it_hard() {
        let hard = steps(&[0.0, 1.0]);
        hard.rate_sync.set(SIXTEENTH);
        assert_eq!(hard.value_at(STEP * 1.5), 1.0, "no smoothing means the step is already there");
        let glided = steps(&[0.0, 1.0]);
        glided.rate_sync.set(SIXTEENTH);
        glided.smooth.set(0.5);
        assert_eq!(glided.value_at(STEP), 0.0, "the glide starts at the previous step's value");
        let half = glided.value_at(STEP * 1.25);
        assert!(half > 0.4 && half < 0.6, "halfway through the glide sits between the two, got {half}");
        assert_eq!(glided.value_at(STEP * 1.5), 1.0, "and it has arrived once the glide is over");
        assert_eq!(glided.value_at(STEP * 1.9), 1.0);
    }

    #[test]
    fn the_sum_is_nan_until_something_actually_contributes() {
        let state = Rc::new(ModulatorState {enabled: Cell::new(true),
            kind: ModulatorKind::Lfo(lfo(SHAPE_SQUARE, ONE_BAR)),
            broadcast: RefCell::new(None), broadcast_active: Rc::new(Cell::new(false))});
        let bound = |depth: f32, enabled: bool| BoundModulation {
            modulator: state.clone(),
            depth: Rc::new(Cell::new(depth)),
            enabled: Rc::new(Cell::new(enabled))
        };
        assert!(modulation_sum(None, 0.0).is_nan(), "no chain at all");
        let chain: ModulationChain = Rc::from(Vec::new());
        assert!(modulation_sum(Some(&chain), 0.0).is_nan(), "an empty chain");
        let chain: ModulationChain = Rc::from(alloc::vec![bound(0.5, false)]);
        assert!(modulation_sum(Some(&chain), 0.0).is_nan(), "a disabled assignment is not a zero sum");
        state.enabled.set(false);
        let chain: ModulationChain = Rc::from(alloc::vec![bound(0.5, true)]);
        assert!(modulation_sum(Some(&chain), 0.0).is_nan(), "a disabled modulator is not a zero sum");
        state.enabled.set(true);
        let chain: ModulationChain = Rc::from(alloc::vec![bound(0.5, true), bound(-0.125, true)]);
        assert!((modulation_sum(Some(&chain), 0.0).unwrap_or(0.0) - 0.375).abs() < 1.0e-6, "depths sum");
    }

    trait OrZero {fn unwrap_or(self, fallback: f32) -> f32;}
    impl OrZero for f32 {
        fn unwrap_or(self, fallback: f32) -> f32 {if self.is_nan() {fallback} else {self}}
    }
}
