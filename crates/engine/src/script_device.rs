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
use alloc::rc::Rc;
use alloc::vec;
use alloc::vec::Vec;
use bindings::value_collection::ValueCollection;
use boxgraph::address::{Address, Uuid};
use boxgraph::subscription::{Propagation, SubscriptionId};
use crate::audio_unit::resolve_and_deliver_sample;
use crate::param_automation::ParamHandle;
use crate::{DeviceReg, Engine};

// Child-box field keys (WASM CONTRACT: mirror the TS `WerkstattParameterBox` / `WerkstattSampleBox` schemas).
const DECL_INDEX_KEY: u16 = 3;  // the @param / @sample declaration index — the id the JS bridge maps to a label
const PARAM_VALUE_KEY: u16 = 4; // WerkstattParameterBox.value (Float32, automatable)
const SAMPLE_FILE_KEY: u16 = 4; // WerkstattSampleBox.file (Pointer -> AudioFileBox)

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
            let id = self.declaration_index(child);
            resolve_and_deliver_sample(&self.graph, child, &[SAMPLE_FILE_KEY], sample_changed_index, state_ptr, id);
            let sub = self.graph.subscribe_vertex(Propagation::This, Address::of(child, vec![SAMPLE_FILE_KEY]),
                Box::new(move |graph, _update| {
                    resolve_and_deliver_sample(graph, child, &[SAMPLE_FILE_KEY], sample_changed_index, state_ptr, id);
                }));
            subs.push(sub);
        }
        subs
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
        self.graph.field_value(&Address::of(child, vec![DECL_INDEX_KEY]))
            .and_then(|value| value.as_int32()).unwrap_or(0) as u32
    }
}
