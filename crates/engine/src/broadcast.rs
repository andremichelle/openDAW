//! The engine-side BROADCAST TABLE (plans/wasm-audio/live-broadcaster.md, phase 1): the registry of live
//! telemetry slots (meters, note activity) the JS worklet mirrors onto its untouched `LiveStreamBroadcaster`
//! as views over wasm memory. Entries register at RECONCILE (the slot `Rc`s live inside processors, stable
//! talc addresses); validity is self-healing — each entry holds a `Weak` of its slot, and `sweep` (run at
//! the end of every working reconcile) drops entries whose owner died, bumping the GENERATION so the worklet
//! re-reads the table and re-registers its packages. Nothing here runs during render.

use alloc::boxed::Box;
use alloc::rc::Weak;
use alloc::vec::Vec;
use boxgraph::address::Uuid;
use core::cell::RefCell;
use engine_env::telemetry::BroadcastSlot;

// WASM CONTRACT: the lib-fusion `PackageType` enum order (Float, FloatArray, Integer, IntegerArray, ByteArray).
pub const PACKAGE_FLOAT: u32 = 0;
pub const PACKAGE_FLOAT_ARRAY: u32 = 1;

pub struct BroadcastEntry {
    pub uuid: Uuid,
    pub keys: Vec<u16>,
    pub package_type: u32,
    pub ptr: u32,
    pub len: u32, // floats at `ptr` (1 for a Float package, 4 for a meter FloatArray)
    pub active: bool, // the UI's subscription flag (round-tripped; producers MAY skip cold work)
    owner: Weak<RefCell<Box<[f32]>>>
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
            owner: alloc::rc::Rc::downgrade(slot)
        });
        self.generation = self.generation.wrapping_add(1);
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

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn entry(&self, index: usize) -> Option<&BroadcastEntry> {
        self.entries.get(index)
    }

    pub fn set_active(&mut self, index: usize, active: bool) {
        if let Some(entry) = self.entries.get_mut(index) {
            entry.active = active;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_sweep_and_generation() {
        let mut broadcasts = Broadcasts::default();
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
