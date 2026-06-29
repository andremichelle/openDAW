//! The render hot path drains completed note spans WITHOUT allocating. A counting global allocator proves
//! `drain_linear_completed` / `drain_all` perform ZERO heap allocations (the old Vec-returning `release_*`
//! allocated a Vec per call). One test in its own binary, so the counter sees no concurrent allocations.

use core::sync::atomic::{AtomicUsize, Ordering};
use std::alloc::{GlobalAlloc, Layout, System};
use value::event::{Event, EventSpan};
use value::retainer::EventSpanRetainer;

static ALLOCS: AtomicUsize = AtomicUsize::new(0);

struct Counting;
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
        System.alloc(layout)
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
        System.alloc_zeroed(layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
        System.realloc(ptr, layout, new_size)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

#[derive(Clone, Copy)]
struct Span {
    position: f64,
    duration: f64
}
impl Event for Span {
    fn position(&self) -> f64 {self.position}
}
impl EventSpan for Span {
    fn duration(&self) -> f64 {self.duration}
}

#[test]
fn draining_retained_spans_does_not_allocate() {
    let mut retainer = EventSpanRetainer::new();
    for i in 0..16 {
        retainer.add_and_retain(Span {position: i as f64, duration: 1.0}); // setup (allocates the backing Vec)
    }

    // The per-block release of completed spans must not allocate.
    let before = ALLOCS.load(Ordering::Relaxed);
    let mut released = 0usize;
    retainer.drain_linear_completed(1000.0, |_span| released += 1);
    let after = ALLOCS.load(Ordering::Relaxed);
    assert_eq!(released, 16, "all completed spans were released");
    assert_eq!(after - before, 0, "drain_linear_completed allocated");

    // The stop / loop-wrap full drain must not allocate either (and keeps capacity for reuse).
    for i in 0..16 {
        retainer.add_and_retain(Span {position: i as f64, duration: 1.0});
    }
    let before = ALLOCS.load(Ordering::Relaxed);
    let mut released = 0usize;
    retainer.drain_all(|_span| released += 1);
    let after = ALLOCS.load(Ordering::Relaxed);
    assert_eq!(released, 16);
    assert_eq!(after - before, 0, "drain_all allocated");

    // Sanity: the counter is actually live — the Vec-returning convenience DOES allocate (so the zero
    // results above are real, not a dead counter).
    for i in 0..16 {
        retainer.add_and_retain(Span {position: i as f64, duration: 1.0});
    }
    let before = ALLOCS.load(Ordering::Relaxed);
    let _vec = retainer.release_linear_completed(1000.0);
    assert!(ALLOCS.load(Ordering::Relaxed) - before > 0, "release_linear_completed should allocate a Vec");
}
