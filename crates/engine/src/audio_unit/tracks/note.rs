//! Note tracks (and the Undefined/default type): their region + launchable-clip cascade, plus the per-unit
//! `CollectionCache` that observes each note-event collection once and shares it across mirrored regions.
use super::*;

/// One bound note region: its loopable span plus a shared handle to its `NoteEventCollection` (the cache's
/// canonical observation — see `CollectionCache`). Keyed by uuid so the region cascade can remove it.
/// MIRRORED regions reference the same collection box, so their `collection` handles are clones of the one
/// observation: each region has its own span, all read the one ever-sorted event list.
pub(crate) struct BoundRegion {
    pub(crate) region_uuid: Uuid,
    pub(crate) region: NoteRegion,
    pub(crate) collection: NoteCollection
}

impl Span for BoundRegion {
    fn position(&self) -> f64 { self.region.position }
    fn duration(&self) -> f64 { self.region.duration }
}

/// Per-unit cache of observed note-event collections. A `NoteEventCollectionBox` is observed ONCE (one
/// `NoteCollection`, one ever-sorted event list) no matter how many regions reference it (mirrored
/// regions); each referencing region gets a cheap clone of that handle. Ref-counted, so the observation is
/// terminated only when the last region referencing it leaves. Mirrors the TS one-adapter-per-box model.
#[derive(Default)]
pub(crate) struct CollectionCache {
    pub(crate) entries: Vec<CollectionEntry>
}

pub(crate) struct CollectionEntry {
    pub(crate) uuid: Uuid,
    pub(crate) collection: NoteCollection,
    pub(crate) refs: usize
}

impl CollectionCache {
    /// Get a handle to the collection `uuid`, observing it once on first use and bumping its ref count.
    pub(crate) fn acquire(&mut self, graph: &mut BoxGraph, uuid: Uuid) -> NoteCollection {
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.uuid == uuid) {
            entry.refs += 1;
            return entry.collection.clone();
        }
        let collection = NoteCollection::observe(graph, uuid);
        self.entries.push(CollectionEntry {uuid, collection: collection.clone(), refs: 1});
        collection
    }

    /// Drop one reference to `uuid`; terminate the observation when the last region leaves.
    pub(crate) fn release(&mut self, graph: &mut BoxGraph, uuid: Uuid) {
        if let Some(index) = self.entries.iter().position(|entry| entry.uuid == uuid) {
            self.entries[index].refs -= 1;
            if self.entries[index].refs == 0 {
                self.entries.remove(index).collection.terminate(graph);
            }
        }
    }

    /// Terminate any remaining observations (a defensive cleanup on unit teardown; normally already empty).
    pub(crate) fn terminate_all(self, graph: &mut BoxGraph) {
        for entry in self.entries {
            entry.collection.terminate(graph);
        }
    }
}

/// ONE track's note regions, kept SORTED BY POSITION (a `RegionCollection`). Scoped to the track because
/// `iterate_range` assumes non-overlapping regions, which holds within a track but not across a unit's
/// tracks. Shared between the track binding (the cascade inserts / removes / re-sorts) and the unit's
/// sequencer (which range-queries it each block).
pub(crate) struct NoteTrackContent {
    pub(crate) uuid: Uuid,
    pub(crate) regions: RegionCollection<BoundRegion>,
    pub(crate) clips: Vec<BoundNoteClip>
}

/// One launchable clip's playable content (TS `NoteClipBoxAdapter`): its live duration / loop flag and
/// its note-event collection (a cache ref, released when the clip leaves).
pub(crate) struct BoundNoteClip {
    pub(crate) clip_uuid: Uuid,
    pub(crate) duration: f64,
    pub(crate) looped: bool,
    pub(crate) mute: bool,
    pub(crate) collection: NoteCollection
}

impl NoteTrackAccess for NoteTrackContent {
    fn for_each_region(&self, from: f64, to: f64, visit: &mut dyn FnMut(&NoteRegion, &EventCollection<NoteEvent>)) {
        // Binary-search the regions overlapping [from, to) within this track (sorted by position). A region
        // being RECORDED INTO is skipped (TS `context.ignoresRegion` in `NoteSequencer.#processRegions`).
        let ignored = unsafe { crate::IGNORED_REGIONS.get() };
        for bound in self.regions.iterate_range(from, to) {
            if ignored.contains(&bound.region_uuid) {
                continue;
            }
            visit(&bound.region, &bound.collection.events());
        }
    }
    fn clip_info(&self, clip: &[u8; 16]) -> Option<(f64, bool)> {
        self.clips.iter().find(|bound| &bound.clip_uuid == clip).map(|bound| (bound.duration, bound.looped))
    }
    fn clip_events(&self, clip: &[u8; 16], visit: &mut dyn FnMut(&EventCollection<NoteEvent>)) {
        if let Some(bound) = self.clips.iter().find(|bound| &bound.clip_uuid == clip) {
            if bound.mute {
                return; // a muted launched clip emits no notes (the UI also gates launching a muted clip)
            }
            visit(&bound.collection.events());
        }
    }
}

pub(crate) type SharedNoteTrack = Rc<RefCell<NoteTrackContent>>;

/// The unit's live list of per-track region collections (one entry per `TrackBox`), shared with the
/// sequencer. Tracks are added / removed live; the sequencer iterates whatever is currently present.
pub(crate) type SharedTrackSets = Rc<RefCell<Vec<SharedNoteTrack>>>;

/// The `NoteContentSource` the unit's sequencer reads. It iterates EACH track's own sorted region collection
/// (unit -> tracks -> regions), range-querying each — mirroring TS `tracks -> regions.collection.iterateRange`.
pub(crate) struct BoundNoteTracks {
    pub(crate) tracks: SharedTrackSets
}

impl NoteContentSource for BoundNoteTracks {
    fn for_each_track(&self, visit: &mut dyn FnMut(&[u8; 16], &dyn NoteTrackAccess)) {
        for track in self.tracks.borrow().iter() {
            let content = track.borrow();
            let uuid = content.uuid;
            visit(&uuid, &*content);
        }
    }
}

/// One bound note region in the cascade: its uuid (its entry in the track's region collection), the
/// collection it references (so the cache ref can be released when the region leaves), and a TARGETED
/// `Parent` subscription on the region box that re-sorts the track when this region's own span is edited.
pub(crate) struct RegionBinding {
    pub(crate) region_uuid: Uuid,
    pub(crate) collection_uuid: Uuid,
    pub(crate) edit_sub: SubscriptionId
}

/// One bound launchable clip: its entry in the track's content, the note collection it references, and a
/// TARGETED `Parent` subscription re-reading its duration / loop flag on edit (mirrors `RegionBinding`).
pub(crate) struct ClipBinding {
    pub(crate) clip_uuid: Uuid,
    pub(crate) collection_uuid: Uuid,
    pub(crate) edit_sub: SubscriptionId
}

/// A track BINDING: owns this track's sorted region collection (`content`, shared with the sequencer)
/// and observes its `regions` membership (add / remove). A member region's span edit is observed per-region
/// (see `RegionBinding`), so no track-wide listener is needed.
pub(crate) struct TrackBinding {
    pub(crate) track_uuid: Uuid,
    pub(crate) content: SharedNoteTrack,
    pub(crate) region_bindings: Vec<RegionBinding>,
    pub(crate) region_changes: Rc<RefCell<Members>>,
    pub(crate) region_sub: SubscriptionId,
    pub(crate) clip_bindings: Vec<ClipBinding>,
    pub(crate) clip_changes: Rc<RefCell<Members>>,
    pub(crate) clip_sub: SubscriptionId,
    // A TARGETED `This` monitor on the track's `enabled` field: toggling it re-derives the unit's active
    // note-track set (a disabled track's regions are excluded), exactly like a device `enabled` toggle.
    pub(crate) enabled_sub: SubscriptionId
}

/// Build a track binding: its own sorted region collection (`content`), a subscription to the track's
/// `regions` membership (key 3), and an edit subscription that re-sorts the collection when a member
/// region's span (position / duration / loop fields) changes — so a moved region lands at the right place.
pub(crate) fn build_track(graph: &mut BoxGraph, track_uuid: Uuid, mark: &DirtyMark) -> TrackBinding {
    let content: SharedNoteTrack = Rc::new(RefCell::new(NoteTrackContent {
        uuid: track_uuid, regions: RegionCollection::new(), clips: Vec::new()
    }));
    let region_changes = Rc::new(RefCell::new(Members::default()));
    let recorder = region_changes.clone();
    let region_mark = mark.clone();
    let region_sub = graph.subscribe_pointer_hub(Address::of(track_uuid, vec![TRACK_REGIONS_KEY]), Box::new(move |_graph, event| {
        match event {
            HubEvent::Added(source) => recorder.borrow_mut().added.push(source.uuid),
            HubEvent::Removed(source) => recorder.borrow_mut().removed.push(source.uuid)
        }
        region_mark.mark();
    }));
    let clip_changes = Rc::new(RefCell::new(Members::default()));
    let clip_recorder = clip_changes.clone();
    let clip_mark = mark.clone();
    let clip_sub = graph.subscribe_pointer_hub(Address::of(track_uuid, vec![TRACK_CLIPS_KEY]), Box::new(move |_graph, event| {
        match event {
            HubEvent::Added(source) => clip_recorder.borrow_mut().added.push(source.uuid),
            HubEvent::Removed(source) => clip_recorder.borrow_mut().removed.push(source.uuid)
        }
        clip_mark.mark();
    }));
    let enabled_mark = mark.clone();
    let enabled_sub = graph.subscribe_vertex(Propagation::This, Address::of(track_uuid, vec![TRACK_ENABLED_KEY]),
        Box::new(move |_graph, _update| enabled_mark.mark()));
    TrackBinding {track_uuid, content, region_bindings: Vec::new(), region_changes, region_sub,
        clip_bindings: Vec::new(), clip_changes, clip_sub, enabled_sub}
}

/// Tear down a track: unsubscribe its membership + edit observers, unregister its region collection from the
/// unit's `track_sets`, and release each region's note-event cache reference.
pub(crate) fn teardown_track(graph: &mut BoxGraph, track_sets: &SharedTrackSets, collections: &mut CollectionCache,
                  clip_sequencer: &Rc<RefCell<ClipSequencer>>, track: TrackBinding) {
    graph.unsubscribe(track.region_sub);
    graph.unsubscribe(track.clip_sub);
    graph.unsubscribe(track.enabled_sub);
    clip_sequencer.borrow_mut().forget(&track.track_uuid);
    track_sets.borrow_mut().retain(|set| !Rc::ptr_eq(set, &track.content));
    for clip in track.clip_bindings {
        graph.unsubscribe(clip.edit_sub);
        collections.release(graph, clip.collection_uuid);
    }
    for region in track.region_bindings {
        graph.unsubscribe(region.edit_sub);
        collections.release(graph, region.collection_uuid);
    }
}

/// Reconcile a track's regions against its `regions` membership, maintaining the track's sorted region
/// collection and the unit's note-event cache (releasing on remove, acquiring + sorted-inserting on add).
pub(crate) fn reconcile_regions(graph: &mut BoxGraph, collections: &mut CollectionCache, track: &mut TrackBinding) {
    let changes = core::mem::take(&mut *track.region_changes.borrow_mut());
    for region_uuid in changes.removed {
        if let Some(index) = track.region_bindings.iter().position(|region| region.region_uuid == region_uuid) {
            let region = track.region_bindings.remove(index);
            track.content.borrow_mut().regions.retain(|bound| bound.region_uuid != region_uuid);
            graph.unsubscribe(region.edit_sub);
            collections.release(graph, region.collection_uuid);
        }
    }
    for region_uuid in changes.added {
        if track.region_bindings.iter().any(|region| region.region_uuid == region_uuid) {
            continue;
        }
        if let Some(binding) = build_region(graph, &track.content, collections, region_uuid) {
            track.region_bindings.push(binding);
        }
    }
}

/// Sync a track's launched-clip bindings to its `clips` membership (key 4): a leaver releases its
/// collection ref and leaves the clip sequencer; a joiner reads its content (mirrors `reconcile_regions`).
pub(crate) fn reconcile_clips(graph: &mut BoxGraph, collections: &mut CollectionCache,
                   clip_sequencer: &Rc<RefCell<ClipSequencer>>, track: &mut TrackBinding) {
    let changes = core::mem::take(&mut *track.clip_changes.borrow_mut());
    for clip_uuid in changes.removed {
        if let Some(index) = track.clip_bindings.iter().position(|clip| clip.clip_uuid == clip_uuid) {
            let clip = track.clip_bindings.remove(index);
            track.content.borrow_mut().clips.retain(|bound| bound.clip_uuid != clip_uuid);
            graph.unsubscribe(clip.edit_sub);
            collections.release(graph, clip.collection_uuid);
            clip_sequencer.borrow_mut().forget(&clip_uuid);
        }
    }
    for clip_uuid in changes.added {
        if track.clip_bindings.iter().any(|clip| clip.clip_uuid == clip_uuid) {
            continue;
        }
        if let Some(binding) = build_clip(graph, &track.content, collections, clip_uuid) {
            track.clip_bindings.push(binding);
        }
    }
}

/// Read a clip's duration (key 10), `triggerMode.loop` (path [4, 1], default TRUE) and `mute` (key 11),
/// ACQUIRE its note-event collection (`events` pointer key 2), and register it in the track content. A
/// targeted `Parent` sub keeps duration / loop / mute fresh on edit. `None` if the clip has no collection.
pub(crate) fn build_clip(graph: &mut BoxGraph, content: &SharedNoteTrack, collections: &mut CollectionCache, clip_uuid: Uuid) -> Option<ClipBinding> {
    let collection_uuid = graph.target_of(&Address::of(clip_uuid, vec![2]))?.uuid;
    let collection = collections.acquire(graph, collection_uuid);
    let (duration, looped, mute) = read_clip_playback(graph, clip_uuid);
    content.borrow_mut().clips.push(BoundNoteClip {clip_uuid, duration, looped, mute, collection});
    let edit_content = content.clone();
    let edit_sub = graph.subscribe_vertex(Propagation::Parent, Address::box_of(clip_uuid), Box::new(move |graph, _update| {
        let (duration, looped, mute) = read_clip_playback(graph, clip_uuid);
        for bound in edit_content.borrow_mut().clips.iter_mut() {
            if bound.clip_uuid == clip_uuid {
                bound.duration = duration;
                bound.looped = looped;
                bound.mute = mute;
            }
        }
    }));
    Some(ClipBinding {clip_uuid, collection_uuid, edit_sub})
}

// NoteClipBox / ValueClipBox / AudioClipBox all carry `mute` at key 11 (WASM CONTRACT: mirror the TS schemas).
pub(crate) const CLIP_MUTE_KEY: u16 = 11;

pub(crate) fn read_clip_playback(graph: &BoxGraph, clip_uuid: Uuid) -> (f64, bool, bool) {
    let duration = region_pulses(graph, clip_uuid, 10);
    let looped = graph.field_value(&Address::of(clip_uuid, vec![4, 1])).and_then(|value| value.as_bool()).unwrap_or(true);
    let mute = graph.field_value(&Address::of(clip_uuid, vec![CLIP_MUTE_KEY])).and_then(|value| value.as_bool()).unwrap_or(false);
    (duration, looped, mute)
}

/// Read a region's loopable span, ACQUIRE its note-event collection (`events` pointer key 2) from the cache
/// (observed once, shared by mirrored regions), and sorted-insert it into the track's region collection.
/// `None` if the region has no collection.
pub(crate) fn build_region(graph: &mut BoxGraph, content: &SharedNoteTrack, collections: &mut CollectionCache, region_uuid: Uuid) -> Option<RegionBinding> {
    let region = read_note_region(graph, region_uuid);
    let collection_uuid = graph.target_of(&Address::of(region_uuid, vec![2]))?.uuid;
    let collection = collections.acquire(graph, collection_uuid);
    content.borrow_mut().regions.add(BoundRegion {region_uuid, region, collection});
    // Targeted: a `Parent` sub on the region box re-reads THIS region's span and re-sorts the track's set
    // when (and only when) one of this region's own fields is edited (TS `onIndexingChanged`, per-region).
    let edit_regions = content.clone();
    let edit_sub = graph.subscribe_vertex(Propagation::Parent, Address::box_of(region_uuid), Box::new(move |graph, _update| {
        let mut content = edit_regions.borrow_mut();
        let set = &mut content.regions;
        let mut moved = false;
        for bound in set.iter_mut() {
            if bound.region_uuid == region_uuid {
                bound.region = read_note_region(graph, region_uuid);
                moved = true;
            }
        }
        if moved {
            set.resort();
        }
    }));
    Some(RegionBinding {region_uuid, collection_uuid, edit_sub})
}

// NoteRegionBox `mute` (WASM CONTRACT: mirror the TS NoteRegionBox schema — note regions carry mute at 15,
// audio and value regions at 14).
pub(crate) const NOTE_REGION_MUTE_KEY: u16 = 15;

/// Read a region's loopable span from the box graph (position 10, duration 11, loopOffset 12, loopDuration 13)
/// plus its `mute` (15) — the sequencer skips a muted region (TS `NoteSequencer.#processRegions`).
pub(crate) fn read_note_region(graph: &BoxGraph, region_uuid: Uuid) -> NoteRegion {
    NoteRegion {
        position: region_pulses(graph, region_uuid, 10),
        duration: region_pulses(graph, region_uuid, 11),
        loop_offset: region_pulses(graph, region_uuid, 12),
        loop_duration: region_pulses(graph, region_uuid, 13),
        mute: graph.field_value(&Address::of(region_uuid, vec![NOTE_REGION_MUTE_KEY])).and_then(|value| value.as_bool()).unwrap_or(false)
    }
}
