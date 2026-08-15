//! Project-global modulator sources and the assignments that bind them to parameters (plans/modulations.md).
//!
//! A modulator is a PURE function of the transport position, so a locate, a loop wrap and an offline render
//! all reproduce the same value with no state to reset and nothing to seed. Its fields are held in live cells
//! fed by targeted subscriptions, so dragging an LFO's rate re-reads a number on the next tick rather than
//! re-binding anything.
//!
//! The value never leaves normalized space here: a source yields `-1..1`, an assignment scales it by its
//! signed `depth`, and the sums of all enabled assignments reach the device on the parameter wire, where
//! `abi::float_value` folds them onto the base with the device's OWN mapping. The host stays mapping-agnostic.

use alloc::rc::Rc;
use alloc::vec::Vec;
use core::cell::Cell;
use boxgraph::address::Uuid;
use boxgraph::subscription::SubscriptionId;
use dsp::fast_math::fast_sin_tau;

// WASM CONTRACT: LfoModulatorBox.shape (field 10), mirrored by LfoModulatorBoxAdapter's shape values.
pub(crate) const SHAPE_SINE: i32 = 0;
pub(crate) const SHAPE_TRIANGLE: i32 = 1;
pub(crate) const SHAPE_SAW: i32 = 2;
pub(crate) const SHAPE_SQUARE: i32 = 3;

// WASM CONTRACT: LfoModulatorBox.rate (field 11) indexes THIS table, mirrored by the adapter's `Rates`. One
// cycle in pulses, ascending: 1/32, 1/16T, 1/16, 1/8T, 1/8, 1/4T, 1/4, 1/2, 1 bar, 2, 4, 8 bars. Index 8
// (one bar) is the schema's default.
pub(crate) const RATES: [f64; 12] = [120.0, 160.0, 240.0, 320.0, 480.0, 640.0, 960.0, 1920.0,
    3840.0, 7680.0, 15360.0, 30720.0];

/// The pulses of one cycle for a rate index, clamped to the table (a value outside it can only be contract
/// drift, and a modulator that stops moving is worse than one that runs at the nearest rate).
fn cycle_pulses(rate: i32) -> f64 {
    RATES[(rate.max(0) as usize).min(RATES.len() - 1)]
}

/// One modulator's live fields, kept current by targeted subscriptions so the render path never reads the
/// graph. Shared (`Rc`) by every assignment that names this modulator.
pub(crate) struct ModulatorState {
    pub(crate) shape: Cell<i32>,
    pub(crate) rate: Cell<i32>,
    pub(crate) phase: Cell<f32>,
    pub(crate) amount: Cell<f32>,
    pub(crate) enabled: Cell<bool>
}

impl ModulatorState {
    pub(crate) fn new() -> Self {
        Self {shape: Cell::new(SHAPE_SINE), rate: Cell::new(8), phase: Cell::new(0.0),
            amount: Cell::new(1.0), enabled: Cell::new(true)}
    }

    /// This source's `-1..1` value at `position` (pulses), scaled by its own `amount`. A disabled modulator
    /// contributes nothing at all, which is not the same as contributing zero: the caller drops it from the
    /// sum entirely, so the parameter takes its un-modulated path.
    pub(crate) fn value_at(&self, position: f64) -> f32 {
        let turn = position / cycle_pulses(self.rate.get()) + self.phase.get() as f64;
        let shape = match self.shape.get() {
            SHAPE_TRIANGLE => triangle(turn),
            SHAPE_SAW => saw(turn),
            SHAPE_SQUARE => square(turn),
            _ => fast_sin_tau(turn)
        };
        shape as f32 * self.amount.get()
    }
}

/// The fractional part of a turn, for any sign. No libm (the engine has none): truncate toward zero, then
/// step down for a negative input, the same idiom as `first_update_position`.
fn fract(turn: f64) -> f64 {
    let truncated = (turn as i64) as f64;
    turn - if truncated > turn {truncated - 1.0} else {truncated}
}

/// Rises through 0 at the cycle start like the sine: 0 -> +1 -> 0 -> -1 -> 0.
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

/// One rising ramp per cycle, from -1 at the cycle start to +1 at its end.
fn saw(turn: f64) -> f64 {
    fract(turn) * 2.0 - 1.0
}

/// The first half of the cycle high, the second low.
fn square(turn: f64) -> f64 {
    if fract(turn) < 0.5 {1.0} else {-1.0}
}

/// One assignment as the render path sees it: the source, plus this assignment's own live `depth` and
/// `enabled` cells. Cheap to clone; a depth drag writes the cell and needs no re-bind.
pub(crate) struct BoundModulation {
    pub(crate) modulator: Rc<ModulatorState>,
    pub(crate) depth: Rc<Cell<f32>>,
    pub(crate) enabled: Rc<Cell<bool>>
}

/// Every assignment driving ONE parameter. Rebuilt when the assignment SET changes (a `ModulationBox` added,
/// removed or re-pointed), never for a value edit.
pub(crate) type ModulationChain = Rc<[BoundModulation]>;

/// The summed modulation for `chain` at `position`, or NaN when nothing contributes (no assignment, or every
/// one disabled). NaN is the wire's "no modulation" sentinel, so a disabled assignment leaves the parameter
/// on its exact un-modulated path rather than adding a zero — which would still round-trip through the
/// device's mapping and could shift the value by a float epsilon.
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

/// The engine's registry of live modulators, keyed by their `LfoModulatorBox` uuid. Membership is recorded by
/// the `RootBox.modulators` hub observer (which holds only `&BoxGraph`) and realized by `sync_modulators`,
/// the same two-step the MIDI-output targets use.
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

    /// Drop a modulator and hand back its subscriptions for the caller to unsubscribe (it holds `&mut graph`).
    pub(crate) fn remove(&mut self, uuid: &Uuid) -> Vec<SubscriptionId> {
        match self.entries.iter().position(|(bound, ..)| bound == uuid) {
            Some(index) => self.entries.remove(index).2,
            None => Vec::new()
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lfo(shape: i32, rate: i32) -> ModulatorState {
        let state = ModulatorState::new();
        state.shape.set(shape);
        state.rate.set(rate);
        state
    }

    const BAR: f64 = 3840.0;

    #[test]
    fn a_sine_walks_its_cycle_from_the_position_alone() {
        let state = lfo(SHAPE_SINE, 8); // one bar
        assert!(state.value_at(0.0).abs() < 1.0e-6);
        assert!((state.value_at(BAR * 0.25) - 1.0).abs() < 1.0e-6);
        assert!(state.value_at(BAR * 0.5).abs() < 1.0e-6);
        assert!((state.value_at(BAR * 0.75) + 1.0).abs() < 1.0e-6);
        // Pure in the position: the value at bar 17 equals the value at bar 1, so a locate needs no seeding.
        assert!((state.value_at(BAR * 17.25) - state.value_at(BAR * 0.25)).abs() < 1.0e-6);
    }

    #[test]
    fn every_shape_starts_at_its_own_cycle_point_and_stays_bounded() {
        for shape in [SHAPE_SINE, SHAPE_TRIANGLE, SHAPE_SAW, SHAPE_SQUARE] {
            let state = lfo(shape, 8);
            for step in 0..64 {
                let value = state.value_at(BAR * step as f64 / 64.0);
                assert!((-1.0..=1.0).contains(&value), "shape {shape} left the unit range: {value}");
            }
        }
        assert!((lfo(SHAPE_TRIANGLE, 8).value_at(BAR * 0.25) - 1.0).abs() < 1.0e-6);
        assert!((lfo(SHAPE_SAW, 8).value_at(0.0) + 1.0).abs() < 1.0e-6);
        assert_eq!(lfo(SHAPE_SQUARE, 8).value_at(BAR * 0.25), 1.0);
        assert_eq!(lfo(SHAPE_SQUARE, 8).value_at(BAR * 0.75), -1.0);
    }

    #[test]
    fn phase_and_amount_shift_and_scale() {
        let shifted = lfo(SHAPE_SINE, 8);
        shifted.phase.set(0.25);
        assert!((shifted.value_at(0.0) - 1.0).abs() < 1.0e-6, "a quarter-turn phase starts at the peak");
        let scaled = lfo(SHAPE_SINE, 8);
        scaled.amount.set(0.5);
        assert!((scaled.value_at(BAR * 0.25) - 0.5).abs() < 1.0e-6);
    }

    #[test]
    fn the_rate_index_selects_the_cycle_length() {
        let quarter = lfo(SHAPE_SINE, 6); // 1/4 = 960 pulses
        assert!((quarter.value_at(240.0) - 1.0).abs() < 1.0e-6, "a quarter of 960 pulses is the peak");
        assert_eq!(cycle_pulses(-3), RATES[0], "an out-of-range index clamps rather than stopping the LFO");
        assert_eq!(cycle_pulses(99), RATES[RATES.len() - 1]);
    }

    #[test]
    fn the_sum_is_nan_until_something_actually_contributes() {
        let state = Rc::new(lfo(SHAPE_SQUARE, 8)); // +1 over the first half of the cycle
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
