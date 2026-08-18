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
// LfoModulatorBoxAdapter.Rates. Slowest first, so the highest index is the fastest cycle.
pub(crate) const RATES: [f64; 12] = [30720.0, 15360.0, 7680.0, 3840.0, 1920.0, 960.0, 640.0, 480.0,
    320.0, 240.0, 160.0, 120.0];

crate::shared_static! {
    static SECONDS: f64 = 0.0;
}

pub(crate) fn advance_seconds(delta: f64) {
    unsafe { *SECONDS.get() += delta; }
}

pub(crate) fn seconds() -> f64 {
    unsafe { *SECONDS.get() }
}

fn cycle_pulses(rate: i32) -> f64 {
    RATES[(rate.max(0) as usize).min(RATES.len() - 1)]
}

// WASM CONTRACT: StepsModulatorBox.direction (field 16), mirrored by StepsModulatorBoxAdapter's StepsDirection.
pub(crate) const DIRECTION_FORWARD: i32 = 0;
pub(crate) const DIRECTION_BACKWARD: i32 = 1;
pub(crate) const DIRECTION_PING_PONG: i32 = 2;
pub(crate) const DIRECTION_ALTERNATE: i32 = 3;
pub(crate) const DIRECTION_RANDOM: i32 = 4;

pub(crate) const MAX_STEPS: usize = 64;

pub(crate) struct LfoState {
    pub(crate) shape: Cell<i32>,
    pub(crate) rate_sync: Cell<i32>,
    pub(crate) rate_absolute: Cell<f32>,
    pub(crate) phase: Cell<f32>,
    pub(crate) amount: Cell<f32>
}

impl LfoState {
    pub(crate) fn new() -> Self {
        Self {shape: Cell::new(SHAPE_SINE), rate_sync: Cell::new(3), rate_absolute: Cell::new(0.0),
            phase: Cell::new(0.0), amount: Cell::new(1.0)}
    }

    fn turn_at(&self, position: f64, seconds: f64) -> f64 {
        position / cycle_pulses(self.rate_sync.get())
            + seconds * self.rate_absolute.get() as f64
            + self.phase.get() as f64
    }

    fn value_at(&self, position: f64, seconds: f64) -> f32 {
        let turn = self.turn_at(position, seconds);
        let shape = match self.shape.get() {
            SHAPE_TRIANGLE => triangle(turn),
            SHAPE_SAW_UP => saw_up(turn),
            SHAPE_SAW_DOWN => -saw_up(turn),
            SHAPE_SQUARE => square(turn),
            _ => fast_sin_tau(turn)
        };
        shape as f32 * self.amount.get()
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
    pub(crate) steps: [Cell<f32>; MAX_STEPS]
}

impl StepsState {
    pub(crate) fn new() -> Self {
        Self {count: Cell::new(16), rate_sync: Cell::new(9), rate_absolute: Cell::new(0.0),
            phase: Cell::new(0.0), amount: Cell::new(1.0), smooth: Cell::new(0.0),
            direction: Cell::new(DIRECTION_FORWARD), steps: core::array::from_fn(|_| Cell::new(0.0))}
    }

    fn step_position(&self, position: f64, seconds: f64, count: i64) -> f64 {
        position / cycle_pulses(self.rate_sync.get())
            + seconds * self.rate_absolute.get() as f64
            + self.phase.get() as f64 * count as f64
    }

    fn playhead_at(&self, position: f64, seconds: f64) -> f32 {
        let count = self.count.get().clamp(1, MAX_STEPS as i32) as i64;
        let step = self.step_position(position, seconds, count);
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

    fn value_at(&self, position: f64, seconds: f64) -> f32 {
        let count = self.count.get().clamp(1, MAX_STEPS as i32) as i64;
        let step = self.step_position(position, seconds, count);
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

/// WASM CONTRACT: mirrors `StepsModulatorBoxAdapter.randomIndex` (packages/studio/adapters).
fn random_index(cycle: i64, step: i64, count: i64) -> i64 {
    let mut hash = (cycle as i32).wrapping_mul(0x9E3779B1u32 as i32) ^ (step as i32 + 1).wrapping_mul(0x85EBCA77u32 as i32);
    hash = (hash ^ ((hash as u32) >> 15) as i32).wrapping_mul(0x2545F491u32 as i32);
    let hash = ((hash ^ ((hash as u32) >> 13) as i32) as u32) as i64;
    hash % count
}

pub(crate) enum ModulatorKind {
    Lfo(LfoState),
    Steps(StepsState)
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

    pub(crate) fn value_at(&self, position: f64, seconds: f64) -> f32 {
        match &self.kind {
            ModulatorKind::Lfo(lfo) => lfo.value_at(position, seconds),
            ModulatorKind::Steps(steps) => steps.value_at(position, seconds)
        }
    }

    pub(crate) fn publish_phase(&self, position: f64, seconds: f64) {
        if !self.broadcast_active.get() {
            return;
        }
        let Some(slot) = self.broadcast.borrow().clone() else {return};
        let phase = match &self.kind {
            ModulatorKind::Lfo(lfo) => fract(lfo.turn_at(position, seconds)) as f32,
            ModulatorKind::Steps(steps) => steps.playhead_at(position, seconds)
        };
        let mut values = slot.borrow_mut();
        if values.len() > 1 {
            values[0] = phase;
            values[1] = self.value_at(position, seconds);
        }
    }
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
    let seconds = seconds();
    let mut sum = 0.0;
    let mut contributes = false;
    for bound in chain.iter() {
        if !bound.enabled.get() || !bound.modulator.enabled.get() {
            continue;
        }
        sum += bound.depth.get() * bound.modulator.value_at(position, seconds);
        contributes = true;
    }
    if contributes {sum} else {f32::NAN}
}

pub(crate) struct ModulatorTable {
    entries: Vec<(Uuid, Rc<ModulatorState>, Vec<SubscriptionId>)>,
    pending_add: Vec<Uuid>,
    pending_remove: Vec<Uuid>
}

impl ModulatorTable {
    pub(crate) fn new() -> Self {
        Self {entries: Vec::new(), pending_add: Vec::new(), pending_remove: Vec::new()}
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

    pub(crate) fn resolve(&self, uuid: &Uuid) -> Option<Rc<ModulatorState>> {
        self.entries.iter().find(|(bound, ..)| bound == uuid).map(|(_, state, _)| state.clone())
    }

    pub(crate) fn add(&mut self, uuid: Uuid, state: Rc<ModulatorState>, subs: Vec<SubscriptionId>) {
        self.entries.push((uuid, state, subs));
    }

    pub(crate) fn remove(&mut self, uuid: &Uuid) -> Vec<SubscriptionId> {
        match self.entries.iter().position(|(bound, ..)| bound == uuid) {
            Some(index) => self.entries.remove(index).2,
            None => Vec::new()
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub(crate) fn publish_phases(&self, position: f64, seconds: f64) {
        for (_, state, _) in self.entries.iter() {
            state.publish_phase(position, seconds);
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
    const ONE_BAR: i32 = 3;
    const QUARTER: i32 = 5;
    const SIXTEENTH: i32 = 9;
    const STEP: f64 = 240.0; // one sixteenth in pulses

    #[test]
    fn a_sine_walks_its_cycle_from_the_position_alone() {
        let state = lfo(SHAPE_SINE, ONE_BAR);
        assert!(state.value_at(0.0, 0.0).abs() < 1.0e-6);
        assert!((state.value_at(BAR * 0.25, 0.0) - 1.0).abs() < 1.0e-6);
        assert!(state.value_at(BAR * 0.5, 0.0).abs() < 1.0e-6);
        assert!((state.value_at(BAR * 0.75, 0.0) + 1.0).abs() < 1.0e-6);
        // Pure in the position: the value at bar 17 equals the value at bar 1, so a locate needs no seeding.
        assert!((state.value_at(BAR * 17.25, 0.0) - state.value_at(BAR * 0.25, 0.0)).abs() < 1.0e-6);
    }

    #[test]
    fn every_shape_starts_at_its_own_cycle_point_and_stays_bounded() {
        for shape in [SHAPE_SINE, SHAPE_TRIANGLE, SHAPE_SAW_UP, SHAPE_SAW_DOWN, SHAPE_SQUARE] {
            let state = lfo(shape, ONE_BAR);
            for step in 0..64 {
                let value = state.value_at(BAR * step as f64 / 64.0, 0.0);
                assert!((-1.0..=1.0).contains(&value), "shape {shape} left the unit range: {value}");
            }
        }
        assert!((lfo(SHAPE_TRIANGLE, ONE_BAR).value_at(BAR * 0.25, 0.0) - 1.0).abs() < 1.0e-6);
        assert!((lfo(SHAPE_SAW_UP, ONE_BAR).value_at(0.0, 0.0) + 1.0).abs() < 1.0e-6);
        assert!((lfo(SHAPE_SAW_DOWN, ONE_BAR).value_at(0.0, 0.0) - 1.0).abs() < 1.0e-6);
        for step in 0..64 {
            let position = BAR * step as f64 / 64.0;
            let up = lfo(SHAPE_SAW_UP, ONE_BAR).value_at(position, 0.0);
            let down = lfo(SHAPE_SAW_DOWN, ONE_BAR).value_at(position, 0.0);
            assert!((up + down).abs() < 1.0e-6, "the two saws mirror each other at {position}");
        }
        assert_eq!(lfo(SHAPE_SQUARE, ONE_BAR).value_at(BAR * 0.25, 0.0), 1.0);
        assert_eq!(lfo(SHAPE_SQUARE, ONE_BAR).value_at(BAR * 0.75, 0.0), -1.0);
    }

    #[test]
    fn phase_and_amount_shift_and_scale() {
        let shifted = lfo(SHAPE_SINE, ONE_BAR);
        shifted.phase.set(0.25);
        assert!((shifted.value_at(0.0, 0.0) - 1.0).abs() < 1.0e-6, "a quarter-turn phase starts at the peak");
        let scaled = lfo(SHAPE_SINE, ONE_BAR);
        scaled.amount.set(0.5);
        assert!((scaled.value_at(BAR * 0.25, 0.0) - 0.5).abs() < 1.0e-6);
    }

    #[test]
    fn the_rate_index_selects_the_cycle_length() {
        let quarter = lfo(SHAPE_SINE, QUARTER); // 1/4 = 960 pulses
        assert!((quarter.value_at(240.0, 0.0) - 1.0).abs() < 1.0e-6, "a quarter of 960 pulses is the peak");
        assert_eq!(cycle_pulses(-3), RATES[0], "an out-of-range index clamps rather than stopping the LFO");
        assert_eq!(cycle_pulses(99), RATES[RATES.len() - 1]);
        assert!(RATES[RATES.len() - 1] < RATES[0], "the highest index is the fastest cycle");
    }

    #[test]
    fn the_absolute_rate_adds_wall_clock_turns() {
        let state = lfo(SHAPE_SINE, ONE_BAR);
        state.rate_absolute.set(1.0); // one turn per second
        assert!((state.value_at(0.0, 0.25) - 1.0).abs() < 1.0e-6, "a quarter second is a quarter turn");
        assert!(state.value_at(0.0, 0.5).abs() < 1.0e-6);
        // Additive: a quarter bar and a quarter second together land on half a turn.
        assert!(state.value_at(BAR * 0.25, 0.25).abs() < 1.0e-6);
        let synced = lfo(SHAPE_SINE, ONE_BAR);
        assert_eq!(synced.rate_absolute.get(), 0.0, "the default leaves the LFO purely tempo-synced");
        assert_eq!(synced.value_at(BAR * 0.25, 9.0), synced.value_at(BAR * 0.25, 0.0));
    }

    #[test]
    fn a_step_holds_its_value_for_one_rate_unit_and_wraps() {
        let state = steps(&[1.0, -0.5, 0.25, 0.0]);
        state.rate_sync.set(SIXTEENTH);
        assert_eq!(state.value_at(0.0, 0.0), 1.0);
        assert_eq!(state.value_at(STEP * 0.99, 0.0), 1.0, "it holds to the very end of its step");
        assert_eq!(state.value_at(STEP, 0.0), -0.5);
        assert_eq!(state.value_at(STEP * 2.0, 0.0), 0.25);
        assert_eq!(state.value_at(STEP * 4.0, 0.0), 1.0, "the sequence wraps after the count");
        // Pure in the position, exactly like the LFO: a locate replays the same step.
        assert_eq!(state.value_at(STEP * 400.0, 0.0), state.value_at(0.0, 0.0));
        // Steps before zero wrap backwards rather than clamping.
        assert_eq!(state.value_at(-STEP, 0.0), 0.0);
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
            assert_eq!(forward.value_at(position, 0.0), values[index]);
            assert_eq!(backward.value_at(position, 0.0), values[3 - index]);
            assert_eq!(ping_pong.value_at(position, 0.0), values[index], "the first pass runs forward");
            assert_eq!(ping_pong.value_at(position + STEP * 4.0, 0.0), values[3 - index], "the second runs back");
        }
    }

    #[test]
    fn alternate_turns_around_without_repeating_the_ends() {
        let values = [0.0, 0.25, 0.5, 1.0];
        let state = steps(&values);
        state.direction.set(DIRECTION_ALTERNATE);
        // Four steps fold into a six-step round trip: 0 1 2 3 2 1, then around again.
        let played: Vec<f32> = (0..12).map(|index| state.value_at(STEP * index as f64, 0.0)).collect();
        assert_eq!(played, alloc::vec![0.0, 0.25, 0.5, 1.0, 0.5, 0.25, 0.0, 0.25, 0.5, 1.0, 0.5, 0.25]);
        // Ping-pong plays the turning points twice, which is exactly what alternate avoids.
        let ping_pong = steps(&values);
        ping_pong.direction.set(DIRECTION_PING_PONG);
        assert_eq!(ping_pong.value_at(STEP * 3.0, 0.0), ping_pong.value_at(STEP * 4.0, 0.0));
        assert_ne!(state.value_at(STEP * 3.0, 0.0), state.value_at(STEP * 4.0, 0.0));
        // Two steps have no turning point to fold.
        let pair = steps(&[1.0, -1.0]);
        pair.direction.set(DIRECTION_ALTERNATE);
        assert_eq!(pair.value_at(0.0, 0.0), 1.0);
        assert_eq!(pair.value_at(STEP, 0.0), -1.0);
        assert_eq!(pair.value_at(STEP * 2.0, 0.0), 1.0);
    }

    #[test]
    fn the_playhead_follows_the_step_the_sequence_is_on() {
        let state = steps(&[0.0, 0.0, 0.0, 0.0]);
        assert_eq!(state.playhead_at(0.0, 0.0), 0.0);
        assert!((state.playhead_at(STEP * 1.5, 0.0) - 1.5).abs() < 1.0e-5, "half way through step 1");
        assert!((state.playhead_at(STEP * 4.25, 0.0) - 0.25).abs() < 1.0e-5, "and it wraps with the sequence");
        let backward = steps(&[0.0, 0.0, 0.0, 0.0]);
        backward.direction.set(DIRECTION_BACKWARD);
        // The last step, entered from its RIGHT edge, since backward crosses it right to left.
        assert!((backward.playhead_at(0.0, 0.0) - 4.0).abs() < 1.0e-5, "backward starts on the last step");
        assert!((backward.playhead_at(STEP, 0.0) - 3.0).abs() < 1.0e-5);
    }

    #[test]
    fn a_glide_always_comes_from_the_step_that_was_played_before() {
        // Backward plays 3, 2, 1, 0, so the glide into step 2 starts at step 3's value, NOT at step 1's.
        let backward = steps(&[0.0, 0.1, 0.2, 1.0]);
        backward.direction.set(DIRECTION_BACKWARD);
        backward.smooth.set(0.5);
        assert_eq!(backward.value_at(STEP, 0.0), 1.0, "the glide leaves the step that just played");
        assert!((backward.value_at(STEP * 1.5, 0.0) - 0.2).abs() < 1.0e-6, "and has arrived by the end of the glide");
        let middle = backward.value_at(STEP * 1.25, 0.0);
        assert!(middle > 0.2 && middle < 1.0, "falling from 1.0 to 0.2, got {middle}");
        // Ping-pong at its turning point: the step plays twice, so the second pass glides from ITSELF.
        let ping_pong = steps(&[0.0, 0.5, 1.0]);
        ping_pong.direction.set(DIRECTION_PING_PONG);
        ping_pong.smooth.set(0.5);
        assert_eq!(ping_pong.value_at(STEP * 3.0, 0.0), 1.0, "the repeated turning point holds its value");
    }

    #[test]
    fn the_playhead_stays_silent_until_the_ui_subscribes() {
        let state = ModulatorState::steps();
        let slot = engine_env::telemetry::broadcast_slot(2);
        *state.broadcast.borrow_mut() = Some(slot.clone());
        state.publish_phase(240.0, 0.0);
        assert_eq!(slot.borrow()[0], 0.0, "nothing is written while no editor is listening");
        state.broadcast_active.set(true);
        state.publish_phase(240.0, 0.0);
        assert_eq!(slot.borrow()[0], 1.0, "and the position appears once one is");
    }

    #[test]
    fn the_playhead_crosses_a_step_the_way_the_sequence_travels() {
        let forward = steps(&[0.0, 0.0, 0.0, 0.0]);
        assert!(forward.playhead_at(0.0, 0.0) < forward.playhead_at(STEP * 0.5, 0.0), "forward runs left to right");
        let backward = steps(&[0.0, 0.0, 0.0, 0.0]);
        backward.direction.set(DIRECTION_BACKWARD);
        // Step 3 is crossed right to left, and the next step picks up exactly where it left off.
        assert!((backward.playhead_at(0.0, 0.0) - 4.0).abs() < 1.0e-5);
        assert!((backward.playhead_at(STEP * 0.5, 0.0) - 3.5).abs() < 1.0e-5);
        assert!((backward.playhead_at(STEP * 0.999, 0.0) - 3.0).abs() < 1.0e-2);
        assert!((backward.playhead_at(STEP, 0.0) - 3.0).abs() < 1.0e-5, "no jump at the boundary");
        assert!((backward.playhead_at(STEP * 1.5, 0.0) - 2.5).abs() < 1.0e-5);
        // Ping-pong turns around with the cycle, alternate one step earlier.
        let ping_pong = steps(&[0.0, 0.0, 0.0, 0.0]);
        ping_pong.direction.set(DIRECTION_PING_PONG);
        assert!(ping_pong.playhead_at(STEP * 0.5, 0.0) < ping_pong.playhead_at(STEP * 1.5, 0.0));
        assert!(ping_pong.playhead_at(STEP * 4.5, 0.0) > ping_pong.playhead_at(STEP * 5.5, 0.0));
    }

    #[test]
    fn the_random_direction_is_stable_per_cycle() {
        let state = steps(&[0.0, 0.25, 0.5, 0.75, 1.0, -0.25, -0.5, -1.0]);
        state.direction.set(DIRECTION_RANDOM);
        let cycle: Vec<f32> = (0..8).map(|index| state.value_at(STEP * index as f64, 0.0)).collect();
        let replay: Vec<f32> = (0..8).map(|index| state.value_at(STEP * index as f64, 0.0)).collect();
        assert_eq!(cycle, replay, "the same position always gives the same step");
        let next: Vec<f32> = (8..16).map(|index| state.value_at(STEP * index as f64, 0.0)).collect();
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
        assert_eq!(hard.value_at(STEP * 1.5, 0.0), 1.0, "no smoothing means the step is already there");
        let glided = steps(&[0.0, 1.0]);
        glided.rate_sync.set(SIXTEENTH);
        glided.smooth.set(0.5);
        assert_eq!(glided.value_at(STEP, 0.0), 0.0, "the glide starts at the previous step's value");
        let half = glided.value_at(STEP * 1.25, 0.0);
        assert!(half > 0.4 && half < 0.6, "halfway through the glide sits between the two, got {half}");
        assert_eq!(glided.value_at(STEP * 1.5, 0.0), 1.0, "and it has arrived once the glide is over");
        assert_eq!(glided.value_at(STEP * 1.9, 0.0), 1.0);
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
