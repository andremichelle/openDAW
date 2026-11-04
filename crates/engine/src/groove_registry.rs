//! The GROOVE REGISTRY: every groove of the project's groove list (`RootBox.grooves`), kept in sync with
//! the box graph inside subscription dispatch (off the render path). Devices reach a groove through the
//! `host_groove_warp` / `host_groove_unwarp` imports by a slot that follows their groove pointer. Mirrors
//! the TS groove adapters (`CellGrooveBoxAdapter`, `GrooveStackBoxAdapter`).

use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::rc::Rc;
use alloc::vec;
use alloc::vec::Vec;
use core::cell::RefCell;
use boxgraph::address::{Address, Uuid};
use boxgraph::field::FieldValue;
use boxgraph::graph::BoxGraph;
use boxgraph::subscription::{Deferred, HubEvent, Propagation, SubscriptionId};
use dsp::groove::{blend_fx, blend_fy, cell, fill_random_values, moebius, random_value_count, squash_unit, Curve};

// WASM CONTRACT: generated box field keys (studio-boxes). Keep in lockstep with the forge schema.
pub(crate) const ROOT_GROOVES: u16 = 12; // RootBox.grooves
const GROOVE_AMOUNT: u16 = 10; // Float32 on every cell groove
const GROOVE_DURATION: u16 = 11; // Int32 ppqn on every cell groove
const FUNCTION_TYPE: u16 = 12; // GrooveFunctionBox.function: 0 power, 1 s-curve
const RANDOM_SEED: u16 = 12; // GrooveRandomBox.seed (Int32)
const RANDOM_ROUGHNESS: u16 = 13; // GrooveRandomBox.roughness (Float32)
const RANDOM_STEPS: u16 = 14; // GrooveRandomBox.steps (Int32)
const STACK_ENTRIES: u16 = 10; // GrooveStackBox.entries (hub)
const ENTRY_GROOVE: u16 = 2; // GrooveStackEntryBox.groove (pointer)
const ENTRY_INDEX: u16 = 3; // GrooveStackEntryBox.index (Int32)
// WASM CONTRACT: the forge schema defaults (GrooveBoxes.ts), read when a field is missing
const SHUFFLE_DEFAULTS: (f32, i32) = (0.6, 480);
const FUNCTION_DEFAULTS: (f32, i32) = (0.75, 960);
const RANDOM_DEFAULTS: (f32, i32) = (0.75, 3840);
const RANDOM_DEFAULT_SEED: i32 = 1;
const RANDOM_DEFAULT_ROUGHNESS: f32 = 1.0;
const RANDOM_DEFAULT_STEPS: i32 = 64;
// A stack never holds itself (the editing functions refuse it), this only guards a broken document
const MAX_DEPTH: u32 = 16;

#[derive(Clone, Debug, PartialEq)]
pub enum GrooveDef {
    Shuffle {h: f64, duration: f64},
    Function {s_curve: bool, amount: f64, duration: f64},
    Random {values: Vec<f64>, amount: f64, duration: f64},
    Stack {members: Vec<Uuid>}
}

#[derive(Default)]
struct State {
    defs: BTreeMap<Uuid, GrooveDef>,
    subs: BTreeMap<Uuid, Vec<SubscriptionId>>,
    // a stack entry's subscription by entry, with the stack it belongs to, released with either
    entry_subs: BTreeMap<Uuid, (Uuid, SubscriptionId)>
}

/// A cheap handle on the registry, the `host_groove_*` imports read it during render.
#[derive(Clone)]
pub struct GrooveRegistry {
    state: Rc<RefCell<State>>,
    deferred: Deferred
}

impl GrooveRegistry {
    pub fn warp(&self, groove: &Uuid, position: f64) -> f64 {
        warp(&self.state.borrow().defs, groove, position, true, 0)
    }

    pub fn unwarp(&self, groove: &Uuid, position: f64) -> f64 {
        warp(&self.state.borrow().defs, groove, position, false, 0)
    }

    pub fn def(&self, groove: &Uuid) -> Option<GrooveDef> {
        self.state.borrow().defs.get(groove).cloned()
    }

    /// Follow a groove a device points to that is not in the list (a document from before the list, or from
    /// an older peer). Its subscriptions register with the next deferred flush.
    pub fn ensure(&self, graph: &BoxGraph, groove: Uuid) {
        if !self.state.borrow().subs.contains_key(&groove) {
            join(&self.state, &self.deferred, graph, groove);
        }
    }

    /// Observe the root's groove list. Each member box and, for a stack, its entries hub and every entry box
    /// are watched, any change re-reads that groove.
    pub fn observe(graph: &mut BoxGraph, root: Uuid) -> (Self, SubscriptionId) {
        let state = Rc::new(RefCell::new(State::default()));
        let hub_state = state.clone();
        let deferred = graph.deferred();
        let hub_deferred = deferred.clone();
        let subscription = graph.subscribe_pointer_hub(Address::of(root, vec![ROOT_GROOVES]),
            Box::new(move |graph, event| match event {
                HubEvent::Added(source) => {
                    if !hub_state.borrow().subs.contains_key(&source.uuid) {
                        join(&hub_state, &hub_deferred, graph, source.uuid)
                    }
                }
                // a groove that leaves the list but still exists stays followed, devices and stacks may use it
                HubEvent::Removed(source) => if graph.find_box(&source.uuid).is_none() {
                    leave(&hub_state, &hub_deferred, source.uuid)
                }
            }));
        graph.apply_deferred();
        (Self {state, deferred}, subscription)
    }
}

fn warp(defs: &BTreeMap<Uuid, GrooveDef>, groove: &Uuid, position: f64, forward: bool, depth: u32) -> f64 {
    let Some(def) = defs.get(groove) else { return position };
    match def {
        GrooveDef::Shuffle {h, duration} => {
            let h = if forward { *h } else { 1.0 - *h };
            cell(position, *duration, |x| moebius(x, h))
        }
        GrooveDef::Function {s_curve, amount, duration} => {
            let curve = if *s_curve { Curve::SCurve } else { Curve::Power };
            cell(position, *duration, |x| if forward { blend_fx(curve, *amount, x) } else { blend_fy(curve, *amount, x) })
        }
        GrooveDef::Random {values, amount, duration} => {
            let curve = Curve::Table(values);
            cell(position, *duration, |x| if forward { blend_fx(curve, *amount, x) } else { blend_fy(curve, *amount, x) })
        }
        GrooveDef::Stack {members} => {
            if depth >= MAX_DEPTH {
                return position;
            }
            if forward {
                members.iter().fold(position, |value, member| warp(defs, member, value, true, depth + 1))
            } else {
                members.iter().rev().fold(position, |value, member| warp(defs, member, value, false, depth + 1))
            }
        }
    }
}

fn read(graph: &BoxGraph, groove: Uuid) -> Option<GrooveDef> {
    let graph_box = graph.find_box(&groove)?;
    let float = |key: u16, default: f32| graph.field_value(&Address::of(groove, vec![key]))
        .and_then(FieldValue::as_float32).unwrap_or(default) as f64;
    let int = |key: u16, default: i32| graph.field_value(&Address::of(groove, vec![key]))
        .and_then(FieldValue::as_int32).unwrap_or(default);
    match graph_box.name.as_str() {
        "GrooveShuffleBox" => Some(GrooveDef::Shuffle {
            h: squash_unit(float(GROOVE_AMOUNT, SHUFFLE_DEFAULTS.0)),
            duration: int(GROOVE_DURATION, SHUFFLE_DEFAULTS.1) as f64
        }),
        "GrooveFunctionBox" => Some(GrooveDef::Function {
            s_curve: int(FUNCTION_TYPE, 0) == 1,
            amount: float(GROOVE_AMOUNT, FUNCTION_DEFAULTS.0),
            duration: int(GROOVE_DURATION, FUNCTION_DEFAULTS.1) as f64
        }),
        "GrooveRandomBox" => {
            let steps = int(RANDOM_STEPS, RANDOM_DEFAULT_STEPS);
            let mut values = vec![0.0; random_value_count(steps)];
            fill_random_values(int(RANDOM_SEED, RANDOM_DEFAULT_SEED), steps,
                float(RANDOM_ROUGHNESS, RANDOM_DEFAULT_ROUGHNESS), &mut values);
            Some(GrooveDef::Random {
                values,
                amount: float(GROOVE_AMOUNT, RANDOM_DEFAULTS.0),
                duration: int(GROOVE_DURATION, RANDOM_DEFAULTS.1) as f64
            })
        }
        "GrooveStackBox" => {
            let mut entries: Vec<(i32, Uuid)> = graph.incoming(&Address::of(groove, vec![STACK_ENTRIES])).into_iter()
                .filter_map(|source| {
                    let member = graph.target_of(&Address::of(source.uuid, vec![ENTRY_GROOVE]))?.uuid;
                    let index = graph.field_value(&Address::of(source.uuid, vec![ENTRY_INDEX]))
                        .and_then(FieldValue::as_int32).unwrap_or(0);
                    Some((index, member))
                })
                .collect();
            entries.sort_by_key(|(index, _)| *index);
            Some(GrooveDef::Stack {members: entries.into_iter().map(|(_, member)| member).collect()})
        }
        _ => None
    }
}

fn update(state: &Rc<RefCell<State>>, deferred: &Deferred, graph: &BoxGraph, groove: Uuid) {
    let def = read(graph, groove);
    // a stack's members are followed even when they are not in the list
    let unknown: Vec<Uuid> = match &def {
        Some(GrooveDef::Stack {members}) => {
            let state = state.borrow();
            members.iter().filter(|member| !state.subs.contains_key(*member)).copied().collect()
        }
        _ => Vec::new()
    };
    {
        let mut state = state.borrow_mut();
        match def {
            Some(def) => {state.defs.insert(groove, def);}
            None => {state.defs.remove(&groove);}
        }
    }
    unknown.into_iter().for_each(|member| {
        if !state.borrow().subs.contains_key(&member) {
            join(state, deferred, graph, member);
        }
    });
}

fn join(state: &Rc<RefCell<State>>, deferred: &Deferred, graph: &BoxGraph, groove: Uuid) {
    state.borrow_mut().subs.insert(groove, Vec::new());
    update(state, deferred, graph, groove);
    let mut subs = Vec::new();
    let box_state = state.clone();
    let box_deferred = deferred.clone();
    subs.push(deferred.subscribe_vertex(Propagation::Parent, Address::box_of(groove),
        Box::new(move |graph, _update| update(&box_state, &box_deferred, graph, groove))));
    if matches!(graph.find_box(&groove).map(|graph_box| graph_box.name.as_str()), Some("GrooveStackBox")) {
        let hub_state = state.clone();
        let hub_deferred = deferred.clone();
        subs.push(deferred.subscribe_pointer_hub(Address::of(groove, vec![STACK_ENTRIES]),
            Box::new(move |graph, event| {
                match event {
                    HubEvent::Added(source) => {
                        let entry = source.uuid;
                        let entry_state = hub_state.clone();
                        let entry_deferred = hub_deferred.clone();
                        let id = hub_deferred.subscribe_vertex(Propagation::Parent, Address::box_of(entry),
                            Box::new(move |graph, _update| update(&entry_state, &entry_deferred, graph, groove)));
                        if let Some((_, previous)) = hub_state.borrow_mut().entry_subs.insert(entry, (groove, id)) {
                            hub_deferred.unsubscribe(previous);
                        }
                    }
                    HubEvent::Removed(source) => {
                        if let Some((_, id)) = hub_state.borrow_mut().entry_subs.remove(&source.uuid) {
                            hub_deferred.unsubscribe(id);
                        }
                    }
                }
                update(&hub_state, &hub_deferred, graph, groove);
            })));
    }
    state.borrow_mut().subs.entry(groove).or_default().extend(subs);
}

fn leave(state: &Rc<RefCell<State>>, deferred: &Deferred, groove: Uuid) {
    let mut state = state.borrow_mut();
    state.defs.remove(&groove);
    if let Some(ids) = state.subs.remove(&groove) {
        ids.into_iter().for_each(|id| deferred.unsubscribe(id));
    }
    let entries: Vec<Uuid> = state.entry_subs.iter()
        .filter(|(_, (stack, _))| *stack == groove)
        .map(|(entry, _)| *entry)
        .collect();
    entries.into_iter().for_each(|entry| {
        if let Some((_, id)) = state.entry_subs.remove(&entry) {
            deferred.unsubscribe(id);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::string::ToString;
    use boxgraph::boxes::{GraphBox, Registry};
    use boxgraph::field::Fields;
    use boxgraph::updates::Update;

    const ROOT: Uuid = [1u8; 16];
    const SHUFFLE: Uuid = [2u8; 16];
    const POWER: Uuid = [3u8; 16];
    const RANDOM: Uuid = [4u8; 16];
    const STACK: Uuid = [5u8; 16];
    const ENTRY_A: Uuid = [6u8; 16];
    const ENTRY_B: Uuid = [7u8; 16];

    fn graph_box(uuid: Uuid, name: &str, fields: &[(u16, FieldValue)]) -> GraphBox {
        let mut map = Fields::new();
        for (key, value) in fields {
            map.insert(*key, value.clone());
        }
        GraphBox {creation_index: 0, name: name.to_string(), uuid, fields: map}
    }

    fn listed() -> (u16, FieldValue) {(2, FieldValue::Pointer(Some(Address::of(ROOT, vec![ROOT_GROOVES]))))}

    fn root() -> GraphBox {graph_box(ROOT, "RootBox", &[(ROOT_GROOVES, FieldValue::Hook)])}

    fn shuffle(amount: f32) -> GraphBox {
        graph_box(SHUFFLE, "GrooveShuffleBox", &[listed(),
            (GROOVE_AMOUNT, FieldValue::Float32(amount)), (GROOVE_DURATION, FieldValue::Int32(480))])
    }

    fn power(amount: f32) -> GraphBox {
        graph_box(POWER, "GrooveFunctionBox", &[listed(), (GROOVE_AMOUNT, FieldValue::Float32(amount)),
            (GROOVE_DURATION, FieldValue::Int32(960)), (FUNCTION_TYPE, FieldValue::Int32(0))])
    }

    fn random() -> GraphBox {
        graph_box(RANDOM, "GrooveRandomBox", &[listed(), (GROOVE_AMOUNT, FieldValue::Float32(0.8)),
            (GROOVE_DURATION, FieldValue::Int32(3840)), (RANDOM_SEED, FieldValue::Int32(7)),
            (RANDOM_ROUGHNESS, FieldValue::Float32(0.5)), (RANDOM_STEPS, FieldValue::Int32(4))])
    }

    fn stack() -> GraphBox {graph_box(STACK, "GrooveStackBox", &[listed(), (STACK_ENTRIES, FieldValue::Hook)])}

    fn entry(uuid: Uuid, member: Uuid, index: i32) -> GraphBox {
        graph_box(uuid, "GrooveStackEntryBox", &[
            (1, FieldValue::Pointer(Some(Address::of(STACK, vec![STACK_ENTRIES])))),
            (ENTRY_GROOVE, FieldValue::Pointer(Some(Address::box_of(member)))),
            (ENTRY_INDEX, FieldValue::Int32(index))
        ])
    }

    #[test]
    fn a_shuffle_warps_like_the_zeitgeist_always_did() {
        let mut graph = BoxGraph::from_boxes(vec![root(), shuffle(0.6)]);
        let (registry, _) = GrooveRegistry::observe(&mut graph, ROOT);
        let h = squash_unit(0.6f32 as f64);
        assert_eq!(registry.warp(&SHUFFLE, 240.0), moebius(0.5, h) * 480.0);
        assert!((registry.unwarp(&SHUFFLE, registry.warp(&SHUFFLE, 300.0)) - 300.0).abs() < 1.0e-9);
        assert_eq!(registry.warp(&[9u8; 16], 240.0), 240.0, "an unknown groove passes through");
    }

    #[test]
    fn field_edits_and_list_membership_update_the_registry() {
        let mut graph = BoxGraph::from_boxes(vec![root(), shuffle(0.6), power(0.5)]);
        let (registry, _) = GrooveRegistry::observe(&mut graph, ROOT);
        assert!((registry.warp(&POWER, 300.0) - 300.0).abs() < 1.0e-9, "50% is straight");
        let schema = Registry::new();
        graph.transaction(&[Update::Primitive {
            address: Address::of(POWER, vec![GROOVE_AMOUNT]), old: FieldValue::Float32(0.5), new: FieldValue::Float32(1.0)
        }], &schema).unwrap();
        assert!(registry.warp(&POWER, 300.0) > 300.0, "power at 100% pushes later");
        graph.transaction(&[Update::Pointer {
            address: Address::of(POWER, vec![2]), old: Some(Address::of(ROOT, vec![ROOT_GROOVES])), new: None
        }], &schema).unwrap();
        assert!(registry.def(&POWER).is_some(), "a groove leaving the list but still existing stays followed");
        graph.transaction(&[Update::Delete {uuid: POWER, name: "GrooveFunctionBox".to_string(), settings: Vec::new()}], &schema)
            .unwrap();
        assert_eq!(registry.def(&POWER), None, "a deleted groove leaves the registry");
    }

    #[test]
    fn a_random_groove_matches_its_curve() {
        let mut graph = BoxGraph::from_boxes(vec![root(), random()]);
        let (registry, _) = GrooveRegistry::observe(&mut graph, ROOT);
        let mut values = [0.0; 5];
        fill_random_values(7, 4, 0.5, &mut values);
        let expected = blend_fx(Curve::Table(&values), 0.8f32 as f64, 0.3) * 3840.0;
        assert_eq!(registry.warp(&RANDOM, 0.3 * 3840.0), expected);
    }

    #[test]
    fn a_stack_chains_its_members_in_entry_order() {
        let mut graph = BoxGraph::from_boxes(vec![root(), shuffle(0.8), power(0.9), stack(),
            entry(ENTRY_A, POWER, 1), entry(ENTRY_B, SHUFFLE, 0)]);
        let (registry, _) = GrooveRegistry::observe(&mut graph, ROOT);
        assert_eq!(registry.def(&STACK), Some(GrooveDef::Stack {members: vec![SHUFFLE, POWER]}));
        for position in [0.0, 100.0, 333.0, 700.0, 1500.0] {
            let expected = registry.warp(&POWER, registry.warp(&SHUFFLE, position));
            assert_eq!(registry.warp(&STACK, position), expected);
            assert!((registry.unwarp(&STACK, registry.warp(&STACK, position)) - position).abs() < 1.0e-6);
        }
        let schema = Registry::new();
        graph.transaction(&[Update::Primitive {
            address: Address::of(ENTRY_A, vec![ENTRY_INDEX]), old: FieldValue::Int32(1), new: FieldValue::Int32(-1)
        }], &schema).unwrap();
        assert_eq!(registry.def(&STACK), Some(GrooveDef::Stack {members: vec![POWER, SHUFFLE]}), "reordering an entry");
    }

    #[test]
    fn follows_grooves_outside_the_list() {
        let unlisted = graph_box(SHUFFLE, "GrooveShuffleBox", &[
            (GROOVE_AMOUNT, FieldValue::Float32(0.8)), (GROOVE_DURATION, FieldValue::Int32(480))]);
        let unlisted_power = graph_box(POWER, "GrooveFunctionBox", &[(GROOVE_AMOUNT, FieldValue::Float32(1.0)),
            (GROOVE_DURATION, FieldValue::Int32(960)), (FUNCTION_TYPE, FieldValue::Int32(0))]);
        let mut graph = BoxGraph::from_boxes(vec![root(), unlisted, unlisted_power, stack(), entry(ENTRY_A, POWER, 0)]);
        let (registry, _) = GrooveRegistry::observe(&mut graph, ROOT);
        assert_eq!(registry.warp(&SHUFFLE, 240.0), 240.0, "unknown until a device points at it");
        registry.ensure(&graph, SHUFFLE);
        graph.apply_deferred();
        assert!(registry.warp(&SHUFFLE, 240.0) > 240.0);
        assert!(registry.warp(&STACK, 300.0) > 300.0, "a listed stack follows its unlisted member");
        let schema = Registry::new();
        graph.transaction(&[Update::Primitive {
            address: Address::of(SHUFFLE, vec![GROOVE_AMOUNT]), old: FieldValue::Float32(0.8), new: FieldValue::Float32(0.5)
        }], &schema).unwrap();
        assert!((registry.warp(&SHUFFLE, 240.0) - 240.0).abs() < 1.0e-9, "an adopted groove follows its edits");
    }

    #[test]
    fn every_type_round_trips_at_extreme_amounts_and_durations() {
        let durations = [240, 480, 960, 1920, 3840, 7680, 15360, 30720, 61440];
        let amounts = [0.0f32, 0.001, 0.01, 0.5, 0.99, 0.999, 1.0];
        for duration in durations {
            for amount in amounts {
                let shuffle = graph_box(SHUFFLE, "GrooveShuffleBox", &[listed(),
                    (GROOVE_AMOUNT, FieldValue::Float32(amount)), (GROOVE_DURATION, FieldValue::Int32(duration))]);
                let power = graph_box(POWER, "GrooveFunctionBox", &[listed(), (GROOVE_AMOUNT, FieldValue::Float32(amount)),
                    (GROOVE_DURATION, FieldValue::Int32(duration)), (FUNCTION_TYPE, FieldValue::Int32(1))]);
                let random = graph_box(RANDOM, "GrooveRandomBox", &[listed(), (GROOVE_AMOUNT, FieldValue::Float32(amount)),
                    (GROOVE_DURATION, FieldValue::Int32(duration)), (RANDOM_SEED, FieldValue::Int32(3)),
                    (RANDOM_ROUGHNESS, FieldValue::Float32(1.0)), (RANDOM_STEPS, FieldValue::Int32(64))]);
                let mut graph = BoxGraph::from_boxes(vec![root(), shuffle, power, random]);
                let (registry, _) = GrooveRegistry::observe(&mut graph, ROOT);
                for groove in [SHUFFLE, POWER, RANDOM] {
                    let tolerance = duration as f64 * 1.0e-9 + 1.0e-9;
                    for cell in 0..3 {
                        let start = (cell * duration) as f64;
                        for offset in [0.0, 1.0e-6, 1.0, 0.25, 0.5, 0.75] {
                            let position = start + if offset < 0.2 { offset } else { offset * duration as f64 };
                            let back = registry.unwarp(&groove, registry.warp(&groove, position));
                            assert!((back - position).abs() < tolerance, "{amount} {duration} {position} -> {back}");
                            let forth = registry.warp(&groove, registry.unwarp(&groove, position));
                            assert!((forth - position).abs() < tolerance, "{amount} {duration} {position} -> {forth}");
                        }
                    }
                }
            }
        }
    }

    fn large_stack(amounts: &[f32]) -> (BoxGraph, GrooveRegistry) {
        let durations = [240, 480, 960, 1920, 3840, 7680, 15360, 30720, 61440];
        let mut boxes = vec![root(), stack()];
        for index in 0..24usize {
            let groove: Uuid = [100 + index as u8; 16];
            let entry_uuid: Uuid = [200 + index as u8; 16];
            let (name, extra) = match index % 3 {
                0 => ("GrooveShuffleBox", vec![]),
                1 => ("GrooveFunctionBox", vec![(FUNCTION_TYPE, FieldValue::Int32((index % 2) as i32))]),
                _ => ("GrooveRandomBox", vec![(RANDOM_SEED, FieldValue::Int32(index as i32)),
                    (RANDOM_ROUGHNESS, FieldValue::Float32(0.8)), (RANDOM_STEPS, FieldValue::Int32(16))])
            };
            let mut fields = vec![listed(), (GROOVE_AMOUNT, FieldValue::Float32(amounts[index % amounts.len()])),
                (GROOVE_DURATION, FieldValue::Int32(durations[index % durations.len()]))];
            fields.extend(extra);
            boxes.push(graph_box(groove, name, &fields));
            boxes.push(entry(entry_uuid, groove, index as i32));
        }
        let mut graph = BoxGraph::from_boxes(boxes);
        let (registry, _) = GrooveRegistry::observe(&mut graph, ROOT);
        match registry.def(&STACK) {
            Some(GrooveDef::Stack {members}) => assert_eq!(members.len(), 24),
            other => panic!("expected a stack, got {other:?}")
        }
        (graph, registry)
    }

    #[test]
    fn a_stack_with_many_entries_round_trips() {
        let (_graph, registry) = large_stack(&[0.25, 0.4, 0.6, 0.75, 0.5, 0.3, 0.7]);
        for position in [0.0, 1.0, 239.0, 240.0, 480.0, 1000.0, 3839.0, 3840.0, 12345.678, 61439.0, 61440.0, 122897.0] {
            let back = registry.unwarp(&STACK, registry.warp(&STACK, position));
            assert!((back - position).abs() < 1.0e-3, "stack {position} -> {back}");
        }
    }

    #[test]
    fn a_stack_of_many_extreme_entries_stays_finite_and_in_order() {
        // many members at 0% and 100% pull a cell onto almost one position, which no unwarp tells apart again
        let (_graph, registry) = large_stack(&[0.0, 0.25, 0.75, 1.0, 0.5, 0.01, 0.99]);
        let mut previous = f64::NEG_INFINITY;
        let mut position = 0.0;
        while position <= 7680.0 {
            let warped = registry.warp(&STACK, position);
            assert!(warped.is_finite() && warped >= previous, "order at {position}");
            assert!(registry.unwarp(&STACK, warped).is_finite());
            previous = warped;
            position += 13.0;
        }
    }

    #[test]
    fn a_stack_holding_itself_cannot_loop() {
        let mut graph = BoxGraph::from_boxes(vec![root(), stack(), entry(ENTRY_A, STACK, 0)]);
        let (registry, _) = GrooveRegistry::observe(&mut graph, ROOT);
        assert_eq!(registry.warp(&STACK, 123.0), 123.0);
    }
}
