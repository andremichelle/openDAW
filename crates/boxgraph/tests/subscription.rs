//! Subscriptions: propagation filtering (This/Parent/Children), all-updates listeners, ordering,
//! and removal — including proof that unsubscribe frees the observer's captured state. Plus one
//! end-to-end check that `BoxGraph::transaction` dispatches to subscribers.

use std::cell::RefCell;
use std::rc::Rc;
use boxgraph::address::Address;
use boxgraph::boxes::{GraphBox, Registry};
use boxgraph::field::{Fields, FieldValue};
use boxgraph::graph::BoxGraph;
use boxgraph::subscription::{Propagation, Subscriptions};
use boxgraph::updates::Update;

fn primitive_at(address: Address) -> Update {
    Update::Primitive {address, old: FieldValue::Int32(0), new: FieldValue::Int32(1)}
}

#[test]
fn this_fires_only_on_the_exact_address() {
    let uuid = [1u8; 16];
    let target = Address::of(uuid, vec![10u16]);
    let mut subscriptions = Subscriptions::new();
    let hits = Rc::new(RefCell::new(0));
    let recorder = hits.clone();
    subscriptions.subscribe_vertex(Propagation::This, target.clone(), Box::new(move |_| *recorder.borrow_mut() += 1));
    subscriptions.dispatch(&primitive_at(target.clone()));
    subscriptions.dispatch(&primitive_at(Address::of(uuid, vec![10u16, 1]))); // child: no
    subscriptions.dispatch(&primitive_at(Address::box_of(uuid))); // ancestor: no
    assert_eq!(*hits.borrow(), 1);
}

#[test]
fn parent_fires_on_self_and_descendants() {
    let uuid = [2u8; 16];
    let monitor = Address::of(uuid, vec![5u16]);
    let mut subscriptions = Subscriptions::new();
    let hits = Rc::new(RefCell::new(0));
    let recorder = hits.clone();
    subscriptions.subscribe_vertex(Propagation::Parent, monitor.clone(), Box::new(move |_| *recorder.borrow_mut() += 1));
    subscriptions.dispatch(&primitive_at(monitor.clone())); // self: yes
    subscriptions.dispatch(&primitive_at(Address::of(uuid, vec![5u16, 7]))); // descendant: yes
    subscriptions.dispatch(&primitive_at(Address::box_of(uuid))); // ancestor: no
    subscriptions.dispatch(&primitive_at(Address::of(uuid, vec![6u16]))); // sibling: no
    assert_eq!(*hits.borrow(), 2);
}

#[test]
fn children_fires_on_self_and_ancestors() {
    let uuid = [3u8; 16];
    let monitor = Address::of(uuid, vec![5u16, 7]);
    let mut subscriptions = Subscriptions::new();
    let hits = Rc::new(RefCell::new(0));
    let recorder = hits.clone();
    subscriptions.subscribe_vertex(Propagation::Children, monitor.clone(), Box::new(move |_| *recorder.borrow_mut() += 1));
    subscriptions.dispatch(&primitive_at(monitor.clone())); // self: yes
    subscriptions.dispatch(&primitive_at(Address::of(uuid, vec![5u16]))); // ancestor: yes
    subscriptions.dispatch(&primitive_at(Address::box_of(uuid))); // ancestor (box): yes
    subscriptions.dispatch(&primitive_at(Address::of(uuid, vec![5u16, 7, 9]))); // descendant: no
    assert_eq!(*hits.borrow(), 3);
}

#[test]
fn all_listener_fires_on_every_update_kind() {
    let uuid = [4u8; 16];
    let mut subscriptions = Subscriptions::new();
    let hits = Rc::new(RefCell::new(0));
    let recorder = hits.clone();
    subscriptions.subscribe_all(Box::new(move |_| *recorder.borrow_mut() += 1));
    subscriptions.dispatch(&primitive_at(Address::of(uuid, vec![1u16])));
    subscriptions.dispatch(&Update::Pointer {address: Address::of(uuid, vec![2u16]), old: None, new: None});
    subscriptions.dispatch(&Update::New {uuid, name: "X".to_string(), settings: Vec::new()});
    subscriptions.dispatch(&Update::Delete {uuid, name: "X".to_string(), settings: Vec::new()});
    assert_eq!(*hits.borrow(), 4);
}

#[test]
fn observers_fire_in_subscription_order() {
    let uuid = [5u8; 16];
    let address = Address::of(uuid, vec![1u16]);
    let mut subscriptions = Subscriptions::new();
    let log = Rc::new(RefCell::new(Vec::<u8>::new()));
    for tag in [1u8, 2, 3] {
        let recorder = log.clone();
        subscriptions.subscribe_vertex(Propagation::This, address.clone(), Box::new(move |_| recorder.borrow_mut().push(tag)));
    }
    subscriptions.dispatch(&primitive_at(address));
    assert_eq!(*log.borrow(), vec![1, 2, 3]);
}

#[test]
fn unsubscribe_stops_notifications_and_frees_the_observer() {
    let uuid = [6u8; 16];
    let address = Address::of(uuid, vec![1u16]);
    let mut subscriptions = Subscriptions::new();
    let hits = Rc::new(RefCell::new(0));
    let recorder = hits.clone();
    let id = subscriptions.subscribe_vertex(Propagation::This, address.clone(), Box::new(move |_| *recorder.borrow_mut() += 1));
    assert_eq!(subscriptions.count(), 1);
    assert_eq!(Rc::strong_count(&hits), 2); // test + observer
    subscriptions.dispatch(&primitive_at(address.clone()));
    assert!(subscriptions.unsubscribe(id));
    assert_eq!(subscriptions.count(), 0);
    assert!(!subscriptions.unsubscribe(id)); // already removed
    subscriptions.dispatch(&primitive_at(address));
    assert_eq!(*hits.borrow(), 1); // not notified after unsubscribe
    assert_eq!(Rc::strong_count(&hits), 1); // observer dropped -> captured state freed
}

#[test]
fn transaction_dispatches_to_subscribers_and_applies_the_value() {
    let uuid = [7u8; 16];
    let mut fields = Fields::new();
    fields.insert(1u16, FieldValue::Int32(5));
    let mut graph = BoxGraph::from_boxes(vec![GraphBox {creation_index: 0, name: "Test".to_string(), uuid, fields}]);
    let address = Address::of(uuid, vec![1u16]);
    let hits = Rc::new(RefCell::new(0));
    let recorder = hits.clone();
    graph.subscribe_vertex(Propagation::This, address.clone(), Box::new(move |_| *recorder.borrow_mut() += 1));
    let registry = Registry::new(); // a primitive update needs no schema lookup
    graph.transaction(
        &[Update::Primitive {address: address.clone(), old: FieldValue::Int32(5), new: FieldValue::Int32(9)}],
        &registry).unwrap();
    assert_eq!(*hits.borrow(), 1);
    assert_eq!(graph.find_box(&uuid).unwrap().fields.get(&1u16), Some(&FieldValue::Int32(9)));
}
