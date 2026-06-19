//! The Zeitgeist groove warp: the downbeat of each 1/8-note cell is unchanged, the off-beat 1/16 is pushed
//! later (swing), and `unwarp` inverts `warp` (a bijection, so the upstream pull range is well-defined).

use device_zeitgeist::{unwarp, warp};

#[test]
fn the_downbeat_stays_and_the_offbeat_swings_later() {
    assert!((warp(0.0) - 0.0).abs() < 1.0e-6, "cell downbeat unchanged");
    assert!((warp(480.0) - 480.0).abs() < 1.0e-6, "next cell downbeat unchanged");
    let offbeat = warp(240.0); // the second 1/16 of the first cell
    assert!(offbeat > 240.0, "the off-beat is pushed later (swing)");
    assert!((offbeat - 312.0).abs() < 1.0, "moebius(0.5, 0.65) * 480 = 312");
}

#[test]
fn unwarp_inverts_warp() {
    for position in [0.0, 100.0, 240.0, 360.0, 480.0, 700.0, 955.0] {
        assert!((unwarp(warp(position)) - position).abs() < 1.0e-3, "unwarp(warp(p)) == p");
    }
}
