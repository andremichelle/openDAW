//! Value (automation) tracks: the read-only `RegionSpec`/`ValueClipSpec` the per-device param-automation route
//! reads from a track's `regions`/`clips` hubs. No binding cascade lives here (automation is bound per device).
use super::*;

pub(crate) struct ValueClipSpec {
    pub(crate) clip: Uuid,
    pub(crate) collection: Uuid,
    pub(crate) duration: f64,
    pub(crate) looped: bool,
    pub(crate) mute: bool
}

/// The VALUE clips attached to a track's `clips` hub (key 4), each with its event collection, duration
/// (key 10, pulses), `triggerMode.loop` (path [4, 1], default TRUE) and `mute` (key 11).
pub(crate) fn value_clips_of_track(graph: &BoxGraph, track_uuid: Uuid) -> Vec<ValueClipSpec> {
    let mut specs = Vec::new();
    let clips_hub = Address::of(track_uuid, vec![TRACK_CLIPS_KEY]);
    for source in graph.incoming(&clips_hub) {
        let clip_uuid = source.uuid;
        let Some(graph_box) = graph.find_box(&clip_uuid) else { continue; };
        if graph_box.name != "ValueClipBox" {
            continue;
        }
        if let Some(collection) = graph.target_of(&Address::of(clip_uuid, vec![2])).map(|address| address.uuid) {
            specs.push(ValueClipSpec {
                clip: clip_uuid,
                collection,
                duration: region_pulses(graph, clip_uuid, 10),
                looped: graph.field_value(&Address::of(clip_uuid, vec![4, 1])).and_then(|value| value.as_bool()).unwrap_or(true),
                mute: graph.field_value(&Address::of(clip_uuid, vec![CLIP_MUTE_KEY])).and_then(|value| value.as_bool()).unwrap_or(false)
            });
        }
    }
    specs
}

pub(crate) const VALUE_REGION_EVENTS_KEY: u16 = 2; // ValueRegionBox.events -> the ValueEventCollectionBox

/// One value region of an automation track: its `events` collection and loopable span.
pub(crate) struct RegionSpec {
    pub(crate) region: Uuid,
    pub(crate) collection: Uuid,
    pub(crate) position: f64,
    pub(crate) duration: f64,
    pub(crate) loop_offset: f64,
    pub(crate) loop_duration: f64,
    pub(crate) mute: bool
}

// ValueRegionBox `mute` (WASM CONTRACT: mirror the TS ValueRegionBox schema — key 14, like audio regions).
pub(crate) const VALUE_REGION_MUTE_KEY: u16 = 14;

/// Every value region of an automation track: the `ValueRegionBox`es whose `regions` points at `track_uuid`,
/// with their `events` collection and span (position 10, duration 11, loopOffset 12, loopDuration 13). Read
/// from the track's `regions` hub (the incoming pointers) — O(regions on this track) — not a full-graph scan.
pub(crate) fn value_regions_of_track(graph: &BoxGraph, track_uuid: Uuid) -> Vec<RegionSpec> {
    let mut specs = Vec::new();
    let regions_hub = Address::of(track_uuid, vec![TRACK_REGIONS_KEY]);
    for source in graph.incoming(&regions_hub) {
        let region_uuid = source.uuid;
        // a note/audio region could share the hub key; only value regions carry automation
        let Some(graph_box) = graph.find_box(&region_uuid) else { continue; };
        if graph_box.name != "ValueRegionBox" {
            continue;
        }
        if let Some(collection) = graph.target_of(&Address::of(region_uuid, vec![VALUE_REGION_EVENTS_KEY])).map(|address| address.uuid) {
            specs.push(RegionSpec {
                region: region_uuid,
                collection,
                position: region_pulses(graph, region_uuid, 10),
                duration: region_pulses(graph, region_uuid, 11),
                loop_offset: region_pulses(graph, region_uuid, 12),
                loop_duration: region_pulses(graph, region_uuid, 13),
                mute: graph.field_value(&Address::of(region_uuid, vec![VALUE_REGION_MUTE_KEY])).and_then(|value| value.as_bool()).unwrap_or(false)
            });
        }
    }
    specs
}
