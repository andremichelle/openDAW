//! The engine-side BROADCAST TABLE (plans/wasm-audio/live-broadcaster.md, phase 1): the registry of live
//! telemetry slots (meters, note activity) the JS worklet mirrors onto its untouched `LiveStreamBroadcaster`
//! as views over wasm memory. Entries register at RECONCILE (the slot `Rc`s live inside processors, stable
//! talc addresses); validity is self-healing — each entry holds a `Weak` of its slot, and `sweep` (run at
//! the end of every working reconcile) drops entries whose owner died, bumping the GENERATION so the worklet
//! re-reads the table and re-registers its packages. Nothing here runs during render.

use alloc::boxed::Box;
use alloc::rc::{Rc, Weak};
use alloc::vec::Vec;
use boxgraph::address::Uuid;
use core::cell::{Cell, RefCell};
use engine_env::telemetry::BroadcastSlot;

// WASM CONTRACT: the lib-fusion `PackageType` enum order (Float, FloatArray, Integer, IntegerArray, ByteArray).
pub const PACKAGE_FLOAT: u32 = 0;
pub const PACKAGE_FLOAT_ARRAY: u32 = 1;
// An INT RING slot: `[0]` = the producer's write index (i32), `[1..]` = the ring of i32 payloads. The
// consumer (the worklet) mirrors `[1..]` as an Integers package and, per UI tick, writes the 0 sentinel at
// the index and resets it — the TS `broadcastIntegers` consume-on-read (e.g. the Velocity device's ring).
pub const PACKAGE_INT_RING: u32 = 2;
// A PLAIN i32 array mirrored as an Integers package (no consume semantics) — e.g. the per-unit NOTE BITS
// (TS `NoteBroadcaster`: a 128-bit set of held notes the octave grids / note indicators subscribe to).
pub const PACKAGE_INT_ARRAY: u32 = 3;

pub struct BroadcastEntry {
    pub uuid: Uuid,
    pub keys: Vec<u16>,
    pub package_type: u32,
    pub ptr: u32,
    pub len: u32, // floats at `ptr` (1 for a Float package, 4 for a meter FloatArray)
    pub active: bool, // the UI's subscription flag (round-tripped; producers MAY skip cold work)
    // An ENGINE-realized producer (not a plugin, so no `host_broadcast_active`) mirrors the flag here to gate its
    // own cold work, e.g. the frequency splitter's input-spectrum FFT.
    producer_active: Option<Rc<Cell<bool>>>,
    owner: Weak<RefCell<Box<[f32]>>>
}

impl BroadcastEntry {
    /// Whether the owning slot still exists. A DEAD entry's `ptr` points into FREED heap (talc reuses it),
    /// so it must never be served to the worklet — the view would read allocator garbage as meter floats.
    pub fn alive(&self) -> bool {
        self.owner.upgrade().is_some()
    }
}

#[derive(Default)]
pub struct Broadcasts {
    entries: Vec<BroadcastEntry>,
    generation: u32
}

impl Broadcasts {
    /// Register one telemetry slot under a box address; its pointer and length come from the slot itself
    /// (a slot is exactly as long as its content). Reconcile-time (allocates the entry).
    pub fn register(&mut self, uuid: Uuid, keys: &[u16], package_type: u32, slot: &BroadcastSlot) {
        // One package per address (the JS LiveStreamBroadcaster asserts uniqueness): when an ALIVE entry
        // already claims (uuid, keys), keep it and skip — a DEVICE-bound slot at the same address (e.g. the
        // Playfield slot's voice positions at the bare pad address) takes precedence over the engine's
        // generic meter, which registers after `bind_device`. Dead entries do not block (swept later).
        // Same-TYPE only: TS runs different package kinds at ONE address (the unit's peaks FLOATS + its
        // note-bits INTEGERS), which the receiver disambiguates by subscription kind.
        if self.entries.iter().any(|entry| entry.uuid == uuid && entry.keys == keys
            && entry.package_type == package_type && entry.owner.upgrade().is_some()) {
            return;
        }
        let (ptr, len) = {
            let values = slot.borrow();
            (values.as_ptr() as u32, values.len() as u32)
        };
        self.entries.push(BroadcastEntry {
            uuid,
            keys: keys.to_vec(),
            package_type,
            ptr,
            len,
            active: false,
            producer_active: None,
            owner: Rc::downgrade(slot)
        });
        self.generation = self.generation.wrapping_add(1);
    }

    /// Attach an engine producer's `active` mirror to an already-registered entry (matched by address + type), so
    /// its cold work follows the UI subscription just as a plugin's `host_broadcast_active` does.
    pub fn attach_producer_active(&mut self, uuid: Uuid, keys: &[u16], package_type: u32, flag: Rc<Cell<bool>>) {
        if let Some(entry) = self.entries.iter_mut().find(|entry|
            entry.uuid == uuid && entry.keys == keys && entry.package_type == package_type) {
            flag.set(entry.active);
            entry.producer_active = Some(flag);
        }
    }

    /// The live slot already registered at `(uuid, keys, package_type)`, if any — so a re-observe (an automation
    /// edit re-runs `observe_param`) REUSES the parameter's existing UI slot instead of registering a fresh one
    /// that `register`'s dedup would then skip. Mirrors TS, where `onStartAutomation`'s broadcast is created once
    /// and persists across region edits; keeps the registration + write pointer stable so the knob never freezes.
    pub fn live_slot(&self, uuid: Uuid, keys: &[u16], package_type: u32) -> Option<BroadcastSlot> {
        self.entries.iter()
            .find(|entry| entry.uuid == uuid && entry.keys == keys && entry.package_type == package_type)
            .and_then(|entry| entry.owner.upgrade())
    }

    /// Drop every entry whose owning slot died (its processor was torn down). Self-healing: no per-teardown
    /// bookkeeping anywhere else. Bumps the generation when anything changed.
    pub fn sweep(&mut self) {
        let before = self.entries.len();
        self.entries.retain(|entry| entry.owner.upgrade().is_some());
        if self.entries.len() != before {
            self.generation = self.generation.wrapping_add(1);
        }
    }

    pub fn generation(&self) -> u32 {
        self.generation
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn entry(&self, index: usize) -> Option<&BroadcastEntry> {
        self.entries.get(index)
    }

    pub fn set_active(&mut self, index: usize, active: bool) {
        if let Some(entry) = self.entries.get_mut(index) {
            entry.active = active;
            if let Some(flag) = &entry.producer_active {
                flag.set(active);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_sweep_and_generation() {
        let mut broadcasts = Broadcasts::default();
        assert!(broadcasts.is_empty());
        assert_eq!(broadcasts.generation(), 0);
        let alive: BroadcastSlot = engine_env::telemetry::broadcast_slot(4);
        let doomed: BroadcastSlot = engine_env::telemetry::broadcast_slot(1);
        broadcasts.register([1u8; 16], &[], PACKAGE_FLOAT_ARRAY, &alive);
        broadcasts.register([2u8; 16], &[1], PACKAGE_FLOAT, &doomed);
        assert_eq!(broadcasts.len(), 2);
        assert_eq!(broadcasts.generation(), 2);
        let entry = broadcasts.entry(1).unwrap();
        assert_eq!(entry.uuid, [2u8; 16]);
        assert_eq!(entry.keys, alloc::vec![1u16]);
        assert_eq!(entry.package_type, PACKAGE_FLOAT);
        assert_eq!(entry.ptr, doomed.borrow().as_ptr() as u32);
        assert_eq!(entry.len, 1);
        broadcasts.sweep();
        assert_eq!((broadcasts.len(), broadcasts.generation()), (2, 2), "nothing died: no generation bump");
        drop(doomed);
        broadcasts.sweep();
        assert_eq!((broadcasts.len(), broadcasts.generation()), (1, 3), "the dead slot swept, generation bumped");
        assert_eq!(broadcasts.entry(0).unwrap().uuid, [1u8; 16]);
        broadcasts.set_active(0, true);
        assert!(broadcasts.entry(0).unwrap().active);
    }
}
