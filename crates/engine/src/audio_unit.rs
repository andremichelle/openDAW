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
use alloc::collections::BTreeMap;
use alloc::format;
use alloc::rc::Rc;
use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;
use core::cell::{Cell, RefCell};
use abi::{DEVICE_KIND_AUDIO_EFFECT, DEVICE_KIND_INSTRUMENT, DEVICE_KIND_MIDI_EFFECT, FIELD_KIND_BOOL, FIELD_KIND_FLOAT, FIELD_KIND_INT, FIELD_KIND_STRING, PARAM_KIND_BOOL, PARAM_KIND_FLOAT, PARAM_KIND_INT};
use bindings::indexed_collection::IndexedCollection;
use bindings::note_collection::NoteCollection;
use bindings::value_collection::ValueCollection;
use boxgraph::address::{Address, Uuid};
use boxgraph::graph::BoxGraph;
use boxgraph::subscription::{HubEvent, Propagation, SubscriptionId};
use engine_env::audio_buffer::SharedAudioBuffer;
use engine_env::audio_generator::AudioGenerator;
use engine_env::audio_input::AudioInput;
use engine_env::audio_buffer::shared_audio_buffer;
use engine_env::audio_bus_processor::AudioBusProcessor;
use engine_env::aux_send::{AuxSendProcessor, SendParams};
use engine_env::channel_strip::{ChannelStripProcessor, StripAutomation, StripParams};
use math::value_mapping::{Decibel, Linear, ValueMapping};
use engine_env::engine_context::NodeId;
use engine_env::note_event_instrument::SharedNoteEventSource;
use engine_env::note_region::NoteRegion;
use engine_env::clip_sequencer::ClipSequencer;
use engine_env::note_region_source::{NoteRegionSource, NoteTrackAccess};
use engine_env::note_sequencer::NoteSequencer;
use value::event::EventCollection;
use value::note::NoteEvent;
use value::region::{RegionCollection, Span};
use crate::param_automation::{FieldPath, ParamCurve, ParamHandle, ParamSink, ValueBoundRegion};
use crate::plugin_audio_effect::PluginAudioEffect;
use crate::plugin_instrument::PluginInstrument;
use crate::plugin_midi_effect::PluginMidiEffect;
use crate::composite::CompositeBinding;
use crate::audio_region_player::AudioRegionPlayer;
use crate::time_stretch::{TimeStretchConfig, TransientPlayMode};
use crate::tempo_map::{SharedTempoMap, TempoMap};
use crate::{call_device_init, call_device_field_changed, call_device_parameter_changed, call_device_sample_changed, call_device_soundfont_changed, CompositeSpec, DeviceReg, Engine, FieldObs, PullLink, BIND, FIELD_OBS, SAMPLE_OBS, SAMPLES, SOUNDFONT_OBS, SOUNDFONTS, SIDECHAIN_BIND, CURRENT_DEVICE_UUID, EFFECT_INDEX_KEY};

// AudioUnitBox field keys (WASM CONTRACT: mirror the TS AudioUnitBox schema). The unit carries its strip
// params and hosts its instrument / effect chains / tracks at these hub keys.
// WASM CONTRACT: TS `UUID.Lowest` = 00000000-0000-4000-8000-000000000000 (version/variant bits set, NOT all
// zeros); `EngineAddresses.PEAKS` = Address.compose(UUID.Lowest).append(0) — the master strip's meter address.
const UUID_LOWEST: Uuid = [0, 0, 0, 0, 0, 0, 0x40, 0, 0x80, 0, 0, 0, 0, 0, 0, 0];
const UNIT_VOLUME_KEY: u16 = 12;
const UNIT_PANNING_KEY: u16 = 13;
const UNIT_MUTE_KEY: u16 = 14;
const UNIT_TRACKS_KEY: u16 = 20;   // track-membership hub
const UNIT_MIDI_KEY: u16 = 21;     // midi-effect chain host
const UNIT_INPUT_KEY: u16 = 22;    // instrument (input) host
const UNIT_AUDIO_KEY: u16 = 23;    // audio-effect chain host
const UNIT_AUX_SENDS_KEY: u16 = 24; // the unit's `auxSends` collection (parallel post-FX / pre-fader sends)
const UNIT_OUTPUT_KEY: u16 = 25;   // the unit's `output` pointer -> the AudioBusBox `input` it feeds (or the root)
// RootBox.audio-units hub (unit membership) — a different box, same ordinal.
const ROOT_AUDIO_UNITS_KEY: u16 = 20;
// A unit-level device box's `enabled` BooleanField (WASM CONTRACT: the base device schema; a disabled
// audio / midi effect is bypassed — skipped in the chain wiring). Composite-child enabled is separate.
pub(crate) const DEVICE_ENABLED_KEY: u16 = 4;
// The instrument box type whose audio source is the engine-side audio-region player (it reads the unit's AUDIO
// tracks rather than mapping to a wasm device). WASM CONTRACT: mirrors the TS TapeDeviceBox class name.
const TAPE_BOX_TYPE: &str = "TapeDeviceBox";
const DEVICE_HOST_KEY: u16 = 1; // every device box's `host` pointer (field 1) -> its owning unit's host address
const BUS_BOX_TYPE: &str = "AudioBusBox"; // a unit whose `input` device is one is a RETURN / submix bus channel
const BUS_ENABLED_KEY: u16 = 4; // AudioBusBox.enabled: a disabled bus sums nothing (emits silence)
// AuxSendBox fields: targetBus (2, pointer -> the bus's `input`), sendGain (5, dB), sendPan (6, bipolar).
const SEND_TARGET_KEY: u16 = 2;
const SEND_GAIN_KEY: u16 = 5;
const SEND_PAN_KEY: u16 = 6;

/// The handle a unit's subscriptions use to enqueue THAT unit for reconcile when its scope changes, so a
/// related edit reconciles one unit instead of sweeping all units (the Rust analog of TS's per-unit
/// `invalidateWiring`). `units` is the engine's shared `dirty_units` queue; `unit` is this unit's uuid.
#[derive(Clone)]
pub(crate) struct DirtyMark {
    units: Rc<RefCell<Vec<Uuid>>>,
    unit: Uuid
}

impl DirtyMark {
    /// Enqueue this unit (de-duplicated) for the next reconcile.
    fn mark(&self) {
        let mut units = self.units.borrow_mut();
        if !units.contains(&self.unit) {
            units.push(self.unit);
        }
    }

    /// A bare `Fn()` form for the binders (`IndexedCollection`, composite) that take an opaque dirty signal.
    fn signal(&self) -> Rc<dyn Fn()> {
        let mark = self.clone();
        Rc::new(move || mark.mark())
    }
}

// A node's PROFILER label: the device's box type + a short uuid (reconcile-time, report-only).
fn device_label(graph: &BoxGraph, device_uuid: &Uuid) -> String {
    let name = graph.find_box(device_uuid).map_or("<device>", |device_box| device_box.name.as_str());
    format!("{} {:02x}{:02x}", name, device_uuid[0], device_uuid[1])
}

// Count a tape unit's bound audio regions (total + how many run the time-stretch strategy), for the
// player's reconcile-time pre-warm.
fn tape_region_counts(track_sets: &SharedAudioTrackSets) -> (usize, usize) {
    let mut stretch = 0;
    let mut total = 0;
    for track in track_sets.borrow().iter() {
        for region in track.borrow().iter() {
            total += 1;
            if region.time_stretch.is_some() && region.transients.len() >= 2 {
                stretch += 1;
            }
        }
    }
    (stretch, total)
}

// The LIGHT per-unit signal a plain FIELD edit raises while `reconcile_one` runs (set around the unit's
// work, the `CURRENT_DEVICE_UUID` pattern): a knob drag then only marks `params_dirty` (one value push at
// the next reconcile) instead of `automation_dirty` (a full unsubscribe + re-observe of every parameter,
// per drag tick, on the audio thread). Automation ATTACH / DETACH / region moves keep the heavy signal.
#[cfg(not(test))]
static PARAMS_SIGNAL: crate::Shared<Option<Rc<dyn Fn()>>> = crate::Shared::new(None);
#[cfg(test)]
std::thread_local! {
    // Tests run on parallel threads; the production engine is single-threaded, so the Shared cell is only
    // sound there. Per-thread isolation keeps the tests deterministic.
    static PARAMS_SIGNAL: core::cell::RefCell<Option<Rc<dyn Fn()>>> = const { core::cell::RefCell::new(None) };
}

fn set_params_signal(signal: Option<Rc<dyn Fn()>>) {
    #[cfg(not(test))]
    unsafe { *PARAMS_SIGNAL.get() = signal; }
    #[cfg(test)]
    PARAMS_SIGNAL.with(|cell| *cell.borrow_mut() = signal);
}

fn current_params_signal() -> Option<Rc<dyn Fn()>> {
    #[cfg(not(test))]
    { unsafe { PARAMS_SIGNAL.get() }.clone() }
    #[cfg(test)]
    { PARAMS_SIGNAL.with(|cell| cell.borrow().clone()) }
}

fn params_invalidate(unit: &AudioUnitBinding) -> Rc<dyn Fn()> {
    let dirty = unit.params_dirty.clone();
    let mark = unit.mark.clone();
    Rc::new(move || {dirty.set(true); mark.mark();})
}

/// The signal a unit's PARAMETER subscriptions fire when automation attaches / detaches / a region moves:
/// set the unit's `automation_dirty` flag and enqueue the unit, so `reconcile_one` re-binds its automation
/// (no rewire). Distinct from `params_invalidate` (a plain field edit: push only) and from
/// `DirtyMark::signal` (chain / sidechain), which only enqueues.
fn automation_invalidate(unit: &AudioUnitBinding) -> Rc<dyn Fn()> {
    let dirty = unit.automation_dirty.clone();
    let mark = unit.mark.clone();
    Rc::new(move || {dirty.set(true); mark.mark();})
}

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
    pub(crate) collection: NoteCollection
}

impl NoteTrackAccess for NoteTrackContent {
    fn for_each_region(&self, from: f64, to: f64, visit: &mut dyn FnMut(&NoteRegion, &EventCollection<NoteEvent>)) {
        // Binary-search the regions overlapping [from, to) within this track (sorted by position).
        for bound in self.regions.iterate_range(from, to) {
            visit(&bound.region, &bound.collection.events());
        }
    }
    fn clip_info(&self, clip: &[u8; 16]) -> Option<(f64, bool)> {
        self.clips.iter().find(|bound| &bound.clip_uuid == clip).map(|bound| (bound.duration, bound.looped))
    }
    fn clip_events(&self, clip: &[u8; 16], visit: &mut dyn FnMut(&EventCollection<NoteEvent>)) {
        if let Some(bound) = self.clips.iter().find(|bound| &bound.clip_uuid == clip) {
            visit(&bound.collection.events());
        }
    }
}

pub(crate) type SharedTrackRegions = Rc<RefCell<NoteTrackContent>>;

/// The unit's live list of per-track region collections (one entry per `TrackBox`), shared with the
/// sequencer. Tracks are added / removed live; the sequencer iterates whatever is currently present.
pub(crate) type SharedTrackSets = Rc<RefCell<Vec<SharedTrackRegions>>>;

/// ONE audio track's regions, kept SORTED BY POSITION (like the note path, but each element is a self-contained
/// `AudioRegion` — its playback data, no shared event collection). Shared between the track binding (the cascade
/// maintains it) and the unit's audio-region player (which range-queries it each block).
pub(crate) type SharedAudioRegions = Rc<RefCell<RegionCollection<AudioRegion>>>;

/// The unit's live list of per-audio-track region collections, shared with the audio-region player. Mirrors
/// `SharedTrackSets` for the audio side.
pub(crate) type SharedAudioTrackSets = Rc<RefCell<Vec<SharedAudioRegions>>>;

/// The `NoteRegionSource` the unit's sequencer reads. It iterates EACH track's own sorted region collection
/// (unit -> tracks -> regions), range-querying each — mirroring TS `tracks -> regions.collection.iterateRange`.
pub(crate) struct BoundNoteRegions {
    pub(crate) tracks: SharedTrackSets
}

impl NoteRegionSource for BoundNoteRegions {
    fn for_each_track(&self, visit: &mut dyn FnMut(&[u8; 16], &dyn NoteTrackAccess)) {
        for track in self.tracks.borrow().iter() {
            let content = track.borrow();
            let uuid = content.uuid;
            visit(&uuid, &*content);
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

/// One bound note region in the cascade: its uuid (its entry in the track's region collection), the
/// collection it references (so the cache ref can be released when the region leaves), and a TARGETED
/// `Parent` subscription on the region box that re-sorts the track when this region's own span is edited.
struct RegionBinding {
    region_uuid: Uuid,
    collection_uuid: Uuid,
    edit_sub: SubscriptionId
}

/// One bound launchable clip: its entry in the track's content, the note collection it references, and a
/// TARGETED `Parent` subscription re-reading its duration / loop flag on edit (mirrors `RegionBinding`).
struct ClipBinding {
    clip_uuid: Uuid,
    collection_uuid: Uuid,
    edit_sub: SubscriptionId
}

/// A track BINDING: owns this track's sorted region collection (`regions_set`, shared with the sequencer)
/// and observes its `regions` membership (add / remove). A member region's span edit is observed per-region
/// (see `RegionBinding`), so no track-wide listener is needed.
struct TrackBinding {
    track_uuid: Uuid,
    regions_set: SharedTrackRegions,
    region_bindings: Vec<RegionBinding>,
    region_changes: Rc<RefCell<Members>>,
    region_sub: SubscriptionId,
    clip_bindings: Vec<ClipBinding>,
    clip_changes: Rc<RefCell<Members>>,
    clip_sub: SubscriptionId,
    // A TARGETED `This` monitor on the track's `enabled` field: toggling it re-derives the unit's active
    // note-track set (a disabled track's regions are excluded), exactly like a device `enabled` toggle.
    enabled_sub: SubscriptionId
}

/// One audio region's cascade entry: its uuid (its key in the track's collection) and a `Parent` edit monitor
/// that re-reads + re-sorts the region when its own fields change. No collection ref (audio regions hold their
/// playback data inline; the source file is resolved at render).
struct AudioRegionBinding {
    region_uuid: Uuid,
    edit_sub: SubscriptionId
}

/// An AUDIO track binding: its sorted `AudioRegion` collection (shared with the player), its `regions`
/// membership observation, per-region edit monitors, and its `enabled` monitor. The audio analog of `TrackBinding`.
struct AudioTrackBinding {
    track_uuid: Uuid,
    regions_set: SharedAudioRegions,
    region_bindings: Vec<AudioRegionBinding>,
    region_changes: Rc<RefCell<Members>>,
    region_sub: SubscriptionId,
    enabled_sub: SubscriptionId
}

/// What the engine wired for one unit. A LEAF-instrument unit owns its device processors PERSISTENTLY (the
/// analog of TS `AudioDeviceChain`'s `#effects`): a chain edit keeps the survivors and only creates joiners /
/// terminates leavers, re-wiring EDGES ONLY (the `#disconnector` analog), so no survivor's DSP state is reset.
/// A COMPOSITE-instrument unit keeps the older whole-cluster bundle (its instrument is a child cascade, not a
/// single processor; per-child lifecycle lives in the `composite` module).
#[allow(clippy::large_enum_variant)] // the common variant is the live one; boxing it would add a per-build heap allocation
enum Wired {
    Leaf(LeafChain),
    Composite(CompositeWired),
    Tape(TapeWired),
    Bus(BusWired)
}

impl Wired {
    /// The unit's channel-strip node + output buffer — the source a `resolve_outputs` route feeds into its
    /// target bus. Uniform across every wiring kind.
    fn strip(&self) -> (NodeId, SharedAudioBuffer) {
        match self {
            Wired::Leaf(chain) => (chain.strip_id, chain.strip_output.clone()),
            Wired::Composite(composite) => (composite.strip_id, composite.strip_output.clone()),
            Wired::Tape(tape) => (tape.strip_id, tape.strip_output.clone()),
            Wired::Bus(bus) => (bus.strip_id, bus.strip_output.clone())
        }
    }

    /// The POST-effects / PRE-fader tap: the buffer feeding the channel strip + the node that produces it. An
    /// `AuxSendProcessor` reads this buffer (pre volume/pan/mute) and depends on this node for ordering.
    fn pre_strip(&self) -> (NodeId, SharedAudioBuffer) {
        match self {
            Wired::Leaf(chain) => (chain.pre_strip_node, chain.pre_strip.clone()),
            Wired::Composite(composite) => (composite.pre_strip_node, composite.pre_strip.clone()),
            Wired::Tape(tape) => (tape.pre_strip_node, tape.pre_strip.clone()),
            Wired::Bus(bus) => (bus.pre_strip_node, bus.pre_strip.clone())
        }
    }
}

/// A RETURN / submix-bus unit's wiring: its `AudioBusBox` input becomes a summing `AudioBusProcessor` (`sum`,
/// registered in `bus_registry` so sources route into it); the bus's own audio-effect chain runs over the sum
/// (`sum -> fx0 -> ... -> strip`), and the strip's output is routed to the bus's own `output` target like any
/// unit. Rebuilt wholesale on a chain edit (like tape / composite), so `nodes` / `edges` / `device_params`
/// carry everything to tear down.
struct BusWired {
    bus_uuid: Uuid, // the AudioBusBox uuid; its sum node + `bus_registry` entry are dropped on teardown
    pre_strip: SharedAudioBuffer, // the fx-chain output feeding the strip (the send tap)
    pre_strip_node: NodeId,
    strip_id: NodeId,
    strip_output: SharedAudioBuffer,
    nodes: Vec<NodeId>,           // sum + fx nodes + strip (removed on teardown)
    edges: Vec<(NodeId, NodeId)>, // sum -> fx0 -> ... -> strip
    device_params: Vec<DeviceParams>,
    sidechains: Vec<SidechainBinding>, // a sidechained bus effect (e.g. a ducking compressor) resolved each pass
    subs: Vec<SubscriptionId>     // the bus `enabled` monitor + each fx device's `enabled` monitor
}

/// A unit's currently-wired OUTPUT route: which target bus sum its channel strip feeds. `bus` is the target
/// `AudioBusBox` uuid (`None` = the primary bus, i.e. the fixed `master` fallback); `sum_id` the sum node the
/// strip edge points at; `strip_id` / `strip_output` the source, kept so the route can be torn down (remove the
/// summed source + the edge) even after the strip is rebuilt. Diffed each `resolve_outputs` pass so a re-point
/// or a strip rebuild re-wires exactly once.
struct Routed {
    bus: Option<Uuid>,
    sum_id: NodeId,
    strip_id: NodeId,
    strip_output: SharedAudioBuffer
}

/// One built parallel AUX SEND: the `AuxSendProcessor` tapping this unit's PRE-fader buffer, plus its resolution
/// state. `source` is the pre-strip node currently wired as its input; `target` the resolved target bus (uuid +
/// sum node) its output feeds; both diffed in `resolve_sends` so a re-point / strip rebuild re-wires once.
struct SendBinding {
    send_uuid: Uuid,
    proc: Rc<RefCell<AuxSendProcessor>>,
    node_id: NodeId,
    source: Option<NodeId>,
    target: Option<(Option<Uuid>, NodeId)>,
    subs: Vec<SubscriptionId>, // targetBus (2) pointer monitor + sendGain (5) / sendPan (6) field observers
    automation: Rc<StripAutomation>, // sendGain / sendPan automation overrides (volume = gain dB, panning = pan)
    param_subs: Vec<SubscriptionId>, // the automation observers, re-observed on a real automation change
    param_collections: Vec<ValueCollection> // keep the send curves' region collections alive (terminated on rebind)
}

/// A TAPE / audio-region unit's wiring: the engine-side audio-region player (reads the unit's AUDIO tracks) ->
/// channel strip -> master. The player is owned by the context (removed by `player_id` on teardown); it reads
/// `audio_track_sets` live, so a region edit needs no rebuild.
struct TapeWired {
    player: Rc<RefCell<AudioRegionPlayer>>, // kept so a region edit can pre-warm the pool (see `prepare`)
    enabled_sub: SubscriptionId, // TapeDeviceBox `enabled` (4): gates the player, resets on disable (TS mirror)
    player_id: NodeId,
    instrument_uuid: Uuid,        // the TapeDeviceBox uuid: the player output is registered under it so a SIDECHAIN
                                  // targeting the tape device taps its RAW output (pre fx / strip), matching TS
    audio: Vec<Member>,           // the unit's AUDIO-effects chain (player -> fx0 -> ... -> strip), like a leaf
    pre_strip: SharedAudioBuffer, // the fx-chain output feeding the strip (the send tap; == player output if no fx)
    pre_strip_node: NodeId,
    strip_id: NodeId,
    strip_output: SharedAudioBuffer,
    edges: Vec<(NodeId, NodeId)>  // player -> fx0 -> ... -> strip
}

/// A held device processor, kept alive across rewires so its DSP state (voices, delay tails, filter history)
/// survives a chain edit. The `Rc` is also how a rewire re-points the survivor (`set_audio_source` /
/// `set_pull_chain`) without recreating it.
enum ProcHandle {
    Instrument(Rc<RefCell<PluginInstrument>>),
    Audio(Rc<RefCell<PluginAudioEffect>>),
    Midi(Rc<PluginMidiEffect>)
}

/// One persistent chain member: its device box uuid, the held processor, its graph node (none for a midi-fx,
/// which is folded into the instrument's PULL chain and has no audio node), its audio output (for wiring the
/// next node), its bound parameters (bound ONCE on join, reused untouched on survive — re-binding re-runs the
/// device `init`, which resets DSP), and an audio-fx's optional sidechain binding.
struct Member {
    uuid: Uuid,
    proc: ProcHandle,
    node_id: Option<NodeId>,
    output: Option<SharedAudioBuffer>,
    params: DeviceParams,
    sidechain: Option<SidechainBinding>,
    // A TARGETED `This` monitor on the device's `enabled` field: toggling it re-wires the unit (edge-only —
    // a disabled effect is skipped in the chain, its processor + params + DSP state left untouched).
    enabled_sub: SubscriptionId
}

/// A leaf unit's persistent chain: the instrument, its midi-fx (pull-chain order) and audio-fx (graph order)
/// members, the channel strip, and the CURRENT edge set (rebuilt edge-only each reconcile). Members persist
/// across reconciles; only the diff (joiners / leavers) and the edges change.
struct LeafChain {
    instrument: Member,
    // The instrument's note SOURCE. It holds per-block state (notes retained across blocks), so it persists
    // and is REUSED while the instrument survives — recreating it mid-play would drop the held notes (stuck /
    // re-triggered notes). Rebuilt only when the instrument itself changes.
    sequencer: SharedNoteEventSource,
    midi: Vec<Member>,
    audio: Vec<Member>,
    strip: Rc<RefCell<ChannelStripProcessor>>,
    pre_strip: SharedAudioBuffer, // the fx-chain output feeding the strip (the send tap)
    pre_strip_node: NodeId,
    strip_id: NodeId,
    strip_output: SharedAudioBuffer,
    edges: Vec<(NodeId, NodeId)>
}

/// A composite SLOT's persistent cluster (a direct-instrument child, e.g. a Playfield slot): the same per-member
/// machinery as a leaf unit (instrument + midi/audio members + note source), reconciled EDGE-ONLY so a chain edit
/// or an effect `enabled` toggle keeps every survivor's DSP state. Defined here (not in `composite`) so it can
/// reach the module-private `Member`. The owning child appends the slot's sum edge; the slot itself owns its
/// instrument note source (choke-routed) and internal edges.
pub(crate) struct SlotCluster {
    instrument: Member,
    sequencer: SharedNoteEventSource,
    midi: Vec<Member>,
    audio: Vec<Member>,
    internal_edges: Vec<(NodeId, NodeId)>,
    pub(crate) output: SharedAudioBuffer,
    pub(crate) output_node: NodeId
}

impl SlotCluster {
    /// The slot's note source, a live-note injection target (the slot's device filters by its pad note).
    pub(crate) fn note_source(&self) -> SharedNoteEventSource {
        self.sequencer.clone()
    }

    /// Visit every member's bound parameters (instrument + midi + audio), for the unit's automation re-bind.
    pub(crate) fn for_each_params(&mut self, visit: &mut dyn FnMut(&mut DeviceParams)) {
        visit(&mut self.instrument.params);
        for member in &mut self.midi { visit(&mut member.params); }
        for member in &mut self.audio { visit(&mut member.params); }
    }

    /// Visit every audio member's sidechain binding, for the unit's sidechain re-resolve.
    pub(crate) fn for_each_sidechain(&mut self, visit: &mut dyn FnMut(&mut SidechainBinding)) {
        for member in &mut self.audio {
            if let Some(binding) = &mut member.sidechain { visit(binding); }
        }
    }

    #[cfg(test)]
    pub(crate) fn instrument_node(&self) -> NodeId {
        self.instrument.node_id.unwrap()
    }

    /// How many audio-fx members this slot OWNS (built + persistent, incl. a disabled one — edge-only).
    #[cfg(test)]
    pub(crate) fn audio_member_count(&self) -> usize {
        self.audio.len()
    }

    /// How many audio-fx are currently WIRED into the signal path (one internal edge per wired fx; a disabled,
    /// bypassed fx contributes none). Proves the bypass is edge-only: members persist while wiring drops.
    #[cfg(test)]
    pub(crate) fn wired_audio_count(&self) -> usize {
        self.internal_edges.len()
    }
}

/// A composite-instrument unit's wiring: the persistent per-child `CompositeBinding` (which owns the children's
/// processors, params, and sidechains, and reconciles them per child), plus the unit's own tail — the channel
/// strip and the `sum -> strip -> master` edges. The strip persists across child edits (the sum bus is stable).
struct CompositeWired {
    binding: CompositeBinding,
    pre_strip: SharedAudioBuffer, // the composite sum feeding the strip (the send tap)
    pre_strip_node: NodeId,       // == binding.sum_id
    strip_id: NodeId,
    strip_output: SharedAudioBuffer,
    tail_edges: Vec<(NodeId, NodeId)>, // sum -> strip
    // A TARGETED `This` monitor on the composite DEVICE's `enabled`: a toggle enqueues the unit (plain mark, NOT
    // `wiring_dirty`), so reconcile lands in the per-child branch and re-applies the sum gate without a rebuild.
    enabled_sub: SubscriptionId
}

/// The result of `build_cluster` (the wholesale CELL composite-child path; a leaf unit and a direct slot use the
/// edge-only `wire_cluster` instead): an instrument plus its midi-fx pull chain and audio-fx chain, wired into the
/// global graph. `output` is the chain's final buffer and `output_node` its last node, so the caller appends its
/// own tail (the per-child sum). The `nodes` / `edges` / `device_params` / `sidechains` fold into the child's body.
pub(crate) struct BuiltCluster {
    pub(crate) output: SharedAudioBuffer,
    pub(crate) output_node: NodeId,
    pub(crate) nodes: Vec<NodeId>,
    pub(crate) edges: Vec<(NodeId, NodeId)>,
    pub(crate) device_params: Vec<DeviceParams>,
    pub(crate) sidechains: Vec<SidechainBinding> // sidechain bindings collected from this cluster's audio fx
}

/// One device's bound parameters: enough to re-observe and re-push them on a runtime automation change. The
/// `handles` are clones the engine reads for the build / edit push (sharing the node's `Rc<Cell>`s, so the
/// `last`-value diff stays consistent with the clock pull); `field_subs` + `collections` are the graph
/// observations to drop on teardown / re-bind.
pub(crate) struct DeviceParams {
    device_uuid: Uuid,
    reg: DeviceReg,
    state_ptr: u32,
    sink: ParamNode,       // the node, to re-set params on a re-bind
    paths: Vec<FieldPath>, // the parameter field-paths the device declared in `init`
    handles: Vec<ParamHandle>,
    field_subs: Vec<SubscriptionId>,
    collections: Vec<ValueCollection>,
    observe_subs: Vec<SubscriptionId>, // the device's PLAIN field observations (`observe_field`), dropped on teardown
    sidechain_paths: Vec<Vec<u16>>, // the audio effect's declared sidechain pointer paths (`bind_sidechain`), in order
    // SCRIPTABLE devices: membership subscriptions on the dynamic `parameters` / `samples` collection hubs (fire
    // the unit's automation invalidate on a child add / remove). Kept SEPARATE from `field_subs`, since they
    // survive a `rebind_one` (which tears down + rebuilds only the per-parameter subscriptions). `None` for a
    // device without that collection. The per-child param/sample subscriptions live in `field_subs`/`observe_subs`.
    param_hub_sub: Option<SubscriptionId>,
    sample_hub_sub: Option<SubscriptionId>
}

/// A persistent sidechain binding kept by the owning unit: an audio effect that declared sidechain ports, the
/// node it became, and one `SidechainPort` per declared pointer. Unlike a one-shot resolve, this survives so
/// the resolution pass can RE-resolve every reconcile that did work — handling re-pointing, detach, a source
/// unit (re)building, and build order, all by diffing each port's current target against `resolved`.
pub(crate) struct SidechainBinding {
    pub(crate) effect: Rc<RefCell<PluginAudioEffect>>,
    pub(crate) node_id: NodeId,
    pub(crate) device_uuid: Uuid,
    pub(crate) ports: Vec<SidechainPort>
}

/// One declared sidechain port: its id (2+), the device-relative pointer path to follow, the source node it
/// is currently wired to (`None` = unresolved, kept so the resolve pass can diff + tear down the old edge),
/// and a TARGETED `This` monitor on the device's sidechain pointer field so a re-point / detach enqueues the
/// owning unit (no all-updates listener).
pub(crate) struct SidechainPort {
    pub(crate) port_id: u32,
    pub(crate) path: Vec<u16>,
    pub(crate) resolved: Option<NodeId>,
    pub(crate) pointer_sub: SubscriptionId
}

/// Where bound parameters are pushed: an audio node (instrument / audio-fx, mutated through its
/// `Rc<RefCell>`) or a MIDI-fx (shared behind a bare `Rc`, mutated through its interior cells). Both expose
/// "replace this device's params + clock-armed state"; this dispatches to whichever it holds.
enum ParamNode {
    Audio(Rc<RefCell<dyn ParamSink>>),
    Midi(Rc<PluginMidiEffect>)
}

impl ParamNode {
    fn set_params(&self, params: Vec<ParamHandle>, clock_armed: bool) {
        match self {
            ParamNode::Audio(node) => node.borrow_mut().set_params(params, clock_armed),
            ParamNode::Midi(effect) => effect.set_params(params, clock_armed)
        }
    }
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
    audio_track_sets: SharedAudioTrackSets, // per-AUDIO-track region collections, read by the audio-region player
    audio_tracks: Vec<AudioTrackBinding>,
    track_changes: Rc<RefCell<Members>>,
    track_sub: SubscriptionId,
    strip_params: Rc<StripParams>,        // the unit's volume / panning / mute, kept in sync with its box
    strip_subs: Vec<SubscriptionId>,      // the volume / panning / mute field subscriptions
    strip_automation: Rc<StripAutomation>, // the unit's volume / panning AUTOMATION overrides (Value-track curves)
    strip_param_subs: Vec<SubscriptionId>, // the volume / panning parameter observations (field + track hubs)
    strip_param_collections: Vec<ValueCollection>, // keep the strip curves' region collections alive
    input: IndexedCollection,
    midi: IndexedCollection,
    audio: IndexedCollection,
    // SEND/RETURN: the unit's `output` (25) pointer monitor (a re-point enqueues the unit so `resolve_outputs`
    // re-routes it) + the CURRENT output route (which bus sum the strip feeds), and the `auxSends` (24)
    // collection + its built parallel sends. `routed` persists across rewires so a route can be torn down even
    // as the strip is rebuilt; `sends` each resolve their target bus in `resolve_sends`.
    output_sub: SubscriptionId,
    routed: Option<Routed>,
    aux_sends: IndexedCollection,
    sends: Vec<SendBinding>,
    // The wired processor graph: a leaf unit's persistent per-member chain, or a composite unit's bundle.
    // `None` until the first reconcile (or a unit with no resolvable instrument). The instrument's composite
    // cascade, the sidechain bindings, and the bound parameters all live INSIDE this now (per member for a
    // leaf, in the bundle for a composite), so they survive a chain edit exactly as far as the wiring does.
    wired: Option<Wired>,
    // Set by a parameter's TARGETED automation subscriptions (see `observe_params` / `automation_invalidate`)
    // when a Value track attaches / detaches or its data changes; `reconcile_one` then re-binds the unit's
    // curves (no rewire) and clears it.
    automation_dirty: Rc<Cell<bool>>,
    params_dirty: Rc<Cell<bool>>, // a plain field edit: push the value, no automation re-bind
    // Set by a device's `enabled` monitor: the chain membership did not change, but the unit must RE-WIRE
    // (skip / include the toggled effect). `reconcile_one` treats it like a chain-dirty so reconcile_leaf runs
    // its edge-only re-wire (survivors reused — no param push, no reset).
    wiring_dirty: Rc<Cell<bool>>,
    // Enqueues THIS unit for a targeted reconcile when any of its scope subscriptions (chains, tracks,
    // regions, automation, composite, sidechain pointers) fire — so a related edit rewires one unit.
    mark: DirtyMark
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
            self.graph.subscribe_pointer_hub(Address::of(root.uuid, vec![ROOT_AUDIO_UNITS_KEY]), Box::new(move |_graph, event| {
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
        self.graph.catchup_and_subscribe(Address::of(uuid, vec![UNIT_VOLUME_KEY]), move |value| {
            if let Some(value) = value.as_float32() { volume.volume_db.set(value) }
        });
        let panning = params.clone();
        self.graph.catchup_and_subscribe(Address::of(uuid, vec![UNIT_PANNING_KEY]), move |value| {
            if let Some(value) = value.as_float32() { panning.panning.set(value) }
        });
        let mute = params.clone();
        self.graph.catchup_and_subscribe(Address::of(uuid, vec![UNIT_MUTE_KEY]), move |value| {
            if let Some(value) = value.as_bool() { mute.mute.set(value) }
        });
        // THE output unit's own audio-effect chain (e.g. a master Tidal), wired between the summing bus and
        // the master strip: bus -> fx0 -> ... -> strip, ordered by device index. Each device binds its
        // parameters like an instrument unit's, and the initial values are pushed below. Built once at bind
        // (the output unit is a fixed singleton), so the chain is not reactive yet.
        let mut source = master_output;
        let mut source_id = self.master_id;
        let audio = IndexedCollection::observe(&mut self.graph, Address::of(uuid, vec![UNIT_AUDIO_KEY]), EFFECT_INDEX_KEY);
        let mut device_params: Vec<DeviceParams> = Vec::new();
        // THE output unit is a fixed singleton built once at bind, not reconciled, so its parameters need no
        // runtime re-bind: a no-op invalidate (its static values are pushed by `refresh_params` below).
        let noop: Rc<dyn Fn()> = Rc::new(|| {});
        for device_uuid in audio.sorted() {
            let resolved = self.graph.find_box(&device_uuid).and_then(|device_box| self.device_for_type(&device_box.name));
            let device = match resolved {
                Some(device) if device.kind == DEVICE_KIND_AUDIO_EFFECT => device,
                _ => continue
            };
            if !self.device_enabled(device_uuid) {
                continue; // a disabled effect is bypassed: not built, not wired into the chain
            }
            let node = Rc::new(RefCell::new(PluginAudioEffect::new(self.sample_rate, device)));
            let node_state = node.borrow().state_ptr();
            let node_sink: Rc<RefCell<dyn ParamSink>> = node.clone();
            device_params.push(self.bind_device(device_uuid, device, node_state, ParamNode::Audio(node_sink), &noop));
            node.borrow_mut().set_audio_source(source);
            source = node.borrow().audio_output();
            let meter_slot = node.borrow().meter_slot();
            self.broadcasts.register(device_uuid, &[], crate::broadcast::PACKAGE_FLOAT_ARRAY, &meter_slot, 4);
            let node_id = self.context.register_processor(node);
            self.context.set_label(node_id, device_label(&self.graph, &device_uuid));
            self.context.register_edge(source_id, node_id);
            source_id = node_id;
        }
        let position = self.transport.position();
        for params in &device_params {
            refresh_params(&params.handles, params.reg, params.state_ptr, position);
        }
        self.output_audio = Some(audio);
        self.output_device_params = device_params;
        // The output/master unit's volume/panning stay static (not automation-bound here); pass an empty override.
        let strip = Rc::new(RefCell::new(ChannelStripProcessor::new(params, Rc::new(StripAutomation::new()), self.sample_rate)));
        strip.borrow_mut().set_audio_source(source);
        let strip_output = strip.borrow().audio_output();
        // The MASTER peaks, at the TS `EngineAddresses.PEAKS` address (`UUID.Lowest` + key 0).
        let strip_meter = strip.borrow().meter_slot();
        self.broadcasts.register(UUID_LOWEST, &[0], crate::broadcast::PACKAGE_FLOAT_ARRAY, &strip_meter, 4);
        let strip_id = self.context.register_processor(strip);
        self.context.set_label(strip_id, String::from("strip:output"));
        self.context.register_edge(source_id, strip_id); // the (effected) summing bus feeds the master strip
        strip_output
    }

    /// Apply a transaction's recorded changes: tear down / build audio units whose MEMBERSHIP changed, then
    /// reconcile ONLY the units a related edit touched (each subscription enqueues its own unit into
    /// `dirty_units` via `DirtyMark`, mirroring TS's per-unit `invalidateWiring`). Called on bind (catch-up)
    /// and after every transaction; a transaction that touched no unit drains nothing, so it is a true no-op
    /// instead of a sweep over every unit and track.
    pub(crate) fn reconcile_units(&mut self) {
        if self.master.is_none() {
            return;
        }
        let changes = core::mem::take(&mut *self.unit_changes.borrow_mut());
        // A membership change is structural: a unit appearing / disappearing can resolve or strand a sidechain
        // pointing at it, so the resolve pass must run even if no unit was otherwise enqueued.
        let structural = !changes.added.is_empty() || !changes.removed.is_empty();
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
            binding.mark.mark(); // a new unit reconciles itself once (wires its instrument even with no tracks)
            self.audio_units.push(binding);
        }
        // Reconcile only the enqueued units. Take the bindings out so each unit's work can borrow `&mut self`
        // (graph, context, master) without aliasing `self.audio_units`. A rewire's composite catch-up cannot
        // re-enqueue (its signal is wired after the catch-up is consumed), so one drain suffices.
        let dirty = core::mem::take(&mut *self.dirty_units.borrow_mut());
        let did_work = structural || !dirty.is_empty();
        if !dirty.is_empty() {
            let mut units = core::mem::take(&mut self.audio_units);
            for uuid in dirty {
                if let Some(unit) = units.iter_mut().find(|binding| binding.unit == uuid) {
                    self.reconcile_one(unit);
                }
            }
            self.audio_units = units;
        }
        // Every unit's output is now (re)registered, so re-resolve all sidechains — but ONLY if this reconcile
        // did work (a membership change or an enqueued unit, e.g. a sidechain pointer re-point marks its unit).
        // An idle transaction skips it entirely. The pass itself is diff-based, so it no-ops per unchanged port.
        if did_work {
            self.resolve_sidechains();
            self.resolve_outputs(); // route each unit's strip to its OUTPUT bus (or the master fallback)
            self.resolve_sends();   // wire each parallel aux send: pre-fader tap -> target bus
            self.broadcasts.sweep(); // drop telemetry entries whose processor was torn down (generation bump)
        }
    }

    /// Reconcile ONE unit (it was enqueued because a related edit touched its scope): cascade its tracks ->
    /// regions, then re-wire if a device chain or its composite changed (`|` so all dirty flags are consumed),
    /// else re-bind its automation curves if those attached / detached. A full rewire re-gathers automation,
    /// so it also clears that flag.
    fn reconcile_one(&mut self, unit: &mut AudioUnitBinding) {
        reconcile_tracks(&mut self.graph, unit, &self.tempo_map, &self.clip_sequencer);
        // A region add / edit ran the cascade above: pre-warm the tape player NOW (reconcile), so a region
        // entering playback later never allocates its sequencer on the render path.
        if let Some(Wired::Tape(tape)) = &unit.wired {
            let (stretch_regions, total_regions) = tape_region_counts(&unit.audio_track_sets);
            tape.player.borrow_mut().prepare(stretch_regions, total_regions);
        }
        // A REAL automation change (a Value track attach / detach / curve edit on an EXISTING parameter) sets
        // this flag BEFORE this reconcile runs. A joiner's initial parameter catch-up ALSO sets it during the
        // chain reconcile below — but that is spurious (the joiner is bound + refreshed at build), so it must
        // NOT trigger a broad re-bind that would re-push every SURVIVING plugin's parameters (which would, e.g.,
        // glide a delay's offset). So capture it first and only re-bind for a genuine pre-existing change.
        let automation_changed = unit.automation_dirty.get();
        let params_changed = unit.params_dirty.get();
        // While this unit reconciles, a field-value subscription firing (a catch-up or a live edit applied
        // mid-bind) raises the LIGHT flag through this cell instead of the heavy automation invalidate.
        set_params_signal(Some(params_invalidate(unit)));
        // `wiring_dirty` (a device `enabled` toggle) re-wires the chain edge-only without a membership change.
        let unit_dirty = unit.input.take_dirty() | unit.midi.take_dirty() | unit.audio.take_dirty() | unit.wiring_dirty.replace(false);
        if unit_dirty {
            // The unit's own chain changed (instrument swapped, or a unit-level fx joined / left): reconcile the
            // whole chain (a composite instrument is rebuilt; a leaf reconciles per member). Survivors untouched.
            self.reconcile_chain(unit);
        } else if matches!(&unit.wired, Some(Wired::Composite(_))) {
            // The instrument is an UNCHANGED composite; reconcile its children per member (a slot add / remove /
            // reorder, or a child's own fx edit). A no-op when nothing changed.
            let signal = unit.mark.signal();
            let invalidate = automation_invalidate(unit);
            let track_sets = unit.track_sets.clone();
            if let Some(Wired::Composite(composite)) = &mut unit.wired {
                self.reconcile_composite_children(&mut composite.binding, &track_sets, &signal, &invalidate);
            }
        }
        // The unit's parallel aux sends: build / destroy the send processors on a collection change (source +
        // target-bus edges are wired by `resolve_sends` at the end of the reconcile). Dirty on the first build.
        if unit.aux_sends.take_dirty() {
            self.reconcile_sends(unit);
        }
        if automation_changed {
            self.rebind_automation(unit);
        }
        // Bind the strip's volume / panning automation on the FIRST reconcile (subs still empty) and re-observe
        // on a real automation change. Its catch-up sets `automation_dirty` again, cleared just below (like a
        // device joiner's) — the extra enqueue is a no-op (subs are then non-empty, no real change).
        if unit.strip_param_subs.is_empty() || automation_changed {
            self.bind_strip_automation(unit);
        }
        // Same for the aux sends' gain / pan automation (built sends bound in `build_send`; a real automation
        // change re-observes them all — a unit has few sends, so the re-bind is cheap).
        if automation_changed {
            let invalidate = automation_invalidate(unit);
            let mut sends = core::mem::take(&mut unit.sends);
            for send in &mut sends {
                self.bind_send_automation(send, &invalidate);
            }
            unit.sends = sends;
        }
        // A plain FIELD edit (knob drag): the value cells are already updated by their subscriptions, so a
        // single refresh pushes exactly the changed values — no unsubscribe / re-observe churn. Skipped when a
        // heavier path already ran (a rebuild / re-bind pushes on its own).
        if params_changed && !unit_dirty && !automation_changed {
            self.refresh_unit_params(unit);
        }
        set_params_signal(None);
        unit.params_dirty.set(false);
        unit.automation_dirty.set(false); // consume the joiner catch-up flags + the handled real change
    }

    /// Bind the channel strip's volume (12) + panning (13) to their AUTOMATION, so a Value track targeting those
    /// fields drives the strip over the transport. The plain field subscriptions only track the STATIC value, so
    /// without this an automated fader was ignored (the unit played at its static volume). Re-observed on a real
    /// automation change; when a field has no track the override stays `None` and the strip keeps using the static
    /// `StripParams`. Volume maps the 0..1 curve through the AudioUnit dB mapping; panning is bipolar (TS adapters).
    fn bind_strip_automation(&mut self, unit: &mut AudioUnitBinding) {
        const VOLUME: Decibel = Decibel::new(-96.0, -9.0, 6.0); // TS AudioUnitBoxAdapter.VolumeMapper
        let invalidate = automation_invalidate(unit);
        self.bind_gain_pan_automation(unit.unit, UNIT_VOLUME_KEY, UNIT_PANNING_KEY, VOLUME,
            &unit.strip_automation, &mut unit.strip_param_subs, &mut unit.strip_param_collections, &invalidate);
    }

    /// The shared gain (dB) + pan automation binder behind the strip AND the aux sends: drop the previous
    /// observers + curve collections (a plain drop would LEAK their hub / event / curve observers), re-observe
    /// both fields, and install the mapped closures. Without a track an override stays `None` (static cells rule).
    #[allow(clippy::too_many_arguments)]
    fn bind_gain_pan_automation(&mut self, box_uuid: Uuid, gain_key: u16, pan_key: u16, gain_mapping: Decibel,
                                automation: &StripAutomation, subs: &mut Vec<SubscriptionId>,
                                collections: &mut Vec<ValueCollection>, invalidate: &Rc<dyn Fn()>) {
        const PAN: Linear = Linear::bipolar();
        *automation.volume.borrow_mut() = None;
        *automation.panning.borrow_mut() = None;
        for sub in core::mem::take(subs) {
            self.graph.unsubscribe(sub);
        }
        for collection in core::mem::take(collections) {
            collection.terminate(&mut self.graph);
        }
        let (gain_handle, gain_subs, gain_collections, _) = self.observe_param(box_uuid, &[gain_key], 0, invalidate);
        let (pan_handle, pan_subs, pan_collections, _) = self.observe_param(box_uuid, &[pan_key], 1, invalidate);
        subs.extend(gain_subs);
        subs.extend(pan_subs);
        collections.extend(gain_collections);
        collections.extend(pan_collections);
        if gain_handle.track.is_some() {
            *automation.volume.borrow_mut() = Some(Rc::new(move |position: f64| gain_mapping.y(gain_handle.resolve(position).0)));
        }
        if pan_handle.track.is_some() {
            *automation.panning.borrow_mut() = Some(Rc::new(move |position: f64| PAN.y(pan_handle.resolve(position).0)));
        }
    }

    /// Re-resolve EVERY unit's sidechain bindings against the current graph, diff-based so it is a no-op when
    /// nothing moved. For each declared port: follow the device pointer to its target box, look that box's
    /// output up in the registry, and if the source NODE differs from what is wired, swap the producer ->
    /// consumer edge. Then, if any port changed, rebuild the effect's sidechain set from the currently-resolved
    /// ports. An unresolved port (pointer unset / target not built / target gone) clears its edge and is absent
    /// from the rebuilt set, so the device falls back to MAIN. This one pass handles re-pointing, detach, a
    /// source unit (re)building with a new buffer, and load build order uniformly. Run only when a reconcile
    /// did work (a membership change or an enqueued unit), so an idle transaction does nothing here.
    fn resolve_sidechains(&mut self) {
        let mut units = core::mem::take(&mut self.audio_units);
        for unit in &mut units {
            match &mut unit.wired {
                Some(Wired::Leaf(chain)) => {
                    for member in &mut chain.audio {
                        if let Some(binding) = &mut member.sidechain {
                            self.resolve_one_sidechain(binding);
                        }
                    }
                }
                Some(Wired::Composite(composite)) => {
                    composite.binding.for_each_sidechain(&mut |binding| self.resolve_one_sidechain(binding));
                }
                Some(Wired::Tape(tape)) => {
                    for member in &mut tape.audio {
                        if let Some(binding) = &mut member.sidechain {
                            self.resolve_one_sidechain(binding);
                        }
                    }
                }
                Some(Wired::Bus(bus)) => {
                    for binding in &mut bus.sidechains {
                        self.resolve_one_sidechain(binding);
                    }
                }
                None => {}
            }
        }
        self.audio_units = units;
    }

    /// Resolve ONE sidechain binding against the current graph: for each port follow the device pointer to its
    /// target's output, swap the producer -> consumer edge if the source node changed, and (if any port moved)
    /// push the device its current sidechain sources. See `resolve_sidechains` for the why.
    fn resolve_one_sidechain(&mut self, binding: &mut SidechainBinding) {
        let mut changed = false;
        let mut sources: Vec<(u32, SharedAudioBuffer)> = Vec::new();
        for port in &mut binding.ports {
            let target = self.graph.target_of(&Address::of(binding.device_uuid, port.path.clone())).cloned();
            let resolution = target.and_then(|target| {
                // The sidechain pointer targets a UNIT (its strip output) or a DEVICE. TS taps the DEVICE's own
                // output (e.g. the tape instrument's RAW output, before the unit's audio effects + strip), so a
                // device that registers its output under its own uuid (currently the tape instrument) resolves
                // directly. Otherwise follow the device's `host` pointer (field 1) to the owning unit's strip
                // output as a fallback; without either, detection falls back to the compressor's own (hot) input.
                let source_uuid = if self.output_registry.resolve(&Address::of(target.uuid, vec![])).is_some() {
                    Some(target.uuid)
                } else {
                    self.graph.target_of(&Address::of(target.uuid, vec![DEVICE_HOST_KEY])).map(|host| host.uuid)
                };
                source_uuid.and_then(|uuid| self.output_registry.resolve(&Address::of(uuid, vec![]))
                    .map(|output| (output.processor, output.buffer.clone())))
            });
            let source_node = resolution.as_ref().map(|(node, _)| *node);
            if source_node != port.resolved {
                if let Some(old) = port.resolved {
                    self.context.remove_edge(old, binding.node_id);
                }
                if let Some(new) = source_node {
                    self.context.register_edge(new, binding.node_id);
                }
                port.resolved = source_node;
                changed = true;
            }
            if let Some((_, buffer)) = resolution {
                sources.push((port.port_id, buffer));
            }
        }
        if changed {
            binding.effect.borrow_mut().set_sidechains(&sources);
        }
    }

    // ---- SEND / RETURN routing ------------------------------------------------------------------------------
    //
    // A unit's channel strip feeds its OUTPUT bus (a RETURN / submix `AudioBusBox`, or the primary bus = the
    // fixed `master` fallback). A bus unit's `AudioBusBox` input becomes a summing `AudioBusProcessor`
    // (`bus_registry`), so any source routing to it sums in, then the bus runs its own fx + strip. Parallel
    // `AuxSendBox`es tap a unit's PRE-fader buffer into a target bus. Wiring is DEFERRED to `resolve_outputs`
    // / `resolve_sends` (like sidechains), so it is order-independent: all buses are registered by the time the
    // resolve passes run at the end of `reconcile_units`. A feedback loop is rejected up front (`would_cycle`).

    /// The RETURN / submix-bus path: the unit's `input` device is an `AudioBusBox`, so build a summing bus
    /// (`sum`), register it so sources route in, run the bus's own audio-effect chain over it, then a channel
    /// strip; the strip's output is routed to the bus's own `output` by `resolve_outputs`. Wholesale rebuild on
    /// a chain edit (like tape / composite).
    fn reconcile_bus(&mut self, unit: &mut AudioUnitBinding, bus_uuid: Uuid, signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>) {
        self.teardown_unit_wired(unit);
        let sum_buffer = shared_audio_buffer();
        let sum = Rc::new(RefCell::new(AudioBusProcessor::new(sum_buffer.clone())));
        let sum_id = self.context.register_processor(sum.clone());
        self.context.set_label(sum_id, format!("bus-sum {:02x}{:02x}", bus_uuid[0], bus_uuid[1]));
        self.bus_registry.insert(bus_uuid, (sum.clone(), sum_id));
        // Register the RAW SUM (pre-fx, pre-strip, pre-mute) under the AudioBusBox uuid so a sidechain pointer
        // that targets this bus (e.g. a vocoder modulated by a MUTED submix) taps its full signal. Mirrors TS
        // `AudioBusProcessor` registering `adapter.address -> #audioOutput` (the sum), NOT the strip output.
        self.output_registry.register(Address::of(bus_uuid, vec![]), sum_buffer.clone(), sum_id);
        let mut nodes = vec![sum_id];
        let mut edges: Vec<(NodeId, NodeId)> = Vec::new();
        let mut device_params: Vec<DeviceParams> = Vec::new();
        let mut sidechains: Vec<SidechainBinding> = Vec::new();
        let mut subs: Vec<SubscriptionId> = Vec::new();
        // A disabled bus (`enabled` = 4) sums nothing (emits silence).
        let sum_enable = sum.clone();
        subs.push(self.graph.catchup_and_subscribe(Address::of(bus_uuid, vec![BUS_ENABLED_KEY]), move |value| {
            if let Some(enabled) = value.as_bool() { sum_enable.borrow_mut().set_enabled(enabled) }
        }));
        // The bus's own audio-effect chain (host 23), ordered by index, enabled only: sum -> fx0 -> ... Each
        // enabled / disabled effect gets a `This` monitor so a toggle re-wires (wholesale, like a chain edit).
        let mut source = sum_buffer;
        let mut source_id = sum_id;
        for device_uuid in unit.audio.sorted() {
            let resolved = self.graph.find_box(&device_uuid).and_then(|device_box| self.device_for_type(&device_box.name));
            let device = match resolved {
                Some(device) if device.kind == DEVICE_KIND_AUDIO_EFFECT => device,
                _ => continue
            };
            let rewire = Self::rewire_signal(unit);
            subs.push(self.graph.subscribe_vertex(Propagation::This, Address::of(device_uuid, vec![DEVICE_ENABLED_KEY]),
                Box::new(move |_graph, _update| rewire())));
            if !self.device_enabled(device_uuid) {
                continue; // bypassed: not built, not wired into the chain
            }
            let node = Rc::new(RefCell::new(PluginAudioEffect::new(self.sample_rate, device)));
            let node_state = node.borrow().state_ptr();
            let node_sink: Rc<RefCell<dyn ParamSink>> = node.clone();
            let params = self.bind_device(device_uuid, device, node_state, ParamNode::Audio(node_sink), invalidate);
            node.borrow_mut().set_audio_source(source);
            source = node.borrow().audio_output();
            let node_id = self.context.register_processor(node.clone());
            self.context.set_label(node_id, device_label(&self.graph, &device_uuid));
            let meter_slot = node.borrow().meter_slot();
            self.broadcasts.register(device_uuid, &[], crate::broadcast::PACKAGE_FLOAT_ARRAY, &meter_slot, 4);
            // A sidechained bus effect (e.g. a ducking compressor on a submix): build its sidechain binding so the
            // resolve pass feeds it the source unit's signal. Without this it detects on its own (hot) main input
            // and over-ducks everything routed through the bus.
            if !params.sidechain_paths.is_empty() {
                let mut ports = Vec::new();
                for (index, path) in params.sidechain_paths.iter().cloned().enumerate() {
                    let port_signal = signal.clone();
                    let pointer_sub = self.graph.subscribe_vertex(Propagation::This, Address::of(device_uuid, path.clone()),
                        Box::new(move |_graph, _update| port_signal()));
                    ports.push(SidechainPort {port_id: index as u32 + 2, path, resolved: None, pointer_sub});
                }
                sidechains.push(SidechainBinding {effect: node.clone(), node_id, device_uuid, ports});
            }
            device_params.push(params);
            self.context.register_edge(source_id, node_id);
            edges.push((source_id, node_id));
            nodes.push(node_id);
            source_id = node_id;
        }
        let position = self.transport.position();
        for params in &device_params {
            refresh_params(&params.handles, params.reg, params.state_ptr, position);
        }
        let pre_strip = source.clone();
        let pre_strip_node = source_id;
        let strip = Rc::new(RefCell::new(ChannelStripProcessor::new(unit.strip_params.clone(), unit.strip_automation.clone(), self.sample_rate)));
        strip.borrow_mut().set_audio_source(source);
        let strip_output = strip.borrow().audio_output();
        let strip_meter = strip.borrow().meter_slot();
        self.broadcasts.register(unit.unit, &[], crate::broadcast::PACKAGE_FLOAT_ARRAY, &strip_meter, 4);
        let strip_id = self.context.register_processor(strip);
        self.context.set_label(strip_id, format!("strip:bus {:02x}{:02x}", bus_uuid[0], bus_uuid[1]));
        self.context.register_edge(source_id, strip_id);
        edges.push((source_id, strip_id));
        nodes.push(strip_id);
        self.output_registry.register(Address::of(unit.unit, vec![]), strip_output.clone(), strip_id);
        unit.wired = Some(Wired::Bus(BusWired {
            bus_uuid, pre_strip, pre_strip_node, strip_id, strip_output, nodes, edges, device_params, sidechains, subs
        }));
    }

    /// The summing bus of a route: a REGISTERED (non-primary) bus's sum, or the master fallback (`None` =
    /// the primary bus). `None` result = the bus vanished (teardown races resolve to a no-op).
    fn sum_of(&self, bus: Option<Uuid>) -> Option<(Rc<RefCell<AudioBusProcessor>>, NodeId)> {
        match bus {
            Some(bus_uuid) => self.bus_registry.get(&bus_uuid).map(|(sum, id)| (sum.clone(), *id)),
            None => self.master.clone().map(|master| (master, self.master_id))
        }
    }

    /// Drop a unit's current OUTPUT route (the strip -> target bus summed source + ordering edge). A torn-down
    /// bus is already absent from `bus_registry` (its sum + incoming edges vanished with it), so its source
    /// removal is simply skipped.
    fn unwire_output_route(&mut self, unit: &mut AudioUnitBinding) {
        let Some(route) = unit.routed.take() else { return };
        if let Some((sum, _)) = self.sum_of(route.bus) {
            sum.borrow_mut().remove_audio_source(&route.strip_output);
        }
        if self.context.has_node(route.sum_id) {
            self.context.remove_edge(route.strip_id, route.sum_id);
        }
    }

    /// Re-resolve EVERY unit's OUTPUT route against the current graph, diff-based (a no-op per unchanged unit).
    /// Run at the end of a working `reconcile_units`, after all units + buses are (re)built, so a source that
    /// targets a bus resolves once the bus is registered. Mirrors `resolve_sidechains`.
    fn resolve_outputs(&mut self) {
        let mut units = core::mem::take(&mut self.audio_units);
        for unit in &mut units {
            self.resolve_one_output(unit);
        }
        self.audio_units = units;
    }

    /// Resolve ONE unit's output route: follow `output` (25) to the target `AudioBusBox`; a registered
    /// (non-primary) bus resolves to its sum, anything else (the primary bus, unset, or a dangling / not-yet-
    /// built bus) falls back to the `master`. Re-wire only when the source strip or the target sum changed; a
    /// feedback loop is left unrouted (silent) rather than silently broken by the topological sort.
    fn resolve_one_output(&mut self, unit: &mut AudioUnitBinding) {
        let Some((strip_id, strip_output)) = unit.wired.as_ref().map(|wired| wired.strip()) else {
            self.unwire_output_route(unit); // no wired chain: drop any stale route
            return;
        };
        let target_bus: Option<Uuid> = self.graph.target_of(&Address::of(unit.unit, vec![UNIT_OUTPUT_KEY]))
            .map(|target| target.uuid)
            .filter(|uuid| self.bus_registry.contains_key(uuid));
        let Some((sum_rc, sum_id)) = self.sum_of(target_bus) else { return };
        if let Some(route) = &unit.routed {
            if route.strip_id == strip_id && route.sum_id == sum_id {
                return; // unchanged
            }
        }
        self.unwire_output_route(unit);
        if self.context.would_cycle(strip_id, sum_id) {
            return; // a feedback loop: leave unrouted (silent); a later edit can fix it
        }
        sum_rc.borrow_mut().add_audio_source(strip_output.clone());
        self.context.register_edge(strip_id, sum_id);
        unit.routed = Some(Routed {bus: target_bus, sum_id, strip_id, strip_output});
    }

    /// Reconcile a unit's parallel AUX SENDS against its `auxSends` (24) collection: build joiners, terminate
    /// leavers, in collection order. Only the send PROCESSORS + their param subscriptions are (de)allocated
    /// here; their source (pre-fader tap) + target-bus edges are wired by `resolve_sends`.
    fn reconcile_sends(&mut self, unit: &mut AudioUnitBinding) {
        let desired = unit.aux_sends.sorted();
        let existing = core::mem::take(&mut unit.sends);
        let (mut pool, gone): (Vec<SendBinding>, Vec<SendBinding>) =
            existing.into_iter().partition(|send| desired.contains(&send.send_uuid));
        for send in gone {
            self.teardown_send(send);
        }
        let mut sends = Vec::new();
        let invalidate = automation_invalidate(unit);
        for send_uuid in desired {
            if let Some(index) = pool.iter().position(|send| send.send_uuid == send_uuid) {
                sends.push(pool.remove(index));
            } else {
                let mark = unit.mark.clone();
                sends.push(self.build_send(send_uuid, &mark, &invalidate));
            }
        }
        unit.sends = sends;
    }

    /// Build one aux send: its `AuxSendProcessor` reading the send's `sendGain` (5, dB) / `sendPan` (6, bipolar)
    /// via a shared `SendParams` (kept in sync with the box, de-clicked in the node), plus a `targetBus` (2)
    /// pointer monitor that re-resolves on a re-point.
    fn build_send(&mut self, send_uuid: Uuid, mark: &DirtyMark, invalidate: &Rc<dyn Fn()>) -> SendBinding {
        let params = Rc::new(SendParams::new());
        let mut subs = Vec::new();
        let gain = params.clone();
        subs.push(self.graph.catchup_and_subscribe(Address::of(send_uuid, vec![SEND_GAIN_KEY]), move |value| {
            if let Some(value) = value.as_float32() { gain.gain_db.set(value) }
        }));
        let pan = params.clone();
        subs.push(self.graph.catchup_and_subscribe(Address::of(send_uuid, vec![SEND_PAN_KEY]), move |value| {
            if let Some(value) = value.as_float32() { pan.pan.set(value) }
        }));
        let target_mark = mark.clone();
        subs.push(self.graph.subscribe_vertex(Propagation::This, Address::of(send_uuid, vec![SEND_TARGET_KEY]),
            Box::new(move |_graph, _update| target_mark.mark())));
        let automation = Rc::new(StripAutomation::new());
        let proc = Rc::new(RefCell::new(AuxSendProcessor::new(params, automation.clone(), self.sample_rate)));
        let node_id = self.context.register_processor(proc.clone());
        self.context.set_label(node_id, format!("aux-send {:02x}{:02x}", send_uuid[0], send_uuid[1]));
        let mut send = SendBinding {send_uuid, proc, node_id, source: None, target: None, subs, automation,
            param_subs: Vec::new(), param_collections: Vec::new()};
        self.bind_send_automation(&mut send, invalidate);
        send
    }

    /// Bind a send's `sendGain` (5) + `sendPan` (6) to their AUTOMATION (mirrors `bind_strip_automation`): a
    /// Value track targeting those fields drives the send at the update clock. Re-observed on a real automation
    /// change; without a track the override stays `None` and the send keeps using the static `SendParams`.
    /// Gain maps the 0..1 curve through the adapter's `ValueMapping.DefaultDecibel`; pan is bipolar.
    fn bind_send_automation(&mut self, send: &mut SendBinding, invalidate: &Rc<dyn Fn()>) {
        const SEND_GAIN: Decibel = Decibel::new(-72.0, -12.0, 0.0); // TS AuxSendBoxAdapter ValueMapping.DefaultDecibel
        let automation = send.automation.clone();
        self.bind_gain_pan_automation(send.send_uuid, SEND_GAIN_KEY, SEND_PAN_KEY, SEND_GAIN,
            &automation, &mut send.param_subs, &mut send.param_collections, invalidate);
    }

    /// Tear down one aux send: detach its source + target edges (and its summed output), then drop the node +
    /// subscriptions.
    fn teardown_send(&mut self, send: SendBinding) {
        if let Some(source) = send.source {
            if self.context.has_node(send.node_id) {
                self.context.remove_edge(source, send.node_id);
            }
        }
        if let Some((bus, sum_id)) = send.target {
            if let Some((sum, _)) = self.sum_of(bus) {
                sum.borrow_mut().remove_audio_source(&send.proc.borrow().audio_output());
            }
            if self.context.has_node(sum_id) {
                self.context.remove_edge(send.node_id, sum_id);
            }
        }
        for sub in send.subs {
            self.graph.unsubscribe(sub);
        }
        for sub in send.param_subs {
            self.graph.unsubscribe(sub);
        }
        for collection in send.param_collections {
            collection.terminate(&mut self.graph);
        }
        self.context.remove_processor(send.node_id);
    }

    /// Tear down all of a unit's aux sends (a unit removal / a full re-init).
    fn teardown_sends(&mut self, unit: &mut AudioUnitBinding) {
        for send in core::mem::take(&mut unit.sends) {
            self.teardown_send(send);
        }
    }

    /// Re-resolve EVERY unit's aux sends against the current graph (source tap + target bus), diff-based. Run
    /// with `resolve_outputs` at the end of a working `reconcile_units`.
    fn resolve_sends(&mut self) {
        let mut units = core::mem::take(&mut self.audio_units);
        for unit in &mut units {
            let tap = unit.wired.as_ref().map(|wired| wired.pre_strip());
            let mut sends = core::mem::take(&mut unit.sends);
            for send in &mut sends {
                self.resolve_one_send(send, &tap);
            }
            unit.sends = sends;
        }
        self.audio_units = units;
    }

    /// Resolve ONE aux send: wire its PRE-fader tap node as source, and its `targetBus` (registered bus sum, or
    /// the master fallback) as the destination it sums into. Both diffed so a re-point / strip rebuild re-wires
    /// once; a feedback loop is left unrouted.
    fn resolve_one_send(&mut self, send: &mut SendBinding, tap: &Option<(NodeId, SharedAudioBuffer)>) {
        let source_node = tap.as_ref().map(|(node, _)| *node);
        if source_node != send.source {
            if let Some(old) = send.source {
                if self.context.has_node(send.node_id) {
                    self.context.remove_edge(old, send.node_id);
                }
            }
            if let Some((node, buffer)) = tap {
                send.proc.borrow_mut().set_audio_source(buffer.clone());
                self.context.register_edge(*node, send.node_id);
            } else {
                // The source chain is gone: DETACH, or the send keeps summing the last frozen buffer forever.
                send.proc.borrow_mut().clear_audio_source();
            }
            send.source = source_node;
        }
        let target_bus: Option<Uuid> = self.graph.target_of(&Address::of(send.send_uuid, vec![SEND_TARGET_KEY]))
            .map(|target| target.uuid)
            .filter(|uuid| self.bus_registry.contains_key(uuid));
        let Some((sum_rc, sum_id)) = self.sum_of(target_bus) else { return };
        let new_target = (target_bus, sum_id);
        if send.target == Some(new_target) {
            return;
        }
        if let Some((old_bus, old_sum)) = send.target {
            if let Some((sum, _)) = self.sum_of(old_bus) {
                sum.borrow_mut().remove_audio_source(&send.proc.borrow().audio_output());
            }
            if self.context.has_node(old_sum) {
                self.context.remove_edge(send.node_id, old_sum);
            }
        }
        if self.context.would_cycle(send.node_id, sum_id) {
            send.target = None; // a feedback loop: leave unrouted
            return;
        }
        sum_rc.borrow_mut().add_audio_source(send.proc.borrow().audio_output());
        self.context.register_edge(send.node_id, sum_id);
        send.target = Some(new_target);
    }

    /// Remove a unit entirely: drop its wired cluster (edges, nodes, bus source), unsubscribe its tracks
    /// membership + track cascade, and terminate its three device-chain collections.
    fn teardown_unit(&mut self, mut binding: AudioUnitBinding) {
        self.unwire_output_route(&mut binding); // drop the strip -> target bus route + summed source
        self.teardown_sends(&mut binding);      // drop the parallel aux sends (nodes, edges, monitors)
        self.graph.unsubscribe(binding.output_sub);
        if let Some(wired) = binding.wired.take() {
            self.teardown_wired_value(binding.unit, wired);
        }
        self.graph.unsubscribe(binding.track_sub);
        for sub in &binding.strip_subs {
            self.graph.unsubscribe(*sub);
        }
        for sub in &binding.strip_param_subs {
            self.graph.unsubscribe(*sub);
        }
        for collection in core::mem::take(&mut binding.strip_param_collections) {
            collection.terminate(&mut self.graph);
        }
        for track in binding.tracks {
            teardown_track(&mut self.graph, &binding.track_sets, &mut binding.collections, &self.clip_sequencer, track);
        }
        for track in binding.audio_tracks {
            teardown_audio_track(&mut self.graph, &binding.audio_track_sets, track);
        }
        binding.collections.terminate_all(&mut self.graph); // defensive; the tracks released everything
        binding.input.terminate(&mut self.graph);
        binding.midi.terminate(&mut self.graph);
        binding.audio.terminate(&mut self.graph);
        binding.aux_sends.terminate(&mut self.graph);
    }

    /// Drop a unit's whole wired graph (full teardown, the analog of TS `#disconnector.terminate` plus
    /// terminating every `#effects` entry): unwire from the master, remove its edges + nodes, and terminate
    /// each member's params + sidechain monitors. Used when a unit is removed, or its instrument changes kind.
    fn teardown_unit_wired(&mut self, unit: &mut AudioUnitBinding) {
        if let Some(wired) = unit.wired.take() {
            self.teardown_wired_value(unit.unit, wired);
        }
    }

    fn teardown_wired_value(&mut self, unit_uuid: Uuid, wired: Wired) {
        // The unit's strip output is registered for sidechain resolution; drop it so a torn-down unit can never
        // hand a sidechain a stale buffer. A rebuild (kind change) re-registers it immediately after. The OUTPUT
        // route (strip -> target bus) is torn down separately by `unwire_output_route` before this runs.
        self.output_registry.remove(&Address::of(unit_uuid, vec![]));
        match wired {
            Wired::Leaf(chain) => {
                for (source, target) in &chain.edges {
                    self.context.remove_edge(*source, *target);
                }
                self.context.remove_processor(chain.strip_id);
                self.terminate_member(chain.instrument);
                for member in chain.midi {
                    self.terminate_member(member);
                }
                for member in chain.audio {
                    self.terminate_member(member);
                }
            }
            Wired::Composite(composite) => {
                self.graph.unsubscribe(composite.enabled_sub);
                for (source, target) in &composite.tail_edges {
                    self.context.remove_edge(*source, *target);
                }
                self.context.remove_processor(composite.strip_id);
                self.teardown_composite(composite.binding);
            }
            Wired::Tape(tape) => {
                self.graph.unsubscribe(tape.enabled_sub);
                self.output_registry.remove(&Address::of(tape.instrument_uuid, vec![]));
                for (source, target) in &tape.edges {
                    self.context.remove_edge(*source, *target);
                }
                self.context.remove_processor(tape.strip_id);
                self.context.remove_processor(tape.player_id);
                for member in tape.audio {
                    self.terminate_member(member);
                }
            }
            Wired::Bus(bus) => {
                // Drop this bus from the registry FIRST so any source unit still routed to it re-resolves to the
                // master fallback (and skips removing its summed source from the now-gone sum). Then remove the
                // enabled monitors, the fx params, the internal edges, and every node (sum + fx + strip).
                self.bus_registry.remove(&bus.bus_uuid);
                self.output_registry.remove(&Address::of(bus.bus_uuid, vec![]));
                for sub in bus.subs {
                    self.graph.unsubscribe(sub);
                }
                for binding in bus.sidechains {
                    for port in binding.ports {
                        self.graph.unsubscribe(port.pointer_sub);
                    }
                }
                self.teardown_device_params(bus.device_params);
                for (source, target) in &bus.edges {
                    self.context.remove_edge(*source, *target);
                }
                for node in bus.nodes {
                    self.context.remove_processor(node);
                }
            }
        }
    }

    /// Terminate ONE leaf chain member (a leaver, or a full teardown): remove its processor node (a midi-fx
    /// has none), drop its sidechain ports' pointer monitors, and unsubscribe its parameter observations.
    fn terminate_member(&mut self, member: Member) {
        if let Some(node_id) = member.node_id {
            self.context.remove_processor(node_id);
        }
        if let Some(sidechain) = member.sidechain {
            for port in sidechain.ports {
                self.graph.unsubscribe(port.pointer_sub);
            }
        }
        self.graph.unsubscribe(member.enabled_sub);
        self.teardown_device_params(vec![member.params]);
    }

    /// Build a unit binding: its per-track region collections list (`track_sets`, shared with the
    /// sequencer), the track-membership subscription (key 20) the cascade fills, and the three device-chain
    /// collections — `input` (host 22), `midi` (host 21), `audio` (host 23), each ordered by the device
    /// `index` (field 2). No processor nodes yet; the first `reconcile` rewires it (the collections are dirty
    /// from catch-up). No per-device-type logic: the device table (`device_for_type`) maps each box to its plugin.
    fn build_unit(&mut self, uuid: Uuid) -> AudioUnitBinding {
        let mark = DirtyMark {units: self.dirty_units.clone(), unit: uuid};
        let track_sets: SharedTrackSets = Rc::new(RefCell::new(Vec::new()));
        let track_changes = Rc::new(RefCell::new(Members::default()));
        let recorder = track_changes.clone();
        let track_mark = mark.clone();
        let track_sub = self.graph.subscribe_pointer_hub(Address::of(uuid, vec![UNIT_TRACKS_KEY]), Box::new(move |_graph, event| {
            match event {
                HubEvent::Added(source) => recorder.borrow_mut().added.push(source.uuid),
                HubEvent::Removed(source) => recorder.borrow_mut().removed.push(source.uuid)
            }
            track_mark.mark();
        }));
        // The instrument `input` host holds ONE instrument, which has no `index` field (only effects do). So it
        // is never ordered: key `0` is a non-field, read back as 0 for every member, and the collection is used
        // only for membership + `.first()`. The midi (21) and audio (23) chains ARE effects, ordered by index.
        let input = IndexedCollection::observe(&mut self.graph, Address::of(uuid, vec![UNIT_INPUT_KEY]), 0);
        let midi = IndexedCollection::observe(&mut self.graph, Address::of(uuid, vec![UNIT_MIDI_KEY]), EFFECT_INDEX_KEY);
        let audio = IndexedCollection::observe(&mut self.graph, Address::of(uuid, vec![UNIT_AUDIO_KEY]), EFFECT_INDEX_KEY);
        // A chain edit (add / remove / reorder a device) enqueues this unit for a targeted reconcile. Wired
        // after `observe` so the catch-up members do not fire it; the new unit enqueues itself once below.
        input.set_on_dirty(mark.signal());
        midi.set_on_dirty(mark.signal());
        audio.set_on_dirty(mark.signal());
        // SEND/RETURN: the `auxSends` (24) collection (parallel sends, ordered by index but order is not audible)
        // + a monitor on `output` (25) so a re-point of the unit's destination bus enqueues it. Both wired AFTER
        // observe so the catch-up members / value do not fire (the new unit enqueues itself once below).
        let aux_sends = IndexedCollection::observe(&mut self.graph, Address::of(uuid, vec![UNIT_AUX_SENDS_KEY]), EFFECT_INDEX_KEY);
        aux_sends.set_on_dirty(mark.signal());
        let output_mark = mark.clone();
        let output_sub = self.graph.subscribe_vertex(Propagation::This, Address::of(uuid, vec![UNIT_OUTPUT_KEY]),
            Box::new(move |_graph, _update| output_mark.mark()));
        // The channel strip's parameters, kept in sync with the unit's box: volume (12, dB), panning (13),
        // mute (14). Reactive but no rewire needed — the strip reads these Cells each block.
        let strip_params = Rc::new(StripParams::new());
        let volume = strip_params.clone();
        let volume_sub = self.graph.catchup_and_subscribe(Address::of(uuid, vec![UNIT_VOLUME_KEY]), move |value| {
            if let Some(value) = value.as_float32() { volume.volume_db.set(value) }
        });
        let panning = strip_params.clone();
        let panning_sub = self.graph.catchup_and_subscribe(Address::of(uuid, vec![UNIT_PANNING_KEY]), move |value| {
            if let Some(value) = value.as_float32() { panning.panning.set(value) }
        });
        let mute = strip_params.clone();
        let mute_sub = self.graph.catchup_and_subscribe(Address::of(uuid, vec![UNIT_MUTE_KEY]), move |value| {
            if let Some(value) = value.as_bool() { mute.mute.set(value) }
        });
        // Automation reactivity is per-parameter and TARGETED (see `observe_params`): each parameter's field
        // value, its automation pointer-hub, and its track's region hub fire `automation_invalidate`, which
        // sets this flag + enqueues the unit, so `reconcile_one` re-binds the unit's curves (no rewire). No
        // per-unit all-updates observer.
        let automation_dirty = Rc::new(Cell::new(false));
        let params_dirty = Rc::new(Cell::new(false));
        let wiring_dirty = Rc::new(Cell::new(false));
        AudioUnitBinding {
            unit: uuid, track_sets, collections: CollectionCache::default(), tracks: Vec::new(),
            audio_track_sets: Rc::new(RefCell::new(Vec::new())), audio_tracks: Vec::new(),
            track_changes, track_sub, strip_params, strip_subs: vec![volume_sub, panning_sub, mute_sub],
            strip_automation: Rc::new(StripAutomation::new()), strip_param_subs: Vec::new(), strip_param_collections: Vec::new(),
            input, midi, audio, output_sub, routed: None, aux_sends, sends: Vec::new(),
            wired: None, automation_dirty, params_dirty, wiring_dirty, mark
        }
    }

    /// The closure each device's `enabled` monitor fires: mark the unit for a re-wire and enqueue it. A
    /// re-wire reconcile reuses every member (edge-only — no param push, no reset), so a bypass costs nothing
    /// but the connection.
    fn rewire_signal(unit: &AudioUnitBinding) -> Rc<dyn Fn()> {
        let flag = unit.wiring_dirty.clone();
        let mark = unit.mark.clone();
        Rc::new(move || {
            flag.set(true);
            mark.mark();
        })
    }

    /// Reconcile a unit's processor graph to its current chains. Resolve the instrument; dispatch to the
    /// per-member LEAF path (instrument + midi-fx + audio-fx) or the COMPOSITE path. A unit with no resolvable
    /// instrument is left silent (its wiring fully torn down). The only per-device knowledge is the
    /// box-type -> plugin table.
    fn reconcile_chain(&mut self, unit: &mut AudioUnitBinding) {
        // A rewire tears down (or reuses) the strip; drop the current output route first so no stale summed
        // source / edge survives. `resolve_outputs` (end of `reconcile_units`) re-routes the rebuilt strip.
        self.unwire_output_route(unit);
        let instrument_uuid = match unit.input.sorted().first().copied() {
            Some(uuid) => uuid,
            None => return self.teardown_unit_wired(unit) // no instrument: silent until its `input` box appears
        };
        let box_name = match self.graph.find_box(&instrument_uuid) {
            Some(device_box) => device_box.name.clone(),
            None => return self.teardown_unit_wired(unit)
        };
        // Enqueues this unit when a chain / child / sidechain pointer of its scope changes, plus the parameter
        // `invalidate` (which also sets `automation_dirty`). Both threaded through the whole build.
        let signal = unit.mark.signal();
        let invalidate = automation_invalidate(unit);
        let rewire = Self::rewire_signal(unit); // a device `enabled` toggle re-wires the chain edge-only
        if box_name == BUS_BOX_TYPE {
            self.reconcile_bus(unit, instrument_uuid, &signal, &invalidate); // a RETURN / submix bus unit
        } else if let Some(spec) = self.composite_for_type(&box_name) {
            self.reconcile_composite(unit, instrument_uuid, spec, &signal, &invalidate);
        } else if box_name == TAPE_BOX_TYPE {
            self.reconcile_tape(unit, instrument_uuid, &signal, &invalidate, &rewire); // audio unit: player -> fx -> strip
        } else {
            match self.device_for_type(&box_name) {
                Some(device) if device.kind == DEVICE_KIND_INSTRUMENT =>
                    self.reconcile_leaf(unit, instrument_uuid, device, &signal, &invalidate, &rewire),
                _ => self.teardown_unit_wired(unit) // not a buildable instrument: silent
            }
        }
    }

    /// The TAPE / audio-region path: the unit's instrument is a `TapeDeviceBox`, so its source is the engine-side
    /// audio-region player reading the unit's AUDIO tracks (`audio_track_sets`) -> channel strip -> master. Built
    /// wholesale on a chain change; the player reads its track sets live, so a region add / remove / edit needs no
    /// rebuild (the cascade updates the collections the player range-queries).
    fn reconcile_tape(&mut self, unit: &mut AudioUnitBinding, instrument_uuid: Uuid, signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>, rewire: &Rc<dyn Fn()>) {
        // Pool the previous tape audio-fx members so survivors keep their DSP state (compressor ballistics, delay
        // tails) across a chain edit; the player + strip are rebuilt fresh (the player reads its track sets live,
        // the strip carries no DSP state, just the shared volume / panning / mute cells).
        let mut pool: BTreeMap<Uuid, Member> = BTreeMap::new();
        match unit.wired.take() {
            Some(Wired::Tape(tape)) => {
                for (source, target) in &tape.edges {
                    self.context.remove_edge(*source, *target);
                }
                self.context.remove_processor(tape.strip_id);
                self.context.remove_processor(tape.player_id);
                self.output_registry.remove(&Address::of(unit.unit, vec![]));
                self.output_registry.remove(&Address::of(tape.instrument_uuid, vec![]));
                for member in tape.audio {
                    pool.insert(member.uuid, member);
                }
            }
            Some(other) => self.teardown_wired_value(unit.unit, other),
            None => {}
        }
        let player = Rc::new(RefCell::new(AudioRegionPlayer::new(unit.audio_track_sets.clone(), self.sample_rate, self.tempo_map.clone())));
        let player_output = player.borrow().audio_output();
        let player_id = self.context.register_processor(player.clone());
        let (stretch_regions, total_regions) = tape_region_counts(&unit.audio_track_sets);
        player.borrow_mut().prepare(stretch_regions, total_regions);
        // TS `TapeDeviceProcessor` observes the box `enabled`: silence + a state reset while disabled.
        let enabled_player = player.clone();
        let enabled_sub = self.graph.catchup_and_subscribe(Address::of(instrument_uuid, vec![DEVICE_ENABLED_KEY]), move |value| {
            if let Some(enabled) = value.as_bool() {
                enabled_player.borrow_mut().set_enabled(enabled);
            }
        });
        self.context.set_label(player_id, format!("region-player {:02x}{:02x}", unit.unit[0], unit.unit[1]));
        // Live telemetry: the tape's raw output peaks, registered under the TapeDeviceBox (the device column).
        let player_meter = player.borrow().meter_slot();
        self.broadcasts.register(instrument_uuid, &[], crate::broadcast::PACKAGE_FLOAT_ARRAY, &player_meter, 4);
        // The tape's RAW output (pre fx / strip) registered under the TapeDeviceBox uuid: a sidechain targeting the
        // tape device resolves THIS (matching TS, which taps the instrument output before the unit's audio effects).
        self.output_registry.register(Address::of(instrument_uuid, vec![]), player_output.clone(), player_id);
        // Build the AUDIO-effects chain (reusing survivors, building joiners, terminating leavers) exactly like a
        // leaf unit. Without this an audio track's effects (EQ / compressor / gain) are silently dropped.
        let mut audio_members: Vec<Member> = Vec::new();
        for uuid in unit.audio.sorted() {
            let device = self.graph.find_box(&uuid).and_then(|device_box| self.device_for_type(&device_box.name));
            if let Some(device) = device {
                if device.kind == DEVICE_KIND_AUDIO_EFFECT {
                    audio_members.push(self.take_or_build_audio(&mut pool, uuid, device, signal, invalidate, rewire));
                }
            }
        }
        for (_, member) in core::mem::take(&mut pool) {
            self.terminate_member(member);
        }
        // Wire player -> fx0 -> ... (a disabled effect is SKIPPED, its processor + state untouched).
        let mut edges: Vec<(NodeId, NodeId)> = Vec::new();
        let mut output = player_output;
        let mut output_node = player_id;
        for member in &audio_members {
            if !self.device_enabled(member.uuid) {
                continue;
            }
            if let ProcHandle::Audio(node) = &member.proc {
                node.borrow_mut().set_audio_source(output.clone());
            }
            let node_id = member.node_id.unwrap();
            self.context.register_edge(output_node, node_id);
            edges.push((output_node, node_id));
            output = member.output.clone().unwrap();
            output_node = node_id;
        }
        let strip = Rc::new(RefCell::new(ChannelStripProcessor::new(unit.strip_params.clone(), unit.strip_automation.clone(), self.sample_rate)));
        strip.borrow_mut().set_audio_source(output.clone());
        let strip_output = strip.borrow().audio_output();
        let strip_meter = strip.borrow().meter_slot();
        self.broadcasts.register(unit.unit, &[], crate::broadcast::PACKAGE_FLOAT_ARRAY, &strip_meter, 4);
        let strip_id = self.context.register_processor(strip);
        self.context.set_label(strip_id, format!("strip:tape {:02x}{:02x}", unit.unit[0], unit.unit[1]));
        self.context.register_edge(output_node, strip_id);
        edges.push((output_node, strip_id));
        // The strip's output is routed to the unit's OUTPUT bus by `resolve_outputs` (not wired to master here).
        self.output_registry.register(Address::of(unit.unit, vec![]), strip_output.clone(), strip_id);
        unit.wired = Some(Wired::Tape(TapeWired {player, enabled_sub, player_id, instrument_uuid, audio: audio_members, pre_strip: output, pre_strip_node: output_node, strip_id, strip_output, edges}));
    }

    /// The COMPOSITE-instrument path (e.g. Playfield): tear down the old wiring and rebuild the child cascade
    /// wholesale (per-child lifecycle is internal to the `composite` module). The composite's own midi / audio
    /// unit chains are not wrapped around it yet. Mapping-agnostic — `spec` names the slot collection.
    fn reconcile_composite(&mut self, unit: &mut AudioUnitBinding, instrument_uuid: Uuid, spec: CompositeSpec,
                           signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>) {
        self.teardown_unit_wired(unit);
        let track_sets = unit.track_sets.clone();
        let binding = self.build_composite(&track_sets, instrument_uuid, &spec, signal, invalidate);
        // The unit's tail: the composite's sum bus -> channel strip; the strip's output is routed to the unit's
        // OUTPUT bus by `resolve_outputs` (not master here). The strip + sum edge persist across per-child reconciles.
        let pre_strip = binding.sum_buffer.clone();
        let pre_strip_node = binding.sum_id;
        let strip = Rc::new(RefCell::new(ChannelStripProcessor::new(unit.strip_params.clone(), unit.strip_automation.clone(), self.sample_rate)));
        strip.borrow_mut().set_audio_source(binding.sum_buffer.clone());
        let strip_output = strip.borrow().audio_output();
        let strip_meter = strip.borrow().meter_slot();
        self.broadcasts.register(unit.unit, &[], crate::broadcast::PACKAGE_FLOAT_ARRAY, &strip_meter, 4);
        let strip_id = self.context.register_processor(strip);
        self.context.set_label(strip_id, format!("strip:composite {:02x}{:02x}", unit.unit[0], unit.unit[1]));
        let mut tail_edges = Vec::new();
        self.context.register_edge(binding.sum_id, strip_id);
        tail_edges.push((binding.sum_id, strip_id));
        self.output_registry.register(Address::of(unit.unit, vec![]), strip_output.clone(), strip_id);
        // Each child's parameters are pushed as it is built (a joiner), inside `build_one_child`; no blanket
        // re-push here, so a per-child reconcile never touches an existing slot's parameters.
        let enabled_mark = unit.mark.clone();
        let enabled_sub = self.graph.subscribe_vertex(Propagation::This,
            Address::of(instrument_uuid, vec![DEVICE_ENABLED_KEY]),
            Box::new(move |_graph, _update| enabled_mark.mark()));
        unit.wired = Some(Wired::Composite(CompositeWired {binding, pre_strip, pre_strip_node, strip_id, strip_output, tail_edges, enabled_sub}));
    }

    /// The LEAF-instrument per-member path, mirroring TS `AudioDeviceChain`: keep the existing device
    /// processors, create only the joiners, terminate only the leavers, then re-wire EDGES ONLY. A processor
    /// that survives keeps its instance (and so its DSP state — voices, delay tails, filter history); only
    /// joiners are built + bound (re-binding re-runs the device `init`, which resets DSP, so survivors must be
    /// left untouched). The channel strip persists across reconciles too.
    fn reconcile_leaf(&mut self, unit: &mut AudioUnitBinding, instrument_uuid: Uuid, instrument_device: DeviceReg,
                      signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>, rewire: &Rc<dyn Fn()>) {
        // Pool the previous leaf members so survivors can be reused; remove the previous edges (the
        // `#disconnector` analog — edge-only teardown, NODES KEPT). A stale composite / none is fully removed.
        let mut pool: BTreeMap<Uuid, Member> = BTreeMap::new();
        let mut strip_keep: Option<(Rc<RefCell<ChannelStripProcessor>>, NodeId, SharedAudioBuffer)> = None;
        let mut sequencer_keep: Option<(Uuid, SharedNoteEventSource)> = None;
        match unit.wired.take() {
            Some(Wired::Leaf(chain)) => {
                for (source, target) in &chain.edges {
                    self.context.remove_edge(*source, *target);
                }
                // The output route was already dropped in `reconcile_chain`; the strip survives, so it re-routes.
                sequencer_keep = Some((chain.instrument.uuid, chain.sequencer));
                pool.insert(chain.instrument.uuid, chain.instrument);
                for member in chain.midi {
                    pool.insert(member.uuid, member);
                }
                for member in chain.audio {
                    pool.insert(member.uuid, member);
                }
                strip_keep = Some((chain.strip, chain.strip_id, chain.strip_output));
            }
            Some(other) => self.teardown_wired_value(unit.unit, other),
            None => {}
        }
        // Build the desired chain, reusing survivors from the pool (joiners are created + bound).
        let instrument = self.take_or_build_instrument(&mut pool, instrument_uuid, instrument_device, invalidate, rewire);
        let mut midi_members: Vec<Member> = Vec::new();
        for uuid in unit.midi.sorted() {
            let device = self.graph.find_box(&uuid).and_then(|device_box| self.device_for_type(&device_box.name));
            if let Some(device) = device {
                if device.kind == DEVICE_KIND_MIDI_EFFECT {
                    midi_members.push(self.take_or_build_midi(&mut pool, uuid, device, invalidate, rewire));
                }
            }
        }
        let mut audio_members: Vec<Member> = Vec::new();
        for uuid in unit.audio.sorted() {
            let device = self.graph.find_box(&uuid).and_then(|device_box| self.device_for_type(&device_box.name));
            if let Some(device) = device {
                if device.kind == DEVICE_KIND_AUDIO_EFFECT {
                    audio_members.push(self.take_or_build_audio(&mut pool, uuid, device, signal, invalidate, rewire));
                }
            }
        }
        // Whatever remains pooled left the chain (a leaver): terminate it (node + sidechain monitors + params).
        for (_, member) in core::mem::take(&mut pool) {
            self.terminate_member(member);
        }
        // Reuse the instrument's note source if the instrument SURVIVED (it holds notes retained across blocks;
        // recreating it mid-play would drop them — stuck / re-triggered notes). Build a fresh one only when the
        // instrument itself is a joiner. Then fold the midi-fx PULL chain over it (reused midi effects keep
        // their state; only the pull wrappers are rebuilt).
        let sequencer: SharedNoteEventSource = match sequencer_keep {
            Some((uuid, kept)) if uuid == instrument_uuid => kept,
            _ => Rc::new(RefCell::new(NoteSequencer::new(Box::new(BoundNoteRegions {tracks: unit.track_sets.clone()}), self.clip_sequencer.clone())))
        };
        // Edge-only re-wire: instrument -> fx0 -> ... (a leaf has no choke), then -> strip; the strip's output is
        // routed to the unit's OUTPUT bus by `resolve_outputs` (not master here).
        let (output, output_node, mut edges) = self.wire_cluster(&instrument, instrument_uuid, &sequencer, &midi_members, &audio_members, &[]);
        // The channel strip terminates the chain; reuse it across reconciles (it carries no DSP state, just the
        // shared volume / panning / mute), re-pointing its source at the new tail.
        let (strip, strip_id, strip_output) = match strip_keep {
            Some(existing) => existing,
            None => {
                let strip = Rc::new(RefCell::new(ChannelStripProcessor::new(unit.strip_params.clone(), unit.strip_automation.clone(), self.sample_rate)));
                let strip_output = strip.borrow().audio_output();
                let strip_meter = strip.borrow().meter_slot();
                self.broadcasts.register(unit.unit, &[], crate::broadcast::PACKAGE_FLOAT_ARRAY, &strip_meter, 4);
                let strip_id = self.context.register_processor(strip.clone());
                self.context.set_label(strip_id, format!("strip:leaf {:02x}{:02x}", unit.unit[0], unit.unit[1]));
                (strip, strip_id, strip_output)
            }
        };
        strip.borrow_mut().set_audio_source(output.clone());
        self.context.register_edge(output_node, strip_id);
        edges.push((output_node, strip_id));
        self.output_registry.register(Address::of(unit.unit, vec![]), strip_output.clone(), strip_id);
        // Parameters are pushed ONLY to JOINERS (at build, in `take_or_build_*`). Survivors are NOT touched — a
        // reorder / add / remove must leave every existing plugin's parameters exactly as they are (re-pushing
        // would, e.g., glide a delay's offset). A real automation change re-binds via `rebind_automation`.
        unit.wired = Some(Wired::Leaf(LeafChain {
            instrument, sequencer, midi: midi_members, audio: audio_members, strip,
            pre_strip: output, pre_strip_node: output_node, strip_id, strip_output, edges
        }));
    }

    /// Whether a device box is `enabled` (default true): a disabled audio / midi effect is bypassed — skipped
    /// in the chain wiring, its processor + params + DSP state left fully intact.
    pub(crate) fn device_enabled(&self, uuid: Uuid) -> bool {
        self.graph.field_value(&Address::of(uuid, vec![DEVICE_ENABLED_KEY])).and_then(|value| value.as_bool()).unwrap_or(true)
    }

    /// A TARGETED `This` monitor on a device's `enabled` field: a toggle fires `rewire` (mark + enqueue the
    /// unit), so `reconcile_leaf` re-wires the chain edge-only, skipping / including the toggled effect.
    fn subscribe_enabled(&mut self, uuid: Uuid, rewire: &Rc<dyn Fn()>) -> SubscriptionId {
        let rewire = rewire.clone();
        self.graph.subscribe_vertex(Propagation::This, Address::of(uuid, vec![DEVICE_ENABLED_KEY]),
            Box::new(move |_graph, _update| rewire()))
    }

    /// Reuse the pooled instrument processor (a survivor: its voices live on) or build + bind a fresh one (a
    /// joiner). A pooled entry of a different role under this uuid is terminated and rebuilt.
    fn take_or_build_instrument(&mut self, pool: &mut BTreeMap<Uuid, Member>, uuid: Uuid, device: DeviceReg,
                                invalidate: &Rc<dyn Fn()>, rewire: &Rc<dyn Fn()>) -> Member {
        if let Some(existing) = pool.remove(&uuid) {
            if matches!(existing.proc, ProcHandle::Instrument(_)) {
                return existing;
            }
            self.terminate_member(existing);
        }
        let instrument = Rc::new(RefCell::new(PluginInstrument::new(self.sample_rate, device)));
        let state_ptr = instrument.borrow().state_ptr();
        let sink: Rc<RefCell<dyn ParamSink>> = instrument.clone();
        let params = self.bind_device(uuid, device, state_ptr, ParamNode::Audio(sink), invalidate);
        refresh_params(&params.handles, params.reg, params.state_ptr, self.transport.position()); // joiner only
        let output = instrument.borrow().audio_output();
        let node_id = self.context.register_processor(instrument.clone());
        self.context.set_label(node_id, device_label(&self.graph, &uuid));
        // Live telemetry: the instrument's output peaks (TS `PeakBroadcaster(adapter.address)`) plus a monotonic
        // note-activity counter at `.append(1)` (a WASM-only extra; TS broadcasts a 128-bit `Bits` set instead).
        let meter_slot = instrument.borrow().meter_slot();
        self.broadcasts.register(uuid, &[], crate::broadcast::PACKAGE_FLOAT_ARRAY, &meter_slot, 4);
        let activity_slot = instrument.borrow().activity_slot();
        self.broadcasts.register(uuid, &[1], crate::broadcast::PACKAGE_FLOAT, &activity_slot, 1);
        let enabled_sub = self.subscribe_enabled(uuid, rewire);
        Member {uuid, proc: ProcHandle::Instrument(instrument), node_id: Some(node_id), output: Some(output), params, sidechain: None, enabled_sub}
    }

    /// Reuse the pooled midi-fx (a survivor) or build + bind a fresh one (a joiner). A midi-fx has no audio
    /// node; it is folded into the instrument's pull chain.
    fn take_or_build_midi(&mut self, pool: &mut BTreeMap<Uuid, Member>, uuid: Uuid, device: DeviceReg,
                          invalidate: &Rc<dyn Fn()>, rewire: &Rc<dyn Fn()>) -> Member {
        if let Some(existing) = pool.remove(&uuid) {
            if matches!(existing.proc, ProcHandle::Midi(_)) {
                return existing;
            }
            self.terminate_member(existing);
        }
        let effect = Rc::new(PluginMidiEffect::new(device));
        let params = self.bind_device(uuid, device, effect.state_ptr(), ParamNode::Midi(effect.clone()), invalidate);
        refresh_params(&params.handles, params.reg, params.state_ptr, self.transport.position()); // joiner only
        // Live telemetry: a monotonic note-activity counter (a WASM-only extra; TS broadcasts a `Bits` set).
        let activity_slot = effect.activity_slot();
        self.broadcasts.register(uuid, &[], crate::broadcast::PACKAGE_FLOAT, &activity_slot, 1);
        let enabled_sub = self.subscribe_enabled(uuid, rewire);
        Member {uuid, proc: ProcHandle::Midi(effect), node_id: None, output: None, params, sidechain: None, enabled_sub}
    }

    /// Reuse the pooled audio-fx (a survivor: its delay tail / filter history live on) or build + bind a fresh
    /// one (a joiner), creating its sidechain ports + their targeted pointer monitors. The resolve pass wires
    /// the sidechain edges.
    fn take_or_build_audio(&mut self, pool: &mut BTreeMap<Uuid, Member>, uuid: Uuid, device: DeviceReg,
                           signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>, rewire: &Rc<dyn Fn()>) -> Member {
        if let Some(existing) = pool.remove(&uuid) {
            if matches!(existing.proc, ProcHandle::Audio(_)) {
                return existing;
            }
            self.terminate_member(existing);
        }
        let node = Rc::new(RefCell::new(PluginAudioEffect::new(self.sample_rate, device)));
        let state_ptr = node.borrow().state_ptr();
        let sink: Rc<RefCell<dyn ParamSink>> = node.clone();
        let params = self.bind_device(uuid, device, state_ptr, ParamNode::Audio(sink), invalidate);
        refresh_params(&params.handles, params.reg, params.state_ptr, self.transport.position()); // joiner only
        let output = node.borrow().audio_output();
        let node_id = self.context.register_processor(node.clone());
        self.context.set_label(node_id, device_label(&self.graph, &uuid));
        // Live telemetry: the effect's output peaks (TS `PeakBroadcaster(adapter.address)`).
        let meter_slot = node.borrow().meter_slot();
        self.broadcasts.register(uuid, &[], crate::broadcast::PACKAGE_FLOAT_ARRAY, &meter_slot, 4);
        let sidechain = if params.sidechain_paths.is_empty() {
            None
        } else {
            let mut ports = Vec::new();
            for (index, path) in params.sidechain_paths.iter().cloned().enumerate() {
                let port_signal = signal.clone();
                let pointer_sub = self.graph.subscribe_vertex(Propagation::This, Address::of(uuid, path.clone()),
                    Box::new(move |_graph, _update| port_signal()));
                ports.push(SidechainPort {port_id: index as u32 + 2, path, resolved: None, pointer_sub});
            }
            Some(SidechainBinding {effect: node.clone(), node_id, device_uuid: uuid, ports})
        };
        let enabled_sub = self.subscribe_enabled(uuid, rewire);
        Member {uuid, proc: ProcHandle::Audio(node), node_id: Some(node_id), output: Some(output), params, sidechain, enabled_sub}
    }

    /// Wire a cluster's persistent members edge-only (shared by a leaf unit and a composite slot): fold the
    /// midi-fx PULL chain onto the note source (choke-routed for a slot), GATE + set the instrument's pull chain,
    /// then chain the audio fx (instrument -> fx0 -> fx1 -> ...). Every step SKIPS a disabled device (bypassed,
    /// its processor + state untouched). Returns the chain's output buffer, last node, and internal edges; the
    /// caller appends its own tail (a unit's strip -> master, a slot's sum).
    fn wire_cluster(&mut self, instrument: &Member, instrument_uuid: Uuid, sequencer: &SharedNoteEventSource,
                    midi: &[Member], audio: &[Member], choke: &[i32]) -> (SharedAudioBuffer, NodeId, Vec<(NodeId, NodeId)>) {
        let mut pull = if choke.is_empty() {
            PullLink::Source(sequencer.clone())
        } else {
            PullLink::SlotRoute {upstream: sequencer.clone(), choke: Rc::from(choke.to_vec())}
        };
        for member in midi {
            if !self.device_enabled(member.uuid) {
                continue; // a disabled midi-fx is bypassed (left out of the pull chain); its state is untouched
            }
            if let ProcHandle::Midi(effect) = &member.proc {
                pull = PullLink::MidiFx {effect: effect.clone(), upstream: Rc::new(pull)};
            }
        }
        if let ProcHandle::Instrument(processor) = &instrument.proc {
            processor.borrow_mut().set_enabled(self.device_enabled(instrument_uuid));
            processor.borrow_mut().set_pull_chain(pull);
        }
        let mut edges: Vec<(NodeId, NodeId)> = Vec::new();
        let mut output = instrument.output.clone().unwrap();
        let mut output_node = instrument.node_id.unwrap();
        for member in audio {
            if !self.device_enabled(member.uuid) {
                continue; // a disabled audio-fx is BYPASSED: not wired into the signal path; processor untouched
            }
            if let ProcHandle::Audio(node) = &member.proc {
                node.borrow_mut().set_audio_source(output.clone());
            }
            let node_id = member.node_id.unwrap();
            self.context.register_edge(output_node, node_id);
            edges.push((output_node, node_id));
            output = member.output.clone().unwrap();
            output_node = node_id;
        }
        (output, output_node, edges)
    }

    /// Reconcile a composite SLOT's cluster EDGE-ONLY (build when `prev` is `None`): pool the previous members,
    /// rebuild from the current midi/audio uuid lists (reusing survivors, building joiners, terminating leavers),
    /// reuse the note source while the instrument survives, then re-wire (skipping disabled devices). Mirrors
    /// `reconcile_leaf` minus the channel-strip tail (the caller appends the slot's sum edge). `rewire` is the
    /// slot's own re-wire signal (a member `enabled` toggle re-runs THIS, not the unit chain).
    #[allow(clippy::too_many_arguments)] // the reconcile cascade threads its signal/invalidate/rewire context
    pub(crate) fn reconcile_slot_cluster(&mut self, prev: Option<SlotCluster>, instrument_uuid: Uuid, device: DeviceReg,
                                         midi_uuids: &[Uuid], audio_uuids: &[Uuid], track_sets: &SharedTrackSets,
                                         choke: &[i32], signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>, rewire: &Rc<dyn Fn()>) -> SlotCluster {
        let mut pool: BTreeMap<Uuid, Member> = BTreeMap::new();
        let mut sequencer_keep: Option<(Uuid, SharedNoteEventSource)> = None;
        if let Some(prev) = prev {
            for (source, target) in &prev.internal_edges {
                self.context.remove_edge(*source, *target);
            }
            sequencer_keep = Some((prev.instrument.uuid, prev.sequencer));
            pool.insert(prev.instrument.uuid, prev.instrument);
            for member in prev.midi { pool.insert(member.uuid, member); }
            for member in prev.audio { pool.insert(member.uuid, member); }
        }
        let instrument = self.take_or_build_instrument(&mut pool, instrument_uuid, device, invalidate, rewire);
        let mut midi_members: Vec<Member> = Vec::new();
        for uuid in midi_uuids.iter().copied() {
            if let Some(device) = self.graph.find_box(&uuid).and_then(|device_box| self.device_for_type(&device_box.name)) {
                if device.kind == DEVICE_KIND_MIDI_EFFECT {
                    midi_members.push(self.take_or_build_midi(&mut pool, uuid, device, invalidate, rewire));
                }
            }
        }
        let mut audio_members: Vec<Member> = Vec::new();
        for uuid in audio_uuids.iter().copied() {
            if let Some(device) = self.graph.find_box(&uuid).and_then(|device_box| self.device_for_type(&device_box.name)) {
                if device.kind == DEVICE_KIND_AUDIO_EFFECT {
                    audio_members.push(self.take_or_build_audio(&mut pool, uuid, device, signal, invalidate, rewire));
                }
            }
        }
        for (_, member) in core::mem::take(&mut pool) {
            self.terminate_member(member);
        }
        let sequencer: SharedNoteEventSource = match sequencer_keep {
            Some((uuid, kept)) if uuid == instrument_uuid => kept,
            _ => Rc::new(RefCell::new(NoteSequencer::new(Box::new(BoundNoteRegions {tracks: track_sets.clone()}), self.clip_sequencer.clone())))
        };
        let (output, output_node, internal_edges) = self.wire_cluster(&instrument, instrument_uuid, &sequencer, &midi_members, &audio_members, choke);
        SlotCluster {instrument, sequencer, midi: midi_members, audio: audio_members, internal_edges, output, output_node}
    }

    /// Tear a slot cluster down: remove its internal edges, terminate every member (its node + params + sidechain
    /// monitors + `enabled` monitor). The caller has already removed the slot's sum edge + source.
    pub(crate) fn teardown_slot_cluster(&mut self, cluster: SlotCluster) {
        for (source, target) in &cluster.internal_edges {
            self.context.remove_edge(*source, *target);
        }
        self.terminate_member(cluster.instrument);
        for member in cluster.midi { self.terminate_member(member); }
        for member in cluster.audio { self.terminate_member(member); }
    }

    /// Build one processor cluster: an instrument plus its midi-fx pull chain (folded onto `source` in index
    /// order, so the instrument pulls the highest-index fx down to the source) and its audio-fx chain
    /// (instrument -> fx0 -> fx1 -> ...), wired into the global graph. Returns the chain's final output buffer
    /// and last node so the caller appends its own tail (a unit appends the channel strip then master, a
    /// composite child appends the per-child sum), plus the node / edge / param bookkeeping. The only
    /// per-device knowledge is the box-type -> plugin table, so any cluster host reuses this verbatim.
    #[allow(clippy::too_many_arguments)] // a cluster builder takes one input per facet (instrument + midi + audio + signals)
    pub(crate) fn build_cluster(&mut self, source: PullLink, instrument_uuid: Uuid, instrument_device: DeviceReg,
                     midi: &[Uuid], audio: &[Uuid], signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>) -> BuiltCluster {
        let mut device_params: Vec<DeviceParams> = Vec::new();
        // Each midi-fx binds its parameters too, so a midi-fx parameter is automatable like an audio device's.
        let mut chain = source;
        for device_uuid in midi.iter().copied() {
            let device = self.graph.find_box(&device_uuid).and_then(|device_box| self.device_for_type(&device_box.name));
            match device {
                Some(device) if device.kind == DEVICE_KIND_MIDI_EFFECT && self.device_enabled(device_uuid) => {
                    let effect = Rc::new(PluginMidiEffect::new(device));
                    device_params.push(self.bind_device(device_uuid, device, effect.state_ptr(), ParamNode::Midi(effect.clone()), invalidate));
                    chain = PullLink::MidiFx {effect, upstream: Rc::new(chain)};
                }
                _ => {}
            }
        }
        let instrument = Rc::new(RefCell::new(PluginInstrument::new(self.sample_rate, instrument_device)));
        let instrument_state = instrument.borrow().state_ptr();
        let instrument_sink: Rc<RefCell<dyn ParamSink>> = instrument.clone();
        device_params.push(self.bind_device(instrument_uuid, instrument_device, instrument_state, ParamNode::Audio(instrument_sink), invalidate));
        instrument.borrow_mut().set_pull_chain(chain);
        let mut output = instrument.borrow().audio_output();
        let instrument_id = self.context.register_processor(instrument);
        self.context.set_label(instrument_id, device_label(&self.graph, &instrument_uuid));
        let mut nodes = vec![instrument_id];
        let mut edges: Vec<(NodeId, NodeId)> = Vec::new();
        let mut sidechains: Vec<SidechainBinding> = Vec::new();
        let mut output_node = instrument_id;
        // The audio-fx chain in index order: instrument -> fx0 -> fx1 -> ... Each reads the previous output.
        for device_uuid in audio.iter().copied() {
            let resolved = self.graph.find_box(&device_uuid).and_then(|device_box| self.device_for_type(&device_box.name));
            let device = match resolved {
                Some(device) if device.kind == DEVICE_KIND_AUDIO_EFFECT => device,
                _ => continue
            };
            if !self.device_enabled(device_uuid) {
                continue; // a disabled effect is bypassed: not built, not wired into the chain
            }
            let node = Rc::new(RefCell::new(PluginAudioEffect::new(self.sample_rate, device)));
            let node_state = node.borrow().state_ptr();
            let node_sink: Rc<RefCell<dyn ParamSink>> = node.clone();
            let params = self.bind_device(device_uuid, device, node_state, ParamNode::Audio(node_sink), invalidate);
            let sidechain_paths = params.sidechain_paths.clone();
            device_params.push(params);
            node.borrow_mut().set_audio_source(output);
            output = node.borrow().audio_output();
            let node_id = self.context.register_processor(node.clone());
            self.context.set_label(node_id, device_label(&self.graph, &device_uuid));
            // Keep this effect's declared sidechain ports as a persistent binding (resolved by the post-build
            // pass, re-resolved on later edits). Each port gets a TARGETED `This` monitor on its pointer
            // field, so a re-point / detach enqueues the unit. Port ids start at 2 (after MAIN_INPUT).
            if !sidechain_paths.is_empty() {
                let mut ports = Vec::new();
                for (index, path) in sidechain_paths.into_iter().enumerate() {
                    let port_signal = signal.clone();
                    let pointer_sub = self.graph.subscribe_vertex(Propagation::This, Address::of(device_uuid, path.clone()),
                        Box::new(move |_graph, _update| port_signal()));
                    ports.push(SidechainPort {port_id: index as u32 + 2, path, resolved: None, pointer_sub});
                }
                sidechains.push(SidechainBinding {effect: node, node_id, device_uuid, ports});
            }
            self.context.register_edge(output_node, node_id);
            edges.push((output_node, node_id));
            nodes.push(node_id);
            output_node = node_id;
        }
        BuiltCluster {output, output_node, nodes, edges, device_params, sidechains}
    }

    /// Bind one device's parameters: call its `init` (which records its parameter field-paths via
    /// `host_bind_parameter`), observe each path's field value + automation track, hand the node its
    /// parameter set, and return the bookkeeping for teardown / re-bind.
    fn bind_device(&mut self, device_uuid: Uuid, reg: DeviceReg, state_ptr: u32, sink: ParamNode, invalidate: &Rc<dyn Fn()>) -> DeviceParams {
        // Make the device's own box uuid available to `host_self_uuid` for the duration of its `init` (a script
        // device reads it there to key its JS-side bridge); the engine knows it, the device does not.
        unsafe { *CURRENT_DEVICE_UUID.get() = device_uuid; }
        let paths = bind_paths(reg, state_ptr, self.sample_rate);
        let sample_paths = core::mem::take(unsafe { SAMPLE_OBS.get() }); // recorded by host_observe_sample during init
        let soundfont_paths = core::mem::take(unsafe { SOUNDFONT_OBS.get() }); // recorded by host_observe_soundfont during init
        let field_paths = core::mem::take(unsafe { FIELD_OBS.get() }); // recorded by host_observe_field during init
        let sidechain_paths = core::mem::take(unsafe { SIDECHAIN_BIND.get() }); // recorded by host_bind_sidechain during init
        let (mut handles, mut field_subs, mut collections, mut armed) = self.observe_params(device_uuid, &paths, invalidate);
        // The device's plain-field, sample and soundfont observations all unsubscribe the same way, so one list.
        let mut observe_subs = self.observe_fields(device_uuid, reg, state_ptr, &field_paths);
        observe_subs.extend(self.observe_samples(device_uuid, reg, state_ptr, &sample_paths));
        observe_subs.extend(self.observe_soundfonts(device_uuid, reg, state_ptr, &soundfont_paths));
        // SCRIPTABLE devices: also bind the dynamic parameter / sample COLLECTION children, and watch each hub's
        // membership so a child add / remove re-binds (through the same automation-invalidate path).
        let mut param_hub_sub = None;
        if reg.param_collection_field != 0 {
            let (mut script_handles, mut script_subs, mut script_collections, script_armed) =
                self.observe_script_params(device_uuid, reg.param_collection_field, invalidate);
            handles.append(&mut script_handles);
            field_subs.append(&mut script_subs);
            collections.append(&mut script_collections);
            armed |= script_armed;
            let hub_invalidate = invalidate.clone();
            param_hub_sub = Some(self.graph.subscribe_pointer_hub(Address::of(device_uuid, vec![reg.param_collection_field]),
                Box::new(move |_graph, _event| hub_invalidate())));
        }
        let mut sample_hub_sub = None;
        if reg.sample_collection_field != 0 {
            observe_subs.extend(self.observe_script_samples(device_uuid, reg, state_ptr, reg.sample_collection_field));
            let hub_invalidate = invalidate.clone();
            sample_hub_sub = Some(self.graph.subscribe_pointer_hub(Address::of(device_uuid, vec![reg.sample_collection_field]),
                Box::new(move |_graph, _event| hub_invalidate())));
        }
        sink.set_params(handles.clone(), armed);
        DeviceParams {device_uuid, reg, state_ptr, sink, paths, handles, field_subs, collections, observe_subs, sidechain_paths, param_hub_sub, sample_hub_sub}
    }

    /// Wire each field a device asked to observe. A PLAIN observation (`observe_field`, `target_key == 0`):
    /// `catchup_and_subscribe` the field on the device's box and deliver its value through the device's
    /// `field_changed` export, by the id (the observation's index) the device got back. A TARGET-STRING
    /// observation (`observe_target_string`): catch up to the POINTER's current target and subscribe to the
    /// pointer field, delivering the target box's string field `target_key` (empty = unbound) — the
    /// `observe_soundfonts` shape with the payload read straight from the graph. Both run on catch-up and on
    /// edits, only inside a transaction, never during render, so calling the device is safe. Returns the
    /// subscriptions for teardown.
    fn observe_fields(&mut self, device_uuid: Uuid, reg: DeviceReg, state_ptr: u32, paths: &[FieldObs]) -> Vec<SubscriptionId> {
        let mut subs = Vec::new();
        for (index, obs) in paths.iter().enumerate() {
            let id = index as u32;
            let field_changed_index = reg.field_changed_index;
            if obs.target_key == 0 {
                let sub = self.graph.catchup_and_subscribe(Address::of(device_uuid, obs.path.clone()), move |value| {
                    // Encode the field's typed value onto the wire `(kind, bits, len)`: numeric bits, or a string's
                    // pointer + length into the shared memory (valid for the synchronous call).
                    if let Some(value) = value.as_int32() {
                        call_device_field_changed(field_changed_index, state_ptr, id, FIELD_KIND_INT, value as u32, 0);
                    } else if let Some(value) = value.as_float32() {
                        call_device_field_changed(field_changed_index, state_ptr, id, FIELD_KIND_FLOAT, value.to_bits(), 0);
                    } else if let Some(value) = value.as_bool() {
                        call_device_field_changed(field_changed_index, state_ptr, id, FIELD_KIND_BOOL, value as u32, 0);
                    } else if let Some(value) = value.as_str() {
                        call_device_field_changed(field_changed_index, state_ptr, id, FIELD_KIND_STRING, value.as_ptr() as u32, value.len() as u32);
                    }
                });
                subs.push(sub);
            } else {
                let target_key = obs.target_key;
                resolve_and_deliver_target_string(&self.graph, device_uuid, &obs.path, target_key, field_changed_index, state_ptr, id);
                let owned_path = obs.path.clone();
                let sub = self.graph.subscribe_vertex(Propagation::This, Address::of(device_uuid, obs.path.clone()),
                    Box::new(move |graph, _update| {
                        resolve_and_deliver_target_string(graph, device_uuid, &owned_path, target_key, field_changed_index, state_ptr, id);
                    }));
                subs.push(sub);
            }
        }
        subs
    }

    /// Wire each sample a device asked to observe (`observe_sample`): catch up to the `file` pointer's current
    /// target and subscribe to that pointer field, so a set / repoint / clear (inside a transaction, never
    /// during render) re-resolves and re-delivers through the device's `sample_changed` export. Returns the
    /// subscriptions for teardown.
    fn observe_samples(&mut self, device_uuid: Uuid, reg: DeviceReg, state_ptr: u32, paths: &[Vec<u16>]) -> Vec<SubscriptionId> {
        let mut subs = Vec::new();
        for (index, path) in paths.iter().enumerate() {
            let id = index as u32;
            let sample_changed_index = reg.sample_changed_index;
            resolve_and_deliver_sample(&self.graph, device_uuid, path, sample_changed_index, state_ptr, id);
            let owned_path = path.clone();
            let sub = self.graph.subscribe_vertex(Propagation::This, Address::of(device_uuid, path.clone()),
                Box::new(move |graph, _update| {
                    resolve_and_deliver_sample(graph, device_uuid, &owned_path, sample_changed_index, state_ptr, id);
                }));
            subs.push(sub);
        }
        subs
    }

    /// Wire each soundfont a device asked to observe (`observe_soundfont`): catch up to the `file` pointer's
    /// current target and subscribe to that pointer field, so a set / repoint / clear (inside a transaction,
    /// never during render) re-resolves and re-delivers through the device's `soundfont_changed` export.
    /// Mirrors `observe_samples`.
    fn observe_soundfonts(&mut self, device_uuid: Uuid, reg: DeviceReg, state_ptr: u32, paths: &[Vec<u16>]) -> Vec<SubscriptionId> {
        let mut subs = Vec::new();
        for (index, path) in paths.iter().enumerate() {
            let id = index as u32;
            let soundfont_changed_index = reg.soundfont_changed_index;
            resolve_and_deliver_soundfont(&self.graph, device_uuid, path, soundfont_changed_index, state_ptr, id);
            let owned_path = path.clone();
            let sub = self.graph.subscribe_vertex(Propagation::This, Address::of(device_uuid, path.clone()),
                Box::new(move |graph, _update| {
                    resolve_and_deliver_soundfont(graph, device_uuid, &owned_path, soundfont_changed_index, state_ptr, id);
                }));
            subs.push(sub);
        }
        subs
    }

    /// Observe each parameter field's value (a reactive `Rc<Cell>`) and its automation track, returning the
    /// per-parameter handles, the field subscriptions + curve collections (for teardown), and whether ANY
    /// parameter is automated (so the node arms the clock). The id is the parameter's index, matching the
    /// id `host_bind_parameter` returned the device.
    fn observe_params(&mut self, device_uuid: Uuid, paths: &[FieldPath], invalidate: &Rc<dyn Fn()>) -> (Vec<ParamHandle>, Vec<SubscriptionId>, Vec<ValueCollection>, bool) {
        let mut handles = Vec::new();
        let mut subs = Vec::new();
        let mut collections = Vec::new();
        let mut armed = false;
        for (index, path) in paths.iter().enumerate() {
            let (handle, mut param_subs, mut param_collections, param_armed) =
                self.observe_param(device_uuid, path, index as u32, invalidate);
            handles.push(handle);
            subs.append(&mut param_subs);
            collections.append(&mut param_collections);
            armed |= param_armed;
        }
        (handles, subs, collections, armed)
    }

    /// Observe ONE parameter field's value (a reactive cell) + its automation track, returning the handle, its
    /// subscriptions, the curve collections, and whether it is automated. Shared by [`observe_params`] (a device's
    /// fixed field paths) and [`observe_script_params`] (a scriptable device's dynamic `WerkstattParameterBox`
    /// children). `id` is what the device receives in `parameter_changed`. The automation track is found by
    /// `build_param_track(graph, box_uuid, path)`, which scans for a Value track targeting `(box_uuid, path)` —
    /// so for a script param the same machinery binds the CHILD box's `value` field (key 4) unchanged.
    pub(crate) fn observe_param(&mut self, box_uuid: Uuid, path: &[u16], id: u32, invalidate: &Rc<dyn Fn()>) -> (ParamHandle, Vec<SubscriptionId>, Vec<ValueCollection>, bool) {
        let mut subs = Vec::new();
        let mut collections = Vec::new();
        let mut armed = false;
        let address = Address::of(box_uuid, path.to_vec());
        // A parameter field carries its real primitive type — Float32 (a cutoff), Int32 (semitones), or Boolean
        // (a toggle), fixed by the schema. Read it once so the wire tags the un-automated value with its kind;
        // the device then receives a typed `ParamValue`. (A script param's `value` is Float32 -> the static value
        // arrives as `PARAM_KIND_FLOAT` for the bridge to use directly; an automated one arrives as `_UNIT`.)
        let kind = self.graph.field_value(&address).map_or(PARAM_KIND_FLOAT, |value| {
            if value.as_int32().is_some() { PARAM_KIND_INT }
            else if value.as_bool().is_some() { PARAM_KIND_BOOL }
            else { PARAM_KIND_FLOAT }
        });
        let field = Rc::new(core::cell::Cell::new(0.0f32));
        let cell = field.clone();
        // A VALUE change is a light edit (push only); everything structural below keeps the heavy signal.
        let field_invalidate = current_params_signal().unwrap_or_else(|| invalidate.clone());
        subs.push(self.graph.catchup_and_subscribe(address.clone(), move |value| {
            let real = value.as_float32()
                .or_else(|| value.as_int32().map(|value| value as f32))
                .or_else(|| value.as_bool().map(|value| if value {1.0} else {0.0}));
            if let Some(real) = real {
                cell.set(real);
                field_invalidate();
            }
        }));
        let attach_invalidate = invalidate.clone();
        subs.push(self.graph.subscribe_pointer_hub(address, Box::new(move |_graph, _event| attach_invalidate())));
        let (track, track_uuid, mut track_collections) = build_param_track(&mut self.graph, box_uuid, path);
        if track.is_some() {
            armed = true;
        }
        if let Some(track_uuid) = track_uuid {
            let region_invalidate = invalidate.clone();
            subs.push(self.graph.subscribe_pointer_hub(Address::of(track_uuid, vec![TRACK_REGIONS_KEY]),
                Box::new(move |_graph, _event| region_invalidate())));
            let enabled_invalidate = invalidate.clone();
            subs.push(self.graph.subscribe_vertex(Propagation::This, Address::of(track_uuid, vec![TRACK_ENABLED_KEY]),
                Box::new(move |_graph, _update| enabled_invalidate())));
        }
        collections.append(&mut track_collections);
        let handle = ParamHandle {id, field, kind, track, last: Rc::new(core::cell::Cell::new(f32::NAN))};
        (handle, subs, collections, armed)
    }


    /// Push the initial parameter values of freshly built devices (JOINERS) to them. Survivors are NEVER passed
    /// here — a chain edit (reorder / add / remove) must leave every existing plugin's parameters untouched.
    pub(crate) fn refresh_joiner_params(&self, device_params: &[DeviceParams]) {
        let position = self.transport.position();
        for params in device_params {
            refresh_params(&params.handles, params.reg, params.state_ptr, position);
        }
    }

    /// Unsubscribe each device's field observers and terminate its curve collections (a rewire / teardown).
    pub(crate) fn teardown_device_params(&mut self, device_params: Vec<DeviceParams>) {
        for params in device_params {
            for sub in params.field_subs {
                self.graph.unsubscribe(sub);
            }
            for sub in params.observe_subs {
                self.graph.unsubscribe(sub);
            }
            for sub in params.param_hub_sub.into_iter().chain(params.sample_hub_sub) {
                self.graph.unsubscribe(sub);
            }
            for collection in params.collections {
                collection.terminate(&mut self.graph);
            }
        }
    }

    /// Re-bind a unit's device automation after a runtime attach / detach / field edit, WITHOUT rewiring the
    /// audio graph: for each device re-observe its parameters (the field-paths it declared are kept), re-set
    /// them on the node (re-arming or disarming the clock), and push the resolved values. Mirrors TS
    /// `bindParameter` reacting to a parameter's automation pointer hub.
    /// Push the units' devices their CURRENT resolved parameter values (only the changed ones — `last` is
    /// compared per handle). The whole handling of a plain field edit: no subscriptions move.
    fn refresh_unit_params(&mut self, unit: &mut AudioUnitBinding) {
        let position = self.transport.position();
        let mut wired = match unit.wired.take() {
            Some(wired) => wired,
            None => return
        };
        match &mut wired {
            Wired::Leaf(chain) => {
                refresh_params(&chain.instrument.params.handles, chain.instrument.params.reg, chain.instrument.params.state_ptr, position);
                for member in &chain.midi {
                    refresh_params(&member.params.handles, member.params.reg, member.params.state_ptr, position);
                }
                for member in &chain.audio {
                    refresh_params(&member.params.handles, member.params.reg, member.params.state_ptr, position);
                }
            }
            Wired::Composite(composite) => {
                composite.binding.for_each_params(&mut |params| refresh_params(&params.handles, params.reg, params.state_ptr, position));
            }
            Wired::Tape(tape) => {
                for member in &tape.audio {
                    refresh_params(&member.params.handles, member.params.reg, member.params.state_ptr, position);
                }
            }
            Wired::Bus(bus) => {
                for params in &bus.device_params {
                    refresh_params(&params.handles, params.reg, params.state_ptr, position);
                }
            }
        }
        unit.wired = Some(wired);
    }

    fn rebind_automation(&mut self, unit: &mut AudioUnitBinding) {
        let invalidate = automation_invalidate(unit);
        let position = self.transport.position();
        let mut wired = match unit.wired.take() {
            Some(wired) => wired,
            None => return
        };
        match &mut wired {
            Wired::Leaf(chain) => {
                self.rebind_one(&mut chain.instrument.params, &invalidate, position);
                for member in &mut chain.midi {
                    self.rebind_one(&mut member.params, &invalidate, position);
                }
                for member in &mut chain.audio {
                    self.rebind_one(&mut member.params, &invalidate, position);
                }
            }
            Wired::Composite(composite) => {
                composite.binding.for_each_params(&mut |params| self.rebind_one(params, &invalidate, position));
            }
            Wired::Tape(tape) => {
                for member in &mut tape.audio {
                    self.rebind_one(&mut member.params, &invalidate, position);
                }
            }
            Wired::Bus(_) => {} // a bus's fx params are bound at (wholesale) build; live automation re-bind deferred
        }
        unit.wired = Some(wired);
    }

    /// Re-observe ONE device's automation in place: drop the old field subscriptions + curve collections,
    /// re-observe the (unchanged) parameter field-paths, re-set the params on the node (re-arm / disarm the
    /// clock), and push the resolved values. Touches neither the audio graph nor the plain-field / sidechain
    /// observations.
    fn rebind_one(&mut self, params: &mut DeviceParams, invalidate: &Rc<dyn Fn()>, position: f64) {
        // Preserve each parameter's last-pushed value across the re-observe (the paths are unchanged, so the new
        // handles line up by index). Fresh handles start at `last = NaN`, which would re-push EVERY parameter;
        // carrying `last` over means `refresh_params` only pushes the ones whose value actually changed — so a
        // parameter (or whole plugin) unaffected by this automation edit is never re-pushed (and never glides).
        let previous_last: Vec<f32> = params.handles.iter().map(|handle| handle.last.get()).collect();
        for sub in core::mem::take(&mut params.field_subs) {
            self.graph.unsubscribe(sub);
        }
        for collection in core::mem::take(&mut params.collections) {
            collection.terminate(&mut self.graph);
        }
        let (mut handles, mut field_subs, mut collections, mut armed) = self.observe_params(params.device_uuid, &params.paths, invalidate);
        // Re-enumerate a scriptable device's dynamic params too (an add / remove / automation edit re-binds them).
        if params.reg.param_collection_field != 0 {
            let (mut script_handles, mut script_subs, mut script_collections, script_armed) =
                self.observe_script_params(params.device_uuid, params.reg.param_collection_field, invalidate);
            handles.append(&mut script_handles);
            field_subs.append(&mut script_subs);
            collections.append(&mut script_collections);
            armed |= script_armed;
        }
        for (handle, last) in handles.iter().zip(previous_last) {
            handle.last.set(last);
        }
        params.sink.set_params(handles.clone(), armed);
        refresh_params(&handles, params.reg, params.state_ptr, position);
        params.handles = handles;
        params.field_subs = field_subs;
        params.collections = collections;
    }
}

/// Call a device's `init(state_ptr, sample_rate)` to collect the parameter field-paths it declares (it binds
/// them via `host_bind_parameter`, which records into `BIND`) and let it stash the sample rate. Touches no
/// graph, so it is a free fn.
fn bind_paths(reg: DeviceReg, state_ptr: u32, sample_rate: f32) -> Vec<FieldPath> {
    unsafe { BIND.get() }.clear();
    unsafe { SAMPLE_OBS.get() }.clear();
    unsafe { SOUNDFONT_OBS.get() }.clear();
    unsafe { FIELD_OBS.get() }.clear();
    unsafe { SIDECHAIN_BIND.get() }.clear();
    call_device_init(reg.init_index, state_ptr, sample_rate);
    core::mem::take(unsafe { BIND.get() })
}

/// Push each parameter's resolved value (its automation at `position`, else its real field value) to the
/// device via its `parameter_changed` export, but only when it CHANGED since the last push (the TS
/// `updateAutomation` compare). The `kind` tag tells the device how to read the value (uniform automation to
/// map, or a real Int / Float / Bool field value). Called at build (every param, `last` is NaN) and on a
/// runtime edit / field change. Never during render.
fn refresh_params(handles: &[ParamHandle], reg: DeviceReg, state_ptr: u32, position: f64) {
    for handle in handles {
        let (value, kind) = handle.resolve(position);
        if value != handle.last.get() {
            handle.last.set(value);
            call_device_parameter_changed(reg.parameter_changed_index, state_ptr, handle.id, kind, value);
        }
    }
}

/// Resolve a device's observed sample pointer to a handle and deliver it via `sample_changed`: a resident
/// handle when the `file` pointer targets an `AudioFileBox` (the frames are requested through `SAMPLES`), or
/// "unbound" (`present = 0`) when the pointer has no target (cleared). Touches `SAMPLES` (its own cell) and the
/// device, never `&mut Engine`, so it is safe from a transaction observer.
pub(crate) fn resolve_and_deliver_sample(graph: &BoxGraph, device_uuid: Uuid, path: &[u16], sample_changed_index: u32, state_ptr: u32, id: u32) {
    match graph.target_of(&Address::of(device_uuid, path.to_vec())) {
        Some(target) => {
            let handle = unsafe { SAMPLES.get() }.request(target.uuid);
            call_device_sample_changed(sample_changed_index, state_ptr, id, handle, 1);
        }
        None => call_device_sample_changed(sample_changed_index, state_ptr, id, 0, 0)
    }
}

/// Resolve a device's observed soundfont pointer to a handle and deliver it via `soundfont_changed`: a resident
/// handle when the `file` pointer targets a `SoundfontFileBox` (the blob is requested through `SOUNDFONTS`), or
/// "unbound" (`present = 0`) when the pointer has no target. Touches `SOUNDFONTS` (its own cell) and the device,
/// never `&mut Engine`. Mirrors `resolve_and_deliver_sample`.
pub(crate) fn resolve_and_deliver_soundfont(graph: &BoxGraph, device_uuid: Uuid, path: &[u16], soundfont_changed_index: u32, state_ptr: u32, id: u32) {
    match graph.target_of(&Address::of(device_uuid, path.to_vec())) {
        Some(target) => {
            let handle = unsafe { SOUNDFONTS.get() }.request(target.uuid);
            call_device_soundfont_changed(soundfont_changed_index, state_ptr, id, handle, 1);
        }
        None => call_device_soundfont_changed(soundfont_changed_index, state_ptr, id, 0, 0)
    }
}

/// Resolve a device's observed POINTER to its target box and deliver the target's STRING field `target_key`
/// through the device's `field_changed` (`FIELD_KIND_STRING`), or an EMPTY string when the pointer is unbound
/// or the target lacks that string field. The delivered ptr/len reference the live box-graph string, valid for
/// the synchronous call (the device copies or forwards it before returning). Mirrors
/// `resolve_and_deliver_soundfont`, but needs no resource handshake: the payload already lives in the graph.
pub(crate) fn resolve_and_deliver_target_string(graph: &BoxGraph, device_uuid: Uuid, path: &[u16], target_key: u16, field_changed_index: u32, state_ptr: u32, id: u32) {
    let text = graph.target_of(&Address::of(device_uuid, path.to_vec()))
        .and_then(|target| graph.field_value(&Address::of(target.uuid, vec![target_key])))
        .and_then(|value| value.as_str())
        .unwrap_or("");
    call_device_field_changed(field_changed_index, state_ptr, id, FIELD_KIND_STRING, text.as_ptr() as u32, text.len() as u32);
}

/// The automation curve for a device parameter, if a Value track targets `(device_uuid, path)`: build a
/// `ParamCurve` over that track's value regions and return it with the collections to terminate. `None` (and
/// no collections) when the parameter has no automation track.
fn build_param_track(graph: &mut BoxGraph, device_uuid: Uuid, path: &[u16]) -> (Option<ParamCurve>, Option<Uuid>, Vec<ValueCollection>) {
    // Find the Value track whose `target` points at this parameter. NOTE: this scans every TrackBox — it can
    // NOT use `graph.incoming(param)`, because a parameter address is a device-internal field path that is not
    // always a RESOLVED graph vertex (deep param paths), so the track's target edge is "dangling" and absent
    // from `incoming`. The cost is O(TrackBoxes), smaller than the value-region scan below (now targeted).
    let track_uuid = {
        let mut found = None;
        for track in graph.find_all_by_name("TrackBox") {
            if let Some(target) = graph.target_of(&Address::of(track.uuid, vec![TRACK_TARGET_KEY])) {
                if target.uuid == device_uuid && target.field_keys.as_slice() == path {
                    found = Some(track.uuid);
                    break;
                }
            }
        }
        found
    };
    let track_uuid = match track_uuid {
        Some(uuid) => uuid,
        None => return (None, None, Vec::new())
    };
    // A DISABLED automation track applies no curve: the parameter falls back to its own field value (mirrors
    // TS `TrackBoxAdapter.valueAt` returning the fallback when `!enabled`). The track uuid is still returned so
    // `observe_params` keeps the `enabled` monitor armed and re-binds when it is toggled back on.
    if !track_enabled(graph, track_uuid) {
        return (None, Some(track_uuid), Vec::new());
    }
    let mut regions = RegionCollection::new();
    let mut collections = Vec::new();
    for spec in value_regions_of_track(graph, track_uuid) {
        let collection = ValueCollection::observe(graph, spec.collection);
        regions.add(ValueBoundRegion {
            position: spec.position, duration: spec.duration,
            loop_offset: spec.loop_offset, loop_duration: spec.loop_duration,
            curve: collection.curve()
        });
        collections.push(collection);
    }
    (Some(ParamCurve::new(regions)), Some(track_uuid), collections)
}

// ---- The track / region cascade beneath an audio unit. Free functions taking `&mut BoxGraph`: they only
// observe the box graph and edit the per-track region collections + the unit's note-event cache, never the
// processor graph, so they avoid borrowing the engine. Membership is recorded into `Members` + drained
// here; a region's span EDIT re-sorts its track collection live via the track's `edit_sub` observer. ----

/// Reconcile one unit's tracks against its `tracks` membership, then each track's regions. A new track's
/// region collection is registered into the unit's shared `track_sets` (so the sequencer sees it); a
/// removed track's collection is unregistered.
fn reconcile_tracks(graph: &mut BoxGraph, unit: &mut AudioUnitBinding, tempo_map: &SharedTempoMap,
                    clip_sequencer: &Rc<RefCell<ClipSequencer>>) {
    let mark = unit.mark.clone();
    let changes = core::mem::take(&mut *unit.track_changes.borrow_mut());
    for track_uuid in changes.removed {
        if let Some(index) = unit.tracks.iter().position(|track| track.track_uuid == track_uuid) {
            let track = unit.tracks.remove(index);
            teardown_track(graph, &unit.track_sets, &mut unit.collections, clip_sequencer, track);
        } else if let Some(index) = unit.audio_tracks.iter().position(|track| track.track_uuid == track_uuid) {
            let track = unit.audio_tracks.remove(index);
            teardown_audio_track(graph, &unit.audio_track_sets, track);
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
                sets.push(track.regions_set.clone());
            }
        }
    }
    {
        let mut sets = unit.audio_track_sets.borrow_mut();
        sets.clear();
        for track in &unit.audio_tracks {
            if track_enabled(graph, track.track_uuid) {
                sets.push(track.regions_set.clone());
            }
        }
    }
    for track in &mut unit.tracks {
        reconcile_regions(graph, &mut unit.collections, track);
        reconcile_clips(graph, &mut unit.collections, clip_sequencer, track);
    }
    for track in &mut unit.audio_tracks {
        reconcile_audio_regions(graph, track, tempo_map);
    }
}

/// Build a track binding: its own sorted region collection (`regions_set`), a subscription to the track's
/// `regions` membership (key 3), and an edit subscription that re-sorts the collection when a member
/// region's span (position / duration / loop fields) changes — so a moved region lands at the right place.
fn build_track(graph: &mut BoxGraph, track_uuid: Uuid, mark: &DirtyMark) -> TrackBinding {
    let regions_set: SharedTrackRegions = Rc::new(RefCell::new(NoteTrackContent {
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
    TrackBinding {track_uuid, regions_set, region_bindings: Vec::new(), region_changes, region_sub,
        clip_bindings: Vec::new(), clip_changes, clip_sub, enabled_sub}
}

/// Tear down a track: unsubscribe its membership + edit observers, unregister its region collection from the
/// unit's `track_sets`, and release each region's note-event cache reference.
fn teardown_track(graph: &mut BoxGraph, track_sets: &SharedTrackSets, collections: &mut CollectionCache,
                  clip_sequencer: &Rc<RefCell<ClipSequencer>>, track: TrackBinding) {
    graph.unsubscribe(track.region_sub);
    graph.unsubscribe(track.clip_sub);
    graph.unsubscribe(track.enabled_sub);
    clip_sequencer.borrow_mut().forget(&track.track_uuid);
    track_sets.borrow_mut().retain(|set| !Rc::ptr_eq(set, &track.regions_set));
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
fn reconcile_regions(graph: &mut BoxGraph, collections: &mut CollectionCache, track: &mut TrackBinding) {
    let changes = core::mem::take(&mut *track.region_changes.borrow_mut());
    for region_uuid in changes.removed {
        if let Some(index) = track.region_bindings.iter().position(|region| region.region_uuid == region_uuid) {
            let region = track.region_bindings.remove(index);
            track.regions_set.borrow_mut().regions.retain(|bound| bound.region_uuid != region_uuid);
            graph.unsubscribe(region.edit_sub);
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

/// Sync a track's launched-clip bindings to its `clips` membership (key 4): a leaver releases its
/// collection ref and leaves the clip sequencer; a joiner reads its content (mirrors `reconcile_regions`).
fn reconcile_clips(graph: &mut BoxGraph, collections: &mut CollectionCache,
                   clip_sequencer: &Rc<RefCell<ClipSequencer>>, track: &mut TrackBinding) {
    let changes = core::mem::take(&mut *track.clip_changes.borrow_mut());
    for clip_uuid in changes.removed {
        if let Some(index) = track.clip_bindings.iter().position(|clip| clip.clip_uuid == clip_uuid) {
            let clip = track.clip_bindings.remove(index);
            track.regions_set.borrow_mut().clips.retain(|bound| bound.clip_uuid != clip_uuid);
            graph.unsubscribe(clip.edit_sub);
            collections.release(graph, clip.collection_uuid);
            clip_sequencer.borrow_mut().forget(&clip_uuid);
        }
    }
    for clip_uuid in changes.added {
        if track.clip_bindings.iter().any(|clip| clip.clip_uuid == clip_uuid) {
            continue;
        }
        if let Some(binding) = build_clip(graph, &track.regions_set, collections, clip_uuid) {
            track.clip_bindings.push(binding);
        }
    }
}

/// Read a clip's duration (key 10) + `triggerMode.loop` (path [4, 1], default TRUE), ACQUIRE its note-event
/// collection (`events` pointer key 2), and register it in the track content. A targeted `Parent` sub keeps
/// duration / loop fresh on edit. `None` if the clip has no collection.
fn build_clip(graph: &mut BoxGraph, regions_set: &SharedTrackRegions, collections: &mut CollectionCache, clip_uuid: Uuid) -> Option<ClipBinding> {
    let collection_uuid = graph.target_of(&Address::of(clip_uuid, vec![2]))?.uuid;
    let collection = collections.acquire(graph, collection_uuid);
    let (duration, looped) = read_clip_playback(graph, clip_uuid);
    regions_set.borrow_mut().clips.push(BoundNoteClip {clip_uuid, duration, looped, collection});
    let edit_content = regions_set.clone();
    let edit_sub = graph.subscribe_vertex(Propagation::Parent, Address::box_of(clip_uuid), Box::new(move |graph, _update| {
        let (duration, looped) = read_clip_playback(graph, clip_uuid);
        for bound in edit_content.borrow_mut().clips.iter_mut() {
            if bound.clip_uuid == clip_uuid {
                bound.duration = duration;
                bound.looped = looped;
            }
        }
    }));
    Some(ClipBinding {clip_uuid, collection_uuid, edit_sub})
}

fn read_clip_playback(graph: &BoxGraph, clip_uuid: Uuid) -> (f64, bool) {
    let duration = region_pulses(graph, clip_uuid, 10);
    let looped = graph.field_value(&Address::of(clip_uuid, vec![4, 1])).and_then(|value| value.as_bool()).unwrap_or(true);
    (duration, looped)
}

/// Read a region's loopable span, ACQUIRE its note-event collection (`events` pointer key 2) from the cache
/// (observed once, shared by mirrored regions), and sorted-insert it into the track's region collection.
/// `None` if the region has no collection.
fn build_region(graph: &mut BoxGraph, regions_set: &SharedTrackRegions, collections: &mut CollectionCache, region_uuid: Uuid) -> Option<RegionBinding> {
    let region = read_note_region(graph, region_uuid);
    let collection_uuid = graph.target_of(&Address::of(region_uuid, vec![2]))?.uuid;
    let collection = collections.acquire(graph, collection_uuid);
    regions_set.borrow_mut().regions.add(BoundRegion {region_uuid, region, collection});
    // Targeted: a `Parent` sub on the region box re-reads THIS region's span and re-sorts the track's set
    // when (and only when) one of this region's own fields is edited (TS `onIndexingChanged`, per-region).
    let edit_regions = regions_set.clone();
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

/// Read a region's loopable span from the box graph (position 10, duration 11, loopOffset 12, loopDuration 13).
fn read_note_region(graph: &BoxGraph, region_uuid: Uuid) -> NoteRegion {
    NoteRegion {
        position: region_pulses(graph, region_uuid, 10),
        duration: region_pulses(graph, region_uuid, 11),
        loop_offset: region_pulses(graph, region_uuid, 12),
        loop_duration: region_pulses(graph, region_uuid, 13)
    }
}

fn region_pulses(graph: &BoxGraph, uuid: Uuid, key: u16) -> f64 {
    graph.field_value(&Address::of(uuid, vec![key])).and_then(|value| value.as_int32()).unwrap_or(0) as f64
}

// AudioRegionBox field keys (WASM CONTRACT: mirror the TS AudioRegionBox schema). The loopable span lives at
// the SAME keys as note/value regions (10 position, 11 duration, 12 loop-offset, 13 loop-duration).
const AUDIO_REGION_FILE_KEY: u16 = 2;             // -> the AudioFileBox (the source sample)
const AUDIO_REGION_TIMEBASE_KEY: u16 = 4;         // "musical" (ppqn) or "seconds"; gates the duration / loop unit
const AUDIO_REGION_WAVEFORM_OFFSET_KEY: u16 = 7;  // seconds into the source where playback reads
const AUDIO_REGION_MUTE_KEY: u16 = 14;
const AUDIO_REGION_GAIN_KEY: u16 = 17;            // decibels
const AUDIO_REGION_FADING_KEY: u16 = 18;          // object: 1 in, 2 out (ppqn), 3 in-slope, 4 out-slope (ratio)
const AUDIO_REGION_PLAYMODE_KEY: u16 = 8;         // -> an AudioPitchStretchBox / AudioTimeStretchBox, or unset (native)
const PITCH_STRETCH_WARP_HUB_KEY: u16 = 1;        // AudioPitchStretchBox.warp-markers hub
const WARP_POSITION_KEY: u16 = 2;                 // WarpMarkerBox.position (ppqn, int32)
const WARP_SECONDS_KEY: u16 = 3;                  // WarpMarkerBox.seconds (f32)
// AudioTimeStretchBox field keys (WASM CONTRACT: mirror the TS AudioTimeStretchBox schema).
const TIME_STRETCH_WARP_HUB_KEY: u16 = 1;         // AudioTimeStretchBox.warp-markers hub
const TIME_STRETCH_PLAY_MODE_KEY: u16 = 2;        // transient-play-mode (int32 enum: 0 once, 1 repeat, 2 pingpong)
const TIME_STRETCH_RATE_KEY: u16 = 3;             // playback-rate (f32 ratio)
// AudioFileBox / TransientMarkerBox keys (the source's transient onsets, in seconds).
const AUDIO_FILE_TRANSIENTS_HUB_KEY: u16 = 10;    // AudioFileBox.transient-markers hub
const TRANSIENT_POSITION_KEY: u16 = 2;            // TransientMarkerBox.position (seconds, f32)

/// One audio region of an AUDIO track: its loopable span (mirrors note/value regions, keys 10-13) plus the
/// playback data the audio-region player needs. `gain_db` is the RAW decibel value (converted to a linear gain
/// in the player); `waveform_offset` is the source read offset in seconds; the fade in/out lengths + slopes let
/// the player apply ONE slope-shaped fade per region (never the doubled voice×clip product that the TS app hit).
/// Kept sorted in the track's `RegionCollection` by position. Fields are `pub(crate)` — the audio-region player
/// reads them directly at render.
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
    // The SOURCE file's transient marker positions in SECONDS (sorted); read only when `time_stretch` is `Some`
    // (the sequencer aligns granular voices to these). Empty otherwise.
    pub(crate) transients: Vec<f64>
}

impl Span for AudioRegion {
    fn position(&self) -> f64 { self.position }
    fn duration(&self) -> f64 { self.duration }
}

fn region_float(graph: &BoxGraph, uuid: Uuid, path: &[u16]) -> f32 {
    graph.field_value(&Address::of(uuid, path.to_vec())).and_then(|value| value.as_float32()).unwrap_or(0.0)
}

/// Read an `AudioRegionBox`'s span + playback fields. `None` when it has no `file` pointer (an unresolved /
/// half-built region is skipped, never played). The loopable span is normalized to PPQN: in a `Seconds`
/// time-base (the no-stretch / NoWarp default) `duration` + `loop-duration` are stored in SECONDS and converted
/// TEMPO-AWARE at the region's position via the `tempo_map` (mirrors `AudioRegionBoxAdapter`'s converted getters
/// `toPPQN(position)` — a single bpm mis-sizes the region under tempo automation). `position` + `loop-offset`
/// are always ppqn.
fn read_audio_region(graph: &BoxGraph, region_uuid: Uuid, tempo_map: &TempoMap) -> Option<AudioRegion> {
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
        transients
    })
}

/// Read a region's PitchStretch warp markers (sorted by ppqn position), mapping content ppqn -> source seconds.
/// Empty when the region has no play-mode (native) or a TimeStretch play-mode (unsupported; TS TODOs it).
fn read_warp_markers(graph: &BoxGraph, region_uuid: Uuid) -> Vec<(f64, f64)> {
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
fn read_time_stretch(graph: &BoxGraph, region_uuid: Uuid) -> Option<TimeStretchConfig> {
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
fn read_transients(graph: &BoxGraph, file: Uuid) -> Vec<f64> {
    let mut positions: Vec<f64> = graph.incoming(&Address::of(file, vec![AUDIO_FILE_TRANSIENTS_HUB_KEY]))
        .into_iter()
        .map(|address| region_float(graph, address.uuid, &[TRANSIENT_POSITION_KEY]) as f64)
        .collect();
    positions.sort_by(|left, right| left.partial_cmp(right).unwrap_or(core::cmp::Ordering::Equal));
    positions
}

/// Build an AUDIO track binding (the audio analog of `build_track`): its sorted `AudioRegion` collection, a
/// `regions` membership observer, and an `enabled` monitor.
fn build_audio_track(graph: &mut BoxGraph, track_uuid: Uuid, mark: &DirtyMark) -> AudioTrackBinding {
    let regions_set: SharedAudioRegions = Rc::new(RefCell::new(RegionCollection::new()));
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
    let enabled_mark = mark.clone();
    let enabled_sub = graph.subscribe_vertex(Propagation::This, Address::of(track_uuid, vec![TRACK_ENABLED_KEY]),
        Box::new(move |_graph, _update| enabled_mark.mark()));
    AudioTrackBinding {track_uuid, regions_set, region_bindings: Vec::new(), region_changes, region_sub, enabled_sub}
}

/// Tear down an audio track: unsubscribe its membership + edit + enabled observers and drop its region
/// collection from the unit's `audio_track_sets`.
fn teardown_audio_track(graph: &mut BoxGraph, audio_track_sets: &SharedAudioTrackSets, track: AudioTrackBinding) {
    graph.unsubscribe(track.region_sub);
    graph.unsubscribe(track.enabled_sub);
    audio_track_sets.borrow_mut().retain(|set| !Rc::ptr_eq(set, &track.regions_set));
    for region in track.region_bindings {
        graph.unsubscribe(region.edit_sub);
    }
}

/// Reconcile an audio track's regions against its `regions` membership: drop leavers, build + sorted-insert
/// joiners. Mirrors `reconcile_regions` without the note-event cache.
fn reconcile_audio_regions(graph: &mut BoxGraph, track: &mut AudioTrackBinding, tempo_map: &SharedTempoMap) {
    let changes = core::mem::take(&mut *track.region_changes.borrow_mut());
    for region_uuid in changes.removed {
        if let Some(index) = track.region_bindings.iter().position(|region| region.region_uuid == region_uuid) {
            let region = track.region_bindings.remove(index);
            track.regions_set.borrow_mut().retain(|bound| bound.region_uuid != region_uuid);
            graph.unsubscribe(region.edit_sub);
        }
    }
    for region_uuid in changes.added {
        if track.region_bindings.iter().any(|region| region.region_uuid == region_uuid) {
            continue;
        }
        if let Some(binding) = build_audio_region(graph, &track.regions_set, region_uuid, tempo_map) {
            track.region_bindings.push(binding);
        }
    }
}

/// Read an audio region, sorted-insert it into the track's collection, and subscribe a `Parent` edit monitor
/// that re-reads + re-sorts it when its own fields change (so a moved / re-gained / re-faded region updates
/// live). `None` if the region has no file (skipped, never played).
fn build_audio_region(graph: &mut BoxGraph, regions_set: &SharedAudioRegions, region_uuid: Uuid, tempo_map: &SharedTempoMap) -> Option<AudioRegionBinding> {
    let region = read_audio_region(graph, region_uuid, &tempo_map.borrow())?;
    regions_set.borrow_mut().add(region);
    let edit_regions = regions_set.clone();
    let edit_tempo = tempo_map.clone();
    let edit_sub = graph.subscribe_vertex(Propagation::Parent, Address::box_of(region_uuid), Box::new(move |graph, _update| {
        let mut set = edit_regions.borrow_mut();
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
    }));
    Some(AudioRegionBinding {region_uuid, edit_sub})
}

// ---- Device parameter automation (Route D). A device's automated parameter is a Value `TrackBox` whose
// `target` points at the parameter field; the engine observes its curve and hands the device a read handle,
// and the device pulls the value on each global clock event. Discovered per device at rewire (mirroring TS
// `bindParameter` connecting a parameter's automation track), independent of the note-region cascade. ----

// TrackBox.type (field 11) values mirror studio-adapters `TrackType`; only a Value track carries parameter
// automation (Note / Audio tracks and the unset default go through the note cascade).
const TRACK_TYPE_VALUE: i32 = 3;
const TRACK_TYPE_AUDIO: i32 = 2; // an Audio track's regions are AudioRegionBoxes, played by the audio-region player
const TRACK_CLIPS_KEY: u16 = 4; // WASM CONTRACT: TrackBox `clips` collection (launchable clips)
const TRACK_TYPE_KEY: u16 = 11;
const TRACK_ENABLED_KEY: u16 = 20;      // TrackBox.enabled (WASM CONTRACT): a disabled track contributes nothing
const TRACK_TARGET_KEY: u16 = 2;        // TrackBox.target -> the automated parameter field (Automation pointer)
const TRACK_REGIONS_KEY: u16 = 3;       // TrackBox.regions -> the hub value regions attach to (membership)
const VALUE_REGION_EVENTS_KEY: u16 = 2; // ValueRegionBox.events -> the ValueEventCollectionBox

/// One value region of an automation track: its `events` collection and loopable span.
struct RegionSpec {
    collection: Uuid,
    position: f64,
    duration: f64,
    loop_offset: f64,
    loop_duration: f64
}

/// Every value region of an automation track: the `ValueRegionBox`es whose `regions` points at `track_uuid`,
/// with their `events` collection and span (position 10, duration 11, loopOffset 12, loopDuration 13). Read
/// from the track's `regions` hub (the incoming pointers) — O(regions on this track) — not a full-graph scan.
fn value_regions_of_track(graph: &BoxGraph, track_uuid: Uuid) -> Vec<RegionSpec> {
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
                collection,
                position: region_pulses(graph, region_uuid, 10),
                duration: region_pulses(graph, region_uuid, 11),
                loop_offset: region_pulses(graph, region_uuid, 12),
                loop_duration: region_pulses(graph, region_uuid, 13)
            });
        }
    }
    specs
}

/// A track's `type` (field 11), defaulting to 0 (Undefined) when unset.
fn track_type(graph: &BoxGraph, track_uuid: Uuid) -> i32 {
    graph.field_value(&Address::of(track_uuid, vec![TRACK_TYPE_KEY])).and_then(|value| value.as_int32()).unwrap_or(0)
}

fn track_enabled(graph: &BoxGraph, track_uuid: Uuid) -> bool {
    graph.field_value(&Address::of(track_uuid, vec![TRACK_ENABLED_KEY])).and_then(|value| value.as_bool()).unwrap_or(true)
}

/// A LIVE note signal the studio injects (TS `NoteSignal`): the on-screen keys / pads / MIDI input.
#[derive(Clone, Copy)]
pub(crate) enum NoteSignal {
    On {pitch: u8, velocity: f32},
    Off {pitch: u8},
    Audition {pitch: u8, duration: f64, velocity: f32}
}

/// Route a live note signal to the unit's note sources: the leaf sequencer, or every composite SLOT's
/// sequencer (each slot pulls independently; its device filters by pad note). Tape / bus units have none.
/// Mirrors TS `EngineProcessor.noteSignal` -> `NoteSequencer.pushRawNoteOn/Off/auditionNote`.
pub(crate) fn note_signal_to_unit(unit: &AudioUnitBinding, signal: NoteSignal) {
    let mut sources: Vec<SharedNoteEventSource> = Vec::new();
    match unit.wired.as_ref() {
        Some(Wired::Leaf(chain)) => sources.push(chain.sequencer.clone()),
        Some(Wired::Composite(wired)) => wired.binding.collect_note_sources(&mut sources),
        _ => {}
    }
    for source in sources {
        let mut source = source.borrow_mut();
        match signal {
            NoteSignal::On {pitch, velocity} => source.push_raw_note_on(pitch, velocity),
            NoteSignal::Off {pitch} => source.push_raw_note_off(pitch),
            NoteSignal::Audition {pitch, duration, velocity} => source.audition_note(pitch, duration, velocity)
        }
    }
}

impl Engine {
    /// Inject a live note signal into the unit identified by its `AudioUnitBox` uuid. Called OFF-render
    /// (between quanta); the note starts / releases at the next block, playing or stopped.
    pub(crate) fn note_signal(&self, unit: Uuid, signal: NoteSignal) {
        if let Some(binding) = self.audio_units.iter().find(|binding| binding.unit == unit) {
            note_signal_to_unit(binding, signal);
        }
    }
}

#[cfg(test)]
mod tests {
    //! Mirrored regions: a NoteEventCollectionBox is observed ONCE by the cache and shared by every region
    //! that references it; the observation survives until the last region leaves. Two regions sharing a
    //! collection both read the same events, and removing one leaves the other reading it.
    use super::{build_param_track, CollectionCache};
    use crate::tempo_map::TempoMap;
    use boxgraph::address::{Address, Uuid};
    use boxgraph::boxes::GraphBox;
    use boxgraph::field::{FieldValue, Fields};
    use boxgraph::graph::BoxGraph;

    const COLLECTION: Uuid = [1u8; 16];
    const NOTE: Uuid = [2u8; 16];
    const DEVICE: Uuid = [9u8; 16];
    const TRACK: Uuid = [8u8; 16];
    const REGION: Uuid = [7u8; 16];
    const VCOLLECTION: Uuid = [6u8; 16];
    const EVENT: Uuid = [4u8; 16];

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

    // A full automation chain (Value track -> region -> ValueEventCollection -> one event) whose track
    // `target` reaches a parameter at `path` on the device. Used to prove the key is the path at any depth.
    fn deep_automation_graph(path: &[u16]) -> BoxGraph {
        BoxGraph::from_boxes(vec![
            graph_box(DEVICE, "RevampDeviceBox", &[]),
            graph_box(TRACK, "TrackBox", &[
                (2, FieldValue::Pointer(Some(Address::of(DEVICE, path.to_vec())))), // target -> the deep field
                (3, FieldValue::Hook)                                               // regions hub
            ]),
            graph_box(REGION, "ValueRegionBox", &[
                (1, FieldValue::Pointer(Some(Address::of(TRACK, vec![3])))),         // regions -> track.regions
                (2, FieldValue::Pointer(Some(Address::of(VCOLLECTION, vec![2])))),   // events -> collection.owners
                (10, FieldValue::Int32(0)), (11, FieldValue::Int32(3840)),
                (12, FieldValue::Int32(0)), (13, FieldValue::Int32(3840))
            ]),
            graph_box(VCOLLECTION, "ValueEventCollectionBox", &[(1, FieldValue::Hook), (2, FieldValue::Hook)]),
            graph_box(EVENT, "ValueEventBox", &[
                (1, FieldValue::Pointer(Some(Address::of(VCOLLECTION, vec![1])))),   // events -> collection.events
                (10, FieldValue::Int32(0)), (13, FieldValue::Float32(0.7))
            ])
        ])
    }

    // ---- Per-member processor lifecycle ----
    // Adding an effect to a unit's audio chain must KEEP the existing processors (instrument + surviving
    // effects), creating only the joiner — not tear down and rebuild the whole cluster, which would reset
    // every survivor's DSP state. We prove identity by NodeId: ids are handed out monotonically and never
    // reused, so a rebuilt processor always gets a fresh (larger) id. A survivor keeping its id == its
    // processor instance was kept.
    use alloc::rc::Rc;
    use core::cell::RefCell;
    use crate::{DeviceReg, Engine, EFFECT_INDEX_KEY};
    use super::{AudioUnitBinding, Wired, DEVICE_KIND_INSTRUMENT, UNIT_MIDI_KEY, UNIT_INPUT_KEY, UNIT_AUDIO_KEY, UNIT_TRACKS_KEY, UNIT_VOLUME_KEY, DEVICE_ENABLED_KEY, TRACK_ENABLED_KEY, TRACK_TYPE_KEY, TRACK_TYPE_AUDIO, TRACK_REGIONS_KEY};
    use abi::DEVICE_KIND_AUDIO_EFFECT;
    use boxgraph::updates::Update;
    use engine_env::engine_context::NodeId;
    use engine_env::audio_buffer::shared_audio_buffer;
    use engine_env::audio_bus_processor::AudioBusProcessor;

    // The instrument node id + the audio-fx node ids (in chain order) of a reconciled leaf unit.
    fn leaf_nodes(unit: &AudioUnitBinding) -> (NodeId, Vec<NodeId>) {
        match unit.wired.as_ref().expect("wired after reconcile") {
            Wired::Leaf(chain) => (
                chain.instrument.node_id.expect("instrument node"),
                chain.audio.iter().map(|member| member.node_id.expect("audio node")).collect()
            ),
            _ => panic!("expected a leaf chain")
        }
    }

    fn leaf_sequencer(unit: &AudioUnitBinding) -> engine_env::note_event_instrument::SharedNoteEventSource {
        match unit.wired.as_ref().expect("wired after reconcile") {
            Wired::Leaf(chain) => chain.sequencer.clone(),
            _ => panic!("expected a leaf chain")
        }
    }

    // The wired signal-path edges of a leaf unit. `node_in_path` says whether a processor node is connected.
    fn leaf_edges(unit: &AudioUnitBinding) -> Vec<(NodeId, NodeId)> {
        match unit.wired.as_ref().expect("wired after reconcile") {
            Wired::Leaf(chain) => chain.edges.clone(),
            _ => panic!("expected a leaf chain")
        }
    }
    fn node_in_path(edges: &[(NodeId, NodeId)], node: NodeId) -> bool {
        edges.iter().any(|(source, target)| *source == node || *target == node)
    }

    const UNIT: Uuid = [10u8; 16];
    const INSTR: Uuid = [11u8; 16];
    const FX_A: Uuid = [12u8; 16];
    const FX_B: Uuid = [13u8; 16];
    const HOST_KEY: u16 = 1; // the device's `host` pointer field (-> the unit's chain hub)

    fn stub_device(kind: u32) -> DeviceReg {
        DeviceReg {
            process_index: 0, state_size: 64, kind, init_index: 0, parameter_changed_index: 0,
            field_changed_index: 0, sample_changed_index: 0, soundfont_changed_index: 0, reset_index: 0,
            midi_effects_field: 0, audio_effects_field: 0, param_collection_field: 0, sample_collection_field: 0
        }
    }

    // A unit with an instrument on `input` (host 22) and ONE audio effect (FX_A, index 0) on the audio
    // chain (host 23). FX_B exists but is not yet connected (host pointer None), so it joins later.
    fn unit_graph() -> BoxGraph {
        BoxGraph::from_boxes(vec![
            graph_box(UNIT, "AudioUnitBox", &[
                (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook), (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook)
            ]),
            graph_box(INSTR, "TestInstrument", &[
                (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_INPUT_KEY]))))
            ]),
            graph_box(FX_A, "TestEffect", &[
                (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_AUDIO_KEY])))),
                (EFFECT_INDEX_KEY, FieldValue::Int32(0))
            ]),
            graph_box(FX_B, "TestEffect", &[
                (HOST_KEY, FieldValue::Pointer(None)),
                (EFFECT_INDEX_KEY, FieldValue::Int32(1))
            ])
        ])
    }

    fn engine_with_devices() -> Engine {
        let mut engine = Engine::new(48_000.0);
        engine.devices = vec![stub_device(DEVICE_KIND_INSTRUMENT), stub_device(DEVICE_KIND_AUDIO_EFFECT)];
        engine.device_box_types = vec![("TestInstrument".to_string(), 0), ("TestEffect".to_string(), 1)];
        let output_buffer = shared_audio_buffer();
        let master = Rc::new(RefCell::new(AudioBusProcessor::new(output_buffer)));
        engine.master_id = engine.context.register_processor(master.clone());
        engine.master = Some(master);
        engine
    }

    #[test]
    fn adding_an_effect_keeps_the_existing_processors() {
        let mut engine = engine_with_devices();
        engine.graph = unit_graph();
        let mut unit = engine.build_unit(UNIT);
        // First reconcile builds the chain: instrument + FX_A.
        engine.reconcile_one(&mut unit);
        let (instr_node, audio_before) = leaf_nodes(&unit);
        assert_eq!(audio_before.len(), 1, "one audio effect (FX_A) before");
        let fx_a_node = audio_before[0];

        // Connect FX_B (index 1) to the audio chain via a real pointer transaction, so the audio
        // IndexedCollection observes the join and marks the unit dirty.
        let connect = Update::Pointer {
            address: Address::of(FX_B, vec![HOST_KEY]),
            old: None,
            new: Some(Address::of(UNIT, vec![UNIT_AUDIO_KEY]))
        };
        engine.graph.transaction(&[connect], &engine.registry).expect("connect FX_B");
        assert_eq!(unit.audio.sorted(), vec![FX_A, FX_B], "FX_B joined the audio chain in index order");

        // Second reconcile: FX_B joins. The instrument and FX_A must be the SAME processors (same ids).
        engine.reconcile_one(&mut unit);
        let (instr_after, audio_after) = leaf_nodes(&unit);
        assert_eq!(audio_after.len(), 2, "FX_A + FX_B after");
        assert_eq!(instr_after, instr_node, "instrument processor identity preserved across chain edit");
        assert_eq!(audio_after[0], fx_a_node, "surviving effect FX_A processor identity preserved");
        assert!(audio_after[1] > fx_a_node, "the joiner FX_B is a freshly created processor");
    }

    #[test]
    fn launching_a_clip_plays_its_notes_instead_of_the_timeline() {
        const CLIP: Uuid = [30u8; 16];
        const CLIP_COLLECTION: Uuid = [31u8; 16];
        const CLIP_NOTE: Uuid = [32u8; 16];
        const TL_REGION: Uuid = [33u8; 16];
        const TL_COLLECTION: Uuid = [34u8; 16];
        const TL_NOTE: Uuid = [35u8; 16];
        let mut engine = engine_with_devices();
        engine.graph = BoxGraph::from_boxes(vec![
            graph_box(UNIT, "AudioUnitBox", &[
                (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook),
                (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook)
            ]),
            graph_box(INSTR, "TestInstrument", &[(HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_INPUT_KEY]))))]),
            graph_box(TRACK, "TrackBox", &[
                (1, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_TRACKS_KEY])))),
                (TRACK_TYPE_KEY, FieldValue::Int32(1)), // Notes
                (TRACK_REGIONS_KEY, FieldValue::Hook),
                (super::TRACK_CLIPS_KEY, FieldValue::Hook),
                (TRACK_ENABLED_KEY, FieldValue::Boolean(true))
            ]),
            // The timeline: one region spanning two bars with a note (pitch 60) inside the SECOND bar.
            graph_box(TL_REGION, "NoteRegionBox", &[
                (1, FieldValue::Pointer(Some(Address::of(TRACK, vec![TRACK_REGIONS_KEY])))),
                (2, FieldValue::Pointer(Some(Address::of(TL_COLLECTION, vec![2])))),
                (10, FieldValue::Int32(0)), (11, FieldValue::Int32(7680)),
                (12, FieldValue::Int32(0)), (13, FieldValue::Int32(7680))
            ]),
            graph_box(TL_COLLECTION, "NoteEventCollectionBox", &[(1, FieldValue::Hook), (2, FieldValue::Hook)]),
            graph_box(TL_NOTE, "NoteEventBox", &[
                (1, FieldValue::Pointer(Some(Address::of(TL_COLLECTION, vec![1])))),
                (10, FieldValue::Int32(3850)), (11, FieldValue::Int32(240)),
                (20, FieldValue::Int32(60)), (21, FieldValue::Float32(0.8)), (24, FieldValue::Float32(0.0))
            ]),
            // The clip: one bar long (960 pulses would be a beat; use 960 to prove clip-duration cycling), a
            // note (pitch 72) at its start, attached to the track's `clips` collection.
            graph_box(CLIP, "NoteClipBox", &[
                (1, FieldValue::Pointer(Some(Address::of(TRACK, vec![super::TRACK_CLIPS_KEY])))),
                (2, FieldValue::Pointer(Some(Address::of(CLIP_COLLECTION, vec![2])))),
                (10, FieldValue::Int32(960))
            ]),
            graph_box(CLIP_COLLECTION, "NoteEventCollectionBox", &[(1, FieldValue::Hook), (2, FieldValue::Hook)]),
            graph_box(CLIP_NOTE, "NoteEventBox", &[
                (1, FieldValue::Pointer(Some(Address::of(CLIP_COLLECTION, vec![1])))),
                (10, FieldValue::Int32(0)), (11, FieldValue::Int32(240)),
                (20, FieldValue::Int32(72)), (21, FieldValue::Float32(0.9)), (24, FieldValue::Float32(0.0))
            ])
        ]);
        let mut unit = engine.build_unit(UNIT);
        engine.reconcile_one(&mut unit);
        let sequencer = leaf_sequencer(&unit);
        let flags = engine_env::block_flags::BlockFlags::create(true, false, true, false);
        let mut events: Vec<engine_env::event::Event> = Vec::new();
        // Before the launch, the timeline note plays.
        sequencer.borrow_mut().process_notes(3800.0, 3900.0, flags, &mut |event| events.push(event));
        assert!(events.iter().any(|event| matches!(event, engine_env::event::Event::NoteStart {pitch: 60, ..})),
            "the timeline note plays before any clip: {events:?}");
        // Launch the clip (resolves its track through the `clips` pointer). Handover on the NEXT bar,
        // and the TRANSPORT STARTS (TS: scheduleClipPlay sets transporting), so a stopped studio plays.
        assert!(!engine.transport.is_playing(), "transport starts stopped");
        engine.schedule_clip_play(CLIP);
        assert!(engine.transport.is_playing(), "launching a clip starts the transport (TS parity)");
        events.clear();
        sequencer.borrow_mut().process_notes(7660.0, 7700.0, flags, &mut |event| events.push(event));
        assert!(events.iter().any(|event| matches!(event, engine_env::event::Event::NoteStart {pitch: 72, position, ..} if *position == 7680.0)),
            "the clip note starts at the bar boundary: {events:?}");
        // While the clip plays, its collection cycles at the CLIP duration (960): next start at 8640, and
        // the timeline stays suppressed.
        events.clear();
        sequencer.borrow_mut().process_notes(8620.0, 8660.0, flags, &mut |event| events.push(event));
        assert!(events.iter().any(|event| matches!(event, engine_env::event::Event::NoteStart {pitch: 72, position, ..} if *position == 8640.0)),
            "the clip cycles at its own duration: {events:?}");
        assert!(!events.iter().any(|event| matches!(event, engine_env::event::Event::NoteStart {pitch: 60, ..})),
            "the timeline is suppressed while the clip plays: {events:?}");
        // The launch queued a STARTED transition for the back-channel.
        let mut started = 0;
        engine.clip_sequencer.borrow_mut().take_changes(&mut |uuid, change| {
            if uuid == &CLIP && change == engine_env::clip_sequencer::Change::Started {
                started += 1;
            }
        });
        assert_eq!(started, 1, "exactly one started notification");
    }

    #[test]
    fn live_note_signal_reaches_the_leaf_sequencer() {
        let mut engine = engine_with_devices();
        engine.graph = unit_graph();
        let mut unit = engine.build_unit(UNIT);
        engine.reconcile_one(&mut unit);
        // A raw note-on routes to the unit's sequencer and emits at the next block, transport STOPPED.
        super::note_signal_to_unit(&unit, super::NoteSignal::On {pitch: 60, velocity: 0.9});
        let sequencer = leaf_sequencer(&unit);
        let stopped = engine_env::block_flags::BlockFlags::create(false, false, false, false);
        let mut events: Vec<engine_env::event::Event> = Vec::new();
        sequencer.borrow_mut().process_notes(0.0, 5.0, stopped, &mut |event| events.push(event));
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], engine_env::event::Event::NoteStart {pitch: 60, ..}));
        // The note-off releases it in the following block.
        super::note_signal_to_unit(&unit, super::NoteSignal::Off {pitch: 60});
        events.clear();
        sequencer.borrow_mut().process_notes(5.0, 10.0, stopped, &mut |event| events.push(event));
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], engine_env::event::Event::NoteComplete {pitch: 60, ..}));
    }

    #[test]
    fn reordering_effects_keeps_their_processors() {
        let mut engine = engine_with_devices();
        engine.graph = unit_graph();
        let mut unit = engine.build_unit(UNIT);
        // Connect FX_B (index 1) so the chain is [FX_A(0), FX_B(1)].
        engine.graph.transaction(&[Update::Pointer {
            address: Address::of(FX_B, vec![HOST_KEY]), old: None, new: Some(Address::of(UNIT, vec![UNIT_AUDIO_KEY]))
        }], &engine.registry).expect("connect FX_B");
        engine.reconcile_one(&mut unit);
        let (_, audio_before) = leaf_nodes(&unit);
        assert_eq!(audio_before.len(), 2);
        let (fx_a_node, fx_b_node) = (audio_before[0], audio_before[1]);

        // SWAP the indices (a pure reorder): FX_A -> 1, FX_B -> 0, so the chain becomes [FX_B, FX_A].
        engine.graph.transaction(&[
            Update::Primitive {address: Address::of(FX_A, vec![EFFECT_INDEX_KEY]), old: FieldValue::Int32(0), new: FieldValue::Int32(1)},
            Update::Primitive {address: Address::of(FX_B, vec![EFFECT_INDEX_KEY]), old: FieldValue::Int32(1), new: FieldValue::Int32(0)}
        ], &engine.registry).expect("swap indices");
        assert_eq!(unit.audio.sorted(), vec![FX_B, FX_A], "the chain reordered");

        // A reorder must ONLY rewire edges: both processors keep their identity (no rebuild -> no DSP reset /
        // delay-offset glide). The order of the node list follows the new chain order.
        let sequencer_before = leaf_sequencer(&unit);
        engine.reconcile_one(&mut unit);
        let (_, audio_after) = leaf_nodes(&unit);
        assert_eq!(audio_after, vec![fx_b_node, fx_a_node],
            "reorder keeps the SAME processors, just re-ordered (FX_B then FX_A)");
        // And it must reuse the instrument's note source: recreating it would drop the notes held across blocks
        // (stuck / re-triggered notes while playing).
        assert!(Rc::ptr_eq(&sequencer_before, &leaf_sequencer(&unit)),
            "reorder reuses the instrument's note sequencer (held notes preserved)");
    }

    #[test]
    fn a_disabled_effect_is_bypassed_and_re_enabling_re_wires_it_edge_only() {
        let mut engine = engine_with_devices();
        // Unit: instrument + FX_A (enabled, index 0) + FX_B (DISABLED, index 1).
        engine.graph = BoxGraph::from_boxes(vec![
            graph_box(UNIT, "AudioUnitBox", &[
                (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook),
                (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook)
            ]),
            graph_box(INSTR, "TestInstrument", &[(HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_INPUT_KEY]))))]),
            graph_box(FX_A, "TestEffect", &[
                (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_AUDIO_KEY])))), (EFFECT_INDEX_KEY, FieldValue::Int32(0))
            ]),
            graph_box(FX_B, "TestEffect", &[
                (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_AUDIO_KEY])))), (EFFECT_INDEX_KEY, FieldValue::Int32(1)),
                (DEVICE_ENABLED_KEY, FieldValue::Boolean(false)) // disabled
            ])
        ]);
        let mut unit = engine.build_unit(UNIT);
        engine.reconcile_one(&mut unit);
        let (_, audio) = leaf_nodes(&unit);
        assert_eq!(audio.len(), 2, "BOTH effects are built (a disabled effect's processor persists)");
        let (fx_a, fx_b) = (audio[0], audio[1]);
        let edges = leaf_edges(&unit);
        assert!(node_in_path(&edges, fx_a), "FX_A (enabled) is in the signal path");
        assert!(!node_in_path(&edges, fx_b), "FX_B (disabled) is BYPASSED — no edge touches it");

        // Enable FX_B: this must RE-WIRE edges only — the SAME processors, no rebuild, no param push.
        engine.graph.transaction(&[Update::Primitive {
            address: Address::of(FX_B, vec![DEVICE_ENABLED_KEY]),
            old: FieldValue::Boolean(false), new: FieldValue::Boolean(true)
        }], &engine.registry).expect("enable FX_B");
        engine.reconcile_one(&mut unit);
        let (_, audio_after) = leaf_nodes(&unit);
        assert_eq!(audio_after, vec![fx_a, fx_b], "same processor instances (edge-only re-wire, no rebuild)");
        assert!(node_in_path(&leaf_edges(&unit), fx_b), "FX_B is now wired into the signal path");
    }

    #[test]
    fn a_disabled_note_track_contributes_no_regions_and_re_enabling_restores_it() {
        const TRACK: Uuid = [20u8; 16];
        let mut engine = engine_with_devices();
        engine.graph = BoxGraph::from_boxes(vec![
            graph_box(UNIT, "AudioUnitBox", &[
                (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook),
                (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook)
            ]),
            graph_box(INSTR, "TestInstrument", &[(HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_INPUT_KEY]))))]),
            graph_box(TRACK, "TrackBox", &[
                (1, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_TRACKS_KEY])))), // tracks -> unit.tracks
                (TRACK_TYPE_KEY, FieldValue::Int32(0)),                                   // a NOTE track
                (TRACK_REGIONS_KEY, FieldValue::Hook),
                (TRACK_ENABLED_KEY, FieldValue::Boolean(true))
            ])
        ]);
        let mut unit = engine.build_unit(UNIT);
        engine.reconcile_one(&mut unit);
        assert_eq!(unit.track_sets.borrow().len(), 1, "an enabled note track feeds its regions to the sequencer");

        // Disable the track: edge-only — its region collection is dropped from the sequencer's set, nothing rebuilt.
        let toggle = |engine: &mut Engine, from: bool, to: bool| engine.graph.transaction(&[Update::Primitive {
            address: Address::of(TRACK, vec![TRACK_ENABLED_KEY]),
            old: FieldValue::Boolean(from), new: FieldValue::Boolean(to)
        }], &engine.registry).expect("toggle track enabled");
        toggle(&mut engine, true, false);
        engine.reconcile_one(&mut unit);
        assert_eq!(unit.track_sets.borrow().len(), 0, "a disabled note track contributes no regions");

        toggle(&mut engine, false, true);
        engine.reconcile_one(&mut unit);
        assert_eq!(unit.track_sets.borrow().len(), 1, "re-enabling restores the track's regions");
    }

    #[test]
    fn read_audio_region_reads_span_file_gain_and_fades() {
        use super::{read_audio_region, AUDIO_REGION_FADING_KEY};
        const REGION: Uuid = [50u8; 16];
        const FILE: Uuid = [51u8; 16];
        let mut fading = Fields::new();
        fading.insert(1u16, FieldValue::Float32(120.0)); // fade in (ppqn)
        fading.insert(2u16, FieldValue::Float32(240.0)); // fade out (ppqn)
        fading.insert(3u16, FieldValue::Float32(0.75));  // in slope
        fading.insert(4u16, FieldValue::Float32(0.25));  // out slope
        let graph = BoxGraph::from_boxes(vec![
            graph_box(FILE, "AudioFileBox", &[]),
            graph_box(REGION, "AudioRegionBox", &[
                (2, FieldValue::Pointer(Some(Address::box_of(FILE)))),  // file -> the AudioFileBox
                (10, FieldValue::Int32(1920)),      // position (ppqn)
                (11, FieldValue::Float32(3840.0)),  // duration (ppqn)
                (12, FieldValue::Float32(0.0)),     // loop offset
                (13, FieldValue::Float32(3840.0)),  // loop duration
                (7, FieldValue::Float32(0.5)),      // waveform offset (seconds)
                (14, FieldValue::Boolean(false)),   // mute
                (17, FieldValue::Float32(-6.0)),    // gain (dB)
                (AUDIO_REGION_FADING_KEY, FieldValue::Object(fading))
            ])
        ]);
        let region = read_audio_region(&graph, REGION, &TempoMap::fixed(120.0)).expect("a region with a file resolves");
        assert_eq!(region.position, 1920.0);
        assert_eq!(region.duration, 3840.0);
        assert_eq!(region.loop_duration, 3840.0);
        assert_eq!(region.file, FILE);
        assert_eq!(region.gain_db, -6.0);
        assert!(!region.mute);
        assert_eq!(region.waveform_offset, 0.5);
        assert_eq!(region.fade_in, 120.0);
        assert_eq!(region.fade_out, 240.0);
        assert_eq!(region.fade_in_slope, 0.75);
        assert_eq!(region.fade_out_slope, 0.25);
        // A region with no file pointer is skipped (never played), not a panic.
        let orphan = BoxGraph::from_boxes(vec![graph_box(REGION, "AudioRegionBox", &[(10, FieldValue::Int32(0))])]);
        assert!(read_audio_region(&orphan, REGION, &TempoMap::fixed(120.0)).is_none());
    }

    #[test]
    fn read_audio_region_reads_pitch_stretch_warp_markers_sorted() {
        use super::read_audio_region;
        const REGION: Uuid = [60u8; 16];
        const FILE: Uuid = [61u8; 16];
        const PITCH: Uuid = [62u8; 16];
        const W0: Uuid = [63u8; 16];
        const W1: Uuid = [64u8; 16];
        let graph = BoxGraph::from_boxes(vec![
            graph_box(FILE, "AudioFileBox", &[]),
            graph_box(PITCH, "AudioPitchStretchBox", &[(1, FieldValue::Hook)]), // warp-markers hub (key 1)
            // out of order on purpose: the reader must sort by position
            graph_box(W1, "WarpMarkerBox", &[(1, FieldValue::Pointer(Some(Address::of(PITCH, vec![1])))), (2, FieldValue::Int32(3840)), (3, FieldValue::Float32(1.0))]),
            graph_box(W0, "WarpMarkerBox", &[(1, FieldValue::Pointer(Some(Address::of(PITCH, vec![1])))), (2, FieldValue::Int32(0)), (3, FieldValue::Float32(0.0))]),
            graph_box(REGION, "AudioRegionBox", &[
                (2, FieldValue::Pointer(Some(Address::box_of(FILE)))), (8, FieldValue::Pointer(Some(Address::box_of(PITCH)))),
                (10, FieldValue::Int32(0)), (11, FieldValue::Float32(3840.0))
            ])
        ]);
        let region = read_audio_region(&graph, REGION, &TempoMap::fixed(120.0)).expect("region with a file");
        assert_eq!(region.warp, vec![(0.0, 0.0), (3840.0, 1.0)], "warp markers read from the play-mode, sorted by ppqn");
        assert!(region.time_stretch.is_none(), "a PitchStretch play-mode is not a TimeStretch config");
        assert!(region.transients.is_empty(), "transients are only read for a time-stretch region");
    }

    #[test]
    fn read_audio_region_reads_time_stretch_config_and_file_transients() {
        use super::read_audio_region;
        use crate::time_stretch::TransientPlayMode;
        const REGION: Uuid = [70u8; 16];
        const FILE: Uuid = [71u8; 16];
        const STRETCH: Uuid = [72u8; 16];
        const W0: Uuid = [73u8; 16];
        const W1: Uuid = [74u8; 16];
        const T0: Uuid = [75u8; 16];
        const T1: Uuid = [76u8; 16];
        let graph = BoxGraph::from_boxes(vec![
            // the file carries two transient markers (key 10 hub), out of order on purpose -> the reader sorts them
            graph_box(FILE, "AudioFileBox", &[(10, FieldValue::Hook)]),
            graph_box(T1, "TransientMarkerBox", &[(1, FieldValue::Pointer(Some(Address::of(FILE, vec![10])))), (2, FieldValue::Float32(0.5))]),
            graph_box(T0, "TransientMarkerBox", &[(1, FieldValue::Pointer(Some(Address::of(FILE, vec![10])))), (2, FieldValue::Float32(0.0))]),
            // the time-stretch play-mode: warp hub (key 1), transient-play-mode (key 2 = Repeat), playback-rate (key 3)
            graph_box(STRETCH, "AudioTimeStretchBox", &[(1, FieldValue::Hook), (2, FieldValue::Int32(1)), (3, FieldValue::Float32(1.5))]),
            graph_box(W1, "WarpMarkerBox", &[(1, FieldValue::Pointer(Some(Address::of(STRETCH, vec![1])))), (2, FieldValue::Int32(3840)), (3, FieldValue::Float32(1.0))]),
            graph_box(W0, "WarpMarkerBox", &[(1, FieldValue::Pointer(Some(Address::of(STRETCH, vec![1])))), (2, FieldValue::Int32(0)), (3, FieldValue::Float32(0.0))]),
            graph_box(REGION, "AudioRegionBox", &[
                (2, FieldValue::Pointer(Some(Address::box_of(FILE)))), (8, FieldValue::Pointer(Some(Address::box_of(STRETCH)))),
                (10, FieldValue::Int32(0)), (11, FieldValue::Float32(3840.0))
            ])
        ]);
        let region = read_audio_region(&graph, REGION, &TempoMap::fixed(120.0)).expect("region with a file");
        let config = region.time_stretch.expect("a time-stretch play-mode resolves a config");
        assert_eq!(config.warp, vec![(0.0, 0.0), (3840.0, 1.0)], "warp markers sorted by ppqn");
        assert_eq!(config.transient_play_mode, TransientPlayMode::Repeat);
        assert_eq!(config.playback_rate, 1.5);
        assert_eq!(region.transients, vec![0.0, 0.5], "file transients read in seconds, sorted");
        assert!(region.warp.is_empty(), "the PitchStretch warp field stays empty for a time-stretch region");
    }

    #[test]
    fn read_audio_region_converts_seconds_time_base_to_ppqn() {
        // A no-stretch (NoWarp) region uses the SECONDS time-base: duration / loop-duration are in seconds and
        // MUST be converted to ppqn, else the region reads as a few pulses and plays nothing (the bug).
        use super::read_audio_region;
        const REGION: Uuid = [65u8; 16];
        const FILE: Uuid = [66u8; 16];
        let graph = BoxGraph::from_boxes(vec![
            graph_box(FILE, "AudioFileBox", &[]),
            graph_box(REGION, "AudioRegionBox", &[
                (2, FieldValue::Pointer(Some(Address::box_of(FILE)))),
                (4, FieldValue::String("seconds".to_string())),                 // Seconds time-base
                (10, FieldValue::Int32(0)), (11, FieldValue::Float32(2.0)), (13, FieldValue::Float32(2.0)) // 2 seconds
            ])
        ]);
        let region = read_audio_region(&graph, REGION, &TempoMap::fixed(120.0)).expect("region with a file");
        assert_eq!(region.duration, 3840.0, "2 s at 120 bpm -> 3840 ppqn (one bar)");
        assert_eq!(region.loop_duration, 3840.0);
        assert_eq!(region.position, 0.0, "position is always ppqn, never converted");
    }

    #[test]
    fn an_audio_track_feeds_its_regions_to_the_audio_player_set() {
        const TRACK: Uuid = [52u8; 16];
        const REGION: Uuid = [53u8; 16];
        const FILE: Uuid = [54u8; 16];
        let mut engine = engine_with_devices();
        engine.graph = BoxGraph::from_boxes(vec![
            graph_box(UNIT, "AudioUnitBox", &[
                (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook),
                (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook)
            ]),
            graph_box(TRACK, "TrackBox", &[
                (1, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_TRACKS_KEY])))), // tracks -> unit.tracks
                (TRACK_TYPE_KEY, FieldValue::Int32(TRACK_TYPE_AUDIO)),                    // an AUDIO track
                (TRACK_REGIONS_KEY, FieldValue::Hook), (TRACK_ENABLED_KEY, FieldValue::Boolean(true))
            ]),
            graph_box(FILE, "AudioFileBox", &[]),
            graph_box(REGION, "AudioRegionBox", &[
                (1, FieldValue::Pointer(Some(Address::of(TRACK, vec![TRACK_REGIONS_KEY])))), // regions -> track.regions
                (2, FieldValue::Pointer(Some(Address::box_of(FILE)))),                       // file
                (10, FieldValue::Int32(0)), (11, FieldValue::Float32(3840.0)), (13, FieldValue::Float32(3840.0))
            ])
        ]);
        let mut unit = engine.build_unit(UNIT);
        engine.reconcile_one(&mut unit);
        let sets = unit.audio_track_sets.borrow();
        assert_eq!(sets.len(), 1, "the enabled audio track feeds one region collection to the player");
        assert_eq!(sets[0].borrow().len(), 1, "with its one audio region");
        // It must NOT leak into the NOTE set (an audio track is not a note track).
        assert_eq!(unit.track_sets.borrow().len(), 0, "an audio track is not in the note-track set");
    }

    #[test]
    fn a_tape_instrument_unit_builds_the_audio_region_player() {
        const TAPE: Uuid = [55u8; 16];
        const TRACK: Uuid = [56u8; 16];
        const REGION: Uuid = [57u8; 16];
        const FILE: Uuid = [58u8; 16];
        let mut engine = engine_with_devices();
        engine.graph = BoxGraph::from_boxes(vec![
            graph_box(UNIT, "AudioUnitBox", &[
                (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook),
                (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook)
            ]),
            graph_box(TAPE, "TapeDeviceBox", &[(HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_INPUT_KEY]))))]),
            graph_box(TRACK, "TrackBox", &[
                (1, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_TRACKS_KEY])))),
                (TRACK_TYPE_KEY, FieldValue::Int32(TRACK_TYPE_AUDIO)), (TRACK_REGIONS_KEY, FieldValue::Hook),
                (TRACK_ENABLED_KEY, FieldValue::Boolean(true))
            ]),
            graph_box(FILE, "AudioFileBox", &[]),
            graph_box(REGION, "AudioRegionBox", &[
                (1, FieldValue::Pointer(Some(Address::of(TRACK, vec![TRACK_REGIONS_KEY])))),
                (2, FieldValue::Pointer(Some(Address::box_of(FILE)))),
                (10, FieldValue::Int32(0)), (11, FieldValue::Float32(3840.0)), (13, FieldValue::Float32(3840.0))
            ])
        ]);
        let mut unit = engine.build_unit(UNIT);
        engine.reconcile_one(&mut unit);
        assert!(matches!(unit.wired, Some(Wired::Tape(_))), "a TapeDeviceBox instrument builds the audio-region player -> strip -> master");
        assert_eq!(unit.audio_track_sets.borrow()[0].borrow().len(), 1, "the player reads the unit's audio region");
    }

    // ---- Composite per-child lifecycle ----
    // A composite (Playfield) unit: adding a child slot must KEEP the existing slots' processors. Same
    // identity-by-NodeId proof as the leaf case, one level down.
    use crate::CompositeSpec;

    const COMPOSITE: Uuid = [30u8; 16];
    const CHILD_A: Uuid = [31u8; 16];
    const CHILD_B: Uuid = [32u8; 16];
    const CHILDREN_FIELD: u16 = 30; // the composite's child-slot host hub
    const CHILD_ENABLED_KEY: u16 = 22; // a child's `enabled` field (Playfield's slot key; the test mirrors it)

    // A unit whose instrument is a composite hosting direct-instrument children (no choke, no routing). CHILD_A
    // is connected; CHILD_B exists but joins later. The children are `TestInstrument` voices.
    fn composite_graph() -> BoxGraph {
        BoxGraph::from_boxes(vec![
            graph_box(UNIT, "AudioUnitBox", &[
                (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook), (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook)
            ]),
            graph_box(COMPOSITE, "TestComposite", &[
                (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_INPUT_KEY])))),
                (CHILDREN_FIELD, FieldValue::Hook)
            ]),
            graph_box(CHILD_A, "TestInstrument", &[
                (HOST_KEY, FieldValue::Pointer(Some(Address::of(COMPOSITE, vec![CHILDREN_FIELD])))),
                (CHILD_ENABLED_KEY, FieldValue::Boolean(true))
            ]),
            graph_box(CHILD_B, "TestInstrument", &[
                (HOST_KEY, FieldValue::Pointer(None)),
                (CHILD_ENABLED_KEY, FieldValue::Boolean(true))
            ])
        ])
    }

    fn child_instrument_node(unit: &AudioUnitBinding, child: Uuid) -> Option<NodeId> {
        match unit.wired.as_ref().expect("wired after reconcile") {
            Wired::Composite(composite) => composite.binding.child_instrument_node(child),
            _ => panic!("expected a composite chain")
        }
    }

    fn child_audio_members(unit: &AudioUnitBinding, child: Uuid) -> Option<usize> {
        match unit.wired.as_ref().expect("wired after reconcile") {
            Wired::Composite(composite) => composite.binding.child_audio_member_count(child),
            _ => panic!("expected a composite chain")
        }
    }
    fn child_wired_audio(unit: &AudioUnitBinding, child: Uuid) -> Option<usize> {
        match unit.wired.as_ref().expect("wired after reconcile") {
            Wired::Composite(composite) => composite.binding.child_wired_audio_count(child),
            _ => panic!("expected a composite chain")
        }
    }

    // How many child outputs the composite's summing bus currently mixes (a removed child must leave the sum,
    // else its stale buffer keeps sounding).
    fn composite_sum_sources(unit: &AudioUnitBinding) -> usize {
        match unit.wired.as_ref().expect("wired after reconcile") {
            Wired::Composite(composite) => composite.binding.sum.borrow().audio_source_count(),
            _ => panic!("expected a composite chain")
        }
    }

    fn composite_engine() -> Engine {
        let mut engine = engine_with_devices(); // TestInstrument + TestEffect device table
        engine.composites = vec![CompositeSpec {
            box_type: "TestComposite".to_string(), children_field: CHILDREN_FIELD, index_key: 0, exclude_key: 0,
            cell_instrument_field: 0, cell_midi_field: 0, cell_audio_field: 0, // direct instruments, no choke
            child_enabled_key: CHILD_ENABLED_KEY
        }];
        engine
    }

    #[test]
    fn a_cell_composite_builds_its_hosted_instrument_and_keeps_it_across_reconcile() {
        // A CELL composite (CompositeDeviceBox path): children are generic wrappers that HOST one instrument at a
        // fixed field. Exercises the `ChildBody::Cell` build + survive + teardown path (otherwise untested).
        const CELL: Uuid = [40u8; 16];
        const CELL_INSTRUMENT_FIELD: u16 = 50;
        let mut engine = engine_with_devices();
        engine.composites = vec![CompositeSpec {
            box_type: "TestComposite".to_string(), children_field: CHILDREN_FIELD, index_key: 0, exclude_key: 0,
            cell_instrument_field: CELL_INSTRUMENT_FIELD, cell_midi_field: 0, cell_audio_field: 0, child_enabled_key: 0
        }];
        engine.graph = BoxGraph::from_boxes(vec![
            graph_box(UNIT, "AudioUnitBox", &[
                (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook),
                (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook)
            ]),
            graph_box(COMPOSITE, "TestComposite", &[
                (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_INPUT_KEY])))), (CHILDREN_FIELD, FieldValue::Hook)
            ]),
            graph_box(CELL, "TestCell", &[
                (HOST_KEY, FieldValue::Pointer(Some(Address::of(COMPOSITE, vec![CHILDREN_FIELD])))), (CELL_INSTRUMENT_FIELD, FieldValue::Hook)
            ]),
            graph_box(CHILD_A, "TestInstrument", &[
                (HOST_KEY, FieldValue::Pointer(Some(Address::of(CELL, vec![CELL_INSTRUMENT_FIELD]))))
            ])
        ]);
        let mut unit = engine.build_unit(UNIT);
        engine.reconcile_one(&mut unit);
        assert_eq!(composite_sum_sources(&unit), 1, "the cell's hosted instrument feeds the sum");
        let node = child_instrument(&unit, CELL).expect("cell child built");
        engine.reconcile_one(&mut unit);
        assert_eq!(child_instrument(&unit, CELL), Some(node), "the cell child survives an idle reconcile (same processor)");
    }

    #[test]
    fn a_nested_composite_builds_and_sums_its_subtree() {
        // A NESTED composite: a child of a composite is ITSELF a composite (recurses). Exercises `ChildBody::Nested`
        // build + survive + teardown (otherwise untested). OUTER hosts INNER (a composite) which hosts a LEAF voice.
        const INNER: Uuid = [40u8; 16];
        const LEAF: Uuid = [41u8; 16];
        let mut engine = composite_engine(); // TestComposite, direct children, child_enabled_key 22
        engine.graph = BoxGraph::from_boxes(vec![
            graph_box(UNIT, "AudioUnitBox", &[
                (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook),
                (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook)
            ]),
            graph_box(COMPOSITE, "TestComposite", &[
                (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_INPUT_KEY])))), (CHILDREN_FIELD, FieldValue::Hook)
            ]),
            graph_box(INNER, "TestComposite", &[
                (HOST_KEY, FieldValue::Pointer(Some(Address::of(COMPOSITE, vec![CHILDREN_FIELD])))),
                (CHILDREN_FIELD, FieldValue::Hook), (CHILD_ENABLED_KEY, FieldValue::Boolean(true))
            ]),
            graph_box(LEAF, "TestInstrument", &[
                (HOST_KEY, FieldValue::Pointer(Some(Address::of(INNER, vec![CHILDREN_FIELD])))), (CHILD_ENABLED_KEY, FieldValue::Boolean(true))
            ])
        ]);
        let mut unit = engine.build_unit(UNIT);
        engine.reconcile_one(&mut unit);
        assert_eq!(composite_sum_sources(&unit), 1, "the outer sum sums the nested composite's one output");
        engine.reconcile_one(&mut unit);
        assert_eq!(composite_sum_sources(&unit), 1, "the nested subtree is stable across an idle reconcile");
    }

    #[test]
    fn adding_a_composite_child_keeps_the_existing_children() {
        let mut engine = composite_engine();
        engine.graph = composite_graph();
        let mut unit = engine.build_unit(UNIT);
        // First reconcile builds the composite with CHILD_A summed.
        engine.reconcile_one(&mut unit);
        let child_a_node = child_instrument_node(&unit, CHILD_A).expect("CHILD_A built");

        // Connect CHILD_B to the composite's child hub, so the children collection observes the join.
        let connect = Update::Pointer {
            address: Address::of(CHILD_B, vec![HOST_KEY]),
            old: None,
            new: Some(Address::of(COMPOSITE, vec![CHILDREN_FIELD]))
        };
        engine.graph.transaction(&[connect], &engine.registry).expect("connect CHILD_B");

        // Second reconcile: CHILD_B joins. CHILD_A's instrument processor must be the SAME (its voices live on).
        engine.reconcile_one(&mut unit);
        let child_a_after = child_instrument_node(&unit, CHILD_A).expect("CHILD_A survives");
        let child_b_node = child_instrument_node(&unit, CHILD_B).expect("CHILD_B joined");
        assert_eq!(child_a_after, child_a_node, "existing composite child keeps its processor identity");
        assert!(child_b_node > child_a_node, "the joining child is a freshly created processor");
    }

    #[test]
    fn removing_a_composite_child_keeps_the_others() {
        let mut engine = composite_engine();
        engine.graph = composite_graph();
        let mut unit = engine.build_unit(UNIT);
        // Connect CHILD_B so both A and B are children.
        engine.graph.transaction(&[Update::Pointer {
            address: Address::of(CHILD_B, vec![HOST_KEY]), old: None, new: Some(Address::of(COMPOSITE, vec![CHILDREN_FIELD]))
        }], &engine.registry).expect("connect CHILD_B");
        engine.reconcile_one(&mut unit);
        let child_b_node = child_instrument_node(&unit, CHILD_B).expect("CHILD_B built");
        assert_eq!(composite_sum_sources(&unit), 2, "both children feed the sum");

        // Disconnect CHILD_A: it leaves, CHILD_B must survive untouched.
        engine.graph.transaction(&[Update::Pointer {
            address: Address::of(CHILD_A, vec![HOST_KEY]), old: Some(Address::of(COMPOSITE, vec![CHILDREN_FIELD])), new: None
        }], &engine.registry).expect("disconnect CHILD_A");
        engine.reconcile_one(&mut unit);
        assert_eq!(child_instrument_node(&unit, CHILD_A), None, "the removed child is gone");
        assert_eq!(child_instrument_node(&unit, CHILD_B), Some(child_b_node), "the surviving child keeps its processor");
        assert_eq!(composite_sum_sources(&unit), 1, "the removed child no longer feeds the sum (no stale buffer)");
    }

    fn child_instrument(unit: &AudioUnitBinding, child: Uuid) -> Option<NodeId> {
        match unit.wired.as_ref().expect("wired after reconcile") {
            Wired::Composite(composite) => composite.binding.child_instrument_node(child),
            _ => panic!("expected a composite chain")
        }
    }

    #[test]
    fn disabling_an_effect_inside_a_composite_child_bypasses_it_edge_only() {
        // A composite child (e.g. a Playfield slot) hosts its OWN audio-fx chain. Disabling one of those effects
        // (its `enabled`, key 4) must BYPASS it EDGE-ONLY: the effect's processor + the slot's instrument are kept
        // (no rebuild, no voice reset), only the wiring drops — exactly like a unit-level effect.
        const CHILD_FX: Uuid = [33u8; 16];
        const CHILD_AUDIO_FIELD: u16 = 40; // the child instrument hosts its audio chain here
        let mut engine = composite_engine();
        engine.devices[0].audio_effects_field = CHILD_AUDIO_FIELD; // TestInstrument children host an audio chain
        engine.graph = BoxGraph::from_boxes(vec![
            graph_box(UNIT, "AudioUnitBox", &[
                (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook),
                (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook)
            ]),
            graph_box(COMPOSITE, "TestComposite", &[
                (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_INPUT_KEY])))),
                (CHILDREN_FIELD, FieldValue::Hook)
            ]),
            graph_box(CHILD_A, "TestInstrument", &[
                (HOST_KEY, FieldValue::Pointer(Some(Address::of(COMPOSITE, vec![CHILDREN_FIELD])))),
                (CHILD_ENABLED_KEY, FieldValue::Boolean(true)), (CHILD_AUDIO_FIELD, FieldValue::Hook)
            ]),
            graph_box(CHILD_FX, "TestEffect", &[
                (HOST_KEY, FieldValue::Pointer(Some(Address::of(CHILD_A, vec![CHILD_AUDIO_FIELD])))),
                (EFFECT_INDEX_KEY, FieldValue::Int32(0)), (DEVICE_ENABLED_KEY, FieldValue::Boolean(true))
            ])
        ]);
        let mut unit = engine.build_unit(UNIT);
        engine.reconcile_one(&mut unit);
        let instrument_node = child_instrument(&unit, CHILD_A).expect("slot instrument built");
        assert_eq!(child_audio_members(&unit, CHILD_A), Some(1), "the slot owns its one effect");
        assert_eq!(child_wired_audio(&unit, CHILD_A), Some(1), "and the enabled effect is wired in");

        // Disable the child's effect: it is BYPASSED — still OWNED (member persists) but no longer wired. The
        // slot's instrument processor is the SAME (no rebuild, voice preserved).
        let toggle = |engine: &mut Engine, from: bool, to: bool| engine.graph.transaction(&[Update::Primitive {
            address: Address::of(CHILD_FX, vec![DEVICE_ENABLED_KEY]),
            old: FieldValue::Boolean(from), new: FieldValue::Boolean(to)
        }], &engine.registry).expect("toggle child effect enabled");
        toggle(&mut engine, true, false);
        engine.reconcile_one(&mut unit);
        assert_eq!(child_audio_members(&unit, CHILD_A), Some(1), "the disabled effect is still owned (not torn down)");
        assert_eq!(child_wired_audio(&unit, CHILD_A), Some(0), "but it is bypassed — not wired into the slot");
        assert_eq!(child_instrument(&unit, CHILD_A), Some(instrument_node), "the slot instrument is untouched (edge-only)");

        // Re-enable: the SAME effect processor is wired back, instrument still untouched.
        toggle(&mut engine, false, true);
        engine.reconcile_one(&mut unit);
        assert_eq!(child_wired_audio(&unit, CHILD_A), Some(1), "the re-enabled effect is wired back in");
        assert_eq!(child_instrument(&unit, CHILD_A), Some(instrument_node), "still the same slot instrument");
    }

    #[test]
    fn disabling_a_composite_child_drops_it_from_the_sum_edge_only() {
        let mut engine = composite_engine();
        engine.graph = composite_graph();
        let mut unit = engine.build_unit(UNIT);
        // Connect CHILD_B so both children are summed.
        engine.graph.transaction(&[Update::Pointer {
            address: Address::of(CHILD_B, vec![HOST_KEY]), old: None, new: Some(Address::of(COMPOSITE, vec![CHILDREN_FIELD]))
        }], &engine.registry).expect("connect CHILD_B");
        engine.reconcile_one(&mut unit);
        let child_b_node = child_instrument_node(&unit, CHILD_B).expect("CHILD_B built");
        assert_eq!(composite_sum_sources(&unit), 2, "both enabled children feed the sum");

        // Disable CHILD_B (its `enabled` field): it must leave the sum, but keep its processor (edge-only).
        let toggle = |engine: &mut Engine, from: bool, to: bool| engine.graph.transaction(&[Update::Primitive {
            address: Address::of(CHILD_B, vec![CHILD_ENABLED_KEY]),
            old: FieldValue::Boolean(from), new: FieldValue::Boolean(to)
        }], &engine.registry).expect("toggle CHILD_B enabled");
        toggle(&mut engine, true, false);
        engine.reconcile_one(&mut unit);
        assert_eq!(composite_sum_sources(&unit), 1, "the disabled child no longer feeds the sum");
        assert_eq!(child_instrument_node(&unit, CHILD_B), Some(child_b_node), "but its processor is kept (not rebuilt)");

        // Re-enable: it rejoins the sum, same processor.
        toggle(&mut engine, false, true);
        engine.reconcile_one(&mut unit);
        assert_eq!(composite_sum_sources(&unit), 2, "the re-enabled child feeds the sum again");
        assert_eq!(child_instrument_node(&unit, CHILD_B), Some(child_b_node), "still the same processor instance");
    }

    #[test]
    fn build_param_track_resolves_the_full_field_path_at_any_depth() {
        // A three-level path — deeper than the old packed u32 key could ever represent — resolves the track.
        let deep = [16u16, 5, 10];
        let mut graph = deep_automation_graph(&deep);
        let (curve, track_uuid, collections) = build_param_track(&mut graph, DEVICE, &deep);
        let curve = curve.expect("the parameter at the deep path has an automation track");
        assert_eq!(track_uuid, Some(TRACK), "the targeting track is found (its region hub is then watched)");
        assert_eq!(collections.len(), 1, "its one value region's collection is observed");
        assert_eq!(curve.value_at(0.0, -1.0), 0.7, "and the curve reads its event through that path");
        // A different path on the same device has no track.
        let (none, _, _) = build_param_track(&mut graph, DEVICE, &[16, 5, 11]);
        assert!(none.is_none(), "an unbound path has no automation track");
    }

    #[test]
    fn build_param_track_resolves_only_the_targeting_track_among_unrelated_ones() {
        // Two automation chains on ONE device at DIFFERENT parameter paths. The targeted (incoming-pointer)
        // lookup must resolve each parameter to its OWN track and ONLY that track's value regions — never the
        // other chain's. This is the behaviour the find_all_by_name scans had; it must survive the rewrite.
        const TRACK_B: Uuid = [18u8; 16];
        const REGION_B: Uuid = [17u8; 16];
        const VCOLLECTION_B: Uuid = [16u8; 16];
        const EVENT_B: Uuid = [15u8; 16];
        let path_a = [5u16];
        let path_b = [6u16];
        let chain = |track: Uuid, region: Uuid, collection: Uuid, event: Uuid, path: &[u16], value: f32| vec![
            graph_box(track, "TrackBox", &[
                (2, FieldValue::Pointer(Some(Address::of(DEVICE, path.to_vec())))),
                (3, FieldValue::Hook)
            ]),
            graph_box(region, "ValueRegionBox", &[
                (1, FieldValue::Pointer(Some(Address::of(track, vec![3])))),
                (2, FieldValue::Pointer(Some(Address::of(collection, vec![2])))),
                (10, FieldValue::Int32(0)), (11, FieldValue::Int32(3840)), (12, FieldValue::Int32(0)), (13, FieldValue::Int32(3840))
            ]),
            graph_box(collection, "ValueEventCollectionBox", &[(1, FieldValue::Hook), (2, FieldValue::Hook)]),
            graph_box(event, "ValueEventBox", &[
                (1, FieldValue::Pointer(Some(Address::of(collection, vec![1])))), (10, FieldValue::Int32(0)), (13, FieldValue::Float32(value))
            ])
        ];
        let mut boxes = vec![graph_box(DEVICE, "RevampDeviceBox", &[])];
        boxes.extend(chain(TRACK, REGION, VCOLLECTION, EVENT, &path_a, 0.7));
        boxes.extend(chain(TRACK_B, REGION_B, VCOLLECTION_B, EVENT_B, &path_b, 0.3));
        let mut graph = BoxGraph::from_boxes(boxes);

        let (curve_a, track_a, cols_a) = build_param_track(&mut graph, DEVICE, &path_a);
        assert_eq!(track_a, Some(TRACK), "param A resolves to its own track");
        assert_eq!(cols_a.len(), 1, "param A observes ONLY its own track's value region");
        assert_eq!(curve_a.expect("curve A").value_at(0.0, -1.0), 0.7);

        let (curve_b, track_b, cols_b) = build_param_track(&mut graph, DEVICE, &path_b);
        assert_eq!(track_b, Some(TRACK_B), "param B resolves to the OTHER track");
        assert_eq!(cols_b.len(), 1, "param B observes ONLY its own track's value region");
        assert_eq!(curve_b.expect("curve B").value_at(0.0, -1.0), 0.3);
    }

    #[test]
    fn param_curve_holds_boundary_values_around_and_between_regions() {
        // Two value regions on one track: A spans [0,100) holding 0.2, B spans [200,300) holding 0.8.
        // `ParamCurve::value_at` must (TS `TrackBoxAdapter.valueAt`): before the first region read its
        // INCOMING value; inside a region read its curve; OUTSIDE a region (the gap after it, or past the
        // last) HOLD that region's OUTGOING value — never jump to the next region early or fall back.
        const REGION_A: Uuid = [20u8; 16];
        const COLL_A: Uuid = [21u8; 16];
        const EVENT_A: Uuid = [22u8; 16];
        const REGION_B: Uuid = [23u8; 16];
        const COLL_B: Uuid = [24u8; 16];
        const EVENT_B: Uuid = [25u8; 16];
        let path = [5u16];
        // One constant-value region: events collection with a single event (held) at local 0.
        let region = |region: Uuid, collection: Uuid, event: Uuid, position: i32, value: f32| vec![
            graph_box(region, "ValueRegionBox", &[
                (1, FieldValue::Pointer(Some(Address::of(TRACK, vec![3])))),
                (2, FieldValue::Pointer(Some(Address::of(collection, vec![2])))),
                (10, FieldValue::Int32(position)), (11, FieldValue::Int32(100)), (12, FieldValue::Int32(0)), (13, FieldValue::Int32(0))
            ]),
            graph_box(collection, "ValueEventCollectionBox", &[(1, FieldValue::Hook), (2, FieldValue::Hook)]),
            graph_box(event, "ValueEventBox", &[
                (1, FieldValue::Pointer(Some(Address::of(collection, vec![1])))), (10, FieldValue::Int32(0)), (13, FieldValue::Float32(value))
            ])
        ];
        let mut boxes = vec![
            graph_box(DEVICE, "RevampDeviceBox", &[]),
            graph_box(TRACK, "TrackBox", &[(2, FieldValue::Pointer(Some(Address::of(DEVICE, path.to_vec())))), (3, FieldValue::Hook)])
        ];
        boxes.extend(region(REGION_A, COLL_A, EVENT_A, 0, 0.2));
        boxes.extend(region(REGION_B, COLL_B, EVENT_B, 200, 0.8));
        let mut graph = BoxGraph::from_boxes(boxes);
        let curve = build_param_track(&mut graph, DEVICE, &path).0.expect("two regions -> a curve");

        assert_eq!(curve.value_at(-10.0, -1.0), 0.2, "before the first region: its incoming value");
        assert_eq!(curve.value_at(50.0, -1.0), 0.2, "inside region A");
        assert_eq!(curve.value_at(150.0, -1.0), 0.2, "in the gap after A: A's HELD outgoing value, not B's");
        assert_eq!(curve.value_at(250.0, -1.0), 0.8, "inside region B");
        assert_eq!(curve.value_at(500.0, -1.0), 0.8, "past the last region: B's HELD outgoing value");
    }

    #[test]
    fn build_param_track_resolves_a_scriptable_devices_child_parameter() {
        // A scriptable device's @param is a WerkstattParameterBox CHILD under the device's `parameters` hub
        // (key 11); a Value track automating it targets the CHILD's `value` field (key 4) — NOT a field on the
        // device box. `observe_script_params` binds `(child, [4])`, so `build_param_track` must resolve the
        // child's automation exactly as it does a fixed device field. This is the param-hub reuse claim.
        const CHILD: Uuid = [42u8; 16];
        let mut graph = BoxGraph::from_boxes(vec![
            graph_box(DEVICE, "WerkstattDeviceBox", &[(11, FieldValue::Hook)]),
            graph_box(CHILD, "WerkstattParameterBox", &[
                (1, FieldValue::Pointer(Some(Address::of(DEVICE, vec![11])))), // owner -> device.parameters
                (3, FieldValue::Int32(0)),                                     // declaration index
                (4, FieldValue::Float32(0.3))                                  // static value (ignored when automated)
            ]),
            graph_box(TRACK, "TrackBox", &[
                (2, FieldValue::Pointer(Some(Address::of(CHILD, vec![4])))),   // target -> the CHILD's value field
                (3, FieldValue::Hook)
            ]),
            graph_box(REGION, "ValueRegionBox", &[
                (1, FieldValue::Pointer(Some(Address::of(TRACK, vec![3])))),
                (2, FieldValue::Pointer(Some(Address::of(VCOLLECTION, vec![2])))),
                (10, FieldValue::Int32(0)), (11, FieldValue::Int32(3840)), (12, FieldValue::Int32(0)), (13, FieldValue::Int32(3840))
            ]),
            graph_box(VCOLLECTION, "ValueEventCollectionBox", &[(1, FieldValue::Hook), (2, FieldValue::Hook)]),
            graph_box(EVENT, "ValueEventBox", &[
                (1, FieldValue::Pointer(Some(Address::of(VCOLLECTION, vec![1])))), (10, FieldValue::Int32(0)), (13, FieldValue::Float32(0.7))
            ])
        ]);
        let (curve, track_uuid, collections) = build_param_track(&mut graph, CHILD, &[4]);
        assert_eq!(track_uuid, Some(TRACK), "the track targeting the child's value field is found");
        assert_eq!(collections.len(), 1, "its one value region's collection is observed");
        assert_eq!(curve.expect("child param has an automation curve").value_at(0.0, -1.0), 0.7,
            "the unit automation value reaches the child param (the bridge then maps it via the @param)");
    }

    #[test]
    fn a_field_edit_raises_the_light_signal_and_an_attach_the_heavy_one() {
        // A knob drag (a Primitive field update) must NOT trigger the automation re-bind machinery: it raises
        // the LIGHT params signal (one value push at reconcile). Attaching a Value TRACK is structural and
        // keeps the heavy automation signal.
        const DEV: Uuid = [40u8; 16];
        const ATRACK: Uuid = [41u8; 16];
        let mut engine = engine_with_devices();
        engine.graph = BoxGraph::from_boxes(vec![
            graph_box(DEV, "TestEffect", &[(10, FieldValue::Float32(0.5))]),
            graph_box(ATRACK, "TrackBox", &[(2, FieldValue::Pointer(None)), (3, FieldValue::Hook)])
        ]);
        use core::cell::Cell;
        let params_flag = Rc::new(Cell::new(false));
        let automation_flag = Rc::new(Cell::new(false));
        let light = params_flag.clone();
        super::set_params_signal(Some(Rc::new(move || light.set(true))));
        let heavy = automation_flag.clone();
        let invalidate: Rc<dyn Fn()> = Rc::new(move || heavy.set(true));
        let (_handle, subs, collections, _) = engine.observe_param(DEV, &[10], 0, &invalidate);
        super::set_params_signal(None);
        params_flag.set(false); // the catch-up fired the light signal; only the EDITS below matter
        automation_flag.set(false);
        engine.graph.transaction(&[Update::Primitive {
            address: Address::of(DEV, vec![10]),
            old: FieldValue::Float32(0.5), new: FieldValue::Float32(0.75)
        }], &engine.registry).expect("field edit");
        assert!(params_flag.get(), "a plain value edit raises the LIGHT signal");
        assert!(!automation_flag.get(), "and must NOT trigger the automation re-bind");
        params_flag.set(false);
        engine.graph.transaction(&[Update::Pointer {
            address: Address::of(ATRACK, vec![2]),
            old: None, new: Some(Address::of(DEV, vec![10]))
        }], &engine.registry).expect("track attach");
        assert!(automation_flag.get(), "an automation ATTACH raises the heavy signal");
        for sub in subs {
            engine.graph.unsubscribe(sub);
        }
        for collection in collections {
            collection.terminate(&mut engine.graph);
        }
    }

    #[test]
    fn an_unwired_send_goes_silent_instead_of_looping_the_stale_buffer() {
        // The send's source chain tears down (tap = None): the send must CLEAR its input, not keep summing
        // the last frozen buffer into the target bus forever (an audible stuck loop).
        use engine_env::audio_buffer::shared_audio_buffer;
        use engine_env::process_info::ProcessInfo;
        use engine_env::processor::Processor;
        const SEND: Uuid = [30u8; 16];
        let mut engine = engine_with_devices();
        engine.graph = BoxGraph::from_boxes(vec![
            graph_box(SEND, "AuxSendBox", &[
                (super::SEND_TARGET_KEY, FieldValue::Pointer(None)),
                (super::SEND_GAIN_KEY, FieldValue::Float32(0.0)),
                (super::SEND_PAN_KEY, FieldValue::Float32(0.0))
            ])
        ]);
        use engine_env::audio_generator::AudioGenerator;
        let mark = super::DirtyMark {units: Rc::new(RefCell::new(Vec::new())), unit: SEND};
        let invalidate: Rc<dyn Fn()> = Rc::new(|| {});
        let mut send = engine.build_send(SEND, &mark, &invalidate);
        let tap_buffer = shared_audio_buffer();
        {
            let mut buffer = tap_buffer.borrow_mut();
            for index in 0..engine_env::RENDER_QUANTUM {
                buffer.left[index] = 1.0;
                buffer.right[index] = 1.0;
            }
        }
        engine.resolve_one_send(&mut send, &Some((engine.master_id, tap_buffer)));
        send.proc.borrow_mut().process(&ProcessInfo {blocks: &[]});
        let wired = send.proc.borrow().audio_output().borrow().left[0];
        assert!(wired.abs() > 0.5, "the wired send passes the tap (got {wired})");
        // The chain is torn down: the tap vanishes. The send must output SILENCE now.
        engine.resolve_one_send(&mut send, &None);
        send.proc.borrow_mut().process(&ProcessInfo {blocks: &[]});
        let after = send.proc.borrow().audio_output().borrow().left[0];
        assert_eq!(after, 0.0, "an unwired send is silent, not a stale-buffer loop");
        engine.teardown_send(send);
    }

    #[test]
    fn rebinding_strip_automation_does_not_leak_subscriptions() {
        // A Value track automates the UNIT's volume (key 12). `bind_strip_automation` re-runs on every real
        // automation change; each pass must terminate the previous pass's ValueCollections, else their hub /
        // event / curve observers accumulate in the graph for the session.
        const VTRACK: Uuid = [20u8; 16];
        const VREGION: Uuid = [21u8; 16];
        const VCOLL: Uuid = [22u8; 16];
        const VEVENT: Uuid = [23u8; 16];
        let mut engine = engine_with_devices();
        let mut boxes = vec![
            graph_box(UNIT, "AudioUnitBox", &[
                (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook), (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook)
            ]),
            graph_box(INSTR, "TestInstrument", &[
                (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_INPUT_KEY]))))
            ])
        ];
        boxes.extend(vec![
            graph_box(VTRACK, "TrackBox", &[
                (2, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_VOLUME_KEY])))),
                (3, FieldValue::Hook)
            ]),
            graph_box(VREGION, "ValueRegionBox", &[
                (1, FieldValue::Pointer(Some(Address::of(VTRACK, vec![3])))),
                (2, FieldValue::Pointer(Some(Address::of(VCOLL, vec![2])))),
                (10, FieldValue::Int32(0)), (11, FieldValue::Int32(3840)), (12, FieldValue::Int32(0)), (13, FieldValue::Int32(3840))
            ]),
            graph_box(VCOLL, "ValueEventCollectionBox", &[(1, FieldValue::Hook), (2, FieldValue::Hook)]),
            graph_box(VEVENT, "ValueEventBox", &[
                (1, FieldValue::Pointer(Some(Address::of(VCOLL, vec![1])))), (10, FieldValue::Int32(0)), (13, FieldValue::Float32(0.5))
            ])
        ]);
        engine.graph = BoxGraph::from_boxes(boxes);
        let mut unit = engine.build_unit(UNIT);
        engine.bind_strip_automation(&mut unit);
        let baseline = engine.graph.subscription_count();
        for _ in 0..3 {
            engine.bind_strip_automation(&mut unit);
        }
        assert_eq!(engine.graph.subscription_count(), baseline,
            "repeated strip-automation rebinds must not grow the graph's observer count");
        let with_unit = baseline;
        engine.teardown_unit(unit);
        assert!(engine.graph.subscription_count() < with_unit,
            "teardown released the strip observers (count must drop below the bound state)");
    }
}
