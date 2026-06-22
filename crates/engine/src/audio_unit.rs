//! The audio-unit cascade: ONE place for everything beneath the RootBox `audio-units`, mirroring the box
//! hierarchy AudioUnitBox -> TrackBox -> RegionBox -> NoteEventCollection -> events. Everything here is
//! reactive (catch-up + subscribe), so a main-thread edit at any level reaches the running engine:
//!
//!   - `AudioUnitBinding`: per `AudioUnitBox`. Holds the device chains (three `IndexedCollection`s — the
//!     `input` instrument, the `midi-effects` and `audio-effects` chains, each ordered by device `index`),
//!     the shared region set the sequencer reads, and the wired processor cluster (rebuilt only when a
//!     chain reports dirty).
//!   - `TrackBinding`: per `TrackBox`, observing its `regions`.
//!   - `RegionBinding`: per region, observing its `NoteEventCollection`.
//!
//! The `impl Engine` methods here own the unit lifecycle (build / rewire / teardown + the per-transaction
//! `reconcile`); the free functions own the track/region cascade (graph-only, no processor wiring). The
//! engine struct + its render path stay in `lib.rs`; this module is the structure beneath a unit.

use alloc::boxed::Box;
use alloc::rc::Rc;
use alloc::vec;
use alloc::vec::Vec;
use core::cell::RefCell;
use abi::{DEVICE_KIND_EFFECT, DEVICE_KIND_INSTRUMENT, DEVICE_KIND_MIDI_EFFECT};
use bindings::indexed_collection::IndexedCollection;
use bindings::note_collection::NoteCollection;
use boxgraph::address::{Address, Uuid};
use boxgraph::graph::BoxGraph;
use boxgraph::subscription::{HubEvent, SubscriptionId};
use boxgraph::updates::Update;
use engine_env::audio_buffer::SharedAudioBuffer;
use engine_env::audio_generator::AudioGenerator;
use engine_env::audio_input::AudioInput;
use engine_env::channel_strip::{ChannelStripProcessor, StripParams};
use engine_env::engine_context::NodeId;
use engine_env::note_event_instrument::SharedNoteEventSource;
use engine_env::note_region::NoteRegion;
use engine_env::note_region_source::NoteRegionSource;
use engine_env::note_sequencer::NoteSequencer;
use value::event::EventCollection;
use value::note::NoteEvent;
use value::region::{RegionCollection, Span};
use crate::plugin_audio_effect::PluginAudioEffect;
use crate::plugin_instrument::PluginInstrument;
use crate::plugin_midi_effect::PluginMidiEffect;
use crate::{Engine, PullLink, DEVICE_INDEX_KEY};

/// One bound note region: its loopable span plus a shared handle to its `NoteEventCollection` (the cache's
/// canonical observation — see `CollectionCache`). Keyed by uuid so the region cascade can remove it.
/// MIRRORED regions reference the same collection box, so their `collection` handles are clones of the one
/// observation: each region has its own span, all read the one ever-sorted event list.
pub(crate) struct BoundRegion {
    region_uuid: Uuid,
    region: NoteRegion,
    collection: NoteCollection
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
struct CollectionCache {
    entries: Vec<CollectionEntry>
}

struct CollectionEntry {
    uuid: Uuid,
    collection: NoteCollection,
    refs: usize
}

impl CollectionCache {
    /// Get a handle to the collection `uuid`, observing it once on first use and bumping its ref count.
    fn acquire(&mut self, graph: &mut BoxGraph, uuid: Uuid) -> NoteCollection {
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.uuid == uuid) {
            entry.refs += 1;
            return entry.collection.clone();
        }
        let collection = NoteCollection::observe(graph, uuid);
        self.entries.push(CollectionEntry {uuid, collection: collection.clone(), refs: 1});
        collection
    }

    /// Drop one reference to `uuid`; terminate the observation when the last region leaves.
    fn release(&mut self, graph: &mut BoxGraph, uuid: Uuid) {
        if let Some(index) = self.entries.iter().position(|entry| entry.uuid == uuid) {
            self.entries[index].refs -= 1;
            if self.entries[index].refs == 0 {
                self.entries.remove(index).collection.terminate(graph);
            }
        }
    }

    /// Terminate any remaining observations (a defensive cleanup on unit teardown; normally already empty).
    fn terminate_all(self, graph: &mut BoxGraph) {
        for entry in self.entries {
            entry.collection.terminate(graph);
        }
    }
}

/// ONE track's note regions, kept SORTED BY POSITION (a `RegionCollection`). Scoped to the track because
/// `iterate_range` assumes non-overlapping regions, which holds within a track but not across a unit's
/// tracks. Shared between the track binding (the cascade inserts / removes / re-sorts) and the unit's
/// sequencer (which range-queries it each block).
pub(crate) type SharedTrackRegions = Rc<RefCell<RegionCollection<BoundRegion>>>;

/// The unit's live list of per-track region collections (one entry per `TrackBox`), shared with the
/// sequencer. Tracks are added / removed live; the sequencer iterates whatever is currently present.
pub(crate) type SharedTrackSets = Rc<RefCell<Vec<SharedTrackRegions>>>;

/// The `NoteRegionSource` the unit's sequencer reads. It iterates EACH track's own sorted region collection
/// (unit -> tracks -> regions), range-querying each — mirroring TS `tracks -> regions.collection.iterateRange`.
pub(crate) struct BoundNoteRegions {
    pub(crate) tracks: SharedTrackSets
}

impl NoteRegionSource for BoundNoteRegions {
    fn for_each_region(&self, from: f64, to: f64, visit: &mut dyn FnMut(&NoteRegion, &EventCollection<NoteEvent>)) {
        for track in self.tracks.borrow().iter() {
            // Binary-search the regions overlapping [from, to) within this track (sorted by position).
            for bound in track.borrow().iterate_range(from, to) {
                visit(&bound.region, &bound.collection.events());
            }
        }
    }
}

/// Pending membership changes a pointer-hub observer records (observers get `&BoxGraph` only, so they
/// cannot mutate the processor graph); the engine drains them while reconciling, where it has `&mut`. Used
/// at every cascade level: the RootBox's audio-units, an audio unit's tracks, a track's regions.
#[derive(Default)]
pub(crate) struct Members {
    pub(crate) added: Vec<Uuid>,
    pub(crate) removed: Vec<Uuid>
}

/// One bound note region in the cascade: its uuid (its entry in the track's region collection) and the
/// collection it references (so the cache ref can be released when the region leaves).
struct RegionBinding {
    region_uuid: Uuid,
    collection_uuid: Uuid
}

/// A track BINDING: owns this track's sorted region collection (`regions_set`, shared with the sequencer),
/// observes its `regions` membership (add / remove), and re-sorts the collection when a member region's
/// span (position / duration / loop) is edited (`edit_sub`).
struct TrackBinding {
    track_uuid: Uuid,
    regions_set: SharedTrackRegions,
    region_bindings: Vec<RegionBinding>,
    region_changes: Rc<RefCell<Members>>,
    region_sub: SubscriptionId,
    edit_sub: SubscriptionId
}

/// The processor nodes + edges the engine wired for one unit (its teardown set, the analog of TS
/// `AudioDeviceChain`'s `#disconnector`): everything to drop before a rebuild. `output_buffer` is the last
/// node's buffer, fed into the master bus.
struct WiredCluster {
    nodes: Vec<NodeId>,
    edges: Vec<(NodeId, NodeId)>,
    output_buffer: SharedAudioBuffer
}

/// A live audio-unit BINDING. The RootBox `audio-units` membership drives create / destroy. Beneath it:
/// the track -> region cascade feeds the per-track `track_sets` the sequencer reads; and three
/// `IndexedCollection`s observe the unit's device hosts — `input` (the instrument, host 22), `midi` (host
/// 21), `audio` (host 23) — each ordered by the device `index`. The wired processor cluster is rebuilt
/// (from the device table + the sorted chains) ONLY when one of those three reports `dirty`, so a unit's
/// wiring stays stable until the user edits its scope. Teardown drops the cluster, the cascade, and the
/// chain subscriptions.
pub(crate) struct AudioUnitBinding {
    unit: Uuid,
    track_sets: SharedTrackSets,
    collections: CollectionCache,
    tracks: Vec<TrackBinding>,
    track_changes: Rc<RefCell<Members>>,
    track_sub: SubscriptionId,
    strip_params: Rc<StripParams>,        // the unit's volume / panning / mute, kept in sync with its box
    strip_subs: Vec<SubscriptionId>,      // the volume / panning / mute field subscriptions
    input: IndexedCollection,
    midi: IndexedCollection,
    audio: IndexedCollection,
    wired: Option<WiredCluster>
}

impl Engine {
    /// Start observing the RootBox `audio-units` membership: each connected `AudioUnitBox` becomes a unit
    /// binding, created / destroyed LIVE as the box graph changes (the reactive replacement for a one-shot
    /// build). The membership observer only records into `unit_changes`; the actual graph mutation happens
    /// in `reconcile_units` (catch-up here, and after every transaction). The master bus must already exist
    /// (created by the engine before this is called), since `reconcile_units` wires units into it.
    pub(crate) fn observe_audio_units(&mut self) {
        // RootBox.audio-units is field key 20; an AudioUnitBox connects via its `collection` pointer, so the
        // hub source's uuid IS the audio unit. We do not order the units (order is not audible).
        if let Some(root) = self.graph.find_by_name("RootBox") {
            let changes = self.unit_changes.clone();
            self.graph.subscribe_pointer_hub(Address::of(root.uuid, vec![20]), Box::new(move |_graph, event| {
                match event {
                    HubEvent::Added(source) => changes.borrow_mut().added.push(source.uuid),
                    HubEvent::Removed(source) => changes.borrow_mut().removed.push(source.uuid)
                }
            }));
        }
        self.reconcile_units();
    }

    /// THE output audio unit's uuid: the `AudioUnitBox` whose `type` (field 1) is `"output"`. It is a fixed
    /// singleton (there is exactly one, and it never changes), so it is found once and wired statically.
    fn output_unit_uuid(&self) -> Option<Uuid> {
        self.graph.find_all_by_name("AudioUnitBox").iter()
            .find(|unit| self.graph.field_value(&Address::of(unit.uuid, vec![1])).and_then(|value| value.as_str()) == Some("output"))
            .map(|unit| unit.uuid)
    }

    fn is_output_unit(&self, uuid: Uuid) -> bool {
        self.graph.field_value(&Address::of(uuid, vec![1])).and_then(|value| value.as_str()) == Some("output")
    }

    /// Wire THE output unit's channel strip as the engine's final master, fed by the static summing bus
    /// (`master_output`, the engine's `master` bus that every instrument unit sums into). The strip applies
    /// the output unit's volume / panning / mute (bound to its box) and its output is what `render` reads.
    /// Built ONCE at bind — the output unit and its bus are fixed singletons, never reactive. Returns the
    /// buffer `render` should read: the strip's output, or `master_output` directly if there is no output unit.
    pub(crate) fn output_strip(&mut self, master_output: SharedAudioBuffer) -> SharedAudioBuffer {
        let uuid = match self.output_unit_uuid() {
            Some(uuid) => uuid,
            None => return master_output
        };
        let params = Rc::new(StripParams::new());
        let volume = params.clone();
        self.graph.catchup_and_subscribe(Address::of(uuid, vec![12]), move |value| {
            if let Some(value) = value.as_float32() { volume.volume_db.set(value) }
        });
        let panning = params.clone();
        self.graph.catchup_and_subscribe(Address::of(uuid, vec![13]), move |value| {
            if let Some(value) = value.as_float32() { panning.panning.set(value) }
        });
        let mute = params.clone();
        self.graph.catchup_and_subscribe(Address::of(uuid, vec![14]), move |value| {
            if let Some(value) = value.as_bool() { mute.mute.set(value) }
        });
        let strip = Rc::new(RefCell::new(ChannelStripProcessor::new(params, self.sample_rate)));
        strip.borrow_mut().set_audio_source(master_output);
        let strip_output = strip.borrow().audio_output();
        let strip_id = self.context.register_processor(strip);
        self.context.register_edge(self.master_id, strip_id); // the bus sums first, then the master strip
        strip_output
    }

    /// Apply recorded membership changes top-down: tear down / build audio units, CASCADE into each unit's
    /// tracks and regions, then RE-WIRE only the units whose device chains changed. Called on bind (catch-up)
    /// and after every transaction; with nothing changed it is a cheap no-op (the per-unit dirty flags gate
    /// the rewire), so a unit's wiring stays stable until the user edits its scope.
    pub(crate) fn reconcile_units(&mut self) {
        if self.master.is_none() {
            return;
        }
        let changes = core::mem::take(&mut *self.unit_changes.borrow_mut());
        for uuid in changes.removed {
            if let Some(index) = self.audio_units.iter().position(|binding| binding.unit == uuid) {
                let binding = self.audio_units.remove(index);
                self.teardown_unit(binding);
            }
        }
        for uuid in changes.added {
            if self.audio_units.iter().any(|binding| binding.unit == uuid) {
                continue;
            }
            if self.is_output_unit(uuid) {
                continue; // THE output unit is a fixed singleton, wired statically at bind (see `output_strip`)
            }
            let binding = self.build_unit(uuid);
            self.audio_units.push(binding);
        }
        // Take the bindings out so the per-unit work can borrow `&mut self` (graph, context, master) without
        // aliasing `self.audio_units`. Cascade the tracks -> regions, then re-wire any unit whose device
        // chains (input / midi / audio) reported dirty — using `|` so all three dirty flags are consumed.
        let mut units = core::mem::take(&mut self.audio_units);
        for unit in &mut units {
            reconcile_tracks(&mut self.graph, unit);
            let dirty = unit.input.take_dirty() | unit.midi.take_dirty() | unit.audio.take_dirty();
            if dirty {
                self.rewire_unit(unit);
            }
        }
        self.audio_units = units;
    }

    /// Remove a unit entirely: drop its wired cluster (edges, nodes, bus source), unsubscribe its tracks
    /// membership + track cascade, and terminate its three device-chain collections.
    fn teardown_unit(&mut self, mut binding: AudioUnitBinding) {
        if let Some(wired) = &binding.wired {
            self.teardown_wired(wired);
        }
        self.graph.unsubscribe(binding.track_sub);
        for sub in &binding.strip_subs {
            self.graph.unsubscribe(*sub);
        }
        for track in binding.tracks {
            teardown_track(&mut self.graph, &binding.track_sets, &mut binding.collections, track);
        }
        binding.collections.terminate_all(&mut self.graph); // defensive; the tracks released everything
        binding.input.terminate(&mut self.graph);
        binding.midi.terminate(&mut self.graph);
        binding.audio.terminate(&mut self.graph);
    }

    /// Drop a wired cluster's processor graph: unwire its output from the master bus, remove its edges, and
    /// remove its nodes. The teardown set, the analog of TS `AudioDeviceChain`'s `#disconnector.terminate`.
    fn teardown_wired(&mut self, wired: &WiredCluster) {
        if let Some(master) = &self.master {
            master.borrow_mut().remove_audio_source(&wired.output_buffer);
        }
        for (source, target) in &wired.edges {
            self.context.remove_edge(*source, *target);
        }
        for node in &wired.nodes {
            self.context.remove_processor(*node);
        }
    }

    /// Build a unit binding: its per-track region collections list (`track_sets`, shared with the
    /// sequencer), the track-membership subscription (key 20) the cascade fills, and the three device-chain
    /// collections — `input` (host 22), `midi` (host 21), `audio` (host 23), each ordered by the device
    /// `index` (field 2). No processor nodes yet; the first `reconcile` rewires it (the collections are dirty
    /// from catch-up). No per-device-type logic: the device table (`device_for_type`) maps each box to its plugin.
    fn build_unit(&mut self, uuid: Uuid) -> AudioUnitBinding {
        let track_sets: SharedTrackSets = Rc::new(RefCell::new(Vec::new()));
        let track_changes = Rc::new(RefCell::new(Members::default()));
        let recorder = track_changes.clone();
        let track_sub = self.graph.subscribe_pointer_hub(Address::of(uuid, vec![20]), Box::new(move |_graph, event| {
            match event {
                HubEvent::Added(source) => recorder.borrow_mut().added.push(source.uuid),
                HubEvent::Removed(source) => recorder.borrow_mut().removed.push(source.uuid)
            }
        }));
        let input = IndexedCollection::observe(&mut self.graph, Address::of(uuid, vec![22]), DEVICE_INDEX_KEY);
        let midi = IndexedCollection::observe(&mut self.graph, Address::of(uuid, vec![21]), DEVICE_INDEX_KEY);
        let audio = IndexedCollection::observe(&mut self.graph, Address::of(uuid, vec![23]), DEVICE_INDEX_KEY);
        // The channel strip's parameters, kept in sync with the unit's box: volume (12, dB), panning (13),
        // mute (14). Reactive but no rewire needed — the strip reads these Cells each block.
        let strip_params = Rc::new(StripParams::new());
        let volume = strip_params.clone();
        let volume_sub = self.graph.catchup_and_subscribe(Address::of(uuid, vec![12]), move |value| {
            if let Some(value) = value.as_float32() { volume.volume_db.set(value) }
        });
        let panning = strip_params.clone();
        let panning_sub = self.graph.catchup_and_subscribe(Address::of(uuid, vec![13]), move |value| {
            if let Some(value) = value.as_float32() { panning.panning.set(value) }
        });
        let mute = strip_params.clone();
        let mute_sub = self.graph.catchup_and_subscribe(Address::of(uuid, vec![14]), move |value| {
            if let Some(value) = value.as_bool() { mute.mute.set(value) }
        });
        AudioUnitBinding {
            unit: uuid, track_sets, collections: CollectionCache::default(), tracks: Vec::new(),
            track_changes, track_sub, strip_params, strip_subs: vec![volume_sub, panning_sub, mute_sub],
            input, midi, audio, wired: None
        }
    }

    /// (Re)build a unit's processor cluster from the current device table + the sorted chains: instrument
    /// (the `input` device), the midi-fx pull chain folded in index order under it, and the audio-fx chain
    /// wired instrument -> fx0 -> ... -> bus in index order. Tears down the old cluster first. A unit with no
    /// resolvable instrument is left silent (wired = None). The whole device set is realized this way; the
    /// only per-device knowledge is the box-type -> plugin table.
    fn rewire_unit(&mut self, unit: &mut AudioUnitBinding) {
        if let Some(wired) = unit.wired.take() {
            self.teardown_wired(&wired);
        }
        let instrument_device = match unit.input.sorted().first()
            .and_then(|uuid| self.graph.find_box(uuid))
            .and_then(|device_box| self.device_for_type(&device_box.name)) {
            Some(device) if device.kind == DEVICE_KIND_INSTRUMENT => device,
            _ => return // no instrument yet: the unit stays silent until its `input` device box appears
        };
        // The pull chain: sequencer (over the unit's per-track region collections) at the leaf, each midi-fx
        // folded on top in index order, so the instrument pulls the highest-index fx, which pulls the next,
        // down to the sequencer. The sequencer reads `track_sets` live, so track / region changes need no rewire.
        let sequencer: SharedNoteEventSource =
            Rc::new(RefCell::new(NoteSequencer::new(Box::new(BoundNoteRegions {tracks: unit.track_sets.clone()}))));
        let mut chain = PullLink::Source(sequencer);
        for device_uuid in unit.midi.sorted() {
            let device = self.graph.find_box(&device_uuid).and_then(|device_box| self.device_for_type(&device_box.name));
            match device {
                Some(device) if device.kind == DEVICE_KIND_MIDI_EFFECT => {
                    chain = PullLink::MidiFx {effect: Rc::new(PluginMidiEffect::new(device)), upstream: Rc::new(chain)};
                }
                _ => {}
            }
        }
        let instrument = Rc::new(RefCell::new(PluginInstrument::new(self.sample_rate, instrument_device)));
        instrument.borrow_mut().set_pull_chain(chain);
        let mut output = instrument.borrow().audio_output();
        let instrument_id = self.context.register_processor(instrument);
        let mut nodes = vec![instrument_id];
        let mut edges: Vec<(NodeId, NodeId)> = Vec::new();
        let mut output_node = instrument_id;
        // The audio-fx chain in index order: instrument -> fx0 -> fx1 -> ... Each reads the previous output.
        for device_uuid in unit.audio.sorted() {
            let resolved = self.graph.find_box(&device_uuid).and_then(|device_box| self.device_for_type(&device_box.name));
            let device = match resolved {
                Some(device) if device.kind == DEVICE_KIND_EFFECT => device,
                _ => continue
            };
            let node = Rc::new(RefCell::new(PluginAudioEffect::new(self.sample_rate, device)));
            node.borrow_mut().set_audio_source(output);
            output = node.borrow().audio_output();
            let node_id = self.context.register_processor(node);
            self.context.register_edge(output_node, node_id);
            edges.push((output_node, node_id));
            nodes.push(node_id);
            output_node = node_id;
        }
        // The channel strip terminates the unit's chain: instrument/fx -> STRIP -> master. It applies the
        // unit's volume / panning / mute (read from the shared StripParams), then feeds the master bus.
        let strip = Rc::new(RefCell::new(ChannelStripProcessor::new(unit.strip_params.clone(), self.sample_rate)));
        strip.borrow_mut().set_audio_source(output);
        let strip_output = strip.borrow().audio_output();
        let strip_id = self.context.register_processor(strip);
        self.context.register_edge(output_node, strip_id);
        edges.push((output_node, strip_id));
        nodes.push(strip_id);
        let master = self.master.as_ref().unwrap();
        master.borrow_mut().add_audio_source(strip_output.clone());
        self.context.register_edge(strip_id, self.master_id);
        edges.push((strip_id, self.master_id));
        unit.wired = Some(WiredCluster {nodes, edges, output_buffer: strip_output});
    }
}

// ---- The track / region cascade beneath an audio unit. Free functions taking `&mut BoxGraph`: they only
// observe the box graph and edit the per-track region collections + the unit's note-event cache, never the
// processor graph, so they avoid borrowing the engine. Membership is recorded into `Members` + drained
// here; a region's span EDIT re-sorts its track collection live via the track's `edit_sub` observer. ----

/// Reconcile one unit's tracks against its `tracks` membership, then each track's regions. A new track's
/// region collection is registered into the unit's shared `track_sets` (so the sequencer sees it); a
/// removed track's collection is unregistered.
fn reconcile_tracks(graph: &mut BoxGraph, unit: &mut AudioUnitBinding) {
    let changes = core::mem::take(&mut *unit.track_changes.borrow_mut());
    for track_uuid in changes.removed {
        if let Some(index) = unit.tracks.iter().position(|track| track.track_uuid == track_uuid) {
            let track = unit.tracks.remove(index);
            teardown_track(graph, &unit.track_sets, &mut unit.collections, track);
        }
    }
    for track_uuid in changes.added {
        if unit.tracks.iter().any(|track| track.track_uuid == track_uuid) {
            continue;
        }
        let track = build_track(graph, track_uuid);
        unit.track_sets.borrow_mut().push(track.regions_set.clone());
        unit.tracks.push(track);
    }
    for track in &mut unit.tracks {
        reconcile_regions(graph, &mut unit.collections, track);
    }
}

/// Build a track binding: its own sorted region collection (`regions_set`), a subscription to the track's
/// `regions` membership (key 3), and an edit subscription that re-sorts the collection when a member
/// region's span (position / duration / loop fields) changes — so a moved region lands at the right place.
fn build_track(graph: &mut BoxGraph, track_uuid: Uuid) -> TrackBinding {
    let regions_set: SharedTrackRegions = Rc::new(RefCell::new(RegionCollection::new()));
    let region_changes = Rc::new(RefCell::new(Members::default()));
    let recorder = region_changes.clone();
    let region_sub = graph.subscribe_pointer_hub(Address::of(track_uuid, vec![3]), Box::new(move |_graph, event| {
        match event {
            HubEvent::Added(source) => recorder.borrow_mut().added.push(source.uuid),
            HubEvent::Removed(source) => recorder.borrow_mut().removed.push(source.uuid)
        }
    }));
    // Re-sort on a member region's edit: re-read its span and re-sort the collection (TS onIndexingChanged).
    let edit_regions = regions_set.clone();
    let edit_sub = graph.subscribe_all(Box::new(move |graph, update| {
        let uuid = affected_uuid(update);
        let mut set = edit_regions.borrow_mut();
        let mut moved = false;
        for bound in set.iter_mut() {
            if bound.region_uuid == uuid {
                bound.region = read_note_region(graph, uuid);
                moved = true;
            }
        }
        if moved {
            set.resort();
        }
    }));
    TrackBinding {track_uuid, regions_set, region_bindings: Vec::new(), region_changes, region_sub, edit_sub}
}

/// Tear down a track: unsubscribe its membership + edit observers, unregister its region collection from the
/// unit's `track_sets`, and release each region's note-event cache reference.
fn teardown_track(graph: &mut BoxGraph, track_sets: &SharedTrackSets, collections: &mut CollectionCache, track: TrackBinding) {
    graph.unsubscribe(track.region_sub);
    graph.unsubscribe(track.edit_sub);
    track_sets.borrow_mut().retain(|set| !Rc::ptr_eq(set, &track.regions_set));
    for region in track.region_bindings {
        collections.release(graph, region.collection_uuid);
    }
}

/// Reconcile a track's regions against its `regions` membership, maintaining the track's sorted region
/// collection and the unit's note-event cache (releasing on remove, acquiring + sorted-inserting on add).
fn reconcile_regions(graph: &mut BoxGraph, collections: &mut CollectionCache, track: &mut TrackBinding) {
    let changes = core::mem::take(&mut *track.region_changes.borrow_mut());
    for region_uuid in changes.removed {
        if let Some(index) = track.region_bindings.iter().position(|region| region.region_uuid == region_uuid) {
            let region = track.region_bindings.remove(index);
            track.regions_set.borrow_mut().retain(|bound| bound.region_uuid != region_uuid);
            collections.release(graph, region.collection_uuid);
        }
    }
    for region_uuid in changes.added {
        if track.region_bindings.iter().any(|region| region.region_uuid == region_uuid) {
            continue;
        }
        if let Some(binding) = build_region(graph, &track.regions_set, collections, region_uuid) {
            track.region_bindings.push(binding);
        }
    }
}

/// Read a region's loopable span, ACQUIRE its note-event collection (`events` pointer key 2) from the cache
/// (observed once, shared by mirrored regions), and sorted-insert it into the track's region collection.
/// `None` if the region has no collection.
fn build_region(graph: &mut BoxGraph, regions_set: &SharedTrackRegions, collections: &mut CollectionCache, region_uuid: Uuid) -> Option<RegionBinding> {
    let region = read_note_region(graph, region_uuid);
    let collection_uuid = graph.target_of(&Address::of(region_uuid, vec![2]))?.uuid;
    let collection = collections.acquire(graph, collection_uuid);
    regions_set.borrow_mut().add(BoundRegion {region_uuid, region, collection});
    Some(RegionBinding {region_uuid, collection_uuid})
}

/// Read a region's loopable span from the box graph (position 10, duration 11, loopOffset 12, loopDuration 13).
fn read_note_region(graph: &BoxGraph, region_uuid: Uuid) -> NoteRegion {
    NoteRegion {
        position: region_pulses(graph, region_uuid, 10),
        duration: region_pulses(graph, region_uuid, 11),
        loop_offset: region_pulses(graph, region_uuid, 12),
        loop_duration: region_pulses(graph, region_uuid, 13)
    }
}

/// The box uuid an update targets (its own box for new/delete, the address' box for field edits).
fn affected_uuid(update: &Update) -> Uuid {
    match update {
        Update::Primitive {address, ..} | Update::Pointer {address, ..} => address.uuid,
        Update::New {uuid, ..} | Update::Delete {uuid, ..} => *uuid
    }
}

fn region_pulses(graph: &BoxGraph, uuid: Uuid, key: u16) -> f64 {
    graph.field_value(&Address::of(uuid, vec![key])).and_then(|value| value.as_int32()).unwrap_or(0) as f64
}

#[cfg(test)]
mod tests {
    //! Mirrored regions: a NoteEventCollectionBox is observed ONCE by the cache and shared by every region
    //! that references it; the observation survives until the last region leaves. Two regions sharing a
    //! collection both read the same events, and removing one leaves the other reading it.
    use super::CollectionCache;
    use boxgraph::address::{Address, Uuid};
    use boxgraph::boxes::GraphBox;
    use boxgraph::field::{FieldValue, Fields};
    use boxgraph::graph::BoxGraph;

    const COLLECTION: Uuid = [1u8; 16];
    const NOTE: Uuid = [2u8; 16];

    fn graph_box(uuid: Uuid, name: &str, fields: &[(u16, FieldValue)]) -> GraphBox {
        let mut map = Fields::new();
        for (key, value) in fields {
            map.insert(*key, value.clone());
        }
        GraphBox {creation_index: 0, name: name.to_string(), uuid, fields: map}
    }

    // A collection with one note member, so the observed NoteCollection has exactly one event.
    fn graph() -> BoxGraph {
        BoxGraph::from_boxes(vec![
            graph_box(COLLECTION, "NoteEventCollectionBox", &[(1, FieldValue::Hook), (2, FieldValue::Hook)]),
            graph_box(NOTE, "NoteEventBox", &[
                (1, FieldValue::Pointer(Some(Address::of(COLLECTION, vec![1])))),
                (10, FieldValue::Int32(0)), (11, FieldValue::Int32(240)),
                (20, FieldValue::Int32(60)), (21, FieldValue::Float32(0.8)), (24, FieldValue::Float32(0.0))
            ])
        ])
    }

    #[test]
    fn shared_collection_is_observed_once_and_refcounted() {
        let mut graph = graph();
        let mut cache = CollectionCache::default();
        let base = graph.subscription_count();

        // First region acquires: the collection is observed once and reads its one note.
        let region_a = cache.acquire(&mut graph, COLLECTION);
        let observed = graph.subscription_count();
        assert!(observed > base, "first acquire observes the collection");
        assert_eq!(region_a.len(), 1);
        assert_eq!(cache.entries.len(), 1);
        assert_eq!(cache.entries[0].refs, 1);

        // A mirrored region acquires the SAME collection: no new observation, shared event list.
        let region_b = cache.acquire(&mut graph, COLLECTION);
        assert_eq!(graph.subscription_count(), observed, "a mirrored region adds no new subscription");
        assert_eq!(region_b.len(), 1, "the mirrored region reads the same events");
        assert_eq!(cache.entries[0].refs, 2);

        // Remove one region: the observation survives and the other still reads it.
        cache.release(&mut graph, COLLECTION);
        assert_eq!(cache.entries[0].refs, 1);
        assert_eq!(graph.subscription_count(), observed, "still observed while a region remains");
        assert_eq!(region_a.len(), 1, "the surviving region still reads the collection");

        // Remove the last region: the observation is terminated.
        cache.release(&mut graph, COLLECTION);
        assert!(cache.entries.is_empty());
        assert_eq!(graph.subscription_count(), base, "the last release unsubscribes the observation");
    }
}
