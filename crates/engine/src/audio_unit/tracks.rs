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

/// ONE audio track's player-visible content: the track uuid, its regions kept SORTED BY POSITION (each a
/// self-contained `AudioRegion` — its playback data, no shared event collection), and its launchable audio
/// clips. Shared between the track binding (the cascade maintains it) and the unit's audio-region player.
pub(crate) struct AudioTrackContent {
    pub(crate) uuid: Uuid,
    pub(crate) regions: RegionCollection<AudioRegion>,
    pub(crate) clips: Vec<BoundAudioClip>
}

/// One launchable audio clip's playable content (TS `AudioClipBoxAdapter` through the Tape's clip branch):
/// the clip plays as a VIRTUAL REGION at position 0 with an infinite completion, looping at the CLIP
/// duration — so the player reuses the exact region passes. `looped` feeds the clip sequencer's sections.
pub(crate) struct BoundAudioClip {
    pub(crate) clip_uuid: Uuid,
    pub(crate) looped: bool,
    pub(crate) region: AudioRegion
}

pub(crate) type SharedAudioTrack = Rc<RefCell<AudioTrackContent>>;

/// The unit's live list of per-audio-track region collections, shared with the audio-region player. Mirrors
/// `SharedTrackSets` for the audio side.
pub(crate) type SharedAudioTrackSets = Rc<RefCell<Vec<SharedAudioTrack>>>;

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

/// One audio region's cascade entry: its uuid (its key in the track's collection) and a `Parent` edit monitor
/// that re-reads + re-sorts the region when its own fields change. No collection ref (audio regions hold their
/// playback data inline; the source file is resolved at render).
pub(crate) struct AudioRegionBinding {
    pub(crate) region_uuid: Uuid,
    pub(crate) edit_sub: SubscriptionId,
    // A re-read monitor on the region's play-mode box (Signalsmith / TimeStretch / PitchStretch), when it has
    // one: transpose lives on that SEPARATE box, so a `Parent` monitor on the region alone never sees it.
    // `None` for a native region (no play-mode).
    pub(crate) playmode_sub: Option<SubscriptionId>,
    // Warp markers are their OWN boxes pointing into the play-mode's warp hub, so neither monitor above sees
    // their edits. `marker_subs` re-reads on a marker DRAG (field edit); `warp_hub_sub` rebuilds this region
    // when a marker is ADDED / REMOVED (so the fresh marker set gets its own drag monitors). Empty / `None`
    // for a native region.
    pub(crate) marker_subs: Vec<SubscriptionId>,
    pub(crate) warp_hub_sub: Option<SubscriptionId>,
    // The SOURCE file's transient markers are their OWN boxes pointing into the file's transient hub, and only a
    // TIME-STRETCH region reads them (the granular sequencer aligns voices to them — see `read_transients`).
    // Neither the region nor play-mode monitor sees them, so mirror the warp pattern: `transient_subs` re-reads on
    // a marker DRAG (position edit); `transient_hub_sub` rebuilds this region when a transient is ADDED / REMOVED
    // (so the fresh set gets its own drag monitors). Empty / `None` unless the region is a time-stretch region.
    pub(crate) transient_subs: Vec<SubscriptionId>,
    pub(crate) transient_hub_sub: Option<SubscriptionId>,
    // Every sub above (playmode / warp / transient) is resolved ONCE from the region's play-mode pointer at build.
    // Switching the region's play-mode REPOINTS that pointer to a DIFFERENT box (e.g. native -> a new
    // AudioTimeStretchBox), which none of them re-resolve — so edits on the new box (transient-play-mode, transpose,
    // rate, its warp/transient markers) went unseen until a save+reload rebuilt from scratch. This monitor watches
    // the pointer itself and queues a full region rebuild on repoint, exactly like the hub observers above.
    pub(crate) playmode_pointer_sub: SubscriptionId
}

/// An AUDIO track binding: its sorted `AudioRegion` collection (shared with the player), its `regions`
/// membership observation, per-region edit monitors, and its `enabled` monitor. The audio analog of `TrackBinding`.
pub(crate) struct AudioTrackBinding {
    pub(crate) track_uuid: Uuid,
    pub(crate) content: SharedAudioTrack,
    pub(crate) region_bindings: Vec<AudioRegionBinding>,
    pub(crate) region_changes: Rc<RefCell<Members>>,
    pub(crate) region_sub: SubscriptionId,
    pub(crate) clip_bindings: Vec<AudioClipBinding>,
    pub(crate) clip_changes: Rc<RefCell<Members>>,
    pub(crate) clip_sub: SubscriptionId,
    pub(crate) enabled_sub: SubscriptionId,
    // The unit-wide dirty mark, kept so a per-region warp-hub observer can queue a region rebuild (via
    // `region_changes`) exactly like the track's own `regions` membership observer does.
    pub(crate) mark: DirtyMark
}

/// One bound launchable AUDIO clip: a targeted `Parent` subscription re-reads its playback fields on edit
/// (mirrors `AudioRegionBinding`).
pub(crate) struct AudioClipBinding {
    pub(crate) clip_uuid: Uuid,
    pub(crate) edit_sub: SubscriptionId
}

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

pub(crate) fn region_pulses(graph: &BoxGraph, uuid: Uuid, key: u16) -> f64 {
    graph.field_value(&Address::of(uuid, vec![key])).and_then(|value| value.as_int32()).unwrap_or(0) as f64
}

// AudioRegionBox field keys (WASM CONTRACT: mirror the TS AudioRegionBox schema). The loopable span lives at
// the SAME keys as note/value regions (10 position, 11 duration, 12 loop-offset, 13 loop-duration).
pub(crate) const AUDIO_REGION_FILE_KEY: u16 = 2;             // -> the AudioFileBox (the source sample)
pub(crate) const AUDIO_REGION_TIMEBASE_KEY: u16 = 4;         // "musical" (ppqn) or "seconds"; gates the duration / loop unit
pub(crate) const AUDIO_REGION_WAVEFORM_OFFSET_KEY: u16 = 7;  // seconds into the source where playback reads
pub(crate) const AUDIO_REGION_MUTE_KEY: u16 = 14;
pub(crate) const AUDIO_REGION_GAIN_KEY: u16 = 17;            // decibels
pub(crate) const AUDIO_REGION_FADING_KEY: u16 = 18;          // object: 1 in, 2 out (ppqn), 3 in-slope, 4 out-slope (ratio)
pub(crate) const AUDIO_REGION_PLAYMODE_KEY: u16 = 8;         // -> an AudioPitchStretchBox / AudioTimeStretchBox, or unset (native)
pub(crate) const PITCH_STRETCH_WARP_HUB_KEY: u16 = 1;        // AudioPitchStretchBox.warp-markers hub
// Every play-mode box (Pitch / TimeStretch / Signalsmith) exposes its warp-markers hub at field 1, so the
// live warp-marker observer can watch the hub without knowing the play-mode type.
pub(crate) const PLAY_MODE_WARP_HUB_KEY: u16 = 1;
pub(crate) const WARP_POSITION_KEY: u16 = 2;                 // WarpMarkerBox.position (ppqn, int32)
pub(crate) const WARP_SECONDS_KEY: u16 = 3;                  // WarpMarkerBox.seconds (f32)
// AudioTimeStretchBox field keys (WASM CONTRACT: mirror the TS AudioTimeStretchBox schema).
pub(crate) const TIME_STRETCH_WARP_HUB_KEY: u16 = 1;         // AudioTimeStretchBox.warp-markers hub
pub(crate) const TIME_STRETCH_PLAY_MODE_KEY: u16 = 2;        // transient-play-mode (int32 enum: 0 once, 1 repeat, 2 pingpong)
pub(crate) const TIME_STRETCH_RATE_KEY: u16 = 3;             // playback-rate (f32 ratio)
// AudioSignalsmithBox field keys (WASM CONTRACT: mirror the TS AudioSignalsmithBox schema).
pub(crate) const SIGNALSMITH_WARP_HUB_KEY: u16 = 1;          // AudioSignalsmithBox.warp-markers hub
pub(crate) const SIGNALSMITH_TRANSPOSE_KEY: u16 = 2;        // transpose (f32 semitones)
// AudioFileBox / TransientMarkerBox keys (the source's transient onsets, in seconds).
pub(crate) const AUDIO_FILE_TRANSIENTS_HUB_KEY: u16 = 10;    // AudioFileBox.transient-markers hub
pub(crate) const TRANSIENT_POSITION_KEY: u16 = 2;            // TransientMarkerBox.position (seconds, f32)

/// One audio region of an AUDIO track: its loopable span (mirrors note/value regions, keys 10-13) plus the
/// playback data the audio-region player needs. `gain_db` is the RAW decibel value (converted to a linear gain
/// in the player); `waveform_offset` is the source read offset in seconds; the fade in/out lengths + slopes let
/// the player apply ONE slope-shaped fade per region (never the doubled voice×clip product that the TS app hit).
/// Kept sorted in the track's `RegionCollection` by position. Fields are `pub(crate)` — the audio-region player
/// reads them directly at render.
#[derive(Clone)]
pub(crate) struct AudioRegion {
    pub(crate) region_uuid: Uuid,
    pub(crate) position: f64,        // ppqn
    pub(crate) duration: f64,        // ppqn
    pub(crate) loop_offset: f64,     // ppqn
    pub(crate) loop_duration: f64,   // ppqn
    pub(crate) file: Uuid,           // the AudioFileBox uuid (resolved to a SampleRef at render)
    pub(crate) gain_db: f32,
    pub(crate) mute: bool,
    pub(crate) waveform_offset: f64, // seconds
    pub(crate) fade_in: f64,         // ppqn
    pub(crate) fade_out: f64,        // ppqn
    pub(crate) fade_in_slope: f32,   // 0..1 ratio
    pub(crate) fade_out_slope: f32,  // 0..1 ratio
    // PitchStretch play-mode warp markers (content ppqn -> source seconds), sorted by ppqn. EMPTY = no
    // PitchStretch play-mode (native, or a TimeStretch play-mode — see `time_stretch`).
    pub(crate) warp: Vec<(f64, f64)>,
    // TimeStretch play-mode config (AudioTimeStretchBox), when the region's play-mode is a time-stretch. `Some`
    // routes the player to the transient-aligned granular sequencer instead of the stateless read head.
    pub(crate) time_stretch: Option<TimeStretchConfig>,
    // Signalsmith spectral play-mode (AudioSignalsmithBox): warp + transpose (semitones). `Some`
    // when the region's play-mode is a Signalsmith box.
    pub(crate) signalsmith: Option<SignalsmithConfig>,
    // The SOURCE file's transient marker positions in SECONDS (sorted); read only when `time_stretch` is `Some`
    // (the sequencer aligns granular voices to these). Empty otherwise.
    pub(crate) transients: Vec<f64>
}

impl Span for AudioRegion {
    fn position(&self) -> f64 { self.position }
    fn duration(&self) -> f64 { self.duration }
}

pub(crate) fn region_float(graph: &BoxGraph, uuid: Uuid, path: &[u16]) -> f32 {
    graph.field_value(&Address::of(uuid, path.to_vec())).and_then(|value| value.as_float32()).unwrap_or(0.0)
}

/// Read an `AudioRegionBox`'s span + playback fields. `None` when it has no `file` pointer (an unresolved /
/// half-built region is skipped, never played). The loopable span is normalized to PPQN: in a `Seconds`
/// time-base (the no-stretch / NoWarp default) `duration` + `loop-duration` are stored in SECONDS and converted
/// TEMPO-AWARE at the region's position via the `tempo_map` (mirrors `AudioRegionBoxAdapter`'s converted getters
/// `toPPQN(position)` — a single bpm mis-sizes the region under tempo automation). `position` + `loop-offset`
/// are always ppqn.
pub(crate) fn read_audio_region(graph: &BoxGraph, region_uuid: Uuid, tempo_map: &TempoMap) -> Option<AudioRegion> {
    let file = graph.target_of(&Address::of(region_uuid, vec![AUDIO_REGION_FILE_KEY]))?.uuid;
    let seconds_base = graph.field_value(&Address::of(region_uuid, vec![AUDIO_REGION_TIMEBASE_KEY]))
        .and_then(|value| value.as_str()).is_some_and(|base| base == "seconds");
    let position = region_pulses(graph, region_uuid, 10);
    let to_ppqn = |value: f64| if seconds_base { tempo_map.seconds_span_to_ppqn(position, value) } else { value };
    let time_stretch = read_time_stretch(graph, region_uuid);
    // The source transient onsets are only needed for the time-stretch sequencer; skip the read otherwise.
    let transients = if time_stretch.is_some() { read_transients(graph, file) } else { Vec::new() };
    Some(AudioRegion {
        region_uuid,
        position,
        duration: to_ppqn(region_float(graph, region_uuid, &[11]) as f64),
        loop_offset: region_float(graph, region_uuid, &[12]) as f64,
        loop_duration: to_ppqn(region_float(graph, region_uuid, &[13]) as f64),
        file,
        gain_db: region_float(graph, region_uuid, &[AUDIO_REGION_GAIN_KEY]),
        mute: graph.field_value(&Address::of(region_uuid, vec![AUDIO_REGION_MUTE_KEY])).and_then(|value| value.as_bool()).unwrap_or(false),
        waveform_offset: region_float(graph, region_uuid, &[AUDIO_REGION_WAVEFORM_OFFSET_KEY]) as f64,
        fade_in: region_float(graph, region_uuid, &[AUDIO_REGION_FADING_KEY, 1]) as f64,
        fade_out: region_float(graph, region_uuid, &[AUDIO_REGION_FADING_KEY, 2]) as f64,
        fade_in_slope: region_float(graph, region_uuid, &[AUDIO_REGION_FADING_KEY, 3]),
        fade_out_slope: region_float(graph, region_uuid, &[AUDIO_REGION_FADING_KEY, 4]),
        warp: read_warp_markers(graph, region_uuid),
        time_stretch,
        signalsmith: read_signalsmith(graph, region_uuid),
        transients
    })
}

/// Read a region's PitchStretch warp markers (sorted by ppqn position), mapping content ppqn -> source seconds.
/// Empty when the region has no play-mode (native) or a TimeStretch play-mode (unsupported; TS TODOs it).
pub(crate) fn read_warp_markers(graph: &BoxGraph, region_uuid: Uuid) -> Vec<(f64, f64)> {
    let play_mode = match graph.target_of(&Address::of(region_uuid, vec![AUDIO_REGION_PLAYMODE_KEY])) {
        Some(target) => target.uuid,
        None => return Vec::new()
    };
    match graph.find_box(&play_mode) {
        Some(found) if found.name == "AudioPitchStretchBox" => {}
        _ => return Vec::new()
    }
    let sources: Vec<Uuid> = graph.incoming(&Address::of(play_mode, vec![PITCH_STRETCH_WARP_HUB_KEY]))
        .into_iter().map(|address| address.uuid).collect();
    let mut markers: Vec<(f64, f64)> = sources.into_iter()
        .map(|uuid| (region_pulses(graph, uuid, WARP_POSITION_KEY), region_float(graph, uuid, &[WARP_SECONDS_KEY]) as f64))
        .collect();
    markers.sort_by(|left, right| left.0.partial_cmp(&right.0).unwrap_or(core::cmp::Ordering::Equal));
    markers
}

/// Read a region's TimeStretch play-mode config (`AudioTimeStretchBox`): its warp markers (content ppqn ->
/// source seconds, sorted), the transient fill mode, and the playback-rate multiplier. `None` when the region
/// has no play-mode or a non-time-stretch one (native / PitchStretch are handled elsewhere).
/// Signalsmith play-mode config (`AudioSignalsmithBox`): warp markers (content ppqn -> source
/// seconds, sorted) + transpose in semitones. `None` unless the region's play-mode is a Signalsmith box.
#[derive(Clone)]
pub(crate) struct SignalsmithConfig {
    pub(crate) warp: alloc::vec::Vec<(f64, f64)>,
    pub(crate) transpose: f32
}

pub(crate) fn read_signalsmith(graph: &BoxGraph, region_uuid: Uuid) -> Option<SignalsmithConfig> {
    let play_mode = graph.target_of(&Address::of(region_uuid, alloc::vec![AUDIO_REGION_PLAYMODE_KEY]))?.uuid;
    match graph.find_box(&play_mode) {
        Some(found) if found.name == "AudioSignalsmithBox" => {}
        _ => return None
    }
    let mut warp: alloc::vec::Vec<(f64, f64)> = graph.incoming(&Address::of(play_mode, alloc::vec![SIGNALSMITH_WARP_HUB_KEY]))
        .into_iter()
        .map(|address| (region_pulses(graph, address.uuid, WARP_POSITION_KEY), region_float(graph, address.uuid, &[WARP_SECONDS_KEY]) as f64))
        .collect();
    warp.sort_by(|left, right| left.0.partial_cmp(&right.0).unwrap_or(core::cmp::Ordering::Equal));
    let transpose = region_float(graph, play_mode, &[SIGNALSMITH_TRANSPOSE_KEY]);
    Some(SignalsmithConfig {warp, transpose})
}

pub(crate) fn read_time_stretch(graph: &BoxGraph, region_uuid: Uuid) -> Option<TimeStretchConfig> {
    let play_mode = graph.target_of(&Address::of(region_uuid, vec![AUDIO_REGION_PLAYMODE_KEY]))?.uuid;
    match graph.find_box(&play_mode) {
        Some(found) if found.name == "AudioTimeStretchBox" => {}
        _ => return None
    }
    let mut warp: Vec<(f64, f64)> = graph.incoming(&Address::of(play_mode, vec![TIME_STRETCH_WARP_HUB_KEY]))
        .into_iter()
        .map(|address| (region_pulses(graph, address.uuid, WARP_POSITION_KEY), region_float(graph, address.uuid, &[WARP_SECONDS_KEY]) as f64))
        .collect();
    warp.sort_by(|left, right| left.0.partial_cmp(&right.0).unwrap_or(core::cmp::Ordering::Equal));
    let transient_play_mode = TransientPlayMode::from_i32(
        graph.field_value(&Address::of(play_mode, vec![TIME_STRETCH_PLAY_MODE_KEY])).and_then(|value| value.as_int32()).unwrap_or(0));
    let playback_rate = region_float(graph, play_mode, &[TIME_STRETCH_RATE_KEY]);
    Some(TimeStretchConfig {warp, transient_play_mode, playback_rate})
}

/// Read a source file's transient onset positions (seconds, sorted) from its `AudioFileBox.transient-markers`
/// hub. Empty when the file has none (the sequencer needs >= 2 to bracket a segment).
pub(crate) fn read_transients(graph: &BoxGraph, file: Uuid) -> Vec<f64> {
    let mut positions: Vec<f64> = graph.incoming(&Address::of(file, vec![AUDIO_FILE_TRANSIENTS_HUB_KEY]))
        .into_iter()
        .map(|address| region_float(graph, address.uuid, &[TRANSIENT_POSITION_KEY]) as f64)
        .collect();
    positions.sort_by(|left, right| left.partial_cmp(right).unwrap_or(core::cmp::Ordering::Equal));
    positions
}

/// Build an AUDIO track binding (the audio analog of `build_track`): its sorted `AudioRegion` collection, a
/// `regions` membership observer, and an `enabled` monitor.
pub(crate) fn build_audio_track(graph: &mut BoxGraph, track_uuid: Uuid, mark: &DirtyMark) -> AudioTrackBinding {
    let content: SharedAudioTrack = Rc::new(RefCell::new(AudioTrackContent {
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
    AudioTrackBinding {track_uuid, content, region_bindings: Vec::new(), region_changes, region_sub,
        clip_bindings: Vec::new(), clip_changes, clip_sub, enabled_sub, mark: mark.clone()}
}

/// Tear down an audio track: unsubscribe its membership + edit + enabled observers, drop its content from
/// the unit's `audio_track_sets`, and leave the clip sequencer.
pub(crate) fn teardown_audio_track(graph: &mut BoxGraph, audio_track_sets: &SharedAudioTrackSets,
                        clip_sequencer: &Rc<RefCell<ClipSequencer>>, track: AudioTrackBinding) {
    graph.unsubscribe(track.region_sub);
    graph.unsubscribe(track.clip_sub);
    graph.unsubscribe(track.enabled_sub);
    clip_sequencer.borrow_mut().forget(&track.track_uuid);
    audio_track_sets.borrow_mut().retain(|set| !Rc::ptr_eq(set, &track.content));
    for region in track.region_bindings {
        unsubscribe_audio_region(graph, region);
    }
    for clip in track.clip_bindings {
        graph.unsubscribe(clip.edit_sub);
    }
}

/// Sync an audio track's launchable clips to its `clips` membership (key 4): a leaver leaves the clip
/// sequencer; a joiner reads its playable content (mirrors `reconcile_clips` for the audio side).
pub(crate) fn reconcile_audio_clips(graph: &mut BoxGraph, clip_sequencer: &Rc<RefCell<ClipSequencer>>,
                         track: &mut AudioTrackBinding, tempo_map: &SharedTempoMap) {
    let changes = core::mem::take(&mut *track.clip_changes.borrow_mut());
    for clip_uuid in changes.removed {
        if let Some(index) = track.clip_bindings.iter().position(|clip| clip.clip_uuid == clip_uuid) {
            let clip = track.clip_bindings.remove(index);
            track.content.borrow_mut().clips.retain(|bound| bound.clip_uuid != clip_uuid);
            graph.unsubscribe(clip.edit_sub);
            clip_sequencer.borrow_mut().forget(&clip_uuid);
        }
    }
    for clip_uuid in changes.added {
        if track.clip_bindings.iter().any(|clip| clip.clip_uuid == clip_uuid) {
            continue;
        }
        if let Some(binding) = build_audio_clip(graph, &track.content, clip_uuid, tempo_map) {
            track.clip_bindings.push(binding);
        }
    }
}

/// Read an audio clip's playable content and register it; a targeted `Parent` sub keeps it fresh on edit.
/// `None` when the clip has no file (skipped, never played).
pub(crate) fn build_audio_clip(graph: &mut BoxGraph, content: &SharedAudioTrack, clip_uuid: Uuid, tempo_map: &SharedTempoMap) -> Option<AudioClipBinding> {
    let (region, looped) = read_audio_clip(graph, clip_uuid, &tempo_map.borrow())?;
    content.borrow_mut().clips.push(BoundAudioClip {clip_uuid, looped, region});
    let edit_content = content.clone();
    let edit_tempo = tempo_map.clone();
    let edit_sub = graph.subscribe_vertex(Propagation::Parent, Address::box_of(clip_uuid), Box::new(move |graph, _update| {
        if let Some((region, looped)) = read_audio_clip(graph, clip_uuid, &edit_tempo.borrow()) {
            for bound in edit_content.borrow_mut().clips.iter_mut() {
                if bound.clip_uuid == clip_uuid {
                    bound.region = region.clone();
                    bound.looped = looped;
                }
            }
        }
    }));
    Some(AudioClipBinding {clip_uuid, edit_sub})
}

// AudioClipBox field keys (WASM CONTRACT: mirror the TS AudioClipBox schema). They DIFFER from the region
// keys: duration lives at 10 (Float32, pulses), mute at 11, gain at 14; file (2), waveformOffset (7) and
// playMode (8) match, so the play-mode/warp readers are shared.
pub(crate) const AUDIO_CLIP_FILE_KEY: u16 = 2;
pub(crate) const AUDIO_CLIP_WAVEFORM_OFFSET_KEY: u16 = 7;
pub(crate) const AUDIO_CLIP_DURATION_KEY: u16 = 10;
pub(crate) const AUDIO_CLIP_MUTE_KEY: u16 = 11;
pub(crate) const AUDIO_CLIP_GAIN_KEY: u16 = 14;

/// Read an audio CLIP as its virtual region (TS Tape clip branch: `{position: 0, loopDuration: clip.duration,
/// loopOffset: 0, complete: +Infinity}`, no fades) plus the `triggerMode.loop` flag for the sequencer.
pub(crate) fn read_audio_clip(graph: &BoxGraph, clip_uuid: Uuid, _tempo_map: &TempoMap) -> Option<(AudioRegion, bool)> {
    let file = graph.target_of(&Address::of(clip_uuid, vec![AUDIO_CLIP_FILE_KEY]))?.uuid;
    let time_stretch = read_time_stretch(graph, clip_uuid);
    let transients = if time_stretch.is_some() { read_transients(graph, file) } else { Vec::new() };
    let looped = graph.field_value(&Address::of(clip_uuid, vec![4, 1])).and_then(|value| value.as_bool()).unwrap_or(true);
    let region = AudioRegion {
        region_uuid: clip_uuid,
        position: 0.0,
        duration: f64::INFINITY,
        loop_offset: 0.0,
        loop_duration: region_float(graph, clip_uuid, &[AUDIO_CLIP_DURATION_KEY]) as f64,
        file,
        gain_db: region_float(graph, clip_uuid, &[AUDIO_CLIP_GAIN_KEY]),
        mute: graph.field_value(&Address::of(clip_uuid, vec![AUDIO_CLIP_MUTE_KEY])).and_then(|value| value.as_bool()).unwrap_or(false),
        waveform_offset: region_float(graph, clip_uuid, &[AUDIO_CLIP_WAVEFORM_OFFSET_KEY]) as f64,
        fade_in: 0.0,
        fade_out: 0.0,
        fade_in_slope: 0.0,
        fade_out_slope: 0.0,
        warp: read_warp_markers(graph, clip_uuid),
        time_stretch,
        signalsmith: read_signalsmith(graph, clip_uuid),
        transients
    };
    Some((region, looped))
}

/// Reconcile an audio track's regions against its `regions` membership: drop leavers, build + sorted-insert
/// joiners. Mirrors `reconcile_regions` without the note-event cache.
pub(crate) fn reconcile_audio_regions(graph: &mut BoxGraph, track: &mut AudioTrackBinding, tempo_map: &SharedTempoMap) {
    let changes = core::mem::take(&mut *track.region_changes.borrow_mut());
    for region_uuid in changes.removed {
        if let Some(index) = track.region_bindings.iter().position(|region| region.region_uuid == region_uuid) {
            let region = track.region_bindings.remove(index);
            track.content.borrow_mut().regions.retain(|bound| bound.region_uuid != region_uuid);
            unsubscribe_audio_region(graph, region);
        }
    }
    for region_uuid in changes.added {
        if track.region_bindings.iter().any(|region| region.region_uuid == region_uuid) {
            continue;
        }
        if let Some(binding) = build_audio_region(graph, &track.content, region_uuid, tempo_map, &track.mark, &track.region_changes) {
            track.region_bindings.push(binding);
        }
    }
}

/// Drop every subscription an audio region binding holds (edit + play-mode pointer + play-mode box + warp markers
/// + warp hub + source-file transient markers + transient hub).
pub(crate) fn unsubscribe_audio_region(graph: &mut BoxGraph, region: AudioRegionBinding) {
    graph.unsubscribe(region.edit_sub);
    graph.unsubscribe(region.playmode_pointer_sub);
    if let Some(sub) = region.playmode_sub { graph.unsubscribe(sub); }
    if let Some(sub) = region.warp_hub_sub { graph.unsubscribe(sub); }
    for sub in region.marker_subs { graph.unsubscribe(sub); }
    for sub in region.transient_subs { graph.unsubscribe(sub); }
    if let Some(sub) = region.transient_hub_sub { graph.unsubscribe(sub); }
}

/// Read an audio region, sorted-insert it into the track's collection, and subscribe a `Parent` edit monitor
/// that re-reads + re-sorts it when its own fields change (so a moved / re-gained / re-faded region updates
/// live). `None` if the region has no file (skipped, never played).
pub(crate) fn build_audio_region(graph: &mut BoxGraph, content: &SharedAudioTrack, region_uuid: Uuid,
                                 tempo_map: &SharedTempoMap, mark: &DirtyMark, region_changes: &Rc<RefCell<Members>>) -> Option<AudioRegionBinding> {
    let region = read_audio_region(graph, region_uuid, &tempo_map.borrow())?;
    let is_time_stretch = region.time_stretch.is_some();
    let file = region.file;
    content.borrow_mut().regions.add(region);
    let edit_sub = graph.subscribe_vertex(Propagation::Parent, Address::box_of(region_uuid),
        audio_region_reread(content, tempo_map, region_uuid));
    // Watch the play-mode box (transpose is a field on it, not on the region).
    let play_mode = graph.target_of(&Address::of(region_uuid, vec![AUDIO_REGION_PLAYMODE_KEY])).map(|target| target.uuid);
    let playmode_sub = play_mode.map(|uuid|
        graph.subscribe_vertex(Propagation::Parent, Address::box_of(uuid), audio_region_reread(content, tempo_map, region_uuid)));
    // Watch the warp markers. Each marker is its own box; a DRAG (position/seconds edit) lands on the marker
    // box, so give each current marker a re-read monitor. ADD/REMOVE changes the marker set, which must also
    // re-subscribe, so the hub observer queues a region REBUILD (removed+added) instead — exactly the track's
    // membership pattern. The initial catch-up Adds fire before `primed`, so they never self-trigger a rebuild.
    let mut marker_subs = Vec::new();
    let mut warp_hub_sub = None;
    if let Some(pm_uuid) = play_mode {
        let hub = Address::of(pm_uuid, vec![PLAY_MODE_WARP_HUB_KEY]);
        let markers: Vec<Uuid> = graph.incoming(&hub).into_iter().map(|address| address.uuid).collect();
        for marker_uuid in markers {
            marker_subs.push(graph.subscribe_vertex(Propagation::Parent, Address::box_of(marker_uuid),
                audio_region_reread(content, tempo_map, region_uuid)));
        }
        let primed = Rc::new(core::cell::Cell::new(false));
        let changes = region_changes.clone();
        let dirty = mark.clone();
        let flag = primed.clone();
        let sub = graph.subscribe_pointer_hub(hub, Box::new(move |_graph, _event| {
            if !flag.get() { return; }
            let mut members = changes.borrow_mut();
            members.removed.push(region_uuid);
            members.added.push(region_uuid);
            dirty.mark();
        }));
        primed.set(true);
        warp_hub_sub = Some(sub);
    }
    // Source-file transient markers (time-stretch regions only): drag monitors per marker + a hub observer that
    // rebuilds this region on add/remove, mirroring the warp-marker block above. Shared per file, so several
    // regions on the same file each watch it independently; a non-time-stretch region never subscribes.
    let mut transient_subs = Vec::new();
    let mut transient_hub_sub = None;
    if is_time_stretch {
        let hub = Address::of(file, vec![AUDIO_FILE_TRANSIENTS_HUB_KEY]);
        let markers: Vec<Uuid> = graph.incoming(&hub).into_iter().map(|address| address.uuid).collect();
        for marker_uuid in markers {
            transient_subs.push(graph.subscribe_vertex(Propagation::Parent, Address::box_of(marker_uuid),
                audio_region_reread(content, tempo_map, region_uuid)));
        }
        let primed = Rc::new(core::cell::Cell::new(false));
        let changes = region_changes.clone();
        let dirty = mark.clone();
        let flag = primed.clone();
        let sub = graph.subscribe_pointer_hub(hub, Box::new(move |_graph, _event| {
            if !flag.get() { return; }
            let mut members = changes.borrow_mut();
            members.removed.push(region_uuid);
            members.added.push(region_uuid);
            dirty.mark();
        }));
        primed.set(true);
        transient_hub_sub = Some(sub);
    }
    // Switching the region's play-mode REPOINTS its play-mode pointer to a different box; every subscription above
    // was resolved from the OLD target and would keep watching it. Watch the pointer FIELD itself and queue a full
    // rebuild on repoint, so playmode_sub + warp + transient subs all re-resolve against the new box. `This` fires
    // only on the pointer edit, not on the region's other field edits, so a gain/fade tweak never forces a rebuild;
    // `subscribe_vertex` never catch-up fires, so the rebuild's fresh monitor cannot self-trigger a loop.
    let rebuild_changes = region_changes.clone();
    let rebuild_mark = mark.clone();
    let playmode_pointer_sub = graph.subscribe_vertex(Propagation::This,
        Address::of(region_uuid, vec![AUDIO_REGION_PLAYMODE_KEY]), Box::new(move |_graph, _update| {
            let mut members = rebuild_changes.borrow_mut();
            members.removed.push(region_uuid);
            members.added.push(region_uuid);
            rebuild_mark.mark();
        }));
    Some(AudioRegionBinding {region_uuid, edit_sub, playmode_sub, marker_subs, warp_hub_sub,
        transient_subs, transient_hub_sub, playmode_pointer_sub})
}

/// A re-read observer: when a watched box changes, re-read THIS region and re-sort the track's collection. Built
/// twice per region (one monitor on the region box, one on its play-mode box), so it is a factory, not inline.
fn audio_region_reread(content: &SharedAudioTrack, tempo_map: &SharedTempoMap, region_uuid: Uuid) -> UpdateObserver {
    let edit_regions = content.clone();
    let edit_tempo = tempo_map.clone();
    Box::new(move |graph: &BoxGraph, _update: &Update| {
        let mut content = edit_regions.borrow_mut();
        let set = &mut content.regions;
        let mut moved = false;
        for bound in set.iter_mut() {
            if bound.region_uuid == region_uuid {
                if let Some(updated) = read_audio_region(graph, region_uuid, &edit_tempo.borrow()) {
                    *bound = updated;
                    moved = true;
                }
            }
        }
        if moved {
            set.resort();
        }
    })
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

/// A track's `type` (field 11), defaulting to 0 (Undefined) when unset.
pub(crate) fn track_type(graph: &BoxGraph, track_uuid: Uuid) -> i32 {
    graph.field_value(&Address::of(track_uuid, vec![TRACK_TYPE_KEY])).and_then(|value| value.as_int32()).unwrap_or(0)
}

pub(crate) fn track_enabled(graph: &BoxGraph, track_uuid: Uuid) -> bool {
    graph.field_value(&Address::of(track_uuid, vec![TRACK_ENABLED_KEY])).and_then(|value| value.as_bool()).unwrap_or(true)
}
