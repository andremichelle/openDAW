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
//!
//! Split across files by concern: this file (shared types + the top-level lifecycle) + `wiring` (chain /
//! cluster builders) + `routing` (sends, outputs, sidechains) + `tracks` (the track/region/clip cascade) +
//! `params` (device parameter automation) + `tests` (the whole suite, whitebox over every submodule).

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
use boxgraph::field::FieldValue;
use boxgraph::graph::BoxGraph;
use boxgraph::subscription::{HubEvent, Propagation, SubscriptionId, UpdateObserver};
use boxgraph::updates::Update;
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
use engine_env::note_content_source::{NoteContentSource, NoteTrackAccess};
use engine_env::note_sequencer::NoteSequencer;
use value::event::EventCollection;
use value::note::NoteEvent;
use value::region::{RegionCollection, Span};
use crate::param_automation::{BoundValueClip, FieldPath, ParamCurve, ParamHandle, ParamSink, ValueBoundRegion};
use crate::plugin_audio_effect::PluginAudioEffect;
use crate::plugin_instrument::PluginInstrument;
use crate::plugin_midi_effect::PluginMidiEffect;
use crate::composite::CompositeBinding;
use crate::effect_composite::EffectCompositeBinding;
use crate::audio_region_player::AudioRegionPlayer;
use crate::midi_output::{self, CcBinding, MidiOutControls, MidiOutProcessor};
use crate::time_stretch::{TimeStretchConfig, TransientPlayMode};
use crate::tempo_map::{SharedTempoMap, TempoMap};
use crate::{call_device_init, call_device_field_changed, call_device_parameter_changed, call_device_sample_changed, call_device_soundfont_changed, call_device_terminate, CompositeSpec, DeviceReg, Engine, FieldObs, PullLink, BIND, BROADCAST_BINDS, DEVICE_BROADCASTS, DEVICE_BROADCAST_FREE, FIELD_OBS, SAMPLE_OBS, SAMPLES, SOUNDFONT_OBS, SOUNDFONTS, SIDECHAIN_BIND, CURRENT_DEVICE_UUID, EFFECT_INDEX_KEY};

mod wiring;
mod routing;
mod tracks;
pub(crate) mod params;
#[cfg(test)]
mod tests;

pub(crate) use tracks::{AudioRegion, SignalsmithConfig, BoundAudioClip, BoundNoteTracks, SharedAudioTrackSets, SharedTrackSets,
    TrackBinding, AudioTrackBinding, CollectionCache, reconcile_tracks, teardown_track, teardown_audio_track};
pub(crate) use params::{resolve_and_deliver_sample, NoteSignal, set_params_signal,
    params_invalidate, automation_invalidate};
pub(crate) use wiring::tape_region_counts;
// Re-exported ONLY for the sibling test module's `super::` (whitebox) paths; not used by the non-test build.
#[cfg(test)]
pub(crate) use tracks::TRACK_CLIPS_KEY;
#[cfg(test)]
pub(crate) use params::note_signal_to_unit;

// AudioUnitBox field keys (WASM CONTRACT: mirror the TS AudioUnitBox schema). The unit carries its strip
// params and hosts its instrument / effect chains / tracks at these hub keys.
const UNIT_VOLUME_KEY: u16 = 12;
const UNIT_PANNING_KEY: u16 = 13;
const UNIT_MUTE_KEY: u16 = 14;
const UNIT_SOLO_KEY: u16 = 15;
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
// The MIDI-output instrument (engine-side like the tape: it emits MIDI messages, no audio).
// WASM CONTRACT: MIDIOutputDeviceBox field keys — enabled 4, channel 11, parameters 13 (hub), device 14
// (pointer -> MIDIOutputBox); MIDIOutputParameterBox — controller 3 (Int32), value 4 (unipolar Float32).
const MIDI_OUT_BOX_TYPE: &str = "MIDIOutputDeviceBox";
const MIDI_OUT_CHANNEL_KEY: u16 = 11;
const MIDI_OUT_PARAMETERS_KEY: u16 = 13;
const MIDI_OUT_DEVICE_KEY: u16 = 14;
const MIDI_OUT_PARAM_CONTROLLER_KEY: u16 = 3;
const MIDI_OUT_PARAM_VALUE_KEY: u16 = 4;
// AuxSendBox fields: targetBus (2, pointer -> the bus's `input`), sendGain (5, dB), sendPan (6, bipolar).
const SEND_TARGET_KEY: u16 = 2;
const SEND_GAIN_KEY: u16 = 5;
const SEND_PAN_KEY: u16 = 6;

/// The handle a unit's subscriptions use to enqueue THAT unit for reconcile when its scope changes, so a
/// related edit reconciles one unit instead of sweeping all units (the Rust analog of TS's per-unit
/// `invalidateWiring`). `units` is the engine's shared `dirty_units` queue; `unit` is this unit's uuid.
#[derive(Clone)]
pub(crate) struct DirtyMark {
    pub(crate) units: Rc<RefCell<Vec<Uuid>>>,
    pub(crate) unit: Uuid
}

impl DirtyMark {
    /// Enqueue this unit (de-duplicated) for the next reconcile.
    pub(crate) fn mark(&self) {
        let mut units = self.units.borrow_mut();
        if !units.contains(&self.unit) {
            units.push(self.unit);
        }
    }

    /// A bare `Fn()` form for the binders (`IndexedCollection`, composite) that take an opaque dirty signal.
    pub(crate) fn signal(&self) -> Rc<dyn Fn()> {
        let mark = self.clone();
        Rc::new(move || mark.mark())
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

/// What the engine wired for one unit. A LEAF-instrument unit owns its device processors PERSISTENTLY (the
/// analog of TS `AudioDeviceChain`'s `#effects`): a chain edit keeps the survivors and only creates joiners /
/// terminates leavers, re-wiring EDGES ONLY (the `#disconnector` analog), so no survivor's DSP state is reset.
/// A COMPOSITE-instrument unit keeps the older whole-cluster bundle (its instrument is a child cascade, not a
/// single processor; per-child lifecycle lives in the `composite` module).
#[allow(clippy::large_enum_variant)] // the common variant is the live one; boxing it would add a per-build heap allocation
pub(crate) enum Wired {
    Leaf(LeafChain),
    Composite(CompositeWired),
    Tape(TapeWired),
    Bus(BusWired),
    Frozen(FrozenWired),
    MidiOut(MidiOutWired)
}

/// A MIDI-OUTPUT unit's wiring (TS `MIDIOutputDeviceProcessor`, engine-side like the tape): the MidiOut
/// node pulls the unit's note stream through its midi-fx pull chain and queues MIDI messages; its audio
/// output is SILENT and still feeds the unit's audio-fx chain + channel strip (the TS unit wiring over the
/// silent device output — meters / sends / routing behave identically). Rebuilt wholesale on a chain edit
/// (midi/audio members pooled so survivors keep their state); the note sequencer persists while the
/// instrument box survives (held notes preserved).
pub(crate) struct MidiOutWired {
    pub(crate) node: Rc<RefCell<MidiOutProcessor>>,
    pub(crate) node_id: NodeId,
    pub(crate) instrument_uuid: Uuid, // the MIDIOutputDeviceBox uuid
    pub(crate) sequencer: SharedNoteEventSource,
    #[allow(dead_code)] // shared with the node + the box-field subscriptions; retained for tests
    pub(crate) controls: Rc<MidiOutControls>,
    pub(crate) midi: Vec<Member>,
    pub(crate) audio: Vec<Member>,
    pub(crate) pre_strip: SharedAudioBuffer,
    pub(crate) pre_strip_node: NodeId,
    pub(crate) strip_id: NodeId,
    pub(crate) strip_output: SharedAudioBuffer,
    pub(crate) edges: Vec<(NodeId, NodeId)>,
    pub(crate) subs: Vec<SubscriptionId>,           // enabled + channel + device pointer + parameters-hub monitors
    pub(crate) cc_subs: Vec<SubscriptionId>,        // the CC parameters' field / automation observations
    pub(crate) cc_collections: Vec<ValueCollection>,
    pub(crate) monitor_node: Option<NodeId>
}

/// A FROZEN unit's wiring (TS `AudioDeviceChain.#wire`'s frozen branch): the pre-rendered PCM player
/// replaces the instrument + fx; the LIVE channel strip still applies (fader / mute / panning), and the
/// aux sends read the player output (`pre_strip`). Rebuilt wholesale on freeze / unfreeze.
pub(crate) struct FrozenWired {
    pub(crate) player_id: NodeId,
    pub(crate) pre_strip: SharedAudioBuffer, // the player output (the send tap)
    pub(crate) strip_id: NodeId,
    pub(crate) strip_output: SharedAudioBuffer,
    pub(crate) edges: Vec<(NodeId, NodeId)>
}

impl Wired {
    /// The unit's channel-strip node + output buffer — the source a `resolve_outputs` route feeds into its
    /// target bus. Uniform across every wiring kind.
    pub(crate) fn strip(&self) -> (NodeId, SharedAudioBuffer) {
        match self {
            Wired::Leaf(chain) => (chain.strip_id, chain.strip_output.clone()),
            Wired::Composite(composite) => (composite.strip_id, composite.strip_output.clone()),
            Wired::Tape(tape) => (tape.strip_id, tape.strip_output.clone()),
            Wired::Bus(bus) => (bus.strip_id, bus.strip_output.clone()),
            Wired::Frozen(frozen) => (frozen.strip_id, frozen.strip_output.clone()),
            Wired::MidiOut(midi) => (midi.strip_id, midi.strip_output.clone())
        }
    }

    /// The POST-effects / PRE-fader tap: the buffer feeding the channel strip + the node that produces it. An
    /// `AuxSendProcessor` reads this buffer (pre volume/pan/mute) and depends on this node for ordering.
    pub(crate) fn pre_strip(&self) -> (NodeId, SharedAudioBuffer) {
        match self {
            Wired::Leaf(chain) => (chain.pre_strip_node, chain.pre_strip.clone()),
            Wired::Composite(composite) => (composite.pre_strip_node, composite.pre_strip.clone()),
            Wired::Tape(tape) => (tape.pre_strip_node, tape.pre_strip.clone()),
            Wired::Bus(bus) => (bus.pre_strip_node, bus.pre_strip.clone()),
            Wired::Frozen(frozen) => (frozen.player_id, frozen.pre_strip.clone()),
            Wired::MidiOut(midi) => (midi.pre_strip_node, midi.pre_strip.clone())
        }
    }
}

/// A RETURN / submix-bus unit's wiring: its `AudioBusBox` input becomes a summing `AudioBusProcessor` (`sum`,
/// registered in `bus_registry` so sources route into it); the bus's own audio-effect chain runs over the sum
/// (`sum -> fx0 -> ... -> strip`), and the strip's output is routed to the bus's own `output` target like any
/// unit. Rebuilt wholesale on a chain edit (like tape / composite), so `nodes` / `edges` / `device_params`
/// carry everything to tear down.
pub(crate) struct BusWired {
    pub(crate) bus_uuid: Uuid, // the AudioBusBox uuid; its sum node + `bus_registry` entry are dropped on teardown
    pub(crate) sum_buffer: SharedAudioBuffer, // the RAW sum (pre-fx), the `useInstrumentOutput` stem tap
    pub(crate) pre_strip: SharedAudioBuffer, // the fx-chain output feeding the strip (the send tap)
    pub(crate) pre_strip_node: NodeId,
    pub(crate) strip_id: NodeId,
    pub(crate) strip_output: SharedAudioBuffer,
    pub(crate) nodes: Vec<NodeId>,           // sum + fx nodes + strip (removed on teardown)
    pub(crate) edges: Vec<(NodeId, NodeId)>, // sum -> fx0 -> ... -> strip
    pub(crate) device_params: Vec<DeviceParams>,
    pub(crate) sidechains: Vec<SidechainBinding>, // a sidechained bus effect (e.g. a ducking compressor) resolved each pass
    pub(crate) subs: Vec<SubscriptionId>     // the bus `enabled` monitor + each fx device's `enabled` monitor
}

/// A unit's currently-wired OUTPUT route: which target bus sum its channel strip feeds. `bus` is the target
/// `AudioBusBox` uuid (`None` = the primary bus, i.e. the fixed `master` fallback); `sum_id` the sum node the
/// strip edge points at; `strip_id` / `strip_output` the source, kept so the route can be torn down (remove the
/// summed source + the edge) even after the strip is rebuilt. Diffed each `resolve_outputs` pass so a re-point
/// or a strip rebuild re-wires exactly once.
pub(crate) struct Routed {
    pub(crate) bus: Option<Uuid>,
    pub(crate) sum_id: NodeId,
    pub(crate) strip_id: NodeId,
    pub(crate) strip_output: SharedAudioBuffer
}

/// One built parallel AUX SEND: the `AuxSendProcessor` tapping this unit's PRE-fader buffer, plus its resolution
/// state. `source` is the pre-strip node currently wired as its input; `target` the resolved target bus (uuid +
/// sum node) its output feeds; both diffed in `resolve_sends` so a re-point / strip rebuild re-wires once.
pub(crate) struct SendBinding {
    pub(crate) send_uuid: Uuid,
    pub(crate) proc: Rc<RefCell<AuxSendProcessor>>,
    pub(crate) node_id: NodeId,
    pub(crate) source: Option<NodeId>,
    pub(crate) target: Option<(Option<Uuid>, NodeId)>,
    pub(crate) subs: Vec<SubscriptionId>, // targetBus (2) pointer monitor + sendGain (5) / sendPan (6) field observers
    pub(crate) automation: Rc<StripAutomation>, // sendGain / sendPan automation overrides (volume = gain dB, panning = pan)
    pub(crate) param_subs: Vec<SubscriptionId>, // the automation observers, re-observed on a real automation change
    pub(crate) param_collections: Vec<ValueCollection> // keep the send curves' region collections alive (terminated on rebind)
}

/// A TAPE / audio-region unit's wiring: the engine-side audio-region player (reads the unit's AUDIO tracks) ->
/// channel strip -> master. The player is owned by the context (removed by `player_id` on teardown); it reads
/// `audio_track_sets` live, so a region edit needs no rebuild.
pub(crate) struct TapeWired {
    pub(crate) player: Rc<RefCell<AudioRegionPlayer>>, // kept so a region edit can pre-warm the pool (see `prepare`)
    pub(crate) enabled_sub: SubscriptionId, // TapeDeviceBox `enabled` (4): gates the player, resets on disable (TS mirror)
    pub(crate) player_id: NodeId,
    pub(crate) instrument_uuid: Uuid,        // the TapeDeviceBox uuid: the player output is registered under it so a SIDECHAIN
                                  // targeting the tape device taps its RAW output (pre fx / strip), matching TS
    pub(crate) audio: Vec<Member>,           // the unit's AUDIO-effects chain (player -> fx0 -> ... -> strip), like a leaf
    pub(crate) pre_strip: SharedAudioBuffer, // the fx-chain output feeding the strip (the send tap; == player output if no fx)
    pub(crate) pre_strip_node: NodeId,
    pub(crate) strip_id: NodeId,
    pub(crate) strip_output: SharedAudioBuffer,
    pub(crate) edges: Vec<(NodeId, NodeId)>, // player -> fx0 -> ... -> strip
    pub(crate) monitor_node: Option<NodeId>  // the EFFECTS-monitoring injector, rebuilt per re-wire
}

/// A held device processor, kept alive across rewires so its DSP state (voices, delay tails, filter history)
/// survives a chain edit. The `Rc` is also how a rewire re-points the survivor (`set_audio_source` /
/// `set_pull_chain`) without recreating it.
pub(crate) enum ProcHandle {
    Instrument(Rc<RefCell<PluginInstrument>>),
    Audio(Rc<RefCell<PluginAudioEffect>>),
    Midi(Rc<PluginMidiEffect>),
    // A parallel EFFECT COMPOSITE: not one plugin but a whole sub-graph (distributor -> entries -> wet sum ->
    // dry/wet mix) the engine owns itself. It sits in an audio chain like any other member — see `Member`'s
    // `input_node` for how the chain wires through it.
    EffectComposite(Box<EffectCompositeBinding>)
}

/// One persistent chain member: its device box uuid, the held processor, its graph node (none for a midi-fx,
/// which is folded into the instrument's PULL chain and has no audio node), its audio output (for wiring the
/// next node), its bound parameters (bound ONCE on join, reused untouched on survive — re-binding re-runs the
/// device `init`, which resets DSP), and an audio-fx's optional sidechain binding.
pub(crate) struct Member {
    pub(crate) uuid: Uuid,
    pub(crate) proc: ProcHandle,
    // The chain's EXIT node for this member: what the next member reads / edges from. For a plugin it is the
    // plugin's node; for an effect composite it is the dry/wet mix at the composite's end.
    pub(crate) node_id: Option<NodeId>,
    // The chain's ENTRY node: what the PREVIOUS member edges INTO. `None` means "same as `node_id`", which is
    // every plugin. An effect composite differs: the upstream feeds its DISTRIBUTOR while its exit is the mix,
    // so the chain wires `prev -> input_node` and continues from `node_id`.
    pub(crate) input_node: Option<NodeId>,
    pub(crate) output: Option<SharedAudioBuffer>,
    // The device's bound parameters. `None` for a member that is NOT a plugin (an effect composite: its dry /
    // wet and its entries' gain / mute / solo are bound by its own binding, not through the device ABI).
    pub(crate) params: Option<DeviceParams>,
    pub(crate) sidechain: Option<SidechainBinding>,
    // A TARGETED `This` monitor on the device's `enabled` field: toggling it re-wires the unit (edge-only —
    // a disabled effect is skipped in the chain, its processor + params + DSP state left untouched).
    pub(crate) enabled_sub: SubscriptionId
}

/// A leaf unit's persistent chain: the instrument, its midi-fx (pull-chain order) and audio-fx (graph order)
/// members, the channel strip, and the CURRENT edge set (rebuilt edge-only each reconcile). Members persist
/// across reconciles; only the diff (joiners / leavers) and the edges change.
pub(crate) struct LeafChain {
    pub(crate) instrument: Member,
    // The instrument's note SOURCE. It holds per-block state (notes retained across blocks), so it persists
    // and is REUSED while the instrument survives — recreating it mid-play would drop the held notes (stuck /
    // re-triggered notes). Rebuilt only when the instrument itself changes.
    pub(crate) sequencer: SharedNoteEventSource,
    pub(crate) midi: Vec<Member>,
    pub(crate) audio: Vec<Member>,
    pub(crate) strip: Rc<RefCell<ChannelStripProcessor>>,
    pub(crate) pre_strip: SharedAudioBuffer, // the fx-chain output feeding the strip (the send tap)
    pub(crate) pre_strip_node: NodeId,
    pub(crate) strip_id: NodeId,
    pub(crate) strip_output: SharedAudioBuffer,
    pub(crate) edges: Vec<(NodeId, NodeId)>,
    pub(crate) monitor_node: Option<NodeId> // the EFFECTS-monitoring injector, rebuilt per re-wire
}

/// Visit one chain member's device parameters, recursing into an effect composite's ENTRIES — so an automation
/// re-bind / param visit reaches every device in the cascade, not just the top-level plugins. A member that is
/// not a plugin (a composite) contributes none of its own.
pub(crate) fn visit_member_params(member: &mut Member, visit: &mut dyn FnMut(&mut DeviceParams)) {
    if let Some(params) = &mut member.params { visit(params); }
    if let ProcHandle::EffectComposite(binding) = &mut member.proc {
        binding.for_each_params(visit);
    }
}

/// Visit one chain member's sidechain bindings, recursing into an effect composite's ENTRIES — so the unit's
/// sidechain re-resolve reaches a device nested inside a composite.
pub(crate) fn visit_member_sidechains(member: &mut Member, visit: &mut dyn FnMut(&mut SidechainBinding)) {
    if let Some(binding) = &mut member.sidechain { visit(binding); }
    if let ProcHandle::EffectComposite(composite) = &mut member.proc {
        composite.for_each_sidechain(visit);
    }
}

/// A composite SLOT's persistent cluster (a direct-instrument child, e.g. a Playfield slot): the same per-member
/// machinery as a leaf unit (instrument + midi/audio members + note source), reconciled EDGE-ONLY so a chain edit
/// or an effect `enabled` toggle keeps every survivor's DSP state. Defined here (not in `composite`) so it can
/// reach the module-private `Member`. The owning child appends the slot's sum edge; the slot itself owns its
/// instrument note source (choke-routed) and internal edges.
pub(crate) struct SlotCluster {
    pub(crate) instrument: Member,
    pub(crate) sequencer: SharedNoteEventSource,
    pub(crate) midi: Vec<Member>,
    pub(crate) audio: Vec<Member>,
    pub(crate) internal_edges: Vec<(NodeId, NodeId)>,
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
        if let Some(params) = &mut self.instrument.params { visit(params); }
        for member in &mut self.midi { visit_member_params(member, visit); }
        for member in &mut self.audio { visit_member_params(member, visit); }
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
pub(crate) struct CompositeWired {
    pub(crate) binding: CompositeBinding,
    pub(crate) audio: Vec<Member>,           // the unit's AUDIO-effects chain (sum -> fx0 -> ... -> strip), like a leaf
    pub(crate) pre_strip: SharedAudioBuffer, // the fx-chain output feeding the strip (the send tap; == the sum if no fx)
    pub(crate) pre_strip_node: NodeId,
    pub(crate) strip_id: NodeId,
    pub(crate) strip_output: SharedAudioBuffer,
    pub(crate) tail_edges: Vec<(NodeId, NodeId)>, // sum -> fx0 -> ... -> strip
    // A TARGETED `This` monitor on the composite DEVICE's `enabled`: a toggle enqueues the unit (plain mark, NOT
    // `wiring_dirty`), so reconcile lands in the per-child branch and re-applies the sum gate without a rebuild.
    pub(crate) enabled_sub: SubscriptionId,
    pub(crate) monitor_node: Option<NodeId> // the EFFECTS-monitoring injector, rebuilt per re-wire
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
    pub(crate) device_uuid: Uuid,
    pub(crate) reg: DeviceReg,
    pub(crate) state_ptr: u32,
    pub(crate) sink: ParamNode,       // the node, to re-set params on a re-bind
    pub(crate) paths: Vec<FieldPath>, // the parameter field-paths the device declared in `init`
    pub(crate) handles: Vec<ParamHandle>,
    pub(crate) field_subs: Vec<SubscriptionId>,
    pub(crate) collections: Vec<ValueCollection>,
    pub(crate) observe_subs: Vec<SubscriptionId>, // the device's PLAIN field observations (`observe_field`), dropped on teardown
    // POINTER-CROSSING field observations (`observe_field` with a pointer at the path head, e.g. Zeitgeist's
    // `groove`): each cell holds the CURRENT target-field subscription, swapped by the pointer watcher (which
    // itself lives in `observe_subs`) on a repoint / clear. Unsubscribed by cell on teardown.
    pub(crate) pointer_field_subs: Vec<Rc<Cell<Option<SubscriptionId>>>>,
    pub(crate) sidechain_paths: Vec<Vec<u16>>, // the audio effect's declared sidechain pointer paths (`bind_sidechain`), in order
    // SCRIPTABLE devices: membership subscriptions on the dynamic `parameters` / `samples` collection hubs (fire
    // the unit's automation invalidate on a child add / remove). Kept SEPARATE from `field_subs`, since they
    // survive a `rebind_one` (which tears down + rebuilds only the per-parameter subscriptions). `None` for a
    // device without that collection. The per-child param/sample subscriptions live in `field_subs`/`observe_subs`.
    pub(crate) param_hub_sub: Option<SubscriptionId>,
    pub(crate) sample_hub_sub: Option<SubscriptionId>,
    // The device's LIVE-DATA broadcast slots (`host_bind_broadcast`): (global registry id, slot). The Rc keeps
    // the table entry alive (Weak-swept on drop); teardown zeroes the registry ptr + frees the id.
    pub(crate) broadcast_slots: Vec<(u32, engine_env::telemetry::BroadcastSlot)>
}

impl DeviceParams {
    /// The owning device box uuid, for the output-registry cleanup on a wholesale (non-member) teardown.
    pub(crate) fn device_uuid(&self) -> Uuid {
        self.device_uuid
    }
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
pub(crate) enum ParamNode {
    Audio(Rc<RefCell<dyn ParamSink>>),
    Midi(Rc<PluginMidiEffect>)
}

impl ParamNode {
    pub(crate) fn set_params(&self, params: Vec<ParamHandle>, clock_armed: bool) {
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
    pub(crate) unit: Uuid,
    pub(crate) track_sets: SharedTrackSets,
    pub(crate) collections: CollectionCache,
    pub(crate) tracks: Vec<TrackBinding>,
    pub(crate) audio_track_sets: SharedAudioTrackSets, // per-AUDIO-track region collections, read by the audio-region player
    pub(crate) audio_tracks: Vec<AudioTrackBinding>,
    pub(crate) track_changes: Rc<RefCell<Members>>,
    pub(crate) track_sub: SubscriptionId,
    pub(crate) strip_params: Rc<StripParams>,        // the unit's volume / panning / mute, kept in sync with its box
    pub(crate) strip_subs: Vec<SubscriptionId>,      // the volume / panning / mute field subscriptions
    pub(crate) strip_automation: Rc<StripAutomation>, // the unit's volume / panning AUTOMATION overrides (Value-track curves)
    pub(crate) strip_param_subs: Vec<SubscriptionId>, // the volume / panning parameter observations (field + track hubs)
    pub(crate) strip_param_collections: Vec<ValueCollection>, // keep the strip curves' region collections alive
    // The unit's NOTE-BITS broadcast (TS `NoteEventInstrument`'s `NoteBroadcaster` at the unit address,
    // an Integers package of 128 held-note bits): every instrument built for this unit (leaf or composite
    // slot) marks resolved note starts/completes here; the octave grids / note indicators subscribe to it.
    pub(crate) note_bits: engine_env::telemetry::BroadcastSlot,
    pub(crate) input: IndexedCollection,
    pub(crate) midi: IndexedCollection,
    pub(crate) audio: IndexedCollection,
    // SEND/RETURN: the unit's `output` (25) pointer monitor (a re-point enqueues the unit so `resolve_outputs`
    // re-routes it) + the CURRENT output route (which bus sum the strip feeds), and the `auxSends` (24)
    // collection + its built parallel sends. `routed` persists across rewires so a route can be torn down even
    // as the strip is rebuilt; `sends` each resolve their target bus in `resolve_sends`.
    pub(crate) output_sub: SubscriptionId,
    pub(crate) routed: Option<Routed>,
    pub(crate) aux_sends: IndexedCollection,
    pub(crate) sends: Vec<SendBinding>,
    // The wired processor graph: a leaf unit's persistent per-member chain, or a composite unit's bundle.
    // `None` until the first reconcile (or a unit with no resolvable instrument). The instrument's composite
    // cascade, the sidechain bindings, and the bound parameters all live INSIDE this now (per member for a
    // leaf, in the bundle for a composite), so they survive a chain edit exactly as far as the wiring does.
    pub(crate) wired: Option<Wired>,
    // Set by a parameter's TARGETED automation subscriptions (see `observe_params` / `automation_invalidate`)
    // when a Value track attaches / detaches or its data changes; `reconcile_one` then re-binds the unit's
    // curves (no rewire) and clears it.
    pub(crate) automation_dirty: Rc<Cell<bool>>,
    pub(crate) params_dirty: Rc<Cell<bool>>, // a plain field edit: push the value, no automation re-bind
    // Set by a device's `enabled` monitor: the chain membership did not change, but the unit must RE-WIRE
    // (skip / include the toggled effect). `reconcile_one` treats it like a chain-dirty so reconcile_leaf runs
    // its edge-only re-wire (survivors reused — no param push, no reset).
    pub(crate) wiring_dirty: Rc<Cell<bool>>,
    // Enqueues THIS unit for a targeted reconcile when any of its scope subscriptions (chains, tracks,
    // regions, automation, composite, sidechain pointers) fire — so a related edit rewires one unit.
    pub(crate) mark: DirtyMark
}

impl AudioUnitBinding {
    /// Clear the unit's held-note indicator bits (transport stop; TS `NoteBroadcaster.clear`).
    pub(crate) fn clear_note_bits(&self) {
        engine_env::telemetry::clear_note_bits(&self.note_bits);
    }

    /// The unit's STEM-EXPORT tap per its options (TS `AudioUnit.audioOutput()`): the raw chain start for
    /// `useInstrumentOutput` (the instrument / tape player / composite sum / bus sum output — pre-fx by
    /// construction, since the fx write their OWN buffers), the pre-strip (post-fx) buffer for
    /// `skipChannelStrip`, else the channel-strip output.
    pub(crate) fn stem_tap(&self, entry: &crate::StemEntry) -> Option<SharedAudioBuffer> {
        let wired = self.wired.as_ref()?;
        if entry.use_instrument_output {
            return Some(match wired {
                Wired::Leaf(chain) => chain.instrument.output.clone()?,
                Wired::Tape(tape) => tape.player.borrow().audio_output(),
                Wired::Composite(composite) => composite.binding.sum_buffer.clone(),
                Wired::Bus(bus) => bus.sum_buffer.clone(),
                Wired::Frozen(frozen) => frozen.pre_strip.clone(),
                Wired::MidiOut(midi) => midi.node.borrow().audio_output() // silent by construction
            });
        }
        if entry.skip_channel_strip {
            return Some(wired.pre_strip().1);
        }
        Some(wired.strip().1)
    }
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

    fn is_output_unit(&self, uuid: Uuid) -> bool {
        self.graph.field_value(&Address::of(uuid, vec![1])).and_then(|value| value.as_str()) == Some("output")
    }

    /// Apply a transaction's recorded changes: tear down / build audio units whose MEMBERSHIP changed, then
    /// reconcile ONLY the units a related edit touched (each subscription enqueues its own unit into
    /// `dirty_units` via `DirtyMark`, mirroring TS's per-unit `invalidateWiring`). Called on bind (catch-up)
    /// and after every transaction; a transaction that touched no unit drains nothing, so it is a true no-op
    /// instead of a sweep over every unit and track.
    /// Copy each stem's TAP (per its options: chain start / pre-strip / strip, TS `unit.audioOutput()`)
    /// into the stem staging (planar, stem i -> channels 2i / 2i+1). Runs right after `render`.
    pub(crate) fn copy_stem_outputs(&mut self) {
        // `metronome_stem` alone is a valid export (every unit deselected, just the click), and it has no
        // entry in `stem_exports`, so an emptiness check on that list alone would silently drop it.
        if self.stem_exports.is_empty() && !self.metronome_stem {
            return;
        }
        let stems = core::mem::take(&mut self.stem_exports);
        for (index, entry) in stems.iter().enumerate() {
            let Some(unit) = self.audio_units.iter().find(|unit| unit.unit == entry.uuid) else { continue };
            let Some(tap) = unit.stem_tap(entry) else { continue };
            let buffer = tap.borrow();
            let base = index * 2 * engine_env::RENDER_QUANTUM;
            self.stem_staging[base..base + engine_env::RENDER_QUANTUM].copy_from_slice(&buffer.left);
            self.stem_staging[base + engine_env::RENDER_QUANTUM..base + 2 * engine_env::RENDER_QUANTUM].copy_from_slice(&buffer.right);
        }
        self.stem_exports = stems;
        // The metronome is not an audio unit and has no tap, so it is appended by hand as the LAST pair, from
        // the buffer `render` just filled. `set_stem_export` sized the staging for it.
        if self.metronome_stem {
            let base = self.stem_exports.len() * 2 * engine_env::RENDER_QUANTUM;
            self.stem_staging[base..base + 2 * engine_env::RENDER_QUANTUM]
                .copy_from_slice(&self.metronome_staging);
        }
    }

    /// Mark `uuids` for a chain re-wire (e.g. the monitoring map changed) and enqueue them; the next
    /// `reconcile_units` rebuilds only those.
    pub(crate) fn mark_units_rewire(&mut self, uuids: &[[u8; 16]]) {
        for unit in &self.audio_units {
            if uuids.contains(&unit.unit) {
                unit.wiring_dirty.set(true);
                unit.mark.mark();
            }
        }
    }

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
            self.solo_dirty.set(true); // routing may have changed: the solo walk must re-resolve
        }
        if self.solo_dirty.replace(false) {
            self.update_solo();
        }
    }

    /// Resolve SOLO into per-strip `forced_silent` flags, mirroring TS `Mixer.updateSolo` + the strip's
    /// silence rule: while ANY unit is soloed, a strip is silent unless it is soloed itself or kept audible
    /// by the routing walk — a soloed unit keeps its OUTPUT-bus chain audible (recursively), and a soloed
    /// BUS keeps its FEEDERS (routed units + aux senders) audible (recursively). THE output unit is exempt
    /// by construction (it never joins `audio_units`). Off-render; O(units + routing edges).
    pub(crate) fn update_solo(&mut self) {
        struct Entry {
            solo: bool,
            params: Rc<StripParams>,
            routed: Option<Uuid>,   // the bus this unit's strip feeds (None = the master)
            sends: Vec<Uuid>,       // aux-send target buses
            bus: Option<Uuid>,      // when this unit IS a bus: its AudioBusBox uuid
            is_output: bool         // THE terminal master unit: exempt from solo silencing (it is the output)
        }
        let mut entries: Vec<(Uuid, Entry)> = Vec::with_capacity(self.audio_units.len());
        for unit in &self.audio_units {
            let bus = match unit.wired.as_ref() {
                Some(Wired::Bus(wired)) => Some(wired.bus_uuid),
                _ => None
            };
            let routed = unit.routed.as_ref().and_then(|routed| routed.bus);
            let sends = unit.sends.iter()
                .filter_map(|send| send.target.as_ref().and_then(|(uuid, _)| *uuid))
                .collect();
            let is_output = self.is_output_unit(unit.unit);
            entries.push((unit.unit, Entry {
                solo: unit.strip_params.solo.get(),
                params: unit.strip_params.clone(),
                routed, sends, bus, is_output
            }));
        }
        let unit_of_bus = |bus: &Uuid, entries: &Vec<(Uuid, Entry)>| entries.iter()
            .position(|(_, entry)| entry.bus.as_ref() == Some(bus));
        let has_solo = entries.iter().any(|(_, entry)| entry.solo);
        let mut virtual_solo = alloc::vec![false; entries.len()];
        // visit OUTPUTS of every soloed unit: its target-bus owner stays audible; recurse while not soloed (TS).
        let mut touched_outputs = alloc::vec![false; entries.len()];
        let mut stack: Vec<usize> = entries.iter().enumerate()
            .filter(|(_, (_, entry))| entry.solo).map(|(index, _)| index).collect();
        while let Some(index) = stack.pop() {
            if touched_outputs[index] {
                continue;
            }
            touched_outputs[index] = true;
            if let Some(bus) = entries[index].1.routed.as_ref() {
                if let Some(owner) = unit_of_bus(bus, &entries) {
                    if !entries[owner].1.solo {
                        virtual_solo[owner] = true;
                        stack.push(owner);
                    }
                }
            }
        }
        // visit INPUTS of every soloed unit: a soloed BUS keeps its feeders (routed + aux sends) audible;
        // feeders' inputs recurse unconditionally (TS `visitInputs`).
        let mut touched_inputs = alloc::vec![false; entries.len()];
        let mut stack: Vec<usize> = entries.iter().enumerate()
            .filter(|(_, (_, entry))| entry.solo).map(|(index, _)| index).collect();
        while let Some(index) = stack.pop() {
            if touched_inputs[index] {
                continue;
            }
            touched_inputs[index] = true;
            let Some(bus) = entries[index].1.bus else { continue };
            let feeders: Vec<usize> = entries.iter().enumerate()
                .filter(|(_, (_, entry))| entry.routed == Some(bus) || entry.sends.contains(&bus))
                .map(|(feeder, _)| feeder).collect();
            for feeder in feeders {
                if !entries[feeder].1.solo {
                    virtual_solo[feeder] = true;
                }
                stack.push(feeder);
            }
        }
        for (index, (_, entry)) in entries.iter().enumerate() {
            entry.params.forced_silent.set(has_solo && !(entry.solo || virtual_solo[index] || entry.is_output));
        }
    }

    /// Evaluate each unit's SOLO AUTOMATION curve at `position`, write the resolved on/off into the unit's static
    /// `solo` cell, and re-resolve the cross-strip `forced_silent` if any unit changed. Called once per PLAYING
    /// quantum from `render` (solo is a mixer fact, so it cannot resolve inside a single strip like volume / mute):
    /// this is the automation counterpart of the field subscription that arms `solo_dirty` for a manual toggle.
    /// Mirrors TS, where `AutomatableParameter` solo events drive `Mixer.onChannelStripSoloChanged` -> `updateSolo`.
    pub(crate) fn resolve_automated_solo(&mut self, position: f64) {
        let mut changed = false;
        for unit in &self.audio_units {
            let soloed = match unit.strip_automation.solo.borrow().as_ref() {
                Some(source) => source(position) >= 0.5, // TS `ValueMapping.bool.y`
                None => continue
            };
            if unit.strip_params.solo.get() != soloed {
                unit.strip_params.solo.set(soloed);
                changed = true;
            }
        }
        if changed {
            self.update_solo();
        }
    }

    /// Reconcile ONE unit (it was enqueued because a related edit touched its scope): cascade its tracks ->
    /// regions, then re-wire if a device chain or its composite changed (`|` so all dirty flags are consumed),
    /// else re-bind its automation curves if those attached / detached. A full rewire re-gathers automation,
    /// so it also clears that flag.
    fn reconcile_one(&mut self, unit: &mut AudioUnitBinding) {
        // Instruments built below (leaf or composite slots) capture THIS unit's note-bits slot.
        crate::set_current_unit_note_bits(Some(unit.note_bits.clone()));
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
        crate::set_current_unit_note_bits(None);
        unit.params_dirty.set(false);
        unit.automation_dirty.set(false); // consume the joiner catch-up flags + the handled real change
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
            teardown_audio_track(&mut self.graph, &binding.audio_track_sets, &self.clip_sequencer, track);
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
                if let Some(node) = chain.monitor_node {
                    self.context.remove_processor(node);
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
                if let Some(node) = composite.monitor_node {
                    self.context.remove_processor(node);
                }
                for member in composite.audio {
                    self.terminate_member(member);
                }
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
                if let Some(node) = tape.monitor_node {
                    self.context.remove_processor(node);
                }
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
                for params in &bus.device_params {
                    self.output_registry.remove(&Address::of(params.device_uuid(), vec![]));
                }
                self.teardown_device_params(bus.device_params);
                for (source, target) in &bus.edges {
                    self.context.remove_edge(*source, *target);
                }
                for node in bus.nodes {
                    self.context.remove_processor(node);
                }
            }
            Wired::Frozen(frozen) => {
                for (source, target) in &frozen.edges {
                    self.context.remove_edge(*source, *target);
                }
                self.context.remove_processor(frozen.strip_id);
                self.context.remove_processor(frozen.player_id);
            }
            Wired::MidiOut(midi) => {
                for sub in midi.subs {
                    self.graph.unsubscribe(sub);
                }
                for sub in midi.cc_subs {
                    self.graph.unsubscribe(sub);
                }
                for collection in midi.cc_collections {
                    collection.terminate(&mut self.graph);
                }
                self.output_registry.remove(&Address::of(midi.instrument_uuid, vec![]));
                for (source, target) in &midi.edges {
                    self.context.remove_edge(*source, *target);
                }
                self.context.remove_processor(midi.strip_id);
                self.context.remove_processor(midi.node_id);
                if let Some(node) = midi.monitor_node {
                    self.context.remove_processor(node);
                }
                for member in midi.midi {
                    self.terminate_member(member);
                }
                for member in midi.audio {
                    self.terminate_member(member);
                }
            }
        }
    }

    /// Terminate ONE leaf chain member (a leaver, or a full teardown): drop its output registration (a midi-fx
    /// never registered one; the remove is a no-op), remove its processor node (a midi-fx has none), drop its
    /// sidechain ports' pointer monitors, and unsubscribe its parameter observations.
    pub(crate) fn terminate_member(&mut self, member: Member) {
        // An EFFECT COMPOSITE member is a whole sub-graph, not one node: hand it to its own teardown (which
        // drops every entry, its three nodes, its edges, its dry/wet bindings and its observations). Removing
        // just `node_id` here would leak all of that.
        if let ProcHandle::EffectComposite(binding) = member.proc {
            self.graph.unsubscribe(member.enabled_sub);
            self.teardown_effect_composite(*binding);
            return;
        }
        self.output_registry.remove(&Address::of(member.uuid, vec![]));
        if let Some(node_id) = member.node_id {
            self.context.remove_processor(node_id);
        }
        if let Some(sidechain) = member.sidechain {
            for port in sidechain.ports {
                self.graph.unsubscribe(port.pointer_sub);
            }
        }
        self.graph.unsubscribe(member.enabled_sub);
        if let Some(params) = member.params {
            self.teardown_device_params(vec![params]);
        }
    }


    /// Build a unit binding: its per-track region collections list (`track_sets`, shared with the
    /// sequencer), the track-membership subscription (key 20) the cascade fills, and the three device-chain
    /// collections — `input` (host 22), `midi` (host 21), `audio` (host 23), each ordered by the device
    /// `index` (field 2). No processor nodes yet; the first `reconcile` rewires it (the collections are dirty
    /// from catch-up). No per-device-type logic: the device table (`device_for_type`) maps each box to its plugin.
    fn build_unit(&mut self, uuid: Uuid) -> AudioUnitBinding {
        let mark = DirtyMark {units: self.dirty_units.clone(), unit: uuid};
        let note_bits = engine_env::telemetry::broadcast_slot(4);
        self.broadcasts.register(uuid, &[], crate::broadcast::PACKAGE_INT_ARRAY, &note_bits);
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
        // SOLO (15): the field lands in the params AND arms the engine-level resolution (TS
        // `Mixer.onChannelStripSoloChanged` -> `updateSolo`), which forces every non-soloed,
        // non-virtual-solo strip silent.
        let solo = strip_params.clone();
        let solo_dirty = self.solo_dirty.clone();
        let solo_sub = self.graph.catchup_and_subscribe(Address::of(uuid, vec![UNIT_SOLO_KEY]), move |value| {
            if let Some(value) = value.as_bool() {
                solo.solo.set(value);
                solo_dirty.set(true);
            }
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
            track_changes, track_sub, strip_params, strip_subs: vec![volume_sub, panning_sub, mute_sub, solo_sub],
            strip_automation: Rc::new(StripAutomation::new()), strip_param_subs: Vec::new(), strip_param_collections: Vec::new(),
            note_bits, input, midi, audio, output_sub, routed: None, aux_sends, sends: Vec::new(),
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
}
