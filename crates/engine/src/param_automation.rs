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
use boxgraph::address::Uuid;
use engine_env::clip_sequencer::{ClipInfo, ClipSequencer};
use value::region::{global_to_local, RegionCollection, Span};

/// A parameter's stable identifier: the field-key path to its box field (e.g. `[16, 10]` for
/// `lowPass.frequency`). The same keys the box schema and the device use — never a packed encoding — so it
/// keys the device <-> curve relationship table without coupling to how anything is stored.
pub(crate) type FieldPath = Vec<u16>;

/// TS `UpdateClockRate` — the window `TrackBoxAdapter.valueAt` hands to `clipSequencing.iterate`.
const UPDATE_CLOCK_RATE: f64 = dsp::ppqn::UPDATE_CLOCK_RATE;

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
    pub(crate) last: Rc<Cell<f32>>,
    // The UI broadcast slot at the parameter's FIELD ADDRESS (TS `AutomatableParameter.onStartAutomation`:
    // `broadcastFloat(adapter.address, () => getUnitValue())`) — `Some` only while a track is attached;
    // `resolve` keeps `[0]` at the current unit value, the worklet mirrors it, the knob animates.
    pub(crate) broadcast: Option<engine_env::telemetry::BroadcastSlot>
}

impl ParamHandle {
    /// Resolve the parameter at `position`, returning `(value, kind)` for the wire: when a track is connected,
    /// the uniform `0..1` curve value tagged `PARAM_KIND_UNIT` (the device maps it); else the box field's
    /// already-real value tagged with the field's primitive `kind` (the device uses it directly). The host
    /// stays mapping-agnostic — the device owns the mapping. Mirrors TS `track ? track.valueAt(...) : getValue()`.
    pub(crate) fn resolve(&self, position: f64) -> (f32, u32) {
        match &self.track {
            Some(curve) => {
                let value = curve.value_at(position, 0.0);
                if let Some(slot) = &self.broadcast {
                    slot.borrow_mut()[0] = value;
                }
                (value, PARAM_KIND_UNIT)
            }
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

    /// The region's INCOMING value, for a position BEFORE the track's first region (mirrors TS
    /// `ValueRegionBoxAdapter.incomingValue`): the FIRST curve event when one sits at local 0. On STACKED
    /// events at 0, `value_at(0)` floors to the LAST of the stack — a different value (the atstil
    /// pad-StereoTool bug: TS resolved the stack's first, wasm its last). Falls back to the region start.
    fn incoming_value(&self, fallback: f32) -> f32 {
        match self.curve.incoming_zero_value() {
            Some(value) => value,
            None => self.value_at(self.position, fallback)
        }
    }

    /// The region's OUTGOING value, for a position AT/AFTER its end (mirrors TS `ValueRegionBoxAdapter.
    /// outgoingValue`). When the region ends exactly on a loop boundary, read the curve at the loop END
    /// (`loop_duration`, UN-wrapped) so an automated parameter HOLDS its last value; otherwise the wrapped local
    /// of the end. Without this, `value_at(end)` routes through `local()`, which wraps a boundary-ending region
    /// back to the loop START — so the parameter jumps to the loop's first value instead of holding (the
    /// "automation doesn't keep its last value when the region ends" bug). TS: `(complete - offset) %
    /// loopDuration === 0` with `offset = position - loopOffset`, i.e. `(duration + loopOffset) % loopDuration`.
    fn outgoing_value(&self, fallback: f32) -> f32 {
        let ends_on_loop_pass = self.loop_duration > 0.0
            && ((self.duration + self.loop_offset) % self.loop_duration).abs() < 1.0e-6;
        if ends_on_loop_pass {
            self.curve.value_at(self.loop_duration, fallback)
        } else {
            self.curve.value_at(self.local(self.position + self.duration), fallback)
        }
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

/// One launchable VALUE clip's automation content (TS `ValueClipBoxAdapter`): its live event curve, read
/// modulo the clip duration while the clip plays.
pub(crate) struct BoundValueClip {
    pub(crate) clip_uuid: Uuid,
    pub(crate) duration: f64,
    pub(crate) looped: bool,
    pub(crate) curve: ValueCurve
}

struct CurveState {
    track: Uuid,
    regions: RegionCollection<ValueBoundRegion>,
    clips: Vec<BoundValueClip>,
    sequencer: Rc<RefCell<ClipSequencer>>
}

struct ValueClipInfo<'a> {
    clips: &'a [BoundValueClip]
}

impl ClipInfo for ValueClipInfo<'_> {
    fn resolve(&self, clip: &[u8; 16]) -> Option<(f64, bool)> {
        self.clips.iter().find(|bound| &bound.clip_uuid == clip).map(|bound| (bound.duration, bound.looped))
    }
}

/// A cheap, cloneable read handle onto a parameter's automation: the track's value regions + its launchable
/// value clips, and the shared clip sequencer splitting each read into sections. Built once when the device
/// is wired (catch-up of the track's regions); the engine clones it into the device's pull context, and
/// `host_automation` evaluates it per clock event.
#[derive(Clone)]
pub(crate) struct ParamCurve(Rc<RefCell<CurveState>>);

impl ParamCurve {
    pub(crate) fn new(track: Uuid, regions: RegionCollection<ValueBoundRegion>,
                      clips: Vec<BoundValueClip>, sequencer: Rc<RefCell<ClipSequencer>>) -> Self {
        Self(Rc::new(RefCell::new(CurveState {track, regions, clips, sequencer})))
    }

    /// The parameter's unit value (0..1) at `position`, mirroring TS `TrackBoxAdapter.valueAt` INCLUDING the
    /// clip sections: a LAUNCHED value clip replaces the timeline (its curve read modulo the clip duration);
    /// the clip-free sections resolve the region at/before the position (loop-local while inside, its
    /// outgoing value after, the first region's incoming value before). The last section's value wins (TS).
    pub(crate) fn value_at(&self, position: f64, fallback: f32) -> f32 {
        let state = self.0.borrow();
        let mut value = fallback;
        let info = ValueClipInfo {clips: &state.clips};
        let regions = &state.regions;
        let clips = &state.clips;
        state.sequencer.borrow_mut().iterate(&state.track, position, position + UPDATE_CLOCK_RATE, &info, &mut |section| {
            value = match section.clip {
                None => Self::region_value_at(regions, position, fallback),
                Some(clip) => {
                    // TS: only the section STARTING at the queried position reads the clip.
                    if section.from == position {
                        clips.iter().find(|bound| bound.clip_uuid == clip)
                            .filter(|bound| bound.duration > 0.0)
                            .map_or(fallback, |bound| bound.curve.value_at(position % bound.duration, fallback))
                    } else {
                        fallback
                    }
                }
            };
        });
        value
    }

    fn region_value_at(regions: &RegionCollection<ValueBoundRegion>, position: f64, fallback: f32) -> f32 {
        let floor = regions.floor_last_index(position);
        if floor < 0 {
            // Before the track's first region: its INCOMING value (TS `firstRegion.incomingValue(fallback)`).
            return regions.get(0).map_or(fallback, |region| region.incoming_value(fallback));
        }
        match regions.get(floor as usize) {
            None => fallback,
            Some(region) if position < region.position + region.duration => region.value_at(position, fallback),
            Some(region) => region.outgoing_value(fallback)
        }
    }
}
