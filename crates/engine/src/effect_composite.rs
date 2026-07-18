//! EFFECT composites: an audio effect that, instead of being a single leaf DSP, hosts a collection of ENTRIES
//! run in PARALLEL and mixed back together (an FX stack; a split container is the same thing with a different
//! input distributor). Like `composite.rs` this is the GENERIC engine-side mechanism — it learns a composite
//! only as a registered `EffectCompositeSpec` (entry collection + the entry box's field keys); no box name or
//! field key is hardcoded.
//!
//! ```text
//!   upstream -> Distributor -> branch -> [entry fx chain] -> entry strip (gain/mute/solo) -\
//!                    |                                                                      +-> wet sum -\
//!                    |                                                                                    +-> DryWetMix -> downstream
//!                    \--------------------------------- input TAP (dry) --------------------------------/
//! ```
//!
//! The composite sits in an audio chain as ONE `Member` (its `input_node` is the distributor, its `node_id`
//! the mix), so the chain wiring, the disabled-device bypass and the pooled survive-on-reconcile all apply to
//! it with no special case. An entry's chain is built from the SAME `Member` machinery as any chain, so a
//! composite nests inside an entry with no extra code.
//!
//! Reuse is deliberate: an entry's gain / pan / mute / solo strip is a plain `ChannelStripProcessor` (volume =
//! the entry's gain, panning = its pan, `forced_silent` = the cross-entry solo gate) and the wet sum is a plain
//! `AudioBusProcessor`. Only the distributor and the dry/wet mix are new (`engine_env::composite_mix`).

use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::rc::Rc;
use alloc::vec;
use alloc::vec::Vec;
use core::cell::{Cell, RefCell};
use abi::DEVICE_KIND_AUDIO_EFFECT;
use bindings::indexed_collection::IndexedCollection;
use boxgraph::address::{Address, Uuid};
use boxgraph::subscription::SubscriptionId;
use engine_env::audio_buffer::SharedAudioBuffer;
use engine_env::audio_bus_processor::AudioBusProcessor;
use engine_env::audio_generator::AudioGenerator;
use engine_env::audio_input::AudioInput;
use engine_env::channel_strip::{ChannelStripProcessor, StripAutomation, StripParams};
use engine_env::composite_mix::{DistributorMode, DistributorProcessor, DryWetMixProcessor, DryWetParams};
use engine_env::engine_context::NodeId;
use bindings::value_collection::ValueCollection;
use math::value_mapping::{Decibel, ValueMapping};
use crate::audio_unit::{DeviceParams, Member, ProcHandle, SidechainBinding};
use crate::{Distributor, EffectCompositeSpec, Engine, EFFECT_INDEX_KEY};

/// The gain mapping an entry's `gain` / a composite's `dry` / `wet` automation curve resolves through: the
/// TS `ValueMapping.DefaultDecibel` the adapters create those parameters with.
// WASM CONTRACT: mirrors `ValueMapping.DefaultDecibel` (lib-std) as used by the composite adapters.
const GAIN: Decibel = Decibel::default_volume();

/// The pan mapping an entry's `pan` automation curve resolves through: bipolar, matching the channel strip's
/// own pan (the entry adapter creates `pan` with `ValueMapping.bipolar`).
const PAN: math::value_mapping::Linear = math::value_mapping::Linear::bipolar();

/// One persistent ENTRY of an effect composite: its own fx chain (pooled + reconciled like any chain, so a
/// survivor keeps its DSP state) feeding its gain / mute / solo strip into the composite's wet sum.
pub(crate) struct CompositeEntry {
    uuid: Uuid,
    chain: IndexedCollection,          // the entry's fx-host collection (spec.chain_field)
    audio: Vec<Member>,                // the entry's chain members, in index order
    strip: Rc<RefCell<ChannelStripProcessor>>,
    strip_id: NodeId,
    strip_params: Rc<StripParams>,
    strip_automation: Rc<StripAutomation>,
    strip_output: SharedAudioBuffer,
    param_subs: Vec<SubscriptionId>,
    param_collections: Vec<ValueCollection>,
    // TARGETED `This` monitors on the entry's OWN gain / mute / solo fields, created once at build. An edit
    // re-wires the owning unit's chain, so the reconcile re-reads the static values and re-resolves solo
    // across the siblings (mirrors the child composite's `subscribe_child_enabled`). Without these a mute is
    // never seen: it changes no collection and raises no `wiring_dirty` of its own.
    field_subs: Vec<SubscriptionId>,
    edges: Vec<(NodeId, NodeId)>,      // the entry's internal edges (distributor -> fx... -> strip -> wet sum)
    summed: bool,                      // whether `strip_output` is currently a source of the wet sum
    effects_dirty: Rc<Cell<bool>>,     // set by a member `enabled` toggle -> re-wire THIS entry
    wired_index: usize                 // the distributor branch this entry is currently wired to
}

/// An effect composite's PERSISTENT cascade, owned by the chain member it is. Its nodes (`distributor` /
/// `wet_sum` / `mix`) persist across entry edits, so the chain around it is never disturbed: an entry add /
/// remove / reorder builds only the joiner, tears down only the leaver, and keeps every survivor's DSP state.
pub(crate) struct EffectCompositeBinding {
    spec: EffectCompositeSpec,
    composite_uuid: Uuid,
    entries: IndexedCollection,
    distributor: Rc<RefCell<DistributorProcessor>>,
    pub(crate) distributor_id: NodeId,  // the chain's ENTRY node (the member's `input_node`)
    wet_sum: Rc<RefCell<AudioBusProcessor>>,
    wet_sum_id: NodeId,
    pub(crate) mix_id: NodeId,          // the chain's EXIT node (the member's `node_id`)
    pub(crate) mix_output: SharedAudioBuffer,
    dry_wet: Rc<DryWetParams>,
    dry_wet_automation: Rc<StripAutomation>,
    dry_wet_subs: Vec<SubscriptionId>,
    dry_wet_collections: Vec<ValueCollection>,
    // LIVE field subscriptions writing `dry` / `wet` straight into the shared cells the mix node reads each
    // block — the channel strip's own pattern ("reactive but no rewire needed"). Reading the fields once at
    // bind time left the knobs dead: the mix kept its build-time values for the composite's whole life.
    dry_wet_field_subs: Vec<SubscriptionId>,
    members: Vec<CompositeEntry>,
    tail_edges: Vec<(NodeId, NodeId)>   // distributor -> mix (the dry path) and wet_sum -> mix
}

impl EffectCompositeBinding {
    /// Hand the composite its upstream signal: the DISTRIBUTOR takes it (it owns the copy every entry and the
    /// dry path read). Called by the chain wiring exactly where a plugin member gets `set_audio_source`.
    pub(crate) fn set_audio_source(&self, source: SharedAudioBuffer) {
        self.distributor.borrow_mut().set_audio_source(source);
    }

    /// Visit every bound parameter in this composite's entries (recursing into nested composites), so the unit
    /// can re-bind automation across the whole cascade.
    pub(crate) fn for_each_params(&mut self, visit: &mut dyn FnMut(&mut DeviceParams)) {
        for entry in &mut self.members {
            for member in &mut entry.audio {
                if let Some(params) = &mut member.params { visit(params); }
                if let ProcHandle::EffectComposite(nested) = &mut member.proc {
                    nested.for_each_params(visit);
                }
            }
        }
    }

    /// Visit every sidechain binding in this composite's entries (recursing into nested composites), so the
    /// unit can re-resolve sidechains across the whole cascade.
    pub(crate) fn for_each_sidechain(&mut self, visit: &mut dyn FnMut(&mut SidechainBinding)) {
        for entry in &mut self.members {
            for member in &mut entry.audio {
                if let Some(binding) = &mut member.sidechain { visit(binding); }
                if let ProcHandle::EffectComposite(nested) = &mut member.proc {
                    nested.for_each_sidechain(visit);
                }
            }
        }
    }

    /// Push every NESTED device's parameter values (the clock refresh / a joiner push must reach inside a
    /// composite too — its entries hold real plugins, whose automation resolves like any other's).
    pub(crate) fn refresh_params_at(&self, position: f64) {
        for entry in &self.members {
            for member in &entry.audio {
                crate::audio_unit::params::refresh_member(member, position);
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn entry_count(&self) -> usize {
        self.members.len()
    }

    /// The dry / wet values the MIX NODE actually reads each block (not the box fields).
    #[cfg(test)]
    pub(crate) fn dry_db(&self) -> f32 {
        self.dry_wet.dry_db.get()
    }

    #[cfg(test)]
    pub(crate) fn wet_db(&self) -> f32 {
        self.dry_wet.wet_db.get()
    }

    /// Whether the MIX NODE has an automation curve installed for dry / wet (not merely a track in the box).
    #[cfg(test)]
    pub(crate) fn dry_automated(&self) -> bool {
        self.dry_wet_automation.volume.borrow().is_some()
    }

    #[cfg(test)]
    pub(crate) fn wet_automated(&self) -> bool {
        self.dry_wet_automation.panning.borrow().is_some()
    }

    /// The gain an entry's STRIP actually reads each block.
    #[cfg(test)]
    pub(crate) fn entry_gain_db(&self, uuid: Uuid) -> Option<f32> {
        self.members.iter().find(|entry| entry.uuid == uuid)
            .map(|entry| entry.strip_params.volume_db.get())
    }

    /// The pan an entry's STRIP actually reads each block.
    #[cfg(test)]
    pub(crate) fn entry_pan(&self, uuid: Uuid) -> Option<f32> {
        self.members.iter().find(|entry| entry.uuid == uuid)
            .map(|entry| entry.strip_params.panning.get())
    }

    #[cfg(test)]
    pub(crate) fn entry_chain_len(&self, uuid: Uuid) -> Option<usize> {
        self.members.iter().find(|entry| entry.uuid == uuid).map(|entry| entry.audio.len())
    }

    #[cfg(test)]
    pub(crate) fn entry_wired_count(&self, uuid: Uuid) -> Option<usize> {
        self.members.iter().find(|entry| entry.uuid == uuid).map(|entry| entry.edges.len())
    }

    /// The distributor branch this entry is currently wired to — for a positional distributor this IS its channel.
    #[cfg(test)]
    pub(crate) fn entry_branch(&self, uuid: Uuid) -> Option<usize> {
        self.members.iter().find(|entry| entry.uuid == uuid).map(|entry| entry.wired_index)
    }

    /// The composite nested at `nested_uuid` inside entry `entry_uuid`'s chain — for tests / introspection.
    #[cfg(test)]
    pub(crate) fn nested_composite(&self, entry_uuid: Uuid, nested_uuid: Uuid) -> Option<&EffectCompositeBinding> {
        self.members.iter().find(|entry| entry.uuid == entry_uuid)?
            .audio.iter().find(|member| member.uuid == nested_uuid)
            .and_then(|member| match &member.proc {
                ProcHandle::EffectComposite(binding) => Some(&**binding),
                _ => None
            })
    }

    #[cfg(test)]
    pub(crate) fn entry_silent(&self, uuid: Uuid) -> Option<bool> {
        self.members.iter().find(|entry| entry.uuid == uuid)
            .map(|entry| entry.strip_params.forced_silent.get() || entry.strip_params.mute.get())
    }
}

/// One entry's reconcile-time facts, read once per pass: whether it is SILENT (muted, or not soloed while a
/// sibling is). Solo is a CROSS-entry fact, exactly like the mixer's, so it is resolved over the whole set.
struct EntryInfo {
    uuid: Uuid,
    silent: bool
}

impl Engine {
    /// Read every entry's mute / solo once and resolve the cross-entry silent state: `mute || (anySolo &&
    /// !solo)`, mirroring the mixer's solo rule and the child-composite's `child_infos`.
    fn entry_infos(&self, uuids: &[Uuid], spec: &EffectCompositeSpec) -> Vec<EntryInfo> {
        let flag = |uuid: &Uuid, key: u16| key != 0
            && self.graph.field_value(&Address::of(*uuid, vec![key])).and_then(|value| value.as_bool()).unwrap_or(false);
        let has_solo = spec.solo_key != 0 && uuids.iter().any(|uuid| flag(uuid, spec.solo_key));
        uuids.iter().map(|&uuid| EntryInfo {
            uuid,
            silent: flag(&uuid, spec.mute_key) || (has_solo && !flag(&uuid, spec.solo_key))
        }).collect()
    }

    /// Build an effect composite: observe its entry collection, create its three own nodes (distributor / wet
    /// sum / dry-wet mix), bind its dry + wet, then build one persistent entry per member. Returns the binding
    /// the chain member holds. Generic over any registered effect composite — the only specific input is `spec`.
    pub(crate) fn build_effect_composite(&mut self, composite_uuid: Uuid, spec: &EffectCompositeSpec,
                                         signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>,
                                         rewire: &Rc<dyn Fn()>) -> EffectCompositeBinding {
        let entries = IndexedCollection::observe(&mut self.graph,
            Address::of(composite_uuid, vec![spec.entries_field]), spec.index_key);
        entries.take_dirty();
        // An entry add / remove / reorder is a chain RE-WIRE from the owning unit's point of view: `rewire`
        // sets its `wiring_dirty`, so the unit's reconcile re-runs its chain and reaches this composite's
        // `subtree_dirty` check. A plain `signal` would only enqueue the unit, whose own collections are
        // unchanged — and the edit would never reach the composite.
        entries.set_on_dirty(rewire.clone());
        let mode = match spec.distributor {
            Distributor::Broadcast => DistributorMode::Broadcast,
            Distributor::Stereo => DistributorMode::Stereo
        };
        let distributor = Rc::new(RefCell::new(DistributorProcessor::new(mode)));
        let tap = distributor.borrow().tap();
        let distributor_id = self.context.register_processor(distributor.clone());
        self.context.set_label(distributor_id, alloc::string::String::from("composite-distributor"));
        let wet_sum = Rc::new(RefCell::new(AudioBusProcessor::new(engine_env::audio_buffer::shared_audio_buffer())));
        let wet_buffer = wet_sum.borrow().audio_output();
        let wet_sum_id = self.context.register_processor(wet_sum.clone());
        self.context.set_label(wet_sum_id, alloc::string::String::from("composite-wet-sum"));
        let dry_wet = Rc::new(DryWetParams::new());
        let dry_wet_automation = Rc::new(StripAutomation::new());
        let mix = Rc::new(RefCell::new(DryWetMixProcessor::new(dry_wet.clone(), dry_wet_automation.clone(),
            tap.clone(), wet_buffer, self.sample_rate)));
        let mix_output = mix.borrow().audio_output();
        let mix_id = self.context.register_processor(mix.clone());
        self.context.set_label(mix_id, alloc::string::String::from("composite-mix"));
        // Live telemetry: the composite's OUTPUT peaks, under its own box uuid — the same registration every
        // plugin effect makes (`take_or_build_audio`), which is what its device peak meter reads. Without it
        // the composite's meter has no package to subscribe to and simply never moves.
        let meter_slot = mix.borrow().meter_slot();
        self.broadcasts.register(composite_uuid, &[], crate::broadcast::PACKAGE_FLOAT_ARRAY, &meter_slot);
        // The dry path and the wet sum both feed the mix; ordering edges only (the mix reads the buffers).
        self.context.register_edge(distributor_id, mix_id);
        self.context.register_edge(wet_sum_id, mix_id);
        let tail_edges = vec![(distributor_id, mix_id), (wet_sum_id, mix_id)];
        // The composite's INPUT TAP: the address a device NESTED in this composite points its sidechain at to
        // detect the signal entering the composite. The distributor owns this buffer, so the tap survives
        // replacing the plugin upstream (only the distributor's source is re-pointed).
        if spec.input_tap_field != 0 {
            self.output_registry.register(Address::of(composite_uuid, vec![spec.input_tap_field]),
                tap, distributor_id);
        }
        // The composite's OUTPUT under its own box uuid, so a sidechain targeting the composite DEVICE taps its
        // mixed result (mirroring every device registering `adapter.address -> output`).
        self.output_registry.register(Address::of(composite_uuid, vec![]), mix_output.clone(), mix_id);
        let mut binding = EffectCompositeBinding {
            spec: spec.clone(), composite_uuid, entries, distributor, distributor_id, wet_sum, wet_sum_id,
            mix_id, mix_output, dry_wet, dry_wet_automation, dry_wet_subs: Vec::new(),
            dry_wet_collections: Vec::new(), dry_wet_field_subs: Vec::new(), members: Vec::new(), tail_edges
        };
        binding.dry_wet_field_subs = self.subscribe_dry_wet(&binding);
        self.bind_dry_wet(&mut binding, invalidate);
        self.reconcile_effect_composite(&mut binding, signal, invalidate, rewire);
        binding
    }

    /// Keep the composite's `dry` / `wet` CELLS in sync with their box fields, live. The mix node reads the
    /// cells each block, so a knob drag needs no reconcile and no re-wire — exactly how the channel strip
    /// syncs its volume / panning / mute.
    fn subscribe_dry_wet(&mut self, binding: &EffectCompositeBinding) -> Vec<SubscriptionId> {
        let mut subs = Vec::new();
        if binding.spec.dry_key != 0 {
            let params = binding.dry_wet.clone();
            subs.push(self.graph.catchup_and_subscribe(
                Address::of(binding.composite_uuid, vec![binding.spec.dry_key]), move |value| {
                    if let Some(value) = value.as_float32() { params.dry_db.set(value) }
                }));
        }
        if binding.spec.wet_key != 0 {
            let params = binding.dry_wet.clone();
            subs.push(self.graph.catchup_and_subscribe(
                Address::of(binding.composite_uuid, vec![binding.spec.wet_key]), move |value| {
                    if let Some(value) = value.as_float32() { params.wet_db.set(value) }
                }));
        }
        subs
    }

    /// Bind the composite's `dry` (12) + `wet` (13) to their static fields AND their automation, so a Value
    /// track targeting them drives the mix over the transport. Mirrors `bind_gain_pan_automation`, but a
    /// composite has no pan: the shared `StripAutomation` carries dry in `volume` and wet in `panning`.
    /// Re-observed on an automation change; a field with no track leaves its override `None` (static rules).
    fn bind_dry_wet(&mut self, binding: &mut EffectCompositeBinding, invalidate: &Rc<dyn Fn()>) {
        *binding.dry_wet_automation.volume.borrow_mut() = None;
        *binding.dry_wet_automation.panning.borrow_mut() = None;
        for sub in core::mem::take(&mut binding.dry_wet_subs) {
            self.graph.unsubscribe(sub);
        }
        for collection in core::mem::take(&mut binding.dry_wet_collections) {
            collection.terminate(&mut self.graph); // a plain drop would leak their hub / event / curve observers
        }
        if binding.spec.dry_key == 0 || binding.spec.wet_key == 0 {
            return; // a midi composite has no dry / wet
        }
        let uuid = binding.composite_uuid;
        let (dry_handle, dry_subs, dry_collections, _) = self.observe_param(uuid, &[binding.spec.dry_key], 0, invalidate);
        let (wet_handle, wet_subs, wet_collections, _) = self.observe_param(uuid, &[binding.spec.wet_key], 1, invalidate);
        binding.dry_wet_subs.extend(dry_subs);
        binding.dry_wet_subs.extend(wet_subs);
        binding.dry_wet_collections.extend(dry_collections);
        binding.dry_wet_collections.extend(wet_collections);
        // The STATIC values are kept live by `subscribe_dry_wet`; only the AUTOMATION overrides are bound here.
        // `resolve` hands back a UNIT value while the curve covers the position, else the FIELD's stored value
        // with its own kind (already real dB) — map only the unit case, as the strip / sends do.
        if dry_handle.track.is_some() {
            *binding.dry_wet_automation.volume.borrow_mut() = Some(Rc::new(move |position: f64| {
                let (value, kind) = dry_handle.resolve(position);
                if kind == abi::PARAM_KIND_UNIT { GAIN.y(value) } else { value }
            }));
        }
        if wet_handle.track.is_some() {
            *binding.dry_wet_automation.panning.borrow_mut() = Some(Rc::new(move |position: f64| {
                let (value, kind) = wet_handle.resolve(position);
                if kind == abi::PARAM_KIND_UNIT { GAIN.y(value) } else { value }
            }));
        }
    }

    /// Re-observe a composite's OWN automation after a REAL automation change (a Value track attached /
    /// detached / a curve edited): its `dry` / `wet` and every entry's `gain` / `mute` / `solo`.
    ///
    /// These are bound OUTSIDE the device ABI (a composite is not a plugin, so it has no `DeviceParams`), so
    /// nothing else reaches them: `rebind_automation` -> `for_each_params` re-binds the entries' DEVICES only.
    /// Without this, attaching automation to `wet` was indicated in the UI but drove neither the DSP nor the
    /// control — the curve closure was only ever installed at BUILD time, when no track existed yet.
    pub(crate) fn rebind_effect_composite_params(&mut self, binding: &mut EffectCompositeBinding,
                                                 invalidate: &Rc<dyn Fn()>) {
        self.bind_dry_wet(binding, invalidate);
        let spec = binding.spec.clone();
        // Taken out so `self` and the entries are not borrowed from `binding` at once.
        let mut members = core::mem::take(&mut binding.members);
        for entry in &mut members {
            self.bind_entry_params(entry, &spec, invalidate);
        }
        binding.members = members;
    }

    /// Bind ONE entry's gain (40) + mute (41) + solo (42), static and automated. The strip reads them exactly
    /// as a unit's channel strip reads its own: gain -> `volume`, mute -> `mute`. Solo is NOT read by the strip
    /// (it silences OTHER entries); the reconcile resolves it across siblings into `forced_silent`.
    fn bind_entry_params(&mut self, entry: &mut CompositeEntry, spec: &EffectCompositeSpec,
                         invalidate: &Rc<dyn Fn()>) {
        *entry.strip_automation.volume.borrow_mut() = None;
        *entry.strip_automation.panning.borrow_mut() = None;
        *entry.strip_automation.mute.borrow_mut() = None;
        *entry.strip_automation.solo.borrow_mut() = None;
        for sub in core::mem::take(&mut entry.param_subs) {
            self.graph.unsubscribe(sub);
        }
        for collection in core::mem::take(&mut entry.param_collections) {
            collection.terminate(&mut self.graph);
        }
        if spec.gain_key != 0 {
            let (handle, subs, collections, _) = self.observe_param(entry.uuid, &[spec.gain_key], 0, invalidate);
            entry.param_subs.extend(subs);
            entry.param_collections.extend(collections);
            // The STATIC gain is kept live by its own field subscription (see `build_one_entry`); only the
            // AUTOMATION override is bound here.
            if handle.track.is_some() {
                *entry.strip_automation.volume.borrow_mut() = Some(Rc::new(move |position: f64| {
                    let (value, kind) = handle.resolve(position);
                    if kind == abi::PARAM_KIND_UNIT { GAIN.y(value) } else { value }
                }));
            }
        }
        if spec.pan_key != 0 {
            let (handle, subs, collections, _) = self.observe_param(entry.uuid, &[spec.pan_key], 3, invalidate);
            entry.param_subs.extend(subs);
            entry.param_collections.extend(collections);
            // The STATIC pan is kept live by its own field subscription (see `build_one_entry`); only the
            // AUTOMATION override is bound here, mapped bipolar like the strip's own pan.
            if handle.track.is_some() {
                *entry.strip_automation.panning.borrow_mut() = Some(Rc::new(move |position: f64| {
                    let (value, kind) = handle.resolve(position);
                    if kind == abi::PARAM_KIND_UNIT { PAN.y(value) } else { value }
                }));
            }
        }
        if spec.mute_key != 0 {
            let (handle, subs, collections, _) = self.observe_param(entry.uuid, &[spec.mute_key], 1, invalidate);
            entry.param_subs.extend(subs);
            entry.param_collections.extend(collections);
            entry.strip_params.mute.set(handle.field.get() >= 0.5);
            // The mute field stores a bool as 0.0/1.0; the strip thresholds at >= 0.5 either way.
            if handle.track.is_some() {
                *entry.strip_automation.mute.borrow_mut() = Some(Rc::new(move |position: f64| {
                    let (value, _kind) = handle.resolve(position);
                    value
                }));
            }
        }
        if spec.solo_key != 0 {
            // Observed so an edit enqueues the unit (the reconcile re-resolves every sibling's silent state);
            // the strip never reads solo itself.
            let (handle, subs, collections, _) = self.observe_param(entry.uuid, &[spec.solo_key], 2, invalidate);
            entry.param_subs.extend(subs);
            entry.param_collections.extend(collections);
            entry.strip_params.solo.set(handle.field.get() >= 0.5);
        }
    }

    /// A TARGETED `This` monitor on one of an entry's parameter fields: an edit re-wires the owning unit's
    /// chain, so the reconcile re-reads the value and re-resolves solo across every sibling. `None` for a key
    /// the composite does not declare (a midi entry has no gain).
    fn subscribe_entry_field(&mut self, uuid: Uuid, key: u16, rewire: &Rc<dyn Fn()>) -> Option<SubscriptionId> {
        if key == 0 {
            return None;
        }
        let rewire = rewire.clone();
        Some(self.graph.subscribe_vertex(boxgraph::subscription::Propagation::This,
            Address::of(uuid, vec![key]), Box::new(move |_graph, _update| rewire())))
    }

    /// Per-entry reconcile (the mirror of `reconcile_composite_children`, for a parallel FX stack): diff the
    /// entry collection against the persistent members, build only joiners, terminate only leavers, reconcile
    /// each survivor IN PLACE, then resolve solo across the whole set. The composite's own nodes persist, so
    /// the chain around it is never touched.
    pub(crate) fn reconcile_effect_composite(&mut self, binding: &mut EffectCompositeBinding,
                                             signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>,
                                             rewire: &Rc<dyn Fn()>) {
        binding.entries.take_dirty(); // consume the membership flag
        let spec = binding.spec.clone();
        let desired = binding.entries.sorted();
        let infos = self.entry_infos(&desired, &spec);
        let mut pool: BTreeMap<Uuid, CompositeEntry> =
            binding.members.drain(..).map(|entry| (entry.uuid, entry)).collect();
        let mut members: Vec<CompositeEntry> = Vec::new();
        for (index, info) in infos.iter().enumerate() {
            let entry = match pool.remove(&info.uuid) {
                Some(entry) => self.reconcile_one_entry(binding, entry, index, &spec, signal, invalidate, rewire),
                None => self.build_one_entry(binding, info.uuid, index, &spec, signal, invalidate, rewire)
            };
            // Resolved across ALL siblings (solo is a cross-entry fact), so it lands after every read.
            entry.strip_params.forced_silent.set(info.silent);
            members.push(entry);
        }
        for (_, stale) in pool { // whatever is left did not return: a leaver
            self.teardown_entry(binding, stale);
        }
        binding.members = members;
        // An EMPTY composite passes its input through untouched, whatever dry / wet say, so inserting a fresh
        // stack never kills the chain. Re-applied every reconcile, so adding the first entry engages the mix.
        binding.dry_wet.bypass.set(binding.members.is_empty());
    }

    /// Reconcile ONE surviving entry in place: re-wire its chain edge-only when its fx collection or a member
    /// `enabled` toggled (survivors keep their DSP state), and re-read its parameters.
    #[allow(clippy::too_many_arguments)] // threads the reconcile cascade context
    fn reconcile_one_entry(&mut self, binding: &mut EffectCompositeBinding, mut entry: CompositeEntry,
                           index: usize, spec: &EffectCompositeSpec, signal: &Rc<dyn Fn()>,
                           invalidate: &Rc<dyn Fn()>, rewire: &Rc<dyn Fn()>) -> CompositeEntry {
        let dirty = entry.chain.take_dirty() | entry.effects_dirty.replace(false);
        if dirty {
            let uuids = entry.chain.sorted();
            self.unwire_entry(binding, &mut entry);
            let mut pool: BTreeMap<Uuid, Member> =
                entry.audio.drain(..).map(|member| (member.uuid, member)).collect();
            entry.audio = self.build_chain_members(&mut pool, &uuids, signal, invalidate, &entry_rewire(&entry.effects_dirty, rewire));
            for (_, stale) in pool {
                self.terminate_member(stale);
            }
            self.wire_entry(binding, &mut entry, index);
        } else if entry.wired_index != index {
            // Position changed but the chain did not: re-point this entry onto its NEW distributor branch. For a
            // POSITIONAL distributor (a stereo split) this re-routes its channel; for a broadcast stack every
            // branch carries the same input, so it is a harmless refresh.
            self.unwire_entry(binding, &mut entry);
            self.wire_entry(binding, &mut entry, index);
        }
        self.bind_entry_params(&mut entry, spec, invalidate);
        entry
    }

    /// Build one persistent entry: observe its fx collection, create its strip, build its chain, wire it.
    #[allow(clippy::too_many_arguments)] // threads the reconcile cascade context
    fn build_one_entry(&mut self, binding: &mut EffectCompositeBinding, uuid: Uuid, index: usize,
                       spec: &EffectCompositeSpec, signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>,
                       rewire: &Rc<dyn Fn()>) -> CompositeEntry {
        let chain = IndexedCollection::observe(&mut self.graph,
            Address::of(uuid, vec![spec.chain_field]), EFFECT_INDEX_KEY);
        chain.take_dirty();
        // A live add / remove / reorder inside THIS entry re-wires the owning unit's chain (see the entry
        // collection above for why this must be `rewire`, not `signal`).
        chain.set_on_dirty(rewire.clone());
        let strip_params = Rc::new(StripParams::new());
        let strip_automation = Rc::new(StripAutomation::new());
        let strip = Rc::new(RefCell::new(ChannelStripProcessor::new(strip_params.clone(),
            strip_automation.clone(), self.sample_rate)));
        let strip_output = strip.borrow().audio_output();
        let strip_id = self.context.register_processor(strip.clone());
        // Label the node with the entry's own label ("A", "L", ...) so a graph dump names the branch.
        let label = if spec.label_key == 0 { None } else {
            self.graph.field_value(&Address::of(uuid, vec![spec.label_key]))
                .and_then(|value| value.as_str().map(alloc::string::String::from))
        };
        self.context.set_label(strip_id, match label {
            Some(label) if !label.is_empty() => alloc::format!("composite-entry:{label}"),
            _ => alloc::string::String::from("composite-entry")
        });
        // The entry's post-gain output under its own box uuid, so a sidechain can target the ENTRY.
        self.output_registry.register(Address::of(uuid, vec![]), strip_output.clone(), strip_id);
        let entry_meter = strip.borrow().meter_slot();
        self.broadcasts.register(uuid, &[], crate::broadcast::PACKAGE_FLOAT_ARRAY, &entry_meter);
        let effects_dirty = Rc::new(Cell::new(false));
        let uuids = chain.sorted();
        let mut pool: BTreeMap<Uuid, Member> = BTreeMap::new();
        let audio = self.build_chain_members(&mut pool, &uuids, signal, invalidate,
            &entry_rewire(&effects_dirty, rewire));
        // MUTE / SOLO re-wire: they are toggles, and solo re-resolves every SIBLING's silent state.
        let mut field_subs: Vec<SubscriptionId> = [spec.mute_key, spec.solo_key].iter()
            .filter_map(|&key| self.subscribe_entry_field(uuid, key, rewire)).collect();
        // GAIN / PAN are DRAGS: sync them straight into the strip's cells, which the node reads each block.
        // Routing a drag through a re-wire would reconcile the whole chain on every tick of the knob.
        if spec.gain_key != 0 {
            let params = strip_params.clone();
            field_subs.push(self.graph.catchup_and_subscribe(Address::of(uuid, vec![spec.gain_key]),
                move |value| {
                    if let Some(value) = value.as_float32() { params.volume_db.set(value) }
                }));
        }
        if spec.pan_key != 0 {
            let params = strip_params.clone();
            field_subs.push(self.graph.catchup_and_subscribe(Address::of(uuid, vec![spec.pan_key]),
                move |value| {
                    if let Some(value) = value.as_float32() { params.panning.set(value) }
                }));
        }
        let mut entry = CompositeEntry {
            uuid, chain, audio, strip, strip_id, strip_params, strip_automation, strip_output,
            param_subs: Vec::new(), param_collections: Vec::new(), field_subs, edges: Vec::new(),
            summed: false, effects_dirty, wired_index: usize::MAX
        };
        self.wire_entry(binding, &mut entry, index);
        self.bind_entry_params(&mut entry, spec, invalidate);
        entry
    }

    /// Wire one entry: its branch of the distributor -> its enabled fx in index order -> its strip -> the wet
    /// sum. A DISABLED member is SKIPPED (bypassed; its processor + state untouched), exactly as in a leaf
    /// chain. An entry with an EMPTY chain is an identity branch: its strip reads the branch directly.
    fn wire_entry(&mut self, binding: &EffectCompositeBinding, entry: &mut CompositeEntry, index: usize) {
        let mut output = binding.distributor.borrow().branch(index);
        let mut output_node = binding.distributor_id;
        for member in &entry.audio {
            if !self.device_enabled(member.uuid) {
                continue; // a disabled effect is bypassed: not wired, processor untouched
            }
            match &member.proc {
                ProcHandle::Audio(node) => node.borrow_mut().set_audio_source(output.clone()),
                ProcHandle::EffectComposite(nested) => nested.set_audio_source(output.clone()),
                _ => continue
            }
            // A composite member's upstream feeds its DISTRIBUTOR while its exit is its mix.
            let node_id = member.node_id.expect("member.node_id");
            let entry_node = member.input_node.unwrap_or(node_id);
            self.context.register_edge(output_node, entry_node);
            entry.edges.push((output_node, entry_node));
            output = member.output.clone().expect("member.output");
            output_node = node_id;
        }
        entry.strip.borrow_mut().set_audio_source(output);
        self.context.register_edge(output_node, entry.strip_id);
        entry.edges.push((output_node, entry.strip_id));
        self.context.register_edge(entry.strip_id, binding.wet_sum_id);
        entry.edges.push((entry.strip_id, binding.wet_sum_id));
        if !entry.summed {
            binding.wet_sum.borrow_mut().add_audio_source(entry.strip_output.clone());
            entry.summed = true;
        }
        entry.wired_index = index;
    }

    /// Drop an entry's current wiring (its internal edges + its wet-sum source), before a re-wire / teardown.
    fn unwire_entry(&mut self, binding: &EffectCompositeBinding, entry: &mut CompositeEntry) {
        for (source, target) in core::mem::take(&mut entry.edges) {
            self.context.remove_edge(source, target);
        }
        if entry.summed {
            binding.wet_sum.borrow_mut().remove_audio_source(&entry.strip_output);
            entry.summed = false;
        }
    }

    /// Terminate ONE entry (a leaver): unwire it, drop its chain + observations + parameter bindings.
    fn teardown_entry(&mut self, binding: &EffectCompositeBinding, mut entry: CompositeEntry) {
        self.unwire_entry(binding, &mut entry);
        self.output_registry.remove(&Address::of(entry.uuid, vec![]));
        for member in core::mem::take(&mut entry.audio) {
            self.terminate_member(member);
        }
        entry.chain.terminate(&mut self.graph);
        for sub in core::mem::take(&mut entry.param_subs) {
            self.graph.unsubscribe(sub);
        }
        for collection in core::mem::take(&mut entry.param_collections) {
            collection.terminate(&mut self.graph);
        }
        for sub in core::mem::take(&mut entry.field_subs) {
            self.graph.unsubscribe(sub);
        }
        self.context.remove_processor(entry.strip_id);
    }

    /// Terminate a whole effect composite (its chain member left, or the unit is gone): every entry, its own
    /// three nodes, its tail edges, its dry / wet bindings, and its entry-collection observation.
    pub(crate) fn teardown_effect_composite(&mut self, mut binding: EffectCompositeBinding) {
        for entry in core::mem::take(&mut binding.members) {
            self.teardown_entry(&binding, entry);
        }
        for (source, target) in core::mem::take(&mut binding.tail_edges) {
            self.context.remove_edge(source, target);
        }
        self.output_registry.remove(&Address::of(binding.composite_uuid, vec![]));
        if binding.spec.input_tap_field != 0 {
            self.output_registry.remove(&Address::of(binding.composite_uuid, vec![binding.spec.input_tap_field]));
        }
        for sub in core::mem::take(&mut binding.dry_wet_subs) {
            self.graph.unsubscribe(sub);
        }
        for collection in core::mem::take(&mut binding.dry_wet_collections) {
            collection.terminate(&mut self.graph);
        }
        for sub in core::mem::take(&mut binding.dry_wet_field_subs) {
            self.graph.unsubscribe(sub);
        }
        self.context.remove_processor(binding.mix_id);
        self.context.remove_processor(binding.wet_sum_id);
        self.context.remove_processor(binding.distributor_id);
        binding.entries.terminate(&mut self.graph);
    }

    /// Build (or reuse from `pool`) the members of ONE audio chain, in index order: a plugin effect, or a
    /// nested EFFECT COMPOSITE. The shared body behind every audio chain in an entry, so a composite nests
    /// with no extra code. Skips a box that is neither.
    pub(crate) fn build_chain_members(&mut self, pool: &mut BTreeMap<Uuid, Member>, uuids: &[Uuid],
                                      signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>,
                                      rewire: &Rc<dyn Fn()>) -> Vec<Member> {
        let mut members: Vec<Member> = Vec::new();
        for uuid in uuids.iter().copied() {
            if let Some(member) = self.take_or_build_audio_member(pool, uuid, signal, invalidate, rewire) {
                members.push(member);
            }
        }
        members
    }

    /// One audio-chain member by box type: a registered PLUGIN effect, or a registered EFFECT COMPOSITE (an
    /// FX stack / split container the engine realizes itself). `None` for anything else (silently skipped, as
    /// an unknown device always was). This is the ONE place an audio chain learns about composites, so every
    /// chain builder gets them by calling it.
    pub(crate) fn take_or_build_audio_member(&mut self, pool: &mut BTreeMap<Uuid, Member>, uuid: Uuid,
                                             signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>,
                                             rewire: &Rc<dyn Fn()>) -> Option<Member> {
        let name = self.graph.find_box(&uuid)?.name.clone();
        if let Some(device) = self.device_for_type(&name) {
            if device.kind != DEVICE_KIND_AUDIO_EFFECT {
                return None;
            }
            return Some(self.take_or_build_audio(pool, uuid, device, signal, invalidate, rewire));
        }
        let spec = self.effect_composite_for_type(&name)
            .filter(|spec| spec.kind as u32 == DEVICE_KIND_AUDIO_EFFECT)?;
        Some(self.take_or_build_effect_composite(pool, uuid, &spec, signal, invalidate, rewire))
    }

    /// Take a surviving effect-composite member from `pool` (reconciling its entries in place, so every
    /// survivor's DSP state is kept) or build a fresh one. Mirrors `take_or_build_audio`, one level up.
    fn take_or_build_effect_composite(&mut self, pool: &mut BTreeMap<Uuid, Member>, uuid: Uuid,
                                      spec: &EffectCompositeSpec, signal: &Rc<dyn Fn()>,
                                      invalidate: &Rc<dyn Fn()>, rewire: &Rc<dyn Fn()>) -> Member {
        if let Some(existing) = pool.remove(&uuid) {
            if matches!(existing.proc, ProcHandle::EffectComposite(_)) {
                let Member {uuid, mut proc, node_id, input_node, output, params, sidechain, enabled_sub} = existing;
                if let ProcHandle::EffectComposite(binding) = &mut proc {
                    // Its own subtree may have changed while it survived (an entry edit, a nested composite).
                    // Reconcile UNCONDITIONALLY: it diffs the entry set and consults each entry's own dirty
                    // flag, so it is cheap when nothing moved. An outer "is the subtree dirty?" gate would
                    // CONSUME those very flags, leaving the per-entry reconcile below to read `false` and skip
                    // the work — the chain builder only reaches here when the unit is already dirty anyway.
                    self.reconcile_effect_composite(binding, signal, invalidate, rewire);
                }
                return Member {uuid, proc, node_id, input_node, output, params, sidechain, enabled_sub};
            }
            self.terminate_member(existing); // the box type changed under this uuid
        }
        let binding = self.build_effect_composite(uuid, spec, signal, invalidate, rewire);
        let (distributor_id, mix_id, output) = (binding.distributor_id, binding.mix_id, binding.mix_output.clone());
        let enabled_sub = self.subscribe_enabled(uuid, rewire);
        Member {
            uuid,
            proc: ProcHandle::EffectComposite(Box::new(binding)),
            node_id: Some(mix_id),        // the chain continues from the composite's MIX
            input_node: Some(distributor_id), // and the upstream feeds its DISTRIBUTOR
            output: Some(output),
            params: None,                 // not a plugin: its parameters are bound by its own binding
            sidechain: None,              // a composite declares no sidechain of its own; its entries may
            enabled_sub
        }
    }
}

/// The re-wire signal an entry's members fire when their `enabled` toggles: mark THIS entry dirty + enqueue
/// the unit, so the reconcile re-wires only this entry (bypass / restore the toggled effect), no sibling touched.
fn entry_rewire(effects_dirty: &Rc<Cell<bool>>, rewire: &Rc<dyn Fn()>) -> Rc<dyn Fn()> {
    let dirty = effects_dirty.clone();
    let rewire = rewire.clone();
    Rc::new(move || {
        dirty.set(true);
        rewire();
    })
}
