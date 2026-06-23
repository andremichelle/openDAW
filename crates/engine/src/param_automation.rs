//! One automated parameter's curve, read region-aware (Route D). A parameter binds 1:1 to a Value
//! `TrackBox`; that track holds value regions, each a loopable span over a `ValueEventCollection`. The
//! engine evaluates the parameter at a pulse position exactly like TS `TrackBoxAdapter.valueAt`: pick the
//! region at/before the position, and if the position is within it, read its curve at the loop-local
//! coordinate; otherwise hold the boundary value. The clock-driven `host_automation` pull calls
//! `ParamCurve::value_at`, so the value is always read live (the underlying `ValueCollection`s stay synced).

use alloc::rc::Rc;
use alloc::vec::Vec;
use core::cell::{Cell, RefCell};
use abi::PARAM_KIND_UNIT;
use bindings::value_collection::ValueCurve;
use value::region::{global_to_local, RegionCollection, Span};

/// A parameter's stable identifier: the field-key path to its box field (e.g. `[16, 10]` for
/// `lowPass.frequency`). The same keys the box schema and the device use — never a packed encoding — so it
/// keys the device <-> curve relationship table without coupling to how anything is stored.
pub(crate) type FieldPath = Vec<u16>;

/// One bound device parameter (the engine's side of `bind_parameter`): the device-assigned `id`, the box
/// field's current real value (`field`, observed so it stays live) and its primitive `kind` (`PARAM_KIND_INT`
/// / `_FLOAT` / `_BOOL`, fixed by the field's type), the automation `track` when connected, and the `last`
/// value handed to the device (for change detection). Cheap to clone (the `field` / `last` are `Rc`), so the
/// node can swap a set of these into the pull context for `host_update_parameters`.
#[derive(Clone)]
pub(crate) struct ParamHandle {
    pub(crate) id: u32,
    pub(crate) field: Rc<Cell<f32>>, // the box field's current real value (Hz, semitones, bool 0/1) as an f32
    pub(crate) kind: u32,            // the field's primitive type, used when the parameter is NOT automated
    pub(crate) track: Option<ParamCurve>,
    pub(crate) last: Rc<Cell<f32>>
}

impl ParamHandle {
    /// Resolve the parameter at `position`, returning `(value, kind)` for the wire: when a track is connected,
    /// the uniform `0..1` curve value tagged `PARAM_KIND_UNIT` (the device maps it); else the box field's
    /// already-real value tagged with the field's primitive `kind` (the device uses it directly). The host
    /// stays mapping-agnostic — the device owns the mapping. Mirrors TS `track ? track.valueAt(...) : getValue()`.
    pub(crate) fn resolve(&self, position: f64) -> (f32, u32) {
        match &self.track {
            Some(curve) => (curve.value_at(position, 0.0), PARAM_KIND_UNIT),
            None => (self.field.get(), self.kind)
        }
    }
}

/// One value region on a parameter's track: its loopable span plus a read handle onto its curve. Sorted by
/// `position` within the parameter's `RegionCollection`, so `floor_last_index` finds the covering region.
pub(crate) struct ValueBoundRegion {
    pub(crate) position: f64,
    pub(crate) duration: f64,
    pub(crate) loop_offset: f64,
    pub(crate) loop_duration: f64,
    pub(crate) curve: ValueCurve
}

impl Span for ValueBoundRegion {
    fn position(&self) -> f64 { self.position }
    fn duration(&self) -> f64 { self.duration }
}

impl ValueBoundRegion {
    /// Map a global position to this region's local loop coordinate, guarding a zero loop duration (treat as
    /// no loop: a single pass from the region's start).
    fn local(&self, position: f64) -> f64 {
        if self.loop_duration > 0.0 {
            global_to_local(position, self.position, self.loop_offset, self.loop_duration)
        } else {
            position - self.position + self.loop_offset
        }
    }

    fn value_at(&self, position: f64, fallback: f32) -> f32 {
        self.curve.value_at(self.local(position), fallback)
    }
}

/// A graph node (the instrument and audio-effect bridges) whose bound parameters the engine sets after
/// wiring and re-sets when automation attaches / detaches at runtime. Held behind `Rc<RefCell<dyn
/// ParamSink>>` so a unit can re-bind a device's parameters without rewiring its audio graph.
pub(crate) trait ParamSink {
    /// Replace this device's bound parameters; `clock_armed` is true iff at least one has an automation
    /// track. The node swaps `params` into the pull context each `process` for `host_update_parameters`.
    fn set_params(&mut self, params: Vec<ParamHandle>, clock_armed: bool);
    /// The address of this device's state block, for the engine's `init` / `parameter_changed` calls.
    fn state_ptr(&self) -> u32;
}

/// A cheap, cloneable read handle onto a parameter's automation: the track's value regions, sorted. Built
/// once when the device is wired (catch-up of the track's regions); the engine clones it into the device's
/// pull context, and `host_automation` evaluates it per clock event.
#[derive(Clone)]
pub(crate) struct ParamCurve(Rc<RefCell<RegionCollection<ValueBoundRegion>>>);

impl ParamCurve {
    pub(crate) fn new(regions: RegionCollection<ValueBoundRegion>) -> Self {
        Self(Rc::new(RefCell::new(regions)))
    }

    /// The parameter's unit value (0..1) at `position`, mirroring TS `TrackBoxAdapter.valueAt`: the region
    /// at/before the position, read at its loop-local coordinate while the position is within it, else the
    /// region's outgoing value; before the first region, that region's incoming value.
    pub(crate) fn value_at(&self, position: f64, fallback: f32) -> f32 {
        let regions = self.0.borrow();
        let floor = regions.floor_last_index(position);
        if floor < 0 {
            return regions.get(0).map_or(fallback, |region| region.value_at(region.position, fallback));
        }
        match regions.get(floor as usize) {
            None => fallback,
            Some(region) if position < region.position + region.duration => region.value_at(position, fallback),
            Some(region) => region.value_at(region.position + region.duration, fallback)
        }
    }
}
