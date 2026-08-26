//! Warp-table mapping and marker search — verbatim behavior from `engine/src/time_stretch.rs`
//! (hard-won: linear interpolation, exclusive end, clamp-past-end). Do not "improve" these without a
//! parity test; the engine and the TS editor agree on this exact math.

/// Source seconds at content `ppqn`, linearly interpolated between bracketing warp markers;
/// `None` when no segment brackets it.
pub fn ppqn_to_seconds(warp: &[(f64, f64)], ppqn: f64) -> Option<f64> {
    for window in warp.windows(2) {
        let (left, right) = (window[0], window[1]);
        if ppqn >= left.0 && ppqn < right.0 {
            let alpha = (ppqn - left.0) / (right.0 - left.0);
            return Some(left.1 + alpha * (right.1 - left.1));
        }
    }
    None
}

/// Content ppqn at source `seconds`, linearly interpolated; clamps to the last marker position when
/// past the end, 0 when before the start.
pub fn seconds_to_ppqn(warp: &[(f64, f64)], seconds: f64) -> f64 {
    for window in warp.windows(2) {
        let (left, right) = (window[0], window[1]);
        if seconds >= left.1 && seconds < right.1 {
            let alpha = (seconds - left.1) / (right.1 - left.1);
            return left.0 + alpha * (right.0 - left.0);
        }
    }
    match warp.last() {
        Some(last) if seconds >= last.1 => last.0,
        _ => 0.0
    }
}

/// The last index whose value is <= `value`; `-1` when all are greater.
pub fn floor_last_index_by<T>(values: &[T], value: f64, position: impl Fn(&T) -> f64) -> i32 {
    values.partition_point(|entry| position(entry) <= value) as i32 - 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floor_last_index_is_the_last_entry_at_or_below() {
        let values = [0.0, 0.5, 1.0];
        assert_eq!(floor_last_index_by(&values, -0.1, |v| *v), -1, "before all -> -1");
        assert_eq!(floor_last_index_by(&values, 0.0, |v| *v), 0, "exactly the first");
        assert_eq!(floor_last_index_by(&values, 0.49, |v| *v), 0);
        assert_eq!(floor_last_index_by(&values, 0.5, |v| *v), 1);
        assert_eq!(floor_last_index_by(&values, 9.0, |v| *v), 2, "past all -> last");
    }

    #[test]
    fn warp_maps_ppqn_and_seconds_both_ways() {
        let warp = [(0.0, 0.0), (3840.0, 1.0)];
        assert!((ppqn_to_seconds(&warp, 1920.0).unwrap() - 0.5).abs() < 1e-9, "midpoint maps to half a second");
        assert!(ppqn_to_seconds(&warp, 3840.0).is_none(), "the end is exclusive (no bracketing segment)");
        assert!((seconds_to_ppqn(&warp, 0.5) - 1920.0).abs() < 1e-9);
        assert_eq!(seconds_to_ppqn(&warp, 9.0), 3840.0, "past the last marker clamps to its position");
    }
}
