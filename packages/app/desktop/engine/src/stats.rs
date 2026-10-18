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
// the frames the sound card asked for in its last callback
pub static CALLBACK_FRAMES: AtomicU64 = AtomicU64::new(0);
static LAST: Mutex<Option<Instant>> = Mutex::new(None);
static LATENCY: Mutex<Option<(u64, u64, u64)>> = Mutex::new(None);
// a shared mode device latency wanders by a few milliseconds all the time
const DEVICE_JITTER_MS: u64 = 10;

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
    report_latency();
}

// callback frames, reserve frames, device ms: a new callback size, the reserve by more than a tenth, the device by 10 ms
fn worth_logging(seen: Option<(u64, u64, u64)>, now: (u64, u64, u64)) -> bool {
    let Some((callback, reserve, device)) = seen else { return true };
    callback != now.0 || reserve.abs_diff(now.1) * 10 > reserve || device.abs_diff(now.2) >= DEVICE_JITTER_MS
}

// where the output latency comes from, logged when it changes: the card's callback, our reserve, the device itself
fn report_latency() {
    let rate = crate::SAMPLE_RATE.load(Ordering::Relaxed).max(1) as u64;
    let callback = CALLBACK_FRAMES.load(Ordering::Relaxed);
    let reserve = crate::RING_TARGET_FRAMES.load(Ordering::Relaxed) as u64;
    let device = crate::DEVICE_LATENCY_US.load(Ordering::Relaxed) / 1000;
    if callback == 0 { return; }
    let mut last = LATENCY.lock().unwrap();
    if !worth_logging(*last, (callback, reserve, device)) { return; }
    *last = Some((callback, reserve, device));
    let reserve_ms = reserve * 1000 / rate;
    println!("[latency] callback {callback} frames ({} ms), reserve {reserve} frames ({reserve_ms} ms), device {device} ms, output {} ms",
        callback * 1000 / rate, reserve_ms + device);
}

#[cfg(test)]
mod tests {
    use super::*;

    // callback, reserve, device ms: a new callback size or a reserve change above 10% or 10 ms of device latency is news
    #[test]
    fn only_real_latency_changes_are_logged() {
        assert!(worth_logging(None, (480, 2048, 20)));
        assert!(!worth_logging(Some((480, 2048, 20)), (480, 2112, 25)), "the reserve between the buffer floor and two callbacks");
        assert!(worth_logging(Some((480, 2048, 20)), (480, 960, 20)), "the reserve halves");
        assert!(worth_logging(Some((480, 2048, 20)), (128, 2048, 20)), "the card changed its callback");
        assert!(worth_logging(Some((480, 2048, 20)), (480, 2048, 31)), "the device moved by 10 ms or more");
    }
}
