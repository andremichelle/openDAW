//! Observed tables: the plain fields of the CHILD boxes under one of a device's hubs, delivered to the device
//! as rows of 32-bit words (`abi::observe_table`). A device behind the abi reads only its own box, this is how
//! it learns about a variable list of children (the Sampler's zones, groups and modulation slots) without one
//! parameter per field. Nothing here names a box or a field: the device declares the hub path and the columns.
//!
//! A change only raises a flag and the unit's params signal. The unit reconcile then delivers ONE snapshot per
//! changed table (`flush_unit_tables`), so a half-applied transaction never reaches the device. The words of
//! the last snapshot stay alive in the binding until the next one is delivered, which lets the device read
//! them during render without a copy of its own.

use alloc::boxed::Box;
use alloc::rc::Rc;
use alloc::vec::Vec;
use core::cell::Cell;
use abi::{TableColumn, TABLE_NONE, TABLE_SAMPLE, TABLE_TARGET};
use boxgraph::address::{Address, Uuid};
use boxgraph::field::FieldValue;
use boxgraph::subscription::{Propagation, SubscriptionId};
use crate::audio_unit::{AudioUnitBinding, DeviceParams};
use crate::script_device::for_each_wired_params;
use crate::{call_device_table_changed, DeviceReg, Engine, SAMPLES};

/// One `observe_table` call a device made from `init`: the hub on its own box and the wanted columns.
pub(crate) struct TableObs {
    pub(crate) path: Vec<u16>,
    pub(crate) columns: Vec<TableColumn>
}

struct ObservedTable {
    obs: TableObs,
    words: Vec<u32>, // the snapshot the device reads, replaced only after the next one was delivered
    hub_sub: SubscriptionId,
    child_subs: Vec<SubscriptionId>,
    dirty: Rc<Cell<bool>>,
    structure_dirty: Rc<Cell<bool>>
}

/// A device's observed tables, in the order it declared them (the index is the id it got back).
pub(crate) struct TableBinding {
    tables: Vec<ObservedTable>,
    // set while (re)subscribing: a subscription's catch-up must not re-enqueue the unit (no reconcile loop)
    muted: Rc<Cell<bool>>,
    signal: Rc<dyn Fn()>
}

impl Engine {
    /// Watch every table the device declared and deliver each first snapshot right away (its `init` has run).
    pub(crate) fn bind_tables(&mut self, device_uuid: Uuid, reg: DeviceReg, state_ptr: u32, observed: Vec<TableObs>, signal: Rc<dyn Fn()>) -> TableBinding {
        let muted = Rc::new(Cell::new(true));
        let mut tables = Vec::with_capacity(observed.len());
        for obs in observed {
            let dirty = Rc::new(Cell::new(false));
            let structure_dirty = Rc::new(Cell::new(false));
            let hub_signal = (dirty.clone(), structure_dirty.clone(), muted.clone(), signal.clone());
            let hub_sub = self.graph.subscribe_pointer_hub(Address::of(device_uuid, obs.path.clone()),
                Box::new(move |_graph, _event| {
                    if hub_signal.2.get() {return}
                    hub_signal.0.set(true);
                    hub_signal.1.set(true);
                    (hub_signal.3)();
                }));
            let mut table = ObservedTable {obs, words: Vec::new(), hub_sub, child_subs: Vec::new(), dirty, structure_dirty};
            table.child_subs = self.subscribe_table_children(device_uuid, &table, &muted, &signal);
            tables.push(table);
        }
        muted.set(false);
        let mut binding = TableBinding {tables, muted, signal};
        for id in 0..binding.tables.len() {
            self.deliver_table(device_uuid, reg, state_ptr, &mut binding, id);
        }
        binding
    }

    // the children of a table's hub, ordered by uuid so a snapshot does not depend on the graph's edge order
    fn table_children(&self, device_uuid: Uuid, obs: &TableObs) -> Vec<Uuid> {
        let mut children: Vec<Uuid> = self.graph.incoming(&Address::of(device_uuid, obs.path.clone()))
            .into_iter().map(|address| address.uuid).collect();
        children.sort_unstable();
        children.dedup();
        children
    }

    /// Watch each child's observed fields. A value edit only marks the table dirty. A pointer edit is
    /// structural, since what it points at is watched as well and has to be subscribed again.
    fn subscribe_table_children(&mut self, device_uuid: Uuid, table: &ObservedTable, muted: &Rc<Cell<bool>>, signal: &Rc<dyn Fn()>) -> Vec<SubscriptionId> {
        let mut subs = Vec::new();
        let changed = |structural: bool| {
            let (dirty, structure_dirty, muted, signal) =
                (table.dirty.clone(), table.structure_dirty.clone(), muted.clone(), signal.clone());
            move || {
                if muted.get() {return}
                dirty.set(true);
                if structural {structure_dirty.set(true);}
                signal();
            }
        };
        for child in self.table_children(device_uuid, &table.obs) {
            for column in &table.obs.columns {
                let address = Address::of(child, alloc::vec![column.key]);
                let notify = changed(column.kind != abi::TABLE_VALUE);
                subs.push(self.graph.subscribe_vertex(Propagation::This, address.clone(),
                    Box::new(move |_graph, _update| notify())));
                if column.kind != TABLE_TARGET {continue}
                let Some(target) = self.graph.target_of(&address).map(|target| target.uuid) else {continue};
                let notify = changed(false);
                subs.push(self.graph.subscribe_vertex(Propagation::This, Address::of(target, alloc::vec![column.target_key]),
                    Box::new(move |_graph, _update| notify())));
            }
        }
        subs
    }

    fn table_words(&self, device_uuid: Uuid, obs: &TableObs) -> (Vec<u32>, u32) {
        let children = self.table_children(device_uuid, obs);
        let mut words = Vec::with_capacity(children.len() * obs.columns.len());
        for child in &children {
            for column in &obs.columns {
                let address = Address::of(*child, alloc::vec![column.key]);
                words.push(match column.kind {
                    TABLE_SAMPLE => match self.graph.target_of(&address) {
                        Some(target) => unsafe { SAMPLES.get() }.request(target.uuid),
                        None => TABLE_NONE
                    },
                    TABLE_TARGET => self.graph.target_of(&address)
                        .and_then(|target| self.graph.field_value(&Address::of(target.uuid, alloc::vec![column.target_key])))
                        .and_then(FieldValue::as_int32)
                        .map_or(TABLE_NONE, |value| value as u32),
                    _ => match self.graph.field_value(&address) {
                        Some(FieldValue::Int32(value)) => *value as u32,
                        Some(FieldValue::Float32(value)) => value.to_bits(),
                        Some(FieldValue::Boolean(value)) => *value as u32,
                        _ => TABLE_NONE
                    }
                });
            }
        }
        (words, children.len() as u32)
    }

    // The device gets the new words BEFORE the old ones are dropped, it never holds a dangling table.
    fn deliver_table(&mut self, device_uuid: Uuid, reg: DeviceReg, state_ptr: u32, binding: &mut TableBinding, id: usize) {
        let (words, rows) = self.table_words(device_uuid, &binding.tables[id].obs);
        let columns = binding.tables[id].obs.columns.len() as u32;
        call_device_table_changed(reg.table_changed_index, state_ptr, id as u32, &words, rows, columns);
        binding.tables[id].words = words;
    }

    /// Deliver the snapshot of every dirty table (subscribing its children again after a structural change).
    pub(crate) fn flush_table_binding(&mut self, device_uuid: Uuid, reg: DeviceReg, state_ptr: u32, binding: &mut TableBinding) {
        for id in 0..binding.tables.len() {
            if !binding.tables[id].dirty.replace(false) {continue}
            if binding.tables[id].structure_dirty.replace(false) {
                for sub in core::mem::take(&mut binding.tables[id].child_subs) {
                    self.graph.unsubscribe(sub);
                }
                binding.muted.set(true);
                let subs = self.subscribe_table_children(device_uuid, &binding.tables[id], &binding.muted, &binding.signal);
                binding.tables[id].child_subs = subs;
                binding.muted.set(false);
            }
            self.deliver_table(device_uuid, reg, state_ptr, binding, id);
        }
    }

    pub(crate) fn flush_device_tables(&mut self, params: &mut DeviceParams) {
        let Some(mut binding) = params.tables.take() else { return };
        self.flush_table_binding(params.device_uuid, params.reg, params.state_ptr, &mut binding);
        params.tables = Some(binding);
    }

    /// Flush every dirty table of a unit's devices.
    pub(crate) fn flush_unit_tables(&mut self, unit: &mut AudioUnitBinding) {
        let Some(mut wired) = unit.wired.take() else { return };
        for_each_wired_params(&mut wired, &mut |params| self.flush_device_tables(params));
        unit.wired = Some(wired);
    }

    pub(crate) fn teardown_tables(&mut self, binding: TableBinding) {
        for table in binding.tables {
            self.graph.unsubscribe(table.hub_sub);
            for sub in table.child_subs {
                self.graph.unsubscribe(sub);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    //! The table binding against a real graph: what a snapshot contains, when one is delivered, and that the
    //! watching follows children, pointers and pointer targets as they come and go.
    use super::*;
    use alloc::string::ToString;
    use alloc::vec;
    use abi::TABLE_VALUE;
    use boxgraph::boxes::GraphBox;
    use boxgraph::field::Fields;
    use boxgraph::graph::BoxGraph;
    use boxgraph::updates::Update;
    use crate::native_table_changed::{take, Delivery};

    const DEV: Uuid = [1u8; 16];
    const ZONE_A: Uuid = [20u8; 16];
    const ZONE_B: Uuid = [21u8; 16];
    const ZONE_C: Uuid = [22u8; 16];
    const GROUP_A: Uuid = [30u8; 16];
    const GROUP_B: Uuid = [31u8; 16];
    const FILE_A: Uuid = [40u8; 16];
    const FILE_B: Uuid = [41u8; 16];
    const STATE: u32 = 64;
    // the Sampler's schema keys
    const ZONES: u16 = 10;
    const GROUPS: u16 = 11;
    const OWNER: u16 = 1;
    const FILE: u16 = 2;
    const GROUP: u16 = 3;
    const KEY_LOW: u16 = 10;
    const TUNE: u16 = 31;
    const REVERSE: u16 = 43;
    const GROUP_INDEX: u16 = 3;
    const CHOKE: u16 = 11;

    fn graph_box(uuid: Uuid, name: &str, fields: &[(u16, FieldValue)]) -> GraphBox {
        let mut map = Fields::new();
        for (key, value) in fields {
            map.insert(*key, value.clone());
        }
        GraphBox {creation_index: 0, name: name.to_string(), uuid, fields: map}
    }

    fn reg() -> DeviceReg {
        DeviceReg {
            process_index: 0, state_size: 64, kind: abi::DEVICE_KIND_INSTRUMENT, init_index: 0, parameter_changed_index: 0,
            field_changed_index: 0, sample_changed_index: 0, soundfont_changed_index: 0, reset_index: 0, terminate_index: 0,
            midi_effects_field: 0, audio_effects_field: 0, param_collection_field: 0, sample_collection_field: 0,
            sidechain_collection_field: 0, record_collection_field: 0, buffer_collection_field: 0, data_changed_index: 0,
            release_all_index: 0, table_changed_index: 1
        }
    }

    fn device() -> GraphBox {
        graph_box(DEV, "SamplerDeviceBox", &[(ZONES, FieldValue::Hook), (GROUPS, FieldValue::Hook)])
    }

    fn zone(uuid: Uuid, owner: bool, file: Option<Uuid>, group: Option<Uuid>, key_low: i32, tune: f32, reverse: bool) -> GraphBox {
        graph_box(uuid, "SamplerZoneBox", &[
            (OWNER, FieldValue::Pointer(owner.then(|| Address::of(DEV, vec![ZONES])))),
            (FILE, FieldValue::Pointer(file.map(|target| Address::of(target, vec![])))),
            (GROUP, FieldValue::Pointer(group.map(|target| Address::of(target, vec![2])))),
            (KEY_LOW, FieldValue::Int32(key_low)), (TUNE, FieldValue::Float32(tune)), (REVERSE, FieldValue::Boolean(reverse))
        ])
    }

    fn group(uuid: Uuid, owner: bool, index: i32, choke: i32) -> GraphBox {
        graph_box(uuid, "SamplerGroupBox", &[
            (OWNER, FieldValue::Pointer(owner.then(|| Address::of(DEV, vec![GROUPS])))),
            (2, FieldValue::Hook), (GROUP_INDEX, FieldValue::Int32(index)), (CHOKE, FieldValue::Int32(choke))
        ])
    }

    fn file(uuid: Uuid) -> GraphBox {graph_box(uuid, "AudioFileBox", &[])}

    fn values() -> Vec<TableColumn> {
        vec![TableColumn::value(KEY_LOW), TableColumn::value(TUNE), TableColumn::value(REVERSE)]
    }

    fn obs(path: u16, columns: Vec<TableColumn>) -> TableObs {TableObs {path: vec![path], columns}}

    struct Fixture {
        engine: Engine,
        binding: TableBinding,
        signals: Rc<Cell<u32>>
    }

    impl Fixture {
        fn new(boxes: Vec<GraphBox>, observed: Vec<TableObs>) -> Self {
            take();
            let mut engine = Engine::new(48_000.0);
            engine.graph = BoxGraph::from_boxes(boxes);
            let signals = Rc::new(Cell::new(0));
            let counter = signals.clone();
            let binding = engine.bind_tables(DEV, reg(), STATE, observed, Rc::new(move || counter.set(counter.get() + 1)));
            Self {engine, binding, signals}
        }

        fn edit(&mut self, updates: &[Update]) {
            self.engine.graph.transaction(updates, &self.engine.registry).expect("transaction");
        }

        fn set_int(&mut self, uuid: Uuid, key: u16, old: i32, new: i32) {
            self.edit(&[Update::Primitive {address: Address::of(uuid, vec![key]), old: FieldValue::Int32(old), new: FieldValue::Int32(new)}]);
        }

        fn point(&mut self, uuid: Uuid, key: u16, old: Option<Address>, new: Option<Address>) {
            self.edit(&[Update::Pointer {address: Address::of(uuid, vec![key]), old, new}]);
        }

        fn flush(&mut self) -> Vec<Delivery> {
            self.engine.flush_table_binding(DEV, reg(), STATE, &mut self.binding);
            take()
        }
    }

    fn zones_hub() -> Option<Address> {Some(Address::of(DEV, vec![ZONES]))}
    fn groups_hub() -> Option<Address> {Some(Address::of(DEV, vec![GROUPS]))}
    fn file_address(uuid: Uuid) -> Option<Address> {Some(Address::of(uuid, vec![]))}
    fn group_address(uuid: Uuid) -> Option<Address> {Some(Address::of(uuid, vec![2]))}
    fn handle_of(uuid: Uuid) -> u32 {unsafe { SAMPLES.get() }.request(uuid)}

    #[test]
    fn an_empty_hub_delivers_a_table_without_rows() {
        let fixture = Fixture::new(vec![device()], vec![obs(ZONES, values())]);
        let first = take();
        assert_eq!(first.len(), 1, "the catch-up is delivered even when nothing is there");
        assert_eq!((first[0].state_ptr, first[0].id, first[0].rows, first[0].columns), (STATE, 0, 0, 3));
        assert!(first[0].words.is_empty());
        assert_eq!(fixture.signals.get(), 0, "binding does not raise the signal");
    }

    #[test]
    fn the_catch_up_holds_every_child_as_int_float_bits_and_bool() {
        Fixture::new(vec![
            device(),
            zone(ZONE_B, true, None, None, -5, -0.5, false),
            zone(ZONE_A, true, None, None, 60, 1.5, true)
        ], vec![obs(ZONES, values())]);
        let first = take();
        assert_eq!(first.len(), 1);
        assert_eq!((first[0].rows, first[0].columns), (2, 3));
        assert_eq!(first[0].words, vec![60, 1.5f32.to_bits(), 1, -5i32 as u32, (-0.5f32).to_bits(), 0],
            "rows by uuid, not by the order the boxes were given");
    }

    #[test]
    fn frame_positions_beyond_the_float_mantissa_stay_exact() {
        Fixture::new(vec![device(), zone(ZONE_A, true, None, None, i32::MAX, 0.0, false)],
            vec![obs(ZONES, vec![TableColumn::value(KEY_LOW)])]);
        assert_eq!(take()[0].words, vec![i32::MAX as u32]);
    }

    #[test]
    fn a_field_the_child_does_not_have_is_none() {
        Fixture::new(vec![device(), zone(ZONE_A, true, None, None, 1, 0.0, false)],
            vec![obs(ZONES, vec![TableColumn::value(KEY_LOW), TableColumn::value(999)])]);
        assert_eq!(take()[0].words, vec![1, TABLE_NONE]);
    }

    #[test]
    fn a_table_without_columns_still_counts_its_rows() {
        Fixture::new(vec![device(), zone(ZONE_A, true, None, None, 1, 0.0, false), zone(ZONE_B, true, None, None, 2, 0.0, false)],
            vec![obs(ZONES, Vec::new())]);
        let first = take();
        assert_eq!((first[0].rows, first[0].columns), (2, 0));
        assert!(first[0].words.is_empty());
    }

    #[test]
    fn a_child_of_another_hub_is_not_in_the_table() {
        Fixture::new(vec![device(), zone(ZONE_A, true, None, None, 7, 0.0, false), group(GROUP_A, true, 0, 0)],
            vec![obs(ZONES, vec![TableColumn::value(KEY_LOW)])]);
        let first = take();
        assert_eq!(first[0].rows, 1, "the group hangs on the groups hub");
        assert_eq!(first[0].words, vec![7]);
    }

    #[test]
    fn a_child_that_is_not_attached_is_not_in_the_table() {
        Fixture::new(vec![device(), zone(ZONE_A, false, None, None, 7, 0.0, false)], vec![obs(ZONES, values())]);
        assert_eq!(take()[0].rows, 0);
    }

    #[test]
    fn a_value_edit_signals_and_delivers_exactly_one_snapshot() {
        let mut fixture = Fixture::new(vec![device(), zone(ZONE_A, true, None, None, 10, 0.0, false)], vec![obs(ZONES, values())]);
        take();
        fixture.set_int(ZONE_A, KEY_LOW, 10, 11);
        assert_eq!(fixture.signals.get(), 1, "the edit raises the signal");
        assert!(take().is_empty(), "nothing is delivered before the flush");
        let edited = fixture.flush();
        assert_eq!(edited.len(), 1);
        assert_eq!(edited[0].words[0], 11);
        assert!(fixture.flush().is_empty(), "a clean binding delivers nothing");
    }

    #[test]
    fn float_and_bool_edits_are_followed() {
        let mut fixture = Fixture::new(vec![device(), zone(ZONE_A, true, None, None, 10, 0.25, false)], vec![obs(ZONES, values())]);
        take();
        fixture.edit(&[Update::Primitive {address: Address::of(ZONE_A, vec![TUNE]), old: FieldValue::Float32(0.25), new: FieldValue::Float32(-12.5)}]);
        fixture.edit(&[Update::Primitive {address: Address::of(ZONE_A, vec![REVERSE]), old: FieldValue::Boolean(false), new: FieldValue::Boolean(true)}]);
        let edited = fixture.flush();
        assert_eq!(edited.len(), 1);
        assert_eq!(edited[0].words, vec![10, (-12.5f32).to_bits(), 1]);
    }

    #[test]
    fn many_edits_in_one_transaction_make_one_snapshot() {
        let mut fixture = Fixture::new(vec![
            device(), zone(ZONE_A, true, None, None, 10, 0.0, false), zone(ZONE_B, true, None, None, 20, 0.0, false)
        ], vec![obs(ZONES, vec![TableColumn::value(KEY_LOW)])]);
        take();
        fixture.edit(&[
            Update::Primitive {address: Address::of(ZONE_A, vec![KEY_LOW]), old: FieldValue::Int32(10), new: FieldValue::Int32(11)},
            Update::Primitive {address: Address::of(ZONE_B, vec![KEY_LOW]), old: FieldValue::Int32(20), new: FieldValue::Int32(21)}
        ]);
        let edited = fixture.flush();
        assert_eq!(edited.len(), 1);
        assert_eq!(edited[0].words, vec![11, 21]);
    }

    #[test]
    fn edits_across_transactions_before_a_flush_make_one_snapshot() {
        let mut fixture = Fixture::new(vec![device(), zone(ZONE_A, true, None, None, 10, 0.0, false)],
            vec![obs(ZONES, vec![TableColumn::value(KEY_LOW)])]);
        take();
        fixture.set_int(ZONE_A, KEY_LOW, 10, 11);
        fixture.set_int(ZONE_A, KEY_LOW, 11, 12);
        let edited = fixture.flush();
        assert_eq!(edited.len(), 1);
        assert_eq!(edited[0].words, vec![12], "only the last state is delivered");
    }

    #[test]
    fn an_edit_of_a_field_that_is_not_observed_is_ignored() {
        let mut fixture = Fixture::new(vec![device(), zone(ZONE_A, true, None, None, 10, 0.0, false)],
            vec![obs(ZONES, vec![TableColumn::value(KEY_LOW)])]);
        take();
        fixture.edit(&[Update::Primitive {address: Address::of(ZONE_A, vec![TUNE]), old: FieldValue::Float32(0.0), new: FieldValue::Float32(5.0)}]);
        assert_eq!(fixture.signals.get(), 0);
        assert!(fixture.flush().is_empty());
    }

    #[test]
    fn a_child_that_joins_is_delivered_and_watched_from_then_on() {
        let mut fixture = Fixture::new(vec![
            device(), zone(ZONE_A, true, None, None, 10, 0.0, false), zone(ZONE_C, false, None, None, 30, 0.0, false)
        ], vec![obs(ZONES, vec![TableColumn::value(KEY_LOW)])]);
        assert_eq!(take()[0].words, vec![10]);
        fixture.point(ZONE_C, OWNER, None, zones_hub());
        assert_eq!(fixture.signals.get(), 1, "joining raises the signal");
        assert_eq!(fixture.flush()[0].words, vec![10, 30]);
        let before = fixture.signals.get();
        fixture.set_int(ZONE_C, KEY_LOW, 30, 31);
        assert!(fixture.signals.get() > before, "the joined child's fields are watched after the re-subscribe");
        assert_eq!(fixture.flush()[0].words, vec![10, 31]);
    }

    #[test]
    fn a_child_that_leaves_loses_its_row_and_goes_silent() {
        let mut fixture = Fixture::new(vec![
            device(), zone(ZONE_A, true, None, None, 10, 0.0, false), zone(ZONE_B, true, None, None, 20, 0.0, false)
        ], vec![obs(ZONES, vec![TableColumn::value(KEY_LOW)])]);
        take();
        fixture.point(ZONE_A, OWNER, zones_hub(), None);
        let left = fixture.flush();
        assert_eq!((left[0].rows, left[0].words.clone()), (1, vec![20]));
        let before = fixture.signals.get();
        fixture.set_int(ZONE_A, KEY_LOW, 10, 99);
        assert_eq!(fixture.signals.get(), before, "a child that left is no longer watched");
        assert!(fixture.flush().is_empty());
    }

    #[test]
    fn the_last_child_leaving_delivers_an_empty_table() {
        let mut fixture = Fixture::new(vec![device(), zone(ZONE_A, true, None, None, 10, 0.0, false)], vec![obs(ZONES, values())]);
        take();
        fixture.point(ZONE_A, OWNER, zones_hub(), None);
        let left = fixture.flush();
        assert_eq!((left.len(), left[0].rows, left[0].columns), (1, 0, 3));
        assert!(left[0].words.is_empty());
    }

    #[test]
    fn a_child_that_leaves_and_returns_is_watched_again() {
        let mut fixture = Fixture::new(vec![device(), zone(ZONE_A, true, None, None, 10, 0.0, false)],
            vec![obs(ZONES, vec![TableColumn::value(KEY_LOW)])]);
        take();
        fixture.point(ZONE_A, OWNER, zones_hub(), None);
        fixture.flush();
        fixture.point(ZONE_A, OWNER, None, zones_hub());
        assert_eq!(fixture.flush()[0].words, vec![10]);
        fixture.set_int(ZONE_A, KEY_LOW, 10, 12);
        assert_eq!(fixture.flush()[0].words, vec![12]);
    }

    #[test]
    fn leaving_and_returning_before_a_flush_keeps_the_child_watched() {
        let mut fixture = Fixture::new(vec![device(), zone(ZONE_A, true, None, None, 10, 0.0, false)],
            vec![obs(ZONES, vec![TableColumn::value(KEY_LOW)])]);
        take();
        fixture.point(ZONE_A, OWNER, zones_hub(), None);
        fixture.point(ZONE_A, OWNER, None, zones_hub());
        let back = fixture.flush();
        assert_eq!((back.len(), back[0].words.clone()), (1, vec![10]));
        fixture.set_int(ZONE_A, KEY_LOW, 10, 13);
        assert_eq!(fixture.flush()[0].words, vec![13]);
    }

    #[test]
    fn a_sample_column_delivers_the_handle_and_queues_the_load() {
        Fixture::new(vec![device(), file(FILE_A), zone(ZONE_A, true, Some(FILE_A), None, 0, 0.0, false)],
            vec![obs(ZONES, vec![TableColumn::sample(FILE)])]);
        let first = take();
        assert_eq!(first[0].words, vec![handle_of(FILE_A)]);
        assert_eq!(unsafe { SAMPLES.get() }.take_pending().map(|(_, uuid)| uuid), Some(FILE_A), "the file is requested from the host");
        assert!(unsafe { SAMPLES.get() }.take_pending().is_none(), "and only once");
    }

    #[test]
    fn children_on_the_same_file_share_one_handle() {
        Fixture::new(vec![
            device(), file(FILE_A),
            zone(ZONE_A, true, Some(FILE_A), None, 0, 0.0, false), zone(ZONE_B, true, Some(FILE_A), None, 0, 0.0, false)
        ], vec![obs(ZONES, vec![TableColumn::sample(FILE)])]);
        let first = take();
        assert_eq!(first[0].words[0], first[0].words[1]);
        unsafe { SAMPLES.get() }.take_pending();
        assert!(unsafe { SAMPLES.get() }.take_pending().is_none(), "one file, one load");
    }

    #[test]
    fn an_unbound_sample_is_none() {
        Fixture::new(vec![device(), zone(ZONE_A, true, None, None, 0, 0.0, false)],
            vec![obs(ZONES, vec![TableColumn::sample(FILE)])]);
        assert_eq!(take()[0].words, vec![TABLE_NONE]);
    }

    #[test]
    fn a_sample_follows_set_repoint_and_clear() {
        let mut fixture = Fixture::new(vec![device(), file(FILE_A), file(FILE_B), zone(ZONE_A, true, None, None, 0, 0.0, false)],
            vec![obs(ZONES, vec![TableColumn::sample(FILE), TableColumn::value(KEY_LOW)])]);
        take();
        fixture.point(ZONE_A, FILE, None, file_address(FILE_A));
        assert_eq!(fixture.flush()[0].words[0], handle_of(FILE_A));
        fixture.point(ZONE_A, FILE, file_address(FILE_A), file_address(FILE_B));
        let repointed = fixture.flush();
        assert_eq!(repointed[0].words[0], handle_of(FILE_B));
        assert_ne!(handle_of(FILE_A), handle_of(FILE_B));
        fixture.point(ZONE_A, FILE, file_address(FILE_B), None);
        assert_eq!(fixture.flush()[0].words[0], TABLE_NONE);
        fixture.set_int(ZONE_A, KEY_LOW, 0, 4);
        assert_eq!(fixture.flush()[0].words, vec![TABLE_NONE, 4], "value edits are still followed after the pointer moved");
    }

    #[test]
    fn a_target_column_delivers_the_targets_field() {
        Fixture::new(vec![
            device(), group(GROUP_A, true, 3, 0), group(GROUP_B, true, 8, 0),
            zone(ZONE_A, true, None, Some(GROUP_B), 0, 0.0, false), zone(ZONE_B, true, None, Some(GROUP_A), 0, 0.0, false),
            zone(ZONE_C, true, None, None, 0, 0.0, false)
        ], vec![obs(ZONES, vec![TableColumn::target(GROUP, GROUP_INDEX)])]);
        assert_eq!(take()[0].words, vec![8, 3, TABLE_NONE], "each zone reads the index of its own group, an unbound one none");
    }

    #[test]
    fn a_target_without_the_field_is_none() {
        Fixture::new(vec![device(), group(GROUP_A, true, 3, 0), zone(ZONE_A, true, None, Some(GROUP_A), 0, 0.0, false)],
            vec![obs(ZONES, vec![TableColumn::target(GROUP, 999)])]);
        assert_eq!(take()[0].words, vec![TABLE_NONE]);
    }

    #[test]
    fn a_target_field_that_is_not_an_int_is_none() {
        Fixture::new(vec![device(), group(GROUP_A, true, 3, 0), zone(ZONE_A, true, None, Some(GROUP_A), 0, 0.0, false)],
            vec![obs(ZONES, vec![TableColumn::target(GROUP, 2)])]);
        assert_eq!(take()[0].words, vec![TABLE_NONE], "the hub field is no int");
    }

    #[test]
    fn an_edit_of_the_targets_field_is_followed() {
        let mut fixture = Fixture::new(vec![device(), group(GROUP_A, true, 3, 0), zone(ZONE_A, true, None, Some(GROUP_A), 0, 0.0, false)],
            vec![obs(ZONES, vec![TableColumn::target(GROUP, GROUP_INDEX)])]);
        take();
        fixture.set_int(GROUP_A, GROUP_INDEX, 3, 5);
        assert_eq!(fixture.signals.get(), 1);
        assert_eq!(fixture.flush()[0].words, vec![5]);
    }

    #[test]
    fn an_edit_of_another_field_of_the_target_is_ignored() {
        let mut fixture = Fixture::new(vec![device(), group(GROUP_A, true, 3, 0), zone(ZONE_A, true, None, Some(GROUP_A), 0, 0.0, false)],
            vec![obs(ZONES, vec![TableColumn::target(GROUP, GROUP_INDEX)])]);
        take();
        fixture.set_int(GROUP_A, CHOKE, 0, 1);
        assert_eq!(fixture.signals.get(), 0);
    }

    #[test]
    fn a_repointed_target_swaps_what_is_watched() {
        let mut fixture = Fixture::new(vec![
            device(), group(GROUP_A, true, 3, 0), group(GROUP_B, true, 8, 0), zone(ZONE_A, true, None, Some(GROUP_A), 0, 0.0, false)
        ], vec![obs(ZONES, vec![TableColumn::target(GROUP, GROUP_INDEX)])]);
        take();
        fixture.point(ZONE_A, GROUP, group_address(GROUP_A), group_address(GROUP_B));
        assert_eq!(fixture.flush()[0].words, vec![8]);
        let before = fixture.signals.get();
        fixture.set_int(GROUP_A, GROUP_INDEX, 3, 4);
        assert_eq!(fixture.signals.get(), before, "the old target is no longer watched");
        fixture.set_int(GROUP_B, GROUP_INDEX, 8, 9);
        assert!(fixture.signals.get() > before, "the new target is");
        assert_eq!(fixture.flush()[0].words, vec![9]);
    }

    #[test]
    fn a_cleared_target_is_none_and_can_be_set_again() {
        let mut fixture = Fixture::new(vec![device(), group(GROUP_A, true, 3, 0), zone(ZONE_A, true, None, Some(GROUP_A), 0, 0.0, false)],
            vec![obs(ZONES, vec![TableColumn::target(GROUP, GROUP_INDEX)])]);
        take();
        fixture.point(ZONE_A, GROUP, group_address(GROUP_A), None);
        assert_eq!(fixture.flush()[0].words, vec![TABLE_NONE]);
        fixture.point(ZONE_A, GROUP, None, group_address(GROUP_A));
        assert_eq!(fixture.flush()[0].words, vec![3]);
        fixture.set_int(GROUP_A, GROUP_INDEX, 3, 6);
        assert_eq!(fixture.flush()[0].words, vec![6]);
    }

    #[test]
    fn two_children_on_one_target_both_follow_it() {
        let mut fixture = Fixture::new(vec![
            device(), group(GROUP_A, true, 3, 0),
            zone(ZONE_A, true, None, Some(GROUP_A), 0, 0.0, false), zone(ZONE_B, true, None, Some(GROUP_A), 0, 0.0, false)
        ], vec![obs(ZONES, vec![TableColumn::target(GROUP, GROUP_INDEX)])]);
        take();
        fixture.set_int(GROUP_A, GROUP_INDEX, 3, 7);
        let edited = fixture.flush();
        assert_eq!((edited.len(), edited[0].words.clone()), (1, vec![7, 7]));
    }

    #[test]
    fn tables_get_their_ids_in_declaration_order() {
        Fixture::new(vec![device(), zone(ZONE_A, true, None, None, 10, 0.0, false), group(GROUP_A, true, 2, 5)],
            vec![obs(ZONES, vec![TableColumn::value(KEY_LOW)]), obs(GROUPS, vec![TableColumn::value(GROUP_INDEX), TableColumn::value(CHOKE)])]);
        let first = take();
        assert_eq!(first.len(), 2);
        assert_eq!((first[0].id, first[0].columns, first[0].words.clone()), (0, 1, vec![10]));
        assert_eq!((first[1].id, first[1].columns, first[1].words.clone()), (1, 2, vec![2, 5]));
    }

    #[test]
    fn only_the_table_that_changed_is_delivered() {
        let mut fixture = Fixture::new(vec![device(), zone(ZONE_A, true, None, None, 10, 0.0, false), group(GROUP_A, true, 2, 5)],
            vec![obs(ZONES, vec![TableColumn::value(KEY_LOW)]), obs(GROUPS, vec![TableColumn::value(CHOKE)])]);
        take();
        fixture.set_int(GROUP_A, CHOKE, 5, 6);
        let edited = fixture.flush();
        assert_eq!(edited.len(), 1);
        assert_eq!((edited[0].id, edited[0].words.clone()), (1, vec![6]));
    }

    #[test]
    fn a_box_seen_by_two_tables_updates_both() {
        let mut fixture = Fixture::new(vec![device(), group(GROUP_A, true, 2, 5), zone(ZONE_A, true, None, Some(GROUP_A), 0, 0.0, false)],
            vec![obs(ZONES, vec![TableColumn::target(GROUP, GROUP_INDEX)]), obs(GROUPS, vec![TableColumn::value(GROUP_INDEX)])]);
        take();
        fixture.set_int(GROUP_A, GROUP_INDEX, 2, 4);
        let edited = fixture.flush();
        assert_eq!(edited.len(), 2, "the group's own row and the zone that reads it");
        assert_eq!((edited[0].id, edited[0].words.clone()), (0, vec![4]));
        assert_eq!((edited[1].id, edited[1].words.clone()), (1, vec![4]));
    }

    #[test]
    fn the_same_hub_observed_twice_is_two_tables() {
        let mut fixture = Fixture::new(vec![device(), zone(ZONE_A, true, None, None, 10, 2.0, false)],
            vec![obs(ZONES, vec![TableColumn::value(KEY_LOW)]), obs(ZONES, vec![TableColumn::value(TUNE)])]);
        let first = take();
        assert_eq!((first[0].words.clone(), first[1].words.clone()), (vec![10], vec![2.0f32.to_bits()]));
        fixture.set_int(ZONE_A, KEY_LOW, 10, 11);
        let edited = fixture.flush();
        assert_eq!((edited.len(), edited[0].id), (1, 0), "only the table that observes the field");
    }

    #[test]
    fn the_device_reads_the_words_the_binding_keeps() {
        let mut fixture = Fixture::new(vec![device(), zone(ZONE_A, true, None, None, 10, 0.0, false)],
            vec![obs(ZONES, vec![TableColumn::value(KEY_LOW)])]);
        let first = take();
        assert_eq!(first[0].ptr, fixture.binding.tables[0].words.as_ptr() as usize, "no copy between delivery and storage");
        fixture.set_int(ZONE_A, KEY_LOW, 10, 11);
        let edited = fixture.flush();
        assert_eq!(edited[0].ptr, fixture.binding.tables[0].words.as_ptr() as usize);
        assert_eq!(fixture.binding.tables[0].words, vec![11]);
    }

    #[test]
    fn a_torn_down_binding_is_silent() {
        let fixture = Fixture::new(vec![
            device(), group(GROUP_A, true, 3, 0), zone(ZONE_A, true, None, Some(GROUP_A), 10, 0.0, false),
            zone(ZONE_C, false, None, None, 30, 0.0, false)
        ], vec![obs(ZONES, vec![TableColumn::value(KEY_LOW), TableColumn::target(GROUP, GROUP_INDEX)])]);
        take();
        let Fixture {mut engine, binding, signals} = fixture;
        engine.teardown_tables(binding);
        let edit = |engine: &mut Engine, updates: &[Update]| engine.graph.transaction(updates, &engine.registry).expect("transaction");
        edit(&mut engine, &[Update::Primitive {address: Address::of(ZONE_A, vec![KEY_LOW]), old: FieldValue::Int32(10), new: FieldValue::Int32(11)}]);
        edit(&mut engine, &[Update::Primitive {address: Address::of(GROUP_A, vec![GROUP_INDEX]), old: FieldValue::Int32(3), new: FieldValue::Int32(4)}]);
        edit(&mut engine, &[Update::Pointer {address: Address::of(ZONE_C, vec![OWNER]), old: None, new: zones_hub()}]);
        assert_eq!(signals.get(), 0, "no value, target or hub subscription is left");
        assert!(take().is_empty());
    }

    #[test]
    fn a_child_moving_to_another_hub_changes_both_tables() {
        let mut fixture = Fixture::new(vec![device(), zone(ZONE_A, true, None, None, 10, 0.0, false)],
            vec![obs(ZONES, vec![TableColumn::value(KEY_LOW)]), obs(GROUPS, vec![TableColumn::value(KEY_LOW)])]);
        take();
        fixture.point(ZONE_A, OWNER, zones_hub(), groups_hub());
        let moved = fixture.flush();
        assert_eq!(moved.len(), 2);
        assert_eq!((moved[0].rows, moved[1].rows, moved[1].words.clone()), (0, 1, vec![10]));
    }

    #[test]
    fn an_observation_records_path_and_columns_and_counts_ids() {
        unsafe { crate::TABLE_OBS.get() }.clear();
        let columns = [TableColumn::value(KEY_LOW), TableColumn::sample(FILE), TableColumn::target(GROUP, GROUP_INDEX)];
        let first = crate::record_table_obs(&[ZONES], &columns);
        let second = crate::record_table_obs(&[ZONES], &[]);
        let recorded = unsafe { crate::TABLE_OBS.get() };
        assert_eq!((first, second), (0, 1));
        assert_eq!(recorded[0].path, vec![ZONES]);
        assert_eq!(recorded[0].columns, columns.to_vec());
        assert_eq!(recorded[0].columns[1].kind, TABLE_SAMPLE);
        assert_eq!(recorded[0].columns[0].kind, TABLE_VALUE);
        assert!(recorded[1].columns.is_empty());
    }
}
