//! Test-only heap checker (`--features heap-guard`): every allocation gets guard bytes before and after it,
//! and freed blocks are poisoned and held in a quarantine before talc reuses them. A buffer overrun panics
//! at the free of the overrun block (or at `heap_guard_check`), a write into freed memory panics when the
//! block leaves the quarantine (or at `heap_guard_check`), so a corruption is reported at its victim block
//! with its address and size instead of surfacing later as a fault inside talc.

use core::alloc::Layout;
use core::ptr::addr_of_mut;

const GUARD: usize = 64;
const GUARD_BYTE: u8 = 0xA5;
const POISON_BYTE: u8 = 0xDD;
const LIVE_CAPACITY: usize = 1 << 18;
const QUARANTINE_CAPACITY: usize = 4096;
const QUARANTINE_BYTES: usize = 256 << 20;
const EMPTY: u32 = 0;

#[derive(Clone, Copy)]
struct Entry {
    ptr: u32,
    size: u32,
    align: u32
}

struct State {
    live: [Entry; LIVE_CAPACITY],
    live_count: usize,
    quarantine: [Entry; QUARANTINE_CAPACITY],
    head: usize,
    count: usize,
    bytes: usize
}

static mut STATE: State = State {
    live: [Entry {ptr: EMPTY, size: 0, align: 0}; LIVE_CAPACITY],
    live_count: 0,
    quarantine: [Entry {ptr: EMPTY, size: 0, align: 0}; QUARANTINE_CAPACITY],
    head: 0,
    count: 0,
    bytes: 0
};

fn state() -> &'static mut State {
    unsafe { &mut *addr_of_mut!(STATE) }
}

fn pad(align: usize) -> usize {
    GUARD.max(align)
}

fn outer(size: usize, align: usize) -> Layout {
    unsafe { Layout::from_size_align_unchecked(size + 2 * pad(align), align.max(16)) }
}

fn slot(ptr: u32) -> usize {
    (ptr.wrapping_mul(2654435761) >> 14) as usize % LIVE_CAPACITY
}

fn register(entry: Entry) {
    let state = state();
    assert!(state.live_count < LIVE_CAPACITY / 2, "heap-guard: live table full");
    let mut index = slot(entry.ptr);
    while state.live[index].ptr != EMPTY {
        index = (index + 1) % LIVE_CAPACITY;
    }
    state.live[index] = entry;
    state.live_count += 1;
}

fn unregister(ptr: u32) -> Option<Entry> {
    let state = state();
    let mut hole = slot(ptr);
    while state.live[hole].ptr != ptr {
        if state.live[hole].ptr == EMPTY {
            return None;
        }
        hole = (hole + 1) % LIVE_CAPACITY;
    }
    let found = state.live[hole];
    let mut next = (hole + 1) % LIVE_CAPACITY;
    while state.live[next].ptr != EMPTY {
        let home = slot(state.live[next].ptr);
        let distance_home = (next + LIVE_CAPACITY - home) % LIVE_CAPACITY;
        let distance_hole = (next + LIVE_CAPACITY - hole) % LIVE_CAPACITY;
        if distance_home >= distance_hole {
            state.live[hole] = state.live[next];
            hole = next;
        }
        next = (next + 1) % LIVE_CAPACITY;
    }
    state.live[hole].ptr = EMPTY;
    state.live_count -= 1;
    Some(found)
}

fn first_mismatch(from: usize, len: usize, expected: u8) -> Option<usize> {
    let bytes = unsafe { core::slice::from_raw_parts(from as *const u8, len) };
    bytes.iter().position(|byte| *byte != expected)
}

fn verify_live(entry: Entry) {
    let (ptr, size, pad) = (entry.ptr as usize, entry.size as usize, pad(entry.align as usize));
    if let Some(offset) = first_mismatch(ptr - pad, pad, GUARD_BYTE) {
        panic!("heap-guard: UNDERRUN below block {:#x} (size {}): guard byte {} of {} below the start overwritten",
               ptr, size, pad - offset, pad);
    }
    if let Some(offset) = first_mismatch(ptr + size, pad, GUARD_BYTE) {
        panic!("heap-guard: OVERRUN past block {:#x} (size {}): byte {} past the end overwritten", ptr, size, offset);
    }
}

fn verify_freed(entry: Entry) {
    let (ptr, size, pad) = (entry.ptr as usize, entry.size as usize, pad(entry.align as usize));
    if let Some(offset) = first_mismatch(ptr - pad, size + 2 * pad, POISON_BYTE) {
        panic!("heap-guard: WRITE AFTER FREE into block {:#x} (size {}) at offset {}", ptr, size, offset as isize - pad as isize);
    }
}

fn evict<F: FnMut(*mut u8, Layout)>(release: &mut F) {
    let state = state();
    let entry = state.quarantine[state.head];
    state.head = (state.head + 1) % QUARANTINE_CAPACITY;
    state.count -= 1;
    state.bytes -= entry.size as usize;
    verify_freed(entry);
    let pad = pad(entry.align as usize);
    release((entry.ptr as usize - pad) as *mut u8, outer(entry.size as usize, entry.align as usize));
}

pub(crate) fn alloc<F: FnOnce(Layout) -> *mut u8>(layout: Layout, allocate: F) -> *mut u8 {
    let (size, align) = (layout.size(), layout.align());
    let pad = pad(align);
    let base = allocate(outer(size, align));
    if base.is_null() {
        return base;
    }
    unsafe {
        core::ptr::write_bytes(base, GUARD_BYTE, pad);
        core::ptr::write_bytes(base.add(pad + size), GUARD_BYTE, pad);
    }
    let user = unsafe { base.add(pad) };
    register(Entry {ptr: user as u32, size: size as u32, align: align as u32});
    user
}

pub(crate) fn dealloc<F: FnMut(*mut u8, Layout)>(ptr: *mut u8, layout: Layout, mut release: F) {
    let Some(entry) = unregister(ptr as u32) else {
        panic!("heap-guard: free of unknown or already freed block {:#x} (size {})", ptr as usize, layout.size());
    };
    if entry.size as usize != layout.size() || entry.align as usize != layout.align() {
        panic!("heap-guard: free of block {:#x} with size {} align {}, allocated with size {} align {}",
               ptr as usize, layout.size(), layout.align(), entry.size, entry.align);
    }
    verify_live(entry);
    let pad = pad(entry.align as usize);
    unsafe { core::ptr::write_bytes(ptr.sub(pad), POISON_BYTE, entry.size as usize + 2 * pad) };
    let state = state();
    while state.count == QUARANTINE_CAPACITY || (state.count > 0 && state.bytes + entry.size as usize > QUARANTINE_BYTES) {
        evict(&mut release);
    }
    let tail = (state.head + state.count) % QUARANTINE_CAPACITY;
    state.quarantine[tail] = entry;
    state.count += 1;
    state.bytes += entry.size as usize;
}

/// Verify every live block's guards and, if `poison` is non-zero, every quarantined block's poison.
/// Returns the live block count.
#[no_mangle]
pub extern "C" fn heap_guard_check(poison: u32) -> u32 {
    let state = state();
    for entry in state.live.iter() {
        if entry.ptr != EMPTY {
            verify_live(*entry);
        }
    }
    for index in 0..if poison != 0 { state.count } else { 0 } {
        verify_freed(state.quarantine[(state.head + index) % QUARANTINE_CAPACITY]);
    }
    state.live_count as u32
}
