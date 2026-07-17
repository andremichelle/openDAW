use super::*;
use super::tracks::{TRACK_TARGET_KEY, TRACK_REGIONS_KEY, TRACK_CLIPS_KEY, TRACK_ENABLED_KEY, track_enabled, value_regions_of_track, value_clips_of_track};

// The LIGHT per-unit signal a plain FIELD edit raises while `reconcile_one` runs (set around the unit's
// work, the `CURRENT_DEVICE_UUID` pattern): a knob drag then only marks `params_dirty` (one value push at
// the next reconcile) instead of `automation_dirty` (a full unsubscribe + re-observe of every parameter,
// per drag tick, on the audio thread). Automation ATTACH / DETACH / region moves keep the heavy signal.
#[cfg(not(test))]
pub(crate) static PARAMS_SIGNAL: crate::Shared<Option<Rc<dyn Fn()>>> = crate::Shared::new(None);
#[cfg(test)]
std::thread_local! {
    // Tests run on parallel threads; the production engine is single-threaded, so the Shared cell is only
    // sound there. Per-thread isolation keeps the tests deterministic.
    static PARAMS_SIGNAL: core::cell::RefCell<Option<Rc<dyn Fn()>>> = const { core::cell::RefCell::new(None) };
}

pub(crate) fn set_params_signal(signal: Option<Rc<dyn Fn()>>) {
    #[cfg(not(test))]
    unsafe { *PARAMS_SIGNAL.get() = signal; }
    #[cfg(test)]
    PARAMS_SIGNAL.with(|cell| *cell.borrow_mut() = signal);
}

pub(crate) fn current_params_signal() -> Option<Rc<dyn Fn()>> {
    #[cfg(not(test))]
    { unsafe { PARAMS_SIGNAL.get() }.clone() }
    #[cfg(test)]
    { PARAMS_SIGNAL.with(|cell| cell.borrow().clone()) }
}

pub(crate) fn params_invalidate(unit: &AudioUnitBinding) -> Rc<dyn Fn()> {
    let dirty = unit.params_dirty.clone();
    let mark = unit.mark.clone();
    Rc::new(move || {dirty.set(true); mark.mark();})
}

/// The signal a unit's PARAMETER subscriptions fire when automation attaches / detaches / a region moves:
/// set the unit's `automation_dirty` flag and enqueue the unit, so `reconcile_one` re-binds its automation
/// (no rewire). Distinct from `params_invalidate` (a plain field edit: push only) and from
/// `DirtyMark::signal` (chain / sidechain), which only enqueues.
pub(crate) fn automation_invalidate(unit: &AudioUnitBinding) -> Rc<dyn Fn()> {
    let dirty = unit.automation_dirty.clone();
    let mark = unit.mark.clone();
    Rc::new(move || {dirty.set(true); mark.mark();})
}

/// Call a device's `init(state_ptr, sample_rate)` to collect the parameter field-paths it declares (it binds
/// them via `host_bind_parameter`, which records into `BIND`) and let it stash the sample rate. Touches no
/// graph, so it is a free fn.
pub(crate) fn bind_paths(reg: DeviceReg, state_ptr: u32, sample_rate: f32) -> Vec<FieldPath> {
    unsafe { BIND.get() }.clear();
    unsafe { BROADCAST_BINDS.get() }.clear();
    unsafe { SAMPLE_OBS.get() }.clear();
    unsafe { SOUNDFONT_OBS.get() }.clear();
    unsafe { FIELD_OBS.get() }.clear();
    unsafe { SIDECHAIN_BIND.get() }.clear();
    call_device_init(reg.init_index, state_ptr, sample_rate);
    core::mem::take(unsafe { BIND.get() })
}

/// Push ONE chain member's parameter values. A member that is not a plugin (an effect composite) has no device
/// params of its own — but its ENTRIES hold real plugins, so the refresh recurses into its binding. Every
/// per-member refresh goes through here, so a composite anywhere in a chain is never skipped.
#[allow(clippy::needless_pass_by_ref_mut)] // reads only; `&Member` keeps every call site's loop immutable
pub(crate) fn refresh_member(member: &Member, position: f64) {
    if let Some(params) = &member.params {
        refresh_params(&params.handles, params.reg, params.state_ptr, position);
    }
    if let ProcHandle::EffectComposite(binding) = &member.proc {
        binding.refresh_params_at(position);
    }
}

/// Push each parameter's resolved value (its automation at `position`, else its real field value) to the
/// device via its `parameter_changed` export, but only when it CHANGED since the last push (the TS
/// `updateAutomation` compare). The `kind` tag tells the device how to read the value (uniform automation to
/// map, or a real Int / Float / Bool field value). Called at build (every param, `last` is NaN) and on a
/// runtime edit / field change. Never during render.
pub(crate) fn refresh_params(handles: &[ParamHandle], reg: DeviceReg, state_ptr: u32, position: f64) {
    for handle in handles {
        let (value, kind) = handle.resolve(position);
        if value != handle.last.get() {
            handle.last.set(value);
            call_device_parameter_changed(reg.parameter_changed_index, state_ptr, handle.id, kind, value);
        }
    }
}

/// Resolve a device's observed sample pointer to a handle and deliver it via `sample_changed`: a resident
/// handle when the `file` pointer targets an `AudioFileBox` (the frames are requested through `SAMPLES`), or
/// "unbound" (`present = 0`) when the pointer has no target (cleared). Touches `SAMPLES` (its own cell) and the
/// device, never `&mut Engine`, so it is safe from a transaction observer.
pub(crate) fn resolve_and_deliver_sample(graph: &BoxGraph, device_uuid: Uuid, path: &[u16], sample_changed_index: u32, state_ptr: u32, id: u32) {
    match graph.target_of(&Address::of(device_uuid, path.to_vec())) {
        Some(target) => {
            let handle = unsafe { SAMPLES.get() }.request(target.uuid);
            call_device_sample_changed(sample_changed_index, state_ptr, id, handle, 1);
        }
        None => call_device_sample_changed(sample_changed_index, state_ptr, id, 0, 0)
    }
}

/// Resolve a device's observed soundfont pointer to a handle and deliver it via `soundfont_changed`: a resident
/// handle when the `file` pointer targets a `SoundfontFileBox` (the blob is requested through `SOUNDFONTS`), or
/// "unbound" (`present = 0`) when the pointer has no target. Touches `SOUNDFONTS` (its own cell) and the device,
/// never `&mut Engine`. Mirrors `resolve_and_deliver_sample`.
pub(crate) fn resolve_and_deliver_soundfont(graph: &BoxGraph, device_uuid: Uuid, path: &[u16], soundfont_changed_index: u32, state_ptr: u32, id: u32) {
    match graph.target_of(&Address::of(device_uuid, path.to_vec())) {
        Some(target) => {
            let handle = unsafe { SOUNDFONTS.get() }.request(target.uuid);
            call_device_soundfont_changed(soundfont_changed_index, state_ptr, id, handle, 1);
        }
        None => call_device_soundfont_changed(soundfont_changed_index, state_ptr, id, 0, 0)
    }
}

/// Encode a field's typed value onto the `field_changed` wire `(kind, bits, len)`: numeric bits, or a
/// string's pointer + length into the shared memory (valid for the synchronous call).
pub(crate) fn deliver_field_value(value: &FieldValue, field_changed_index: u32, state_ptr: u32, id: u32) {
    if let Some(value) = value.as_int32() {
        call_device_field_changed(field_changed_index, state_ptr, id, FIELD_KIND_INT, value as u32, 0);
    } else if let Some(value) = value.as_float32() {
        call_device_field_changed(field_changed_index, state_ptr, id, FIELD_KIND_FLOAT, value.to_bits(), 0);
    } else if let Some(value) = value.as_bool() {
        call_device_field_changed(field_changed_index, state_ptr, id, FIELD_KIND_BOOL, value as u32, 0);
    } else if let Some(value) = value.as_str() {
        call_device_field_changed(field_changed_index, state_ptr, id, FIELD_KIND_STRING, value.as_ptr() as u32, value.len() as u32);
    }
}

/// The target-field observer of a POINTER-CROSSING observation (`observe_fields`): deliver each primitive
/// edit of the target box's field, but only WHILE the pointer still aims at that target. The guard covers a
/// same-transaction "repoint, then the OLD target's field edited": the swap-out of this subscription is
/// deferred (applied after dispatch), so it can still fire within the repointing transaction and must not
/// overwrite the new target's delivered value.
pub(crate) fn pointer_target_field_observer(pointer: Address, target_uuid: Uuid, field_changed_index: u32, state_ptr: u32, id: u32) -> UpdateObserver {
    Box::new(move |graph, update| {
        if let Update::Primitive {new, ..} = update {
            if graph.target_of(&pointer).map(|target| target.uuid) == Some(target_uuid) {
                deliver_field_value(new, field_changed_index, state_ptr, id);
            }
        }
    })
}

/// Resolve a device's observed POINTER to its target box and deliver the target's STRING field `target_key`
/// through the device's `field_changed` (`FIELD_KIND_STRING`), or an EMPTY string when the pointer is unbound
/// or the target lacks that string field. The delivered ptr/len reference the live box-graph string, valid for
/// the synchronous call (the device copies or forwards it before returning). Mirrors
/// `resolve_and_deliver_soundfont`, but needs no resource handshake: the payload already lives in the graph.
pub(crate) fn resolve_and_deliver_target_string(graph: &BoxGraph, device_uuid: Uuid, path: &[u16], target_key: u16, field_changed_index: u32, state_ptr: u32, id: u32) {
    let text = graph.target_of(&Address::of(device_uuid, path.to_vec()))
        .and_then(|target| graph.field_value(&Address::of(target.uuid, vec![target_key])))
        .and_then(|value| value.as_str())
        .unwrap_or("");
    call_device_field_changed(field_changed_index, state_ptr, id, FIELD_KIND_STRING, text.as_ptr() as u32, text.len() as u32);
}

/// The automation curve for a device parameter, if a Value track targets `(device_uuid, path)`: build a
/// `ParamCurve` over that track's value regions and return it with the collections to terminate. `None` (and
/// no collections) when the parameter has no automation track. The last element is the REBIND set: every
/// bound region + clip box uuid, each of which gets a targeted `Parent` monitor in `observe_param` so a
/// field edit (a move, a mute toggle, a duration change) re-binds the snapshot.
pub(crate) fn build_param_track(graph: &mut BoxGraph, device_uuid: Uuid, path: &[u16],
                     clip_sequencer: &Rc<RefCell<ClipSequencer>>) -> (Option<ParamCurve>, Option<Uuid>, Vec<ValueCollection>, Vec<Uuid>) {
    // Find the Value track whose `target` points at this parameter. NOTE: this scans every TrackBox — it can
    // NOT use `graph.incoming(param)`, because a parameter address is a device-internal field path that is not
    // always a RESOLVED graph vertex (deep param paths), so the track's target edge is "dangling" and absent
    // from `incoming`. The cost is O(TrackBoxes), smaller than the value-region scan below (now targeted).
    let track_uuid = {
        let mut found = None;
        for track in graph.find_all_by_name("TrackBox") {
            if let Some(target) = graph.target_of(&Address::of(track.uuid, vec![TRACK_TARGET_KEY])) {
                if target.uuid == device_uuid && target.field_keys.as_slice() == path {
                    found = Some(track.uuid);
                    break;
                }
            }
        }
        found
    };
    let track_uuid = match track_uuid {
        Some(uuid) => uuid,
        None => return (None, None, Vec::new(), Vec::new())
    };
    // A DISABLED automation track applies no curve: the parameter falls back to its own field value (mirrors
    // TS `TrackBoxAdapter.valueAt` returning the fallback when `!enabled`). The track uuid is still returned so
    // `observe_params` keeps the `enabled` monitor armed and re-binds when it is toggled back on.
    if !track_enabled(graph, track_uuid) {
        return (None, Some(track_uuid), Vec::new(), Vec::new());
    }
    let mut regions = RegionCollection::new();
    let mut collections = Vec::new();
    let mut rebind_uuids = Vec::new();
    for spec in value_regions_of_track(graph, track_uuid) {
        let collection = ValueCollection::observe(graph, spec.collection);
        regions.add(ValueBoundRegion {
            position: spec.position, duration: spec.duration,
            loop_offset: spec.loop_offset, loop_duration: spec.loop_duration,
            mute: spec.mute,
            curve: collection.curve()
        });
        collections.push(collection);
        rebind_uuids.push(spec.region);
    }
    // The track's launchable VALUE clips (TS `TrackBoxAdapter.valueAt`'s clip sections): each clip's live
    // event curve, read modulo the clip duration while launched. Rebound with the rest on automation_dirty.
    let mut clips = Vec::new();
    for spec in value_clips_of_track(graph, track_uuid) {
        let collection = ValueCollection::observe(graph, spec.collection);
        clips.push(BoundValueClip {clip_uuid: spec.clip, duration: spec.duration, looped: spec.looped, mute: spec.mute, curve: collection.curve()});
        collections.push(collection);
        rebind_uuids.push(spec.clip);
    }
    (Some(ParamCurve::new(track_uuid, regions, clips, clip_sequencer.clone())), Some(track_uuid), collections, rebind_uuids)
}

/// A LIVE note signal the studio injects (TS `NoteSignal`): the on-screen keys / pads / MIDI input.
#[derive(Clone, Copy)]
pub(crate) enum NoteSignal {
    On {pitch: u8, velocity: f32},
    Off {pitch: u8},
    Audition {pitch: u8, duration: f64, velocity: f32}
}

/// Route a live note signal to the unit's note sources: the leaf sequencer, or every composite SLOT's
/// sequencer (each slot pulls independently; its device filters by pad note). Tape / bus units have none.
/// Mirrors TS `EngineProcessor.noteSignal` -> `NoteSequencer.pushRawNoteOn/Off/auditionNote`.
pub(crate) fn note_signal_to_unit(unit: &AudioUnitBinding, signal: NoteSignal) {
    let mut sources: Vec<SharedNoteEventSource> = Vec::new();
    match unit.wired.as_ref() {
        Some(Wired::Leaf(chain)) => sources.push(chain.sequencer.clone()),
        Some(Wired::Composite(wired)) => wired.binding.collect_note_sources(&mut sources),
        Some(Wired::MidiOut(wired)) => sources.push(wired.sequencer.clone()),
        _ => {}
    }
    for source in sources {
        let mut source = source.borrow_mut();
        match signal {
            NoteSignal::On {pitch, velocity} => source.push_raw_note_on(pitch, velocity),
            NoteSignal::Off {pitch} => source.push_raw_note_off(pitch),
            NoteSignal::Audition {pitch, duration, velocity} => source.audition_note(pitch, duration, velocity)
        }
    }
}

impl Engine {

    /// Bind the channel strip's volume (12) + panning (13) to their AUTOMATION, so a Value track targeting those
    /// fields drives the strip over the transport. The plain field subscriptions only track the STATIC value, so
    /// without this an automated fader was ignored (the unit played at its static volume). Re-observed on a real
    /// automation change; when a field has no track the override stays `None` and the strip keeps using the static
    /// `StripParams`. Volume maps the 0..1 curve through the AudioUnit dB mapping; panning is bipolar (TS adapters).
    pub(crate) fn bind_strip_automation(&mut self, unit: &mut AudioUnitBinding) {
        const VOLUME: Decibel = Decibel::new(-96.0, -9.0, 6.0); // TS AudioUnitBoxAdapter.VolumeMapper
        let invalidate = automation_invalidate(unit);
        self.bind_gain_pan_automation(unit.unit, UNIT_VOLUME_KEY, UNIT_PANNING_KEY, VOLUME, Some(UNIT_MUTE_KEY),
            &unit.strip_automation, &mut unit.strip_param_subs, &mut unit.strip_param_collections, &invalidate);
        // SOLO (15): unlike the strip gains, solo is resolved ENGINE-side (`resolve_automated_solo` -> `update_solo`)
        // because it silences OTHER strips. Observe its track here so it shares the strip's sub/collection cleanup
        // (the `bind_gain_pan_automation` above already `take`s and drops the previous pass's subs, solo included);
        // `observe_param` also registers the UI broadcast at the solo field address so the solo button reflects it.
        *unit.strip_automation.solo.borrow_mut() = None;
        let (solo_handle, solo_subs, solo_collections, _) = self.observe_param(unit.unit, &[UNIT_SOLO_KEY], 3, &invalidate);
        unit.strip_param_subs.extend(solo_subs);
        unit.strip_param_collections.extend(solo_collections);
        if solo_handle.track.is_some() {
            *unit.strip_automation.solo.borrow_mut() = Some(Rc::new(move |position: f64| {
                let (value, _kind) = solo_handle.resolve(position);
                value
            }));
        } else {
            // No solo curve (never attached, or JUST DETACHED): `resolve_automated_solo` writes the curve value into
            // the static solo cell, so on detach restore it from the FIELD and re-resolve `forced_silent` if it moved
            // (the field subscription only fires on a field EDIT, not on a track detach, so it would stay stale).
            let field_solo = solo_handle.field.get() >= 0.5;
            if unit.strip_params.solo.get() != field_solo {
                unit.strip_params.solo.set(field_solo);
                self.solo_dirty.set(true);
            }
        }
    }

    /// The shared gain (dB) + pan (+ optional mute) automation binder behind the strip AND the aux sends: drop the
    /// previous observers + curve collections (a plain drop would LEAK their hub / event / curve observers),
    /// re-observe the fields, and install the mapped closures. Without a track an override stays `None` (static
    /// cells rule). `mute_key` is `Some` only for the unit strip (the aux sends have no mute); its curve carries a
    /// 0..1 unit value the strip thresholds at >= 0.5 (TS `ValueMapping.bool`), and observing it also registers the
    /// UI broadcast at the mute field address so the mute button reflects the automated state.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn bind_gain_pan_automation(&mut self, box_uuid: Uuid, gain_key: u16, pan_key: u16, gain_mapping: Decibel,
                                mute_key: Option<u16>, automation: &StripAutomation, subs: &mut Vec<SubscriptionId>,
                                collections: &mut Vec<ValueCollection>, invalidate: &Rc<dyn Fn()>) {
        const PAN: Linear = Linear::bipolar();
        *automation.volume.borrow_mut() = None;
        *automation.panning.borrow_mut() = None;
        *automation.mute.borrow_mut() = None;
        for sub in core::mem::take(subs) {
            self.graph.unsubscribe(sub);
        }
        for collection in core::mem::take(collections) {
            collection.terminate(&mut self.graph);
        }
        let (gain_handle, gain_subs, gain_collections, _) = self.observe_param(box_uuid, &[gain_key], 0, invalidate);
        let (pan_handle, pan_subs, pan_collections, _) = self.observe_param(box_uuid, &[pan_key], 1, invalidate);
        subs.extend(gain_subs);
        subs.extend(pan_subs);
        collections.extend(gain_collections);
        collections.extend(pan_collections);
        // `resolve` hands back a UNIT value while the curve covers the position, else the FIELD's stored
        // value with its own kind (already real dB / bipolar pan) — map only the unit case.
        if gain_handle.track.is_some() {
            *automation.volume.borrow_mut() = Some(Rc::new(move |position: f64| {
                let (value, kind) = gain_handle.resolve(position);
                if kind == abi::PARAM_KIND_UNIT { gain_mapping.y(value) } else { value }
            }));
        }
        if pan_handle.track.is_some() {
            *automation.panning.borrow_mut() = Some(Rc::new(move |position: f64| {
                let (value, kind) = pan_handle.resolve(position);
                if kind == abi::PARAM_KIND_UNIT { PAN.y(value) } else { value }
            }));
        }
        if let Some(mute_key) = mute_key {
            let (mute_handle, mute_subs, mute_collections, _) = self.observe_param(box_uuid, &[mute_key], 2, invalidate);
            subs.extend(mute_subs);
            collections.extend(mute_collections);
            // The mute field stores a bool as 0.0/1.0, so the unit-curve value and the field-fallback value are BOTH
            // thresholded at >= 0.5 by the strip — hand back `resolve`'s raw value in either case.
            if mute_handle.track.is_some() {
                *automation.mute.borrow_mut() = Some(Rc::new(move |position: f64| {
                    let (value, _kind) = mute_handle.resolve(position);
                    value
                }));
            }
        }
    }

    /// Bind one device's parameters: call its `init` (which records its parameter field-paths via
    /// `host_bind_parameter`), observe each path's field value + automation track, hand the node its
    /// parameter set, and return the bookkeeping for teardown / re-bind.
    pub(crate) fn bind_device(&mut self, device_uuid: Uuid, reg: DeviceReg, state_ptr: u32, sink: ParamNode, invalidate: &Rc<dyn Fn()>) -> DeviceParams {
        // Make the device's own box uuid available to `host_self_uuid` for the duration of its `init` (a script
        // device reads it there to key its JS-side bridge); the engine knows it, the device does not.
        unsafe { *CURRENT_DEVICE_UUID.get() = device_uuid; }
        let paths = bind_paths(reg, state_ptr, self.sample_rate);
        let sample_paths = core::mem::take(unsafe { SAMPLE_OBS.get() }); // recorded by host_observe_sample during init
        let soundfont_paths = core::mem::take(unsafe { SOUNDFONT_OBS.get() }); // recorded by host_observe_soundfont during init
        let field_paths = core::mem::take(unsafe { FIELD_OBS.get() }); // recorded by host_observe_field during init
        let sidechain_paths = core::mem::take(unsafe { SIDECHAIN_BIND.get() }); // recorded by host_bind_sidechain during init
        // The device's LIVE-DATA broadcast binds (`host_bind_broadcast` during init): create each slot, register
        // it at the device address + declared path (TS `broadcaster.broadcastFloats(adapter.address.append(...))`),
        // and publish the write ptr through the registry so the device's `host_broadcast_ptr` resolves it.
        let broadcast_binds = core::mem::take(unsafe { BROADCAST_BINDS.get() });
        let mut broadcast_slots: Vec<(u32, engine_env::telemetry::BroadcastSlot)> = Vec::with_capacity(broadcast_binds.len());
        for (id, path, len, package_type) in broadcast_binds {
            let slot = engine_env::telemetry::broadcast_slot(len as usize);
            // Honor the type the device DECLARED (via `bind_broadcast` / `bind_broadcast_float` /
            // `bind_broadcast_ints`), not a length heuristic: a one-element FLOAT_ARRAY (the Maximizer's
            // reduction, read with `subscribeFloats`) must NOT collapse to a scalar FLOAT.
            let package_type = match package_type {
                crate::broadcast::PACKAGE_INT_RING => crate::broadcast::PACKAGE_INT_RING,
                crate::broadcast::PACKAGE_FLOAT => crate::broadcast::PACKAGE_FLOAT,
                _ => crate::broadcast::PACKAGE_FLOAT_ARRAY
            };
            self.broadcasts.register(device_uuid, &path, package_type, &slot);
            let ptr = slot.borrow().as_ptr() as u32;
            if let Some(entry) = unsafe { DEVICE_BROADCASTS.get() }.get_mut(id as usize) {
                *entry = (ptr, false);
            }
            broadcast_slots.push((id, slot));
        }
        let (mut handles, mut field_subs, mut collections, mut armed) = self.observe_params(device_uuid, &paths, invalidate);
        // The device's plain-field, sample and soundfont observations all unsubscribe the same way, so one list.
        let (mut observe_subs, pointer_field_subs) = self.observe_fields(device_uuid, reg, state_ptr, &field_paths);
        observe_subs.extend(self.observe_samples(device_uuid, reg, state_ptr, &sample_paths));
        observe_subs.extend(self.observe_soundfonts(device_uuid, reg, state_ptr, &soundfont_paths));
        // SCRIPTABLE devices: also bind the dynamic parameter / sample COLLECTION children, and watch each hub's
        // membership so a child add / remove re-binds (through the same automation-invalidate path).
        let mut param_hub_sub = None;
        if reg.param_collection_field != 0 {
            let (mut script_handles, mut script_subs, mut script_collections, script_armed) =
                self.observe_script_params(device_uuid, reg.param_collection_field, invalidate);
            handles.append(&mut script_handles);
            field_subs.append(&mut script_subs);
            collections.append(&mut script_collections);
            armed |= script_armed;
            let hub_invalidate = invalidate.clone();
            param_hub_sub = Some(self.graph.subscribe_pointer_hub(Address::of(device_uuid, vec![reg.param_collection_field]),
                Box::new(move |_graph, _event| hub_invalidate())));
        }
        let mut sample_hub_sub = None;
        if reg.sample_collection_field != 0 {
            observe_subs.extend(self.observe_script_samples(device_uuid, reg, state_ptr, reg.sample_collection_field));
            let hub_invalidate = invalidate.clone();
            sample_hub_sub = Some(self.graph.subscribe_pointer_hub(Address::of(device_uuid, vec![reg.sample_collection_field]),
                Box::new(move |_graph, _event| hub_invalidate())));
        }
        sink.set_params(handles.clone(), armed);
        DeviceParams {device_uuid, reg, state_ptr, sink, paths, handles, field_subs, collections, observe_subs, pointer_field_subs, sidechain_paths, param_hub_sub, sample_hub_sub, broadcast_slots}
    }

    /// Wire each field a device asked to observe. A PLAIN observation (`observe_field`, `target_key == 0`):
    /// `catchup_and_subscribe` the field on the device's box and deliver its value through the device's
    /// `field_changed` export, by the id (the observation's index) the device got back. A plain path whose
    /// HEAD is a POINTER field (e.g. Zeitgeist's `groove` at `[10, 10]`) crosses the pointer: the REMAINING
    /// path is observed on the pointer's TARGET box, and the pointer itself is watched so a repoint / clear
    /// re-resolves (delivering the new target's value; unbound = no delivery, the device keeps its previous /
    /// seeded value). A TARGET-STRING observation (`observe_target_string`): catch up to the POINTER's current
    /// target and subscribe to the pointer field, delivering the target box's string field `target_key`
    /// (empty = unbound) — the `observe_soundfonts` shape with the payload read straight from the graph. All
    /// run on catch-up and on edits, only inside a transaction, never during render, so calling the device is
    /// safe. Returns the fixed subscriptions plus the pointer-crossing observations' swappable target-field
    /// subscription cells, both for teardown.
    pub(crate) fn observe_fields(&mut self, device_uuid: Uuid, reg: DeviceReg, state_ptr: u32, paths: &[FieldObs]) -> (Vec<SubscriptionId>, Vec<Rc<Cell<Option<SubscriptionId>>>>) {
        let mut subs = Vec::new();
        let mut pointer_subs = Vec::new();
        for (index, obs) in paths.iter().enumerate() {
            let id = index as u32;
            let field_changed_index = reg.field_changed_index;
            if obs.target_key != 0 {
                let target_key = obs.target_key;
                resolve_and_deliver_target_string(&self.graph, device_uuid, &obs.path, target_key, field_changed_index, state_ptr, id);
                let owned_path = obs.path.clone();
                let sub = self.graph.subscribe_vertex(Propagation::This, Address::of(device_uuid, obs.path.clone()),
                    Box::new(move |graph, _update| {
                        resolve_and_deliver_target_string(graph, device_uuid, &owned_path, target_key, field_changed_index, state_ptr, id);
                    }));
                subs.push(sub);
            } else if obs.path.len() > 1
                && matches!(self.graph.field_value(&Address::of(device_uuid, vec![obs.path[0]])), Some(FieldValue::Pointer(_))) {
                // The pointer-crossing shape: `resubscribe` resolves the pointer, delivers the target field's
                // current value (catch-up) and hangs the target-field subscription into the shared cell.
                // Run once now, and again from the pointer watcher on every repoint / clear — the watcher only
                // holds `&BoxGraph`, so the swap goes through the graph's DEFERRED subscription queue.
                let pointer = Address::of(device_uuid, vec![obs.path[0]]);
                let rest: Rc<Vec<u16>> = Rc::new(obs.path[1..].to_vec());
                let target_sub: Rc<Cell<Option<SubscriptionId>>> = Rc::new(Cell::new(None));
                let resubscribe: Rc<dyn Fn(&BoxGraph)> = {
                    let deferred = self.graph.deferred();
                    let pointer = pointer.clone();
                    let holder = target_sub.clone();
                    Rc::new(move |graph| {
                        if let Some(previous) = holder.take() {
                            deferred.unsubscribe(previous);
                        }
                        if let Some(target) = graph.target_of(&pointer).map(|address| address.uuid) {
                            let field = Address::of(target, rest.as_ref().clone());
                            if let Some(value) = graph.field_value(&field) {
                                deliver_field_value(value, field_changed_index, state_ptr, id);
                            }
                            holder.set(Some(deferred.subscribe_vertex(Propagation::This, field,
                                pointer_target_field_observer(pointer.clone(), target, field_changed_index, state_ptr, id))));
                        }
                    })
                };
                resubscribe(&self.graph);
                let on_repoint = resubscribe.clone();
                subs.push(self.graph.subscribe_vertex(Propagation::This, pointer,
                    Box::new(move |graph, _update| on_repoint(graph))));
                pointer_subs.push(target_sub);
            } else {
                let sub = self.graph.catchup_and_subscribe(Address::of(device_uuid, obs.path.clone()), move |value| {
                    deliver_field_value(value, field_changed_index, state_ptr, id);
                });
                subs.push(sub);
            }
        }
        // Register the pointer-crossing catch-ups' queued target-field subscriptions (we hold `&mut`, so the
        // deferred queue would otherwise sit until the next transaction).
        self.graph.apply_deferred();
        (subs, pointer_subs)
    }

    /// Wire each sample a device asked to observe (`observe_sample`): catch up to the `file` pointer's current
    /// target and subscribe to that pointer field, so a set / repoint / clear (inside a transaction, never
    /// during render) re-resolves and re-delivers through the device's `sample_changed` export. Returns the
    /// subscriptions for teardown.
    pub(crate) fn observe_samples(&mut self, device_uuid: Uuid, reg: DeviceReg, state_ptr: u32, paths: &[Vec<u16>]) -> Vec<SubscriptionId> {
        let mut subs = Vec::new();
        for (index, path) in paths.iter().enumerate() {
            let id = index as u32;
            let sample_changed_index = reg.sample_changed_index;
            resolve_and_deliver_sample(&self.graph, device_uuid, path, sample_changed_index, state_ptr, id);
            let owned_path = path.clone();
            let sub = self.graph.subscribe_vertex(Propagation::This, Address::of(device_uuid, path.clone()),
                Box::new(move |graph, _update| {
                    resolve_and_deliver_sample(graph, device_uuid, &owned_path, sample_changed_index, state_ptr, id);
                }));
            subs.push(sub);
        }
        subs
    }

    /// Wire each soundfont a device asked to observe (`observe_soundfont`): catch up to the `file` pointer's
    /// current target and subscribe to that pointer field, so a set / repoint / clear (inside a transaction,
    /// never during render) re-resolves and re-delivers through the device's `soundfont_changed` export.
    /// Mirrors `observe_samples`.
    pub(crate) fn observe_soundfonts(&mut self, device_uuid: Uuid, reg: DeviceReg, state_ptr: u32, paths: &[Vec<u16>]) -> Vec<SubscriptionId> {
        let mut subs = Vec::new();
        for (index, path) in paths.iter().enumerate() {
            let id = index as u32;
            let soundfont_changed_index = reg.soundfont_changed_index;
            resolve_and_deliver_soundfont(&self.graph, device_uuid, path, soundfont_changed_index, state_ptr, id);
            let owned_path = path.clone();
            let sub = self.graph.subscribe_vertex(Propagation::This, Address::of(device_uuid, path.clone()),
                Box::new(move |graph, _update| {
                    resolve_and_deliver_soundfont(graph, device_uuid, &owned_path, soundfont_changed_index, state_ptr, id);
                }));
            subs.push(sub);
        }
        subs
    }

    /// Observe each parameter field's value (a reactive `Rc<Cell>`) and its automation track, returning the
    /// per-parameter handles, the field subscriptions + curve collections (for teardown), and whether ANY
    /// parameter is automated (so the node arms the clock). The id is the parameter's index, matching the
    /// id `host_bind_parameter` returned the device.
    pub(crate) fn observe_params(&mut self, device_uuid: Uuid, paths: &[FieldPath], invalidate: &Rc<dyn Fn()>) -> (Vec<ParamHandle>, Vec<SubscriptionId>, Vec<ValueCollection>, bool) {
        let mut handles = Vec::new();
        let mut subs = Vec::new();
        let mut collections = Vec::new();
        let mut armed = false;
        for (index, path) in paths.iter().enumerate() {
            let (handle, mut param_subs, mut param_collections, param_armed) =
                self.observe_param(device_uuid, path, index as u32, invalidate);
            handles.push(handle);
            subs.append(&mut param_subs);
            collections.append(&mut param_collections);
            armed |= param_armed;
        }
        (handles, subs, collections, armed)
    }

    /// Observe ONE parameter field's value (a reactive cell) + its automation track, returning the handle, its
    /// subscriptions, the curve collections, and whether it is automated. Shared by [`observe_params`] (a device's
    /// fixed field paths) and [`observe_script_params`] (a scriptable device's dynamic `WerkstattParameterBox`
    /// children). `id` is what the device receives in `parameter_changed`. The automation track is found by
    /// `build_param_track(graph, box_uuid, path)`, which scans for a Value track targeting `(box_uuid, path)` —
    /// so for a script param the same machinery binds the CHILD box's `value` field (key 4) unchanged.
    pub(crate) fn observe_param(&mut self, box_uuid: Uuid, path: &[u16], id: u32, invalidate: &Rc<dyn Fn()>) -> (ParamHandle, Vec<SubscriptionId>, Vec<ValueCollection>, bool) {
        let mut subs = Vec::new();
        let mut collections = Vec::new();
        let mut armed = false;
        let address = Address::of(box_uuid, path.to_vec());
        // A parameter field carries its real primitive type — Float32 (a cutoff), Int32 (semitones), or Boolean
        // (a toggle), fixed by the schema. Read it once so the wire tags the un-automated value with its kind;
        // the device then receives a typed `ParamValue`. (A script param's `value` is Float32 -> the static value
        // arrives as `PARAM_KIND_FLOAT` for the bridge to use directly; an automated one arrives as `_UNIT`.)
        let kind = self.graph.field_value(&address).map_or(PARAM_KIND_FLOAT, |value| {
            if value.as_int32().is_some() { PARAM_KIND_INT }
            else if value.as_bool().is_some() { PARAM_KIND_BOOL }
            else { PARAM_KIND_FLOAT }
        });
        let field = Rc::new(core::cell::Cell::new(0.0f32));
        let cell = field.clone();
        // A VALUE change is a light edit (push only); everything structural below keeps the heavy signal.
        let field_invalidate = current_params_signal().unwrap_or_else(|| invalidate.clone());
        subs.push(self.graph.catchup_and_subscribe(address.clone(), move |value| {
            let real = value.as_float32()
                .or_else(|| value.as_int32().map(|value| value as f32))
                .or_else(|| value.as_bool().map(|value| if value {1.0} else {0.0}));
            if let Some(real) = real {
                cell.set(real);
                field_invalidate();
            }
        }));
        let attach_invalidate = invalidate.clone();
        subs.push(self.graph.subscribe_pointer_hub(address, Box::new(move |_graph, _event| attach_invalidate())));
        let (track, track_uuid, mut track_collections, rebind_uuids) =
            build_param_track(&mut self.graph, box_uuid, path, &self.clip_sequencer);
        if track.is_some() {
            armed = true;
        }
        if let Some(track_uuid) = track_uuid {
            let region_invalidate = invalidate.clone();
            subs.push(self.graph.subscribe_pointer_hub(Address::of(track_uuid, vec![TRACK_REGIONS_KEY]),
                Box::new(move |_graph, _event| region_invalidate())));
            let clips_invalidate = invalidate.clone();
            subs.push(self.graph.subscribe_pointer_hub(Address::of(track_uuid, vec![TRACK_CLIPS_KEY]),
                Box::new(move |_graph, _event| clips_invalidate())));
            let enabled_invalidate = invalidate.clone();
            subs.push(self.graph.subscribe_vertex(Propagation::This, Address::of(track_uuid, vec![TRACK_ENABLED_KEY]),
                Box::new(move |_graph, _update| enabled_invalidate())));
            // A bound region's / clip's own field edit — a move, a duration change, a MUTE toggle — re-binds
            // the snapshot (the event CURVES stay live via ValueCollection).
            for rebind_uuid in rebind_uuids {
                let rebind_invalidate = invalidate.clone();
                subs.push(self.graph.subscribe_vertex(Propagation::Parent, Address::box_of(rebind_uuid),
                    Box::new(move |_graph, _update| rebind_invalidate())));
            }
        }
        collections.append(&mut track_collections);
        // An automated parameter broadcasts its UNIT value at its FIELD ADDRESS while the track is attached
        // (TS `onStartAutomation`) — the knob animates in the UI. Registered under the box uuid + field-path
        // keys; the slot Rc lives in the handle, so a rebind/teardown drops it and the sweep unregisters.
        let broadcast = track.as_ref().map(|curve| {
            // NO curve value at the transport position (an attach with no region / clip / events yet) publishes
            // NaN, NOT 0.0: the slot carries a UNIT value, so 0.0 is the MINIMUM of every mapping and pinned
            // each knob to min the moment automation was attached. `resolve` only writes this slot while the
            // curve DOES cover the position, so the bogus seed was never overwritten. NaN is the codebase's
            // existing "no value yet" sentinel (see `ParamHandle::last`); the UI reads it as "keep showing the
            // parameter's own storage value" (AutomatableParameterFieldAdapter). Holding the last automated
            // value PAST a region end is unaffected: that path never writes the slot at all.
            let value = curve.value_at(self.transport.position()).unwrap_or(f32::NAN);
            // REUSE the parameter's existing UI slot across a re-observe (an automation edit re-runs this); only a
            // fresh attach registers a new one. Creating a new slot each rebind would be dedup-skipped by
            // `register` (the outgoing slot is still alive), stranding the knob on a slot the sweep then drops.
            // Mirrors TS's persistent `onStartAutomation` broadcast.
            match self.broadcasts.live_slot(box_uuid, path, crate::broadcast::PACKAGE_FLOAT) {
                Some(slot) => {
                    slot.borrow_mut()[0] = value;
                    slot
                }
                None => {
                    let slot = engine_env::telemetry::broadcast_slot(1);
                    slot.borrow_mut()[0] = value;
                    self.broadcasts.register(box_uuid, path, crate::broadcast::PACKAGE_FLOAT, &slot);
                    slot
                }
            }
        });
        let handle = ParamHandle {id, field, kind, track, last: Rc::new(core::cell::Cell::new(f32::NAN)), broadcast};
        (handle, subs, collections, armed)
    }

    /// Push the initial parameter values of freshly built devices (JOINERS) to them. Survivors are NEVER passed
    /// here — a chain edit (reorder / add / remove) must leave every existing plugin's parameters untouched.
    pub(crate) fn refresh_joiner_params(&self, device_params: &[DeviceParams]) {
        let position = self.transport.position();
        for params in device_params {
            refresh_params(&params.handles, params.reg, params.state_ptr, position);
        }
    }

    /// Unsubscribe each device's field observers and terminate its curve collections (a rewire / teardown).
    /// Called ONLY on a genuine device-instance death (a leaver via `terminate_member`, or a wholesale bus
    /// teardown) — never for a chain-edit survivor — so this is also the single place that fires the
    /// device's OWN `terminate` export (releases resources it holds outside its state block, e.g. a bridge's
    /// JS-side instance).
    pub(crate) fn teardown_device_params(&mut self, device_params: Vec<DeviceParams>) {
        for params in device_params {
            call_device_terminate(params.reg.terminate_index, params.state_ptr);
            for sub in params.field_subs {
                self.graph.unsubscribe(sub);
            }
            for sub in params.observe_subs {
                self.graph.unsubscribe(sub);
            }
            for cell in params.pointer_field_subs {
                if let Some(sub) = cell.take() {
                    self.graph.unsubscribe(sub);
                }
            }
            for sub in params.param_hub_sub.into_iter().chain(params.sample_hub_sub) {
                self.graph.unsubscribe(sub);
            }
            for collection in params.collections {
                collection.terminate(&mut self.graph);
            }
            for (id, slot) in params.broadcast_slots {
                if let Some(entry) = unsafe { DEVICE_BROADCASTS.get() }.get_mut(id as usize) {
                    *entry = (0, false);
                }
                unsafe { DEVICE_BROADCAST_FREE.get() }.push(id);
                drop(slot); // the table entry Weak-sweeps on the next reconcile
            }
        }
    }

    /// Re-bind a unit's device automation after a runtime attach / detach / field edit, WITHOUT rewiring the
    /// audio graph: for each device re-observe its parameters (the field-paths it declared are kept), re-set
    /// them on the node (re-arming or disarming the clock), and push the resolved values. Mirrors TS
    /// `bindParameter` reacting to a parameter's automation pointer hub.
    /// Push the units' devices their CURRENT resolved parameter values (only the changed ones — `last` is
    /// compared per handle). The whole handling of a plain field edit: no subscriptions move.
    pub(crate) fn refresh_unit_params(&mut self, unit: &mut AudioUnitBinding) {
        let position = self.transport.position();
        let mut wired = match unit.wired.take() {
            Some(wired) => wired,
            None => return
        };
        match &mut wired {
            Wired::Leaf(chain) => {
                refresh_member(&chain.instrument, position);
                for member in &chain.midi {
                    refresh_member(member, position);
                }
                for member in &chain.audio {
                    refresh_member(member, position);
                }
            }
            Wired::Composite(composite) => {
                composite.binding.for_each_params(&mut |params| refresh_params(&params.handles, params.reg, params.state_ptr, position));
                for member in &composite.audio {
                    refresh_member(member, position);
                }
            }
            Wired::Tape(tape) => {
                for member in &tape.audio {
                    refresh_member(member, position);
                }
            }
            Wired::Bus(bus) => {
                for params in &bus.device_params {
                    refresh_params(&params.handles, params.reg, params.state_ptr, position);
                }
            }
            Wired::Frozen(_) => {} // pre-rendered: no live parameters
            Wired::MidiOut(midi) => {
                // CC value edits reach the node through the observed field cells (diffed per block);
                // only the fx members carry device params to refresh.
                for member in &midi.midi {
                    refresh_member(member, position);
                }
                for member in &midi.audio {
                    refresh_member(member, position);
                }
            }
        }
        unit.wired = Some(wired);
    }

    pub(crate) fn rebind_automation(&mut self, unit: &mut AudioUnitBinding) {
        let invalidate = automation_invalidate(unit);
        let position = self.transport.position();
        let mut wired = match unit.wired.take() {
            Some(wired) => wired,
            None => return
        };
        match &mut wired {
            Wired::Leaf(chain) => {
                self.rebind_member(&mut chain.instrument, &invalidate, position);
                for member in &mut chain.midi {
                    self.rebind_member(member, &invalidate, position);
                }
                for member in &mut chain.audio {
                    self.rebind_member(member, &invalidate, position);
                }
            }
            Wired::Composite(composite) => {
                composite.binding.for_each_params(&mut |params| self.rebind_one(params, &invalidate, position));
                for member in &mut composite.audio {
                    self.rebind_member(member, &invalidate, position);
                }
            }
            Wired::Tape(tape) => {
                for member in &mut tape.audio {
                    self.rebind_member(member, &invalidate, position);
                }
            }
            Wired::Bus(_) => {} // a bus's fx params are bound at (wholesale) build; live automation re-bind deferred
            Wired::Frozen(_) => {} // pre-rendered: no live parameters
            Wired::MidiOut(midi) => {
                for member in &mut midi.midi {
                    self.rebind_member(member, &invalidate, position);
                }
                for member in &mut midi.audio {
                    self.rebind_member(member, &invalidate, position);
                }
                // CC automation attach / detach / curve edit: re-observe the parameter bindings in place,
                // carrying each survivor's last emitted value (no spurious CC re-emission).
                let previous = midi.node.borrow().cc_snapshot();
                for sub in core::mem::take(&mut midi.cc_subs) {
                    self.graph.unsubscribe(sub);
                }
                for collection in core::mem::take(&mut midi.cc_collections) {
                    collection.terminate(&mut self.graph);
                }
                let cc = self.build_midi_out_cc(midi.instrument_uuid, &invalidate, &previous, &mut midi.cc_subs, &mut midi.cc_collections);
                midi.node.borrow_mut().set_cc(cc);
            }
        }
        unit.wired = Some(wired);
    }

    /// Re-observe ONE chain member's automation. A member that is not a plugin (an effect composite) has no
    /// device params of its own — but its ENTRIES hold real plugins, so the re-bind recurses into its binding.
    /// Every per-member re-bind goes through here, so a composite anywhere in a chain is never skipped.
    pub(crate) fn rebind_member(&mut self, member: &mut Member, invalidate: &Rc<dyn Fn()>, position: f64) {
        if let Some(params) = &mut member.params {
            self.rebind_one(params, invalidate, position);
        }
        // Its entries' devices re-bind exactly like a leaf chain's, one level down. `binding` borrows
        // `member`, never `self`, so the visitor may take `self` (the composite unit does the same).
        if let ProcHandle::EffectComposite(binding) = &mut member.proc {
            binding.for_each_params(&mut |params| self.rebind_one(params, invalidate, position));
            // The composite's OWN parameters (dry / wet, and each entry's gain / mute / solo) are not device
            // params, so the visitor above never reaches them — re-observe them here.
            self.rebind_effect_composite_params(binding, invalidate);
        }
    }

    /// Re-observe ONE device's automation in place: drop the old field subscriptions + curve collections,
    /// re-observe the (unchanged) parameter field-paths, re-set the params on the node (re-arm / disarm the
    /// clock), and push the resolved values. Touches neither the audio graph nor the plain-field / sidechain
    /// observations.
    pub(crate) fn rebind_one(&mut self, params: &mut DeviceParams, invalidate: &Rc<dyn Fn()>, position: f64) {
        // Preserve each parameter's last-pushed value across the re-observe (the paths are unchanged, so the new
        // handles line up by index). Fresh handles start at `last = NaN`, which would re-push EVERY parameter;
        // carrying `last` over means `refresh_params` only pushes the ones whose value actually changed — so a
        // parameter (or whole plugin) unaffected by this automation edit is never re-pushed (and never glides).
        let previous_last: Vec<f32> = params.handles.iter().map(|handle| handle.last.get()).collect();
        for sub in core::mem::take(&mut params.field_subs) {
            self.graph.unsubscribe(sub);
        }
        for collection in core::mem::take(&mut params.collections) {
            collection.terminate(&mut self.graph);
        }
        let (mut handles, mut field_subs, mut collections, mut armed) = self.observe_params(params.device_uuid, &params.paths, invalidate);
        // Re-enumerate a scriptable device's dynamic params too (an add / remove / automation edit re-binds them).
        if params.reg.param_collection_field != 0 {
            let (mut script_handles, mut script_subs, mut script_collections, script_armed) =
                self.observe_script_params(params.device_uuid, params.reg.param_collection_field, invalidate);
            handles.append(&mut script_handles);
            field_subs.append(&mut script_subs);
            collections.append(&mut script_collections);
            armed |= script_armed;
        }
        for (handle, last) in handles.iter().zip(previous_last) {
            handle.last.set(last);
        }
        params.sink.set_params(handles.clone(), armed);
        refresh_params(&handles, params.reg, params.state_ptr, position);
        params.handles = handles;
        params.field_subs = field_subs;
        params.collections = collections;
    }

    /// Inject a live note signal into the unit identified by its `AudioUnitBox` uuid. Called OFF-render
    /// (between quanta); the note starts / releases at the next block, playing or stopped.
    pub(crate) fn note_signal(&self, unit: Uuid, signal: NoteSignal) {
        if let Some(binding) = self.audio_units.iter().find(|binding| binding.unit == unit) {
            note_signal_to_unit(binding, signal);
        }
    }
}
