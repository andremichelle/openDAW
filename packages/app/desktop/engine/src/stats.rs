// Drop-out diagnostics: printed once per second while underruns or skipped plugin blocks occur
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

pub static UNDERRUNS: AtomicU64 = AtomicU64::new(0);
pub static PLUGIN_SKIPS: AtomicU64 = AtomicU64::new(0);
pub static STATE_READS: AtomicU64 = AtomicU64::new(0);
pub static MAX_RENDER_US: AtomicU64 = AtomicU64::new(0);
pub static MAX_PLUGIN_US: AtomicU64 = AtomicU64::new(0);
pub static MAX_STATE_US: AtomicU64 = AtomicU64::new(0);
pub static MAX_RECEIVE_US: AtomicU64 = AtomicU64::new(0);
pub static MAX_TIMERS_US: AtomicU64 = AtomicU64::new(0);
static LAST: Mutex<Option<Instant>> = Mutex::new(None);

pub fn count(counter: &AtomicU64) {counter.fetch_add(1, Ordering::Relaxed);}

pub fn record_max(slot: &AtomicU64, started: Instant) {
    slot.fetch_max(started.elapsed().as_micros() as u64, Ordering::Relaxed);
}

pub fn report() {
    let mut last = LAST.lock().unwrap();
    if last.is_some_and(|at| at.elapsed().as_secs() < 1) { return; }
    *last = Some(Instant::now());
    let take = |counter: &AtomicU64| counter.swap(0, Ordering::Relaxed);
    let (underruns, skips, reads) = (take(&UNDERRUNS), take(&PLUGIN_SKIPS), take(&STATE_READS));
    let (render, plugin, state) = (take(&MAX_RENDER_US), take(&MAX_PLUGIN_US), take(&MAX_STATE_US));
    let (receive, timers) = (take(&MAX_RECEIVE_US), take(&MAX_TIMERS_US));
    if underruns > 0 || skips > 0 {
        println!("[stats] underruns {underruns}, plugin skips {skips}, max render {render} µs, max plugin {plugin} µs, \
            max messages {receive} µs, max timers {timers} µs, state reads {reads} (max {state} µs)");
    }
}
