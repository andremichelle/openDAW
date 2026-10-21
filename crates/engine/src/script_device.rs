//! Scriptable-device collection binding (Werkstatt / Apparat / Spielwerk). These devices declare their
//! parameters and samples NOT as fixed box fields but as dynamic CHILD boxes — `WerkstattParameterBox` /
//! `WerkstattSampleBox` instances under the device's `parameters` (key 11) and `samples` (key 12) pointer hubs.
//! This module is the engine's side of that: enumerate the hub's children and bind each one, reusing the
//! ordinary parameter / sample machinery so automation, value mappings, and sample residency all work
//! identically to a fixed device — the ONLY difference is the binding SOURCE (child boxes, keyed by their
//! declaration index) rather than the device's own field paths. `bind_device` calls these; the per-child
//! subscriptions are returned for teardown, and the hub membership is watched so a child add / remove re-binds
//! through the normal automation-invalidate path.

use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::rc::Rc;
use alloc::vec;
use alloc::vec::Vec;
use core::cell::Cell;
use bindings::value_collection::ValueCollection;
use boxgraph::address::{Address, Uuid};
use boxgraph::field::FieldValue;
use boxgraph::graph::BoxGraph;
use boxgraph::subscription::{Propagation, SubscriptionId};
use crate::audio_unit::{resolve_and_deliver_sample, visit_member_params, AudioUnitBinding, DeviceParams, SidechainBinding, SidechainPort, Wired};
use crate::param_automation::ParamHandle;
use crate::{call_device_data_changed, DeviceReg, Engine};

// Child-box field keys (WASM CONTRACT: mirror the TS `WerkstattParameterBox` / `WerkstattSampleBox` schemas).
const DECL_INDEX_KEY: u16 = 3;  // the @param / @sample declaration index — the id the JS bridge maps to a label
const PARAM_VALUE_KEY: u16 = 4; // WerkstattParameterBox.value (Float32, automatable)
const SAMPLE_FILE_KEY: u16 = 4; // WerkstattSampleBox.file (Pointer -> AudioFileBox)
const SIDECHAIN_SOURCE_KEY: u16 = 4; // WerkstattSidechainBox.source (Pointer -> the tapped output)

impl Engine {
    /// Bind a scriptable device's dynamic PARAMETERS: enumerate the `WerkstattParameterBox` children under the
    /// device's `parameters` hub (`hub_field`), and bind each child's `value` field (key 4) automation, keyed by
    /// the child's declaration `index` (key 3) so the JS bridge maps the id back to the `@param` label. Reuses
    /// [`Engine::observe_param`], so a Value track targeting the child's `value` resolves through the same
    /// curve / region machinery as any fixed parameter. Returns the handles, their subscriptions + curve
    /// collections (for teardown), and whether any is automated (to arm the clock).
    pub(crate) fn observe_script_params(&mut self, device_uuid: Uuid, hub_field: u16, invalidate: &Rc<dyn Fn()>)
        -> (Vec<ParamHandle>, Vec<SubscriptionId>, Vec<ValueCollection>, bool) {
        let mut handles = Vec::new();
        let mut subs = Vec::new();
        let mut collections = Vec::new();
        let mut armed = false;
        for child in self.collection_children(device_uuid, hub_field) {
            let id = self.declaration_index(child);
            let (handle, mut child_subs, mut child_collections, child_armed) =
                self.observe_param(child, &[PARAM_VALUE_KEY], id, invalidate);
            handles.push(handle);
            subs.append(&mut child_subs);
            // a reordered @param re-numbers its child: re-bind so the value travels under the new index
            let index_invalidate = invalidate.clone();
            subs.push(self.graph.subscribe_vertex(Propagation::This, Address::of(child, vec![DECL_INDEX_KEY]),
                Box::new(move |_graph, _update| index_invalidate())));
            collections.append(&mut child_collections);
            armed |= child_armed;
        }
        (handles, subs, collections, armed)
    }

    /// Bind a scriptable device's dynamic SAMPLES: enumerate the `WerkstattSampleBox` children under the device's
    /// `samples` hub (`hub_field`), and for each resolve + deliver its `file` pointer (key 4) through the device's
    /// `sample_changed`, keyed by the child's declaration `index` (key 3). Reuses [`resolve_and_deliver_sample`]
    /// (so residency / repoint / clear all behave like a fixed device sample); returns the per-child `file`
    /// pointer subscriptions for teardown.
    pub(crate) fn observe_script_samples(&mut self, device_uuid: Uuid, reg: DeviceReg, state_ptr: u32, hub_field: u16) -> Vec<SubscriptionId> {
        let sample_changed_index = reg.sample_changed_index;
        let mut subs = Vec::new();
        for child in self.collection_children(device_uuid, hub_field) {
            resolve_and_deliver_sample(&self.graph, child, &[SAMPLE_FILE_KEY], sample_changed_index, state_ptr, declaration_index_in(&self.graph, child));
            // the index is read at delivery: a reordered @sample re-numbers its child, its file is delivered again
            for key in [SAMPLE_FILE_KEY, DECL_INDEX_KEY] {
                subs.push(self.graph.subscribe_vertex(Propagation::This, Address::of(child, vec![key]),
                    Box::new(move |graph, _update| {
                        resolve_and_deliver_sample(graph, child, &[SAMPLE_FILE_KEY], sample_changed_index, state_ptr, declaration_index_in(graph, child));
                    })));
            }
        }
        subs
    }

    /// Sync a binding's COLLECTION ports with the `WerkstattSidechainBox` children of its hub: a removed child
    /// drops its port (edge + monitors), a new child gets one monitoring its `source` and `index`, and every
    /// port id follows its child's index (WASM CONTRACT: `2 + bound_count + index`, mirrored by the script
    /// bridge). Returns whether the port set changed.
    pub(crate) fn sync_sidechain_collection(&mut self, binding: &mut SidechainBinding) -> bool {
        let Some(collection) = &binding.collection else { return false };
        let (hub_field, bound_count, signal) = (collection.hub_field, collection.bound_count, collection.signal.clone());
        let children = self.collection_children(binding.device_uuid, hub_field);
        let child_of = |port: &SidechainPort| port.child.as_ref().map(|(child, _)| *child);
        let mut changed = false;
        let (kept, gone): (Vec<SidechainPort>, Vec<SidechainPort>) = core::mem::take(&mut binding.ports).into_iter()
            .partition(|port| child_of(port).is_none_or(|child| children.contains(&child)));
        binding.ports = kept;
        for port in gone {
            if let Some(source) = port.resolved {
                self.context.remove_edge(source, binding.node_id);
            }
            self.unsubscribe_sidechain_port(port);
            changed = true;
        }
        for child in children {
            let port_id = 2 + bound_count + self.declaration_index(child);
            if let Some(port) = binding.ports.iter_mut().find(|port| child_of(port) == Some(child)) {
                if port.port_id != port_id {
                    port.port_id = port_id;
                    changed = true;
                }
                continue;
            }
            let address = Address::of(child, vec![SIDECHAIN_SOURCE_KEY]);
            let source_signal = signal.clone();
            let pointer_sub = self.graph.subscribe_vertex(Propagation::This, address.clone(),
                Box::new(move |_graph, _update| source_signal()));
            let index_signal = signal.clone();
            let index_sub = self.graph.subscribe_vertex(Propagation::This, Address::of(child, vec![DECL_INDEX_KEY]),
                Box::new(move |_graph, _update| index_signal()));
            binding.ports.push(SidechainPort {port_id, address, resolved: None, pointer_sub, child: Some((child, index_sub))});
            changed = true;
        }
        changed
    }

    pub(crate) fn unsubscribe_sidechain_port(&mut self, port: SidechainPort) {
        self.graph.unsubscribe(port.pointer_sub);
        if let Some((_, index_sub)) = port.child {
            self.graph.unsubscribe(index_sub);
        }
    }

    /// Release every monitor of a dying device's sidechain binding (ports + collection hub).
    pub(crate) fn teardown_sidechain(&mut self, binding: SidechainBinding) {
        for port in binding.ports {
            self.unsubscribe_sidechain_port(port);
        }
        if let Some(collection) = binding.collection {
            self.graph.unsubscribe(collection.hub_sub);
        }
    }

    /// The uuids of the child boxes connected into a device's collection hub (`parameters` / `samples`), i.e. the
    /// boxes whose `owner` pointer targets it.
    fn collection_children(&self, device_uuid: Uuid, hub_field: u16) -> Vec<Uuid> {
        self.graph.incoming(&Address::of(device_uuid, vec![hub_field]))
            .into_iter().map(|address| address.uuid).collect()
    }

    /// A child's declaration `index` (key 3) — its order among the script's `@param` / `@sample` lines, used as
    /// the id the device forwards to the JS bridge (which maps it to the declared label + value mapping).
    fn declaration_index(&self, child: Uuid) -> u32 {
        declaration_index_in(&self.graph, child)
    }
}

fn declaration_index_in(graph: &BoxGraph, child: Uuid) -> u32 {
    graph.field_value(&Address::of(child, vec![DECL_INDEX_KEY])).and_then(|value| value.as_int32()).unwrap_or(0) as u32
}

// Record / value box field keys (WASM CONTRACT: mirror the TS `ScriptRecordBox` / `ScriptValueBox` schemas).
const RECORD_COLLECTION_INDEX_KEY: u16 = 3;
const RECORD_ORDER_KEY: u16 = 4;
const RECORD_VALUES_KEY: u16 = 5;
const VALUE_FIELD_INDEX_KEY: u16 = 3;
const VALUE_KEY: u16 = 4;
// WASM CONTRACT: a `data_changed` call with this collection resets every collection before a snapshot
pub(crate) const DATA_RESET: u32 = u32::MAX;
// WASM CONTRACT: a `@buffer` arrives as `data_changed(BUFFER_FLAG | index, values, length, 1)`
pub(crate) const BUFFER_FLAG: u32 = 0x8000_0000;
const BUFFER_INDEX_KEY: u16 = 3;
const BUFFER_LEGACY_DATA_KEY: u16 = 4; // one blob, from before chunks: read only while a buffer has no chunks
const BUFFER_CHUNKS_KEY: u16 = 5;
const CHUNK_INDEX_KEY: u16 = 2;
const CHUNK_DATA_KEY: u16 = 3;

/// A scriptable device's `@collection` data: the `ScriptRecordBox` children of its `records` hub and their
/// `ScriptValueBox` values. Any change marks it dirty and raises the unit's params signal, the unit reconcile
/// then flushes ONE snapshot per collection (`flush_script_records`), so a half-applied transaction is never
/// delivered. A structural change (a record or value added / removed) re-subscribes the children first.
pub(crate) struct RecordBinding {
    pub(crate) hub_field: u16,
    pub(crate) buffer_field: u16,
    pub(crate) hub_subs: Vec<SubscriptionId>,
    pub(crate) child_subs: Vec<SubscriptionId>,
    dirty: Rc<Cell<bool>>,
    structure_dirty: Rc<Cell<bool>>,
    // set while (re)subscribing: a subscription's catch-up must not re-enqueue the unit (no reconcile loop)
    muted: Rc<Cell<bool>>,
    signal: Rc<dyn Fn()>
}

/// Visit every bound device of a wired unit, recursing into composites and effect composites.
pub(crate) fn for_each_wired_params(wired: &mut Wired, visit: &mut dyn FnMut(&mut DeviceParams)) {
    match wired {
        Wired::Leaf(chain) => {
            visit_member_params(&mut chain.instrument, visit);
            for member in chain.midi.iter_mut().chain(chain.audio.iter_mut()) {
                visit_member_params(member, visit);
            }
        }
        Wired::Composite(composite) => {
            composite.binding.for_each_params(visit);
            for member in &mut composite.audio {
                visit_member_params(member, visit);
            }
        }
        Wired::Tape(tape) => tape.audio.iter_mut().for_each(|member| visit_member_params(member, visit)),
        Wired::Bus(bus) => bus.audio.iter_mut().for_each(|member| visit_member_params(member, visit)),
        Wired::MidiOut(midi) => {
            for member in midi.midi.iter_mut().chain(midi.audio.iter_mut()) {
                visit_member_params(member, visit);
            }
        }
        Wired::Frozen(_) => {}
    }
}

impl Engine {
    /// Bind a scriptable device's `@collection` records: watch the hub and every record / value, and deliver the
    /// first snapshot right away (the device's `init` has run, its bridge exists).
    pub(crate) fn bind_script_records(&mut self, device_uuid: Uuid, reg: DeviceReg, state_ptr: u32, signal: Rc<dyn Fn()>) -> RecordBinding {
        let (hub_field, buffer_field) = (reg.record_collection_field, reg.buffer_collection_field);
        let dirty = Rc::new(Cell::new(false));
        let structure_dirty = Rc::new(Cell::new(false));
        let muted = Rc::new(Cell::new(true));
        let mut hub_subs = Vec::new();
        for field in [hub_field, buffer_field].into_iter().filter(|field| *field != 0) {
            let hub_signal = (dirty.clone(), structure_dirty.clone(), muted.clone(), signal.clone());
            hub_subs.push(self.graph.subscribe_pointer_hub(Address::of(device_uuid, vec![field]),
                Box::new(move |_graph, _event| {
                    if hub_signal.2.get() {return}
                    hub_signal.0.set(true);
                    hub_signal.1.set(true);
                    (hub_signal.3)();
                })));
        }
        let mut binding = RecordBinding {hub_field, buffer_field, hub_subs, child_subs: Vec::new(), dirty, structure_dirty, muted, signal};
        binding.child_subs = self.subscribe_record_children(device_uuid, &binding);
        binding.muted.set(false);
        self.deliver_script_records(device_uuid, &binding, reg.data_changed_index, state_ptr);
        binding
    }

    fn subscribe_record_children(&mut self, device_uuid: Uuid, binding: &RecordBinding) -> Vec<SubscriptionId> {
        let mut subs = Vec::new();
        let changed = |structural: bool| {
            let (dirty, structure_dirty, muted, signal) =
                (binding.dirty.clone(), binding.structure_dirty.clone(), binding.muted.clone(), binding.signal.clone());
            move || {
                if muted.get() {return}
                dirty.set(true);
                if structural {structure_dirty.set(true);}
                signal();
            }
        };
        if binding.buffer_field != 0 {
            for buffer in self.collection_children(device_uuid, binding.buffer_field) {
                for key in [BUFFER_INDEX_KEY, BUFFER_LEGACY_DATA_KEY] {
                    let notify = changed(false);
                    subs.push(self.graph.subscribe_vertex(Propagation::This, Address::of(buffer, vec![key]),
                        Box::new(move |_graph, _update| notify())));
                }
                let notify = changed(true);
                subs.push(self.graph.subscribe_pointer_hub(Address::of(buffer, vec![BUFFER_CHUNKS_KEY]),
                    Box::new(move |_graph, _event| notify())));
                for chunk in self.collection_children(buffer, BUFFER_CHUNKS_KEY) {
                    for key in [CHUNK_INDEX_KEY, CHUNK_DATA_KEY] {
                        let notify = changed(false);
                        subs.push(self.graph.subscribe_vertex(Propagation::This, Address::of(chunk, vec![key]),
                            Box::new(move |_graph, _update| notify())));
                    }
                }
            }
        }
        if binding.hub_field == 0 {
            return subs;
        }
        for record in self.collection_children(device_uuid, binding.hub_field) {
            for key in [RECORD_COLLECTION_INDEX_KEY, RECORD_ORDER_KEY] {
                let notify = changed(false);
                subs.push(self.graph.subscribe_vertex(Propagation::This, Address::of(record, vec![key]),
                    Box::new(move |_graph, _update| notify())));
            }
            let notify = changed(true);
            subs.push(self.graph.subscribe_pointer_hub(Address::of(record, vec![RECORD_VALUES_KEY]),
                Box::new(move |_graph, _event| notify())));
            for value in self.graph.incoming(&Address::of(record, vec![RECORD_VALUES_KEY])).into_iter().map(|address| address.uuid).collect::<Vec<_>>() {
                for key in [VALUE_FIELD_INDEX_KEY, VALUE_KEY] {
                    let notify = changed(false);
                    subs.push(self.graph.subscribe_vertex(Propagation::This, Address::of(value, vec![key]),
                        Box::new(move |_graph, _update| notify())));
                }
            }
        }
        subs
    }

    /// Deliver the snapshot of a dirty record binding (re-subscribing its children after a structural change).
    pub(crate) fn flush_script_records(&mut self, params: &mut DeviceParams) {
        let Some(mut binding) = params.records.take() else { return };
        self.flush_record_binding(params.device_uuid, params.reg, params.state_ptr, &mut binding);
        params.records = Some(binding);
    }

    pub(crate) fn flush_record_binding(&mut self, device_uuid: Uuid, reg: DeviceReg, state_ptr: u32, binding: &mut RecordBinding) {
        if !binding.dirty.replace(false) {return}
        if binding.structure_dirty.replace(false) {
            for sub in core::mem::take(&mut binding.child_subs) {
                self.graph.unsubscribe(sub);
            }
            binding.muted.set(true);
            binding.child_subs = self.subscribe_record_children(device_uuid, binding);
            binding.muted.set(false);
        }
        self.deliver_script_records(device_uuid, binding, reg.data_changed_index, state_ptr);
    }

    /// Flush every dirty record binding of a unit's devices.
    pub(crate) fn flush_unit_records(&mut self, unit: &mut AudioUnitBinding) {
        let Some(mut wired) = unit.wired.take() else { return };
        for_each_wired_params(&mut wired, &mut |params| self.flush_script_records(params));
        unit.wired = Some(wired);
    }

    pub(crate) fn teardown_script_records(&mut self, binding: RecordBinding) {
        for sub in binding.hub_subs {
            self.graph.unsubscribe(sub);
        }
        for sub in binding.child_subs {
            self.graph.unsubscribe(sub);
        }
    }

    /// Reset every collection, then deliver each present one as `f32` record-major in field-index order (`NaN`
    /// where a record has no value box for a field; the bridge fills the `@field` default).
    fn deliver_script_records(&self, device_uuid: Uuid, binding: &RecordBinding, data_changed_index: u32, state_ptr: u32) {
        call_device_data_changed(data_changed_index, state_ptr, DATA_RESET, &[], 0, 0);
        if binding.buffer_field != 0 {
            for buffer in self.collection_children(device_uuid, binding.buffer_field) {
                let index = self.graph.field_value(&Address::of(buffer, vec![BUFFER_INDEX_KEY])).and_then(|value| value.as_int32()).unwrap_or(0).max(0) as u32;
                let mut chunks: Vec<(i32, Uuid)> = self.collection_children(buffer, BUFFER_CHUNKS_KEY).into_iter()
                    .map(|chunk| (self.graph.field_value(&Address::of(chunk, vec![CHUNK_INDEX_KEY])).and_then(|value| value.as_int32()).unwrap_or(0), chunk))
                    .collect();
                chunks.sort_by_key(|(chunk_index, _)| *chunk_index);
                let decode = |bytes: &[u8]| bytes.chunks_exact(4).map(|word| f32::from_le_bytes([word[0], word[1], word[2], word[3]])).collect::<Vec<f32>>();
                let mut values: Vec<f32> = Vec::new();
                if chunks.is_empty() {
                    if let Some(FieldValue::Bytes(bytes)) = self.graph.field_value(&Address::of(buffer, vec![BUFFER_LEGACY_DATA_KEY])) {
                        values = decode(bytes);
                    }
                }
                for (_, chunk) in chunks {
                    if let Some(FieldValue::Bytes(bytes)) = self.graph.field_value(&Address::of(chunk, vec![CHUNK_DATA_KEY])) {
                        values.extend(decode(bytes));
                    }
                }
                call_device_data_changed(data_changed_index, state_ptr, BUFFER_FLAG | index, &values, values.len() as u32, 1);
            }
        }
        if binding.hub_field == 0 {
            return;
        }
        let hub_field = binding.hub_field;
        let int_at = |uuid: Uuid, key: u16| self.graph.field_value(&Address::of(uuid, vec![key])).and_then(|value| value.as_int32()).unwrap_or(0);
        let mut collections: BTreeMap<u32, Vec<(i32, Vec<(u32, f32)>)>> = BTreeMap::new();
        for record in self.collection_children(device_uuid, hub_field) {
            let values = self.graph.incoming(&Address::of(record, vec![RECORD_VALUES_KEY])).into_iter()
                .map(|address| {
                    let value = address.uuid;
                    let number = self.graph.field_value(&Address::of(value, vec![VALUE_KEY])).and_then(|field| field.as_float32()).unwrap_or(f32::NAN);
                    (int_at(value, VALUE_FIELD_INDEX_KEY).max(0) as u32, number)
                }).collect();
            collections.entry(int_at(record, RECORD_COLLECTION_INDEX_KEY).max(0) as u32).or_default()
                .push((int_at(record, RECORD_ORDER_KEY), values));
        }
        for (collection, mut records) in collections {
            records.sort_by_key(|(order, _)| *order);
            let fields = records.iter().flat_map(|(_, values)| values.iter().map(|(index, _)| index + 1)).max().unwrap_or(0);
            let mut snapshot = vec![f32::NAN; records.len() * fields as usize];
            for (row, (_, values)) in records.iter().enumerate() {
                for (index, number) in values {
                    snapshot[row * fields as usize + *index as usize] = *number;
                }
            }
            call_device_data_changed(data_changed_index, state_ptr, collection, &snapshot, records.len() as u32, fields);
        }
    }
}
