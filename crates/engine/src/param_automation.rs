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
use crate::modulation::{modulation_sum, ModulationChain};

/// A parameter's stable identifier: the field-key path to its box field (e.g. `[16, 10]` for
/// `lowPass.frequency`). The same keys the box schema and the device use — never a packed encoding — so it
/// keys the device <-> curve relationship table without coupling to how anything is stored.
pub(crate) type FieldPath = Vec<u16>;

/// TS `UpdateClockRate` — the window `TrackBoxAdapter.valueAt` hands to `clipSequencing.iterate`.
const UPDATE_CLOCK_RATE: f64 = dsp::ppqn::UPDATE_CLOCK_RATE;

/// `ParamHandle::held`'s "nothing resolved yet" kind, distinct from every `PARAM_KIND_*`.
pub(crate) const HELD_NONE: u32 = u32::MAX;

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
    // Every enabled assignment driving this parameter (`RootBox.modulators` -> `ModulationBox` -> here).
    // `None` when the parameter has no assignment at all, which keeps it on its exact un-modulated path.
    pub(crate) modulation: Option<ModulationChain>,
    pub(crate) last: Rc<Cell<f32>>,
    // The modulation sum last handed to the device, beside `last`. Compared by BIT PATTERN, since the "no
    // modulation" sentinel is NaN and `NaN != NaN` would otherwise report a change on every single push.
    pub(crate) last_modulation: Rc<Cell<f32>>,
    // The AUTOMATION value last resolved while transporting, for the HOST-side consumers (the strip, the
    // sends, a composite's gains). Unlike a device those resolve per block rather than on the update clock,
    // so a paused transport must hand them a held automation value while the modulation keeps moving. `kind`
    // is `HELD_NONE` until the first resolve, where the parameter's own storage value applies (the TS
    // `AutomatableParameter` initial `#value`).
    pub(crate) held: Rc<Cell<(f32, u32)>>,
    // The UI broadcast slot at the parameter's FIELD ADDRESS (TS `AutomatableParameter.onStartAutomation`:
    // `broadcastFloat(adapter.address, () => getUnitValue())`) — `Some` only while a track is attached;
    // `resolve` keeps `[0]` at the current unit value, the worklet mirrors it, the knob animates.
    pub(crate) broadcast: Option<engine_env::telemetry::BroadcastSlot>
}

impl ParamHandle {
    /// Resolve the parameter at `position`, returning `(value, kind, modulation)` for the wire: when a track is
    /// connected AND its curve covers the position, the uniform `0..1` curve value tagged `PARAM_KIND_UNIT` (the
    /// device maps it); else the box field's STORED value tagged with the field's primitive `kind` (the device
    /// uses it directly). `modulation` is the summed modulation in NORMALIZED space, NaN when the parameter has
    /// none. The host stays mapping-agnostic — the device owns the mapping, so it folds the base and the sum
    /// together (`abi::float_value`), which is the only place both are known. Mirrors TS
    /// `valueMapping.y(track.valueAt(position, getUnitValue()))`: the TS fallback is the mapped FIELD value,
    /// so a muted value clip / an empty curve resolves to the field's storage value, never a made-up 0.
    pub(crate) fn resolve(&self, position: f64) -> (f32, u32, f32) {
        self.resolve_split(position, position)
    }

    /// [`resolve`] with the two positions apart, for a PAUSED transport: the automation reads the FROZEN song
    /// position (a static curve at a fixed position is exactly the "hold" TS gets from its silent update
    /// clock), while the modulation keeps moving with the free-running position the render loop passes. While
    /// transporting the two are the same number and this is plain `resolve`.
    pub(crate) fn resolve_split(&self, automation_position: f64, modulation_position: f64) -> (f32, u32, f32) {
        let (value, kind) = self.resolve_base(automation_position);
        let modulation = modulation_sum(self.modulation.as_ref(), modulation_position);
        self.publish(value, modulation);
        (value, kind, modulation)
    }

    /// Mirror the resolved pair into the UI slot: `[0]` the AUTOMATED unit value (NaN when the curve does not
    /// apply, so the knob keeps showing the parameter's own storage value), `[1]` the modulation sum. The UI
    /// adds them, since only it (and the device) knows the mapping to normalize a storage value with.
    fn publish(&self, value: f32, modulation: f32) {
        if let Some(slot) = &self.broadcast {
            let mut slot = slot.borrow_mut();
            if slot.len() > 1 {
                slot[1] = modulation;
            }
            if self.track.is_none() {
                slot[0] = f32::NAN; // no automation applies; `resolve_base` only writes `[0]` when it does
            }
            let _ = value;
        }
    }

    /// Resolve for a HOST-side consumer, which is called per BLOCK rather than on the update clock: while
    /// transporting this is `resolve`, remembering the automation value; while PAUSED the automation is the
    /// held value (the parameter's storage value until one was ever resolved) and only the modulation moves.
    pub(crate) fn resolve_held(&self, position: f64, transporting: bool) -> (f32, u32, f32) {
        let (value, kind) = if transporting {
            let resolved = self.resolve_base(position);
            self.held.set(resolved);
            resolved
        } else {
            match self.held.get() {
                (_, HELD_NONE) => (self.field.get(), self.kind),
                held => held
            }
        };
        let modulation = modulation_sum(self.modulation.as_ref(), position);
        self.publish(value, modulation);
        (value, kind, modulation)
    }

    /// Whether `(value, modulation)` differs from what this parameter last handed the device, the push / pull
    /// paths' change detection. The modulation compares by bit pattern so the NaN sentinel is stable.
    pub(crate) fn changed(&self, value: f32, modulation: f32) -> bool {
        value != self.last.get() || modulation.to_bits() != self.last_modulation.get().to_bits()
    }

    /// Record `(value, modulation)` as the pair handed to the device.
    pub(crate) fn mark(&self, value: f32, modulation: f32) {
        self.last.set(value);
        self.last_modulation.set(modulation);
    }

    /// The un-modulated `(value, kind)`, i.e. everything [`resolve`] does apart from the modulation sum.
    fn resolve_base(&self, position: f64) -> (f32, u32) {
        match self.track.as_ref().and_then(|curve| curve.value_at(position)) {
            Some(value) => {
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
/// A MUTED region is skipped by the lookup (TS `lowerEqual(position, region => !region.mute)`), so the
/// previous unmuted region's value (or the first region's incoming value) applies instead.
pub(crate) struct ValueBoundRegion {
    pub(crate) position: f64,
    pub(crate) duration: f64,
    pub(crate) loop_offset: f64,
    pub(crate) loop_duration: f64,
    pub(crate) mute: bool,
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

    /// `None` when the curve is empty (the caller falls back to the field's STORED value, like TS).
    fn value_at(&self, position: f64) -> Option<f32> {
        self.curve.value_at_opt(self.local(position))
    }

    /// The region's INCOMING value, for a position BEFORE the track's first region (mirrors TS
    /// `ValueRegionBoxAdapter.incomingValue`): the FIRST curve event when one sits at local 0. On STACKED
    /// events at 0, `value_at(0)` floors to the LAST of the stack — a different value (the atstil
    /// pad-StereoTool bug: TS resolved the stack's first, wasm its last). Falls back to the region start.
    fn incoming_value(&self) -> Option<f32> {
        self.curve.incoming_zero_value().or_else(|| self.value_at(self.position))
    }

    /// The region's OUTGOING value, for a position AT/AFTER its end (mirrors TS `ValueRegionBoxAdapter.
    /// outgoingValue`). When the region ends exactly on a loop boundary, read the curve at the loop END
    /// (`loop_duration`, UN-wrapped) so an automated parameter HOLDS its last value; otherwise the wrapped local
    /// of the end. Without this, `value_at(end)` routes through `local()`, which wraps a boundary-ending region
    /// back to the loop START — so the parameter jumps to the loop's first value instead of holding (the
    /// "automation doesn't keep its last value when the region ends" bug). TS: `(complete - offset) %
    /// loopDuration === 0` with `offset = position - loopOffset`, i.e. `(duration + loopOffset) % loopDuration`.
    fn outgoing_value(&self) -> Option<f32> {
        let ends_on_loop_pass = self.loop_duration > 0.0
            && ((self.duration + self.loop_offset) % self.loop_duration).abs() < 1.0e-6;
        if ends_on_loop_pass {
            self.curve.value_at_opt(self.loop_duration)
        } else {
            self.curve.value_at_opt(self.local(self.position + self.duration))
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
/// modulo the clip duration while the clip plays. A MUTED clip reads as the fallback (the UI also gates
/// launching a muted clip).
pub(crate) struct BoundValueClip {
    pub(crate) clip_uuid: Uuid,
    pub(crate) duration: f64,
    pub(crate) looped: bool,
    pub(crate) mute: bool,
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
    /// `None` = no automation applies (a MUTED clip, an empty curve, no regions): the caller resolves the
    /// field's STORED value, exactly like TS's `getUnitValue()` fallback.
    pub(crate) fn value_at(&self, position: f64) -> Option<f32> {
        let state = self.0.borrow();
        let mut value = None;
        let info = ValueClipInfo {clips: &state.clips};
        let regions = &state.regions;
        let clips = &state.clips;
        state.sequencer.borrow_mut().iterate(&state.track, position, position + UPDATE_CLOCK_RATE, &info, &mut |section| {
            value = match section.clip {
                None => Self::region_value_at(regions, position),
                Some(clip) => {
                    // TS: only the section STARTING at the queried position reads the clip; a MUTED clip
                    // reads as the fallback = the field's storage value.
                    if section.from == position {
                        clips.iter().find(|bound| bound.clip_uuid == clip)
                            .filter(|bound| bound.duration > 0.0 && !bound.mute)
                            .and_then(|bound| bound.curve.value_at_opt(position % bound.duration))
                    } else {
                        None
                    }
                }
            };
        });
        value
    }

    fn region_value_at(regions: &RegionCollection<ValueBoundRegion>, position: f64) -> Option<f32> {
        // Walk down from the floor past MUTED regions (TS `lowerEqual(position, region => !region.mute)`),
        // so a muted region applies nothing and the previous unmuted one rules instead.
        let mut floor = regions.floor_last_index(position);
        while floor >= 0 && regions.get(floor as usize).is_some_and(|region| region.mute) {
            floor -= 1;
        }
        if floor < 0 {
            // Before the track's first (unmuted) region: the FIRST region's INCOMING value — TS reads
            // `optAt(0)` here WITHOUT the mute filter, quirk mirrored.
            return regions.get(0).and_then(|region| region.incoming_value());
        }
        match regions.get(floor as usize) {
            None => None,
            Some(region) if position < region.position + region.duration => region.value_at(position),
            Some(region) => region.outgoing_value()
        }
    }
}
