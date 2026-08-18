//! Project-global modulator sources and their assignments (plans/modulations.md).

use alloc::rc::Rc;
use alloc::vec::Vec;
use core::cell::Cell;
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

// The free-running wall clock the absolute rate integrates over, advanced once per quantum by the engine.
// Its OWN cell (NOT `ENGINE`), like `SONG_POSITION`: the re-entrant read during render must not alias the
// `&mut Engine` the render path holds.
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

pub(crate) struct ModulatorState {
    pub(crate) shape: Cell<i32>,
    pub(crate) rate_sync: Cell<i32>,
    pub(crate) rate_absolute: Cell<f32>,
    pub(crate) phase: Cell<f32>,
    pub(crate) amount: Cell<f32>,
    pub(crate) enabled: Cell<bool>
}

impl ModulatorState {
    pub(crate) fn new() -> Self {
        Self {shape: Cell::new(SHAPE_SINE), rate_sync: Cell::new(3), rate_absolute: Cell::new(0.0),
            phase: Cell::new(0.0), amount: Cell::new(1.0), enabled: Cell::new(true)}
    }

    /// The two rates are ADDITIVE in frequency: the tempo-synced cycle plus `rate_absolute` Hz of wall clock.
    pub(crate) fn value_at(&self, position: f64, seconds: f64) -> f32 {
        let turn = position / cycle_pulses(self.rate_sync.get())
            + seconds * self.rate_absolute.get() as f64
            + self.phase.get() as f64;
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

fn fract(turn: f64) -> f64 {
    let truncated = (turn as i64) as f64;
    turn - if truncated > turn {truncated - 1.0} else {truncated}
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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lfo(shape: i32, rate: i32) -> ModulatorState {
        let state = ModulatorState::new();
        state.shape.set(shape);
        state.rate_sync.set(rate);
        state
    }

    const BAR: f64 = 3840.0;
    const ONE_BAR: i32 = 3;
    const QUARTER: i32 = 5;

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
    fn the_sum_is_nan_until_something_actually_contributes() {
        let state = Rc::new(lfo(SHAPE_SQUARE, ONE_BAR)); // +1 over the first half of the cycle
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
