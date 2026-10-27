//! The update clock an automated processor walks: the fixed grid, or for a processor behind delay compensation
//! (#482) the grid of the position its audio was rendered at, which the engine installs.

use core::sync::atomic::{AtomicUsize, Ordering};
use crate::ppqn::{first_update_position, UPDATE_CLOCK_RATE};

/// `(position, lag, strict)`: the first lagged grid pulse at or (`strict`) after `position`, as a current pulse.
pub type LaggedClock = fn(f64, u32, bool) -> f64;

static LAGGED: AtomicUsize = AtomicUsize::new(0);

pub fn install_lagged_clock(clock: LaggedClock) {
    LAGGED.store(clock as usize, Ordering::Relaxed);
}

fn lagged(position: f64, lag: u32, strict: bool) -> Option<f64> {
    match LAGGED.load(Ordering::Relaxed) {
        0 => None,
        pointer => Some(unsafe { core::mem::transmute::<usize, LaggedClock>(pointer) }(position, lag, strict))
    }
}

pub fn first_update(at: f64, lag: u32) -> f64 {
    if lag == 0 {
        return first_update_position(at);
    }
    lagged(at, lag, false).unwrap_or_else(|| first_update_position(at))
}

pub fn next_update(after: f64, lag: u32) -> f64 {
    if lag == 0 {
        return after + UPDATE_CLOCK_RATE;
    }
    lagged(after, lag, true).unwrap_or(after + UPDATE_CLOCK_RATE)
}
