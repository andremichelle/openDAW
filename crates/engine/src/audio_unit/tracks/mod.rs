//! Track/region cascade beneath an audio unit, split by track-content type into [`note`], [`audio`] and
//! [`value`] submodules. This root keeps the cross-cutting `reconcile_tracks` dispatcher, the shared
//! `region_pulses` helper + `track_type`/`track_enabled`, and the common `TrackBox` field keys, and re-exports
//! every submodule item so callers keep referring to `tracks::X` unchanged.
use super::*;

mod note;
mod audio;
mod value;

pub(crate) use note::*;
pub(crate) use audio::*;
pub(crate) use value::*;

// ---- The track / region cascade beneath an audio unit. Free functions taking `&mut BoxGraph`: they only
// observe the box graph and edit the per-track region collections + the unit's note-event cache, never the
// processor graph, so they avoid borrowing the engine. Membership is recorded into `Members` + drained
// here; a region's span EDIT re-sorts its track collection live via the track's `edit_sub` observer. ----

/// Reconcile one unit's tracks against its `tracks` membership, then each track's regions. A new track's
/// region collection is registered into the unit's shared `track_sets` (so the sequencer sees it); a
/// removed track's collection is unregistered.
pub(crate) fn reconcile_tracks(graph: &mut BoxGraph, unit: &mut AudioUnitBinding, tempo_map: &SharedTempoMap,
                    clip_sequencer: &Rc<RefCell<ClipSequencer>>) {
    let mark = unit.mark.clone();
    let changes = core::mem::take(&mut *unit.track_changes.borrow_mut());
    for track_uuid in changes.removed {
        if let Some(index) = unit.tracks.iter().position(|track| track.track_uuid == track_uuid) {
            let track = unit.tracks.remove(index);
            teardown_track(graph, &unit.track_sets, &mut unit.collections, clip_sequencer, track);
        } else if let Some(index) = unit.audio_tracks.iter().position(|track| track.track_uuid == track_uuid) {
            let track = unit.audio_tracks.remove(index);
            teardown_audio_track(graph, &unit.audio_track_sets, clip_sequencer, track);
        }
    }
    for track_uuid in changes.added {
        if unit.tracks.iter().any(|track| track.track_uuid == track_uuid)
            || unit.audio_tracks.iter().any(|track| track.track_uuid == track_uuid) {
            continue;
        }
        match track_type(graph, track_uuid) {
            TRACK_TYPE_VALUE => continue, // a Value (automation) track is read per-device by `device_automation`
            TRACK_TYPE_AUDIO => unit.audio_tracks.push(build_audio_track(graph, track_uuid, &mark)),
            _ => unit.tracks.push(build_track(graph, track_uuid, &mark)) // Notes / Undefined -> the note cascade
        }
    }
    // Re-derive the active track sets (note + audio): a track feeds the player its regions IFF enabled.
    // Rebuilding here (not only on add) makes an `enabled` toggle take effect edge-only — the disabled track's
    // collection is simply dropped from the set (and restored on re-enable), no region rebuild.
    {
        let mut sets = unit.track_sets.borrow_mut();
        sets.clear();
        for track in &unit.tracks {
            if track_enabled(graph, track.track_uuid) {
                sets.push(track.content.clone());
            }
        }
    }
    {
        let mut sets = unit.audio_track_sets.borrow_mut();
        sets.clear();
        for track in &unit.audio_tracks {
            if track_enabled(graph, track.track_uuid) {
                sets.push(track.content.clone());
            }
        }
    }
    for track in &mut unit.tracks {
        reconcile_regions(graph, &mut unit.collections, track);
        reconcile_clips(graph, &mut unit.collections, clip_sequencer, track);
    }
    for track in &mut unit.audio_tracks {
        reconcile_audio_regions(graph, track, tempo_map);
        reconcile_audio_clips(graph, clip_sequencer, track, tempo_map);
    }
}

pub(crate) fn region_pulses(graph: &BoxGraph, uuid: Uuid, key: u16) -> f64 {
    graph.field_value(&Address::of(uuid, vec![key])).and_then(|value| value.as_int32()).unwrap_or(0) as f64
}

// ---- Device parameter automation (Route D). A device's automated parameter is a Value `TrackBox` whose
// `target` points at the parameter field; the engine observes its curve and hands the device a read handle,
// and the device pulls the value on each global clock event. Discovered per device at rewire (mirroring TS
// `bindParameter` connecting a parameter's automation track), independent of the note-region cascade. ----

// TrackBox.type (field 11) values mirror studio-adapters `TrackType`; only a Value track carries parameter
// automation (Note / Audio tracks and the unset default go through the note cascade).
pub(crate) const TRACK_TYPE_VALUE: i32 = 3;
pub(crate) const TRACK_TYPE_AUDIO: i32 = 2; // an Audio track's regions are AudioRegionBoxes, played by the audio-region player
pub(crate) const TRACK_CLIPS_KEY: u16 = 4; // WASM CONTRACT: TrackBox `clips` collection (launchable clips)
pub(crate) const TRACK_TYPE_KEY: u16 = 11;
pub(crate) const TRACK_ENABLED_KEY: u16 = 20;      // TrackBox.enabled (WASM CONTRACT): a disabled track contributes nothing
pub(crate) const TRACK_TARGET_KEY: u16 = 2;        // TrackBox.target -> the automated parameter field (Automation pointer)
pub(crate) const TRACK_REGIONS_KEY: u16 = 3;       // TrackBox.regions -> the hub value regions attach to (membership)

/// A track's `type` (field 11), defaulting to 0 (Undefined) when unset.
pub(crate) fn track_type(graph: &BoxGraph, track_uuid: Uuid) -> i32 {
    graph.field_value(&Address::of(track_uuid, vec![TRACK_TYPE_KEY])).and_then(|value| value.as_int32()).unwrap_or(0)
}

pub(crate) fn track_enabled(graph: &BoxGraph, track_uuid: Uuid) -> bool {
    graph.field_value(&Address::of(track_uuid, vec![TRACK_ENABLED_KEY])).and_then(|value| value.as_bool()).unwrap_or(true)
}
