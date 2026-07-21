//! Mirrored regions: a NoteEventCollectionBox is observed ONCE by the cache and shared by every region
//! that references it; the observation survives until the last region leaves. Two regions sharing a
//! collection both read the same events, and removing one leaves the other reading it.

use super::*;

use super::params::build_param_track;
use super::tracks::CollectionCache;
use engine_env::clip_sequencer::ClipSequencer;

fn clip_rc() -> Rc<RefCell<ClipSequencer>> {
    Rc::new(RefCell::new(ClipSequencer::new()))
}
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
use super::{AudioUnitBinding, Wired, DEVICE_KIND_INSTRUMENT, UNIT_MIDI_KEY, UNIT_INPUT_KEY, UNIT_AUDIO_KEY, UNIT_TRACKS_KEY, UNIT_VOLUME_KEY, DEVICE_ENABLED_KEY};
use super::tracks::{TRACK_ENABLED_KEY, TRACK_TYPE_KEY, TRACK_TYPE_AUDIO, TRACK_REGIONS_KEY};
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
        field_changed_index: 0, sample_changed_index: 0, soundfont_changed_index: 0, reset_index: 0, terminate_index: 0,
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
fn a_chain_teardown_never_leaves_a_dead_or_skipped_meter_entry() {
    let _guard = pull_lock();
    // The studio PeakMeter NaN crash: a wholesale chain teardown (freeze, composite/tape rebuild, an
    // instrument unwire) removes its processors, but the context's CACHED render queue still holds Rc
    // clones — so the torn-down meter slots look ALIVE through the reconcile's sweep AND block a
    // same-address re-registration (the register dedup). The next render rebuilds the queue, the old
    // slots die, and the broadcast table serves a FREED pointer to the worklet: talc metadata read as
    // negative floats -> `gainToDb(negative)` = NaN in the UI meter. TS never exhibits this — a device's
    // terminate removes its LiveStreamBroadcaster package synchronously with the teardown.
    use engine_env::process_info::ProcessInfo;
    let mut engine = engine_with_devices();
    engine.graph = unit_graph();
    let mut unit = engine.build_unit(UNIT);
    engine.reconcile_one(&mut unit);
    engine.broadcasts.sweep();
    let render = |engine: &mut Engine| engine.context.process(&ProcessInfo {blocks: &[]});
    render(&mut engine); // cache the render queue (the studio always renders between reconciles)
    let alive_meter = |engine: &Engine, uuid: Uuid| (0..engine.broadcasts.len()).any(|index| {
        let entry = engine.broadcasts.entry(index).expect("entry");
        entry.uuid == uuid && entry.keys.is_empty()
            && entry.package_type == crate::broadcast::PACKAGE_FLOAT_ARRAY && entry.alive()
    });
    let dead_entries = |engine: &Engine| (0..engine.broadcasts.len())
        .filter(|index| !engine.broadcasts.entry(*index).expect("entry").alive()).count();
    assert!(alive_meter(&engine, FX_A), "FX_A meter registered after the first reconcile");
    // Unwire the instrument: `reconcile_leaf` tears the WHOLE chain down (no instrument -> silent).
    let point = |engine: &mut Engine, old: Option<Address>, new: Option<Address>|
        engine.graph.transaction(&[Update::Pointer {
            address: Address::of(INSTR, vec![HOST_KEY]), old, new
        }], &engine.registry).expect("point instrument host");
    point(&mut engine, Some(Address::of(UNIT, vec![UNIT_INPUT_KEY])), None);
    engine.reconcile_one(&mut unit);
    engine.broadcasts.sweep();
    // Re-wire it in the SAME apply pass (no render between): the chain rebuilds and re-registers its
    // meters at the SAME addresses while the queue still keeps the old slots alive.
    point(&mut engine, None, Some(Address::of(UNIT, vec![UNIT_INPUT_KEY])));
    engine.reconcile_one(&mut unit);
    engine.broadcasts.sweep();
    assert!(alive_meter(&engine, FX_A), "the rebuilt FX_A meter is registered (not dedup-skipped)");
    render(&mut engine); // the queue rebuild drops the torn-down processors for good
    assert_eq!(dead_entries(&engine), 0, "no dead entry (freed slot ptr) is served after the render");
    assert!(alive_meter(&engine, FX_A), "FX_A still meters after the rebuild's first render");
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

// ---- MIDI-output unit (engine-side instrument, TS MIDIOutputDeviceProcessor) ----
// The MidiOut node pulls through the process-global `PULL` cell (single-threaded on wasm); tests that
// drive `context.process` must not run concurrently, so they serialize on this lock.
fn pull_lock() -> std::sync::MutexGuard<'static, ()> {
    crate::pull_lock() // the ONE crate-wide lock (see `crate::pull_lock`)
}

const MIDI_DEV: Uuid = [30u8; 16];
const MIDI_TARGET: Uuid = [31u8; 16];
const MIDI_ROOT: Uuid = [32u8; 16];
const MIDI_PARAM: Uuid = [33u8; 16];

fn midi_out_graph() -> BoxGraph {
    BoxGraph::from_boxes(vec![
        graph_box(MIDI_ROOT, "RootBox", &[(35, FieldValue::Hook)]),
        graph_box(UNIT, "AudioUnitBox", &[
            (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook),
            (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook)
        ]),
        graph_box(MIDI_DEV, "MIDIOutputDeviceBox", &[
            (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_INPUT_KEY])))),
            (super::MIDI_OUT_CHANNEL_KEY, FieldValue::Int32(2)),
            (super::MIDI_OUT_PARAMETERS_KEY, FieldValue::Hook),
            (super::MIDI_OUT_DEVICE_KEY, FieldValue::Pointer(Some(Address::of(MIDI_TARGET, vec![2]))))
        ]),
        graph_box(MIDI_TARGET, "MIDIOutputBox", &[
            (1, FieldValue::Pointer(Some(Address::of(MIDI_ROOT, vec![35])))),
            (2, FieldValue::Hook),
            (3, FieldValue::String("unit-test-device".to_string())),
            (5, FieldValue::Int32(10)),
            (6, FieldValue::Boolean(true))
        ]),
        graph_box(MIDI_PARAM, "MIDIOutputParameterBox", &[
            (1, FieldValue::Pointer(Some(Address::of(MIDI_DEV, vec![super::MIDI_OUT_PARAMETERS_KEY])))),
            (super::MIDI_OUT_PARAM_CONTROLLER_KEY, FieldValue::Int32(74)),
            (super::MIDI_OUT_PARAM_VALUE_KEY, FieldValue::Float32(0.5))
        ])
    ])
}

fn note_bit(unit: &AudioUnitBinding, pitch: i32) -> bool {
    let values = unit.note_bits.borrow();
    (values[(pitch >> 5) as usize].to_bits() & (1u32 << (pitch & 31))) != 0
}

#[test]
fn a_midi_output_unit_wires_emits_timed_midi_and_lights_its_note_bits() {
    let _guard = pull_lock();
    let mut engine = engine_with_devices();
    engine.graph = midi_out_graph();
    engine.observe_midi_outputs(); // registers the MIDIOutputBox target (catch-up + sync)
    assert_eq!(engine.midi_out.borrow().device_id(0), Some("unit-test-device"));
    let mut unit = engine.build_unit(UNIT);
    engine.reconcile_one(&mut unit);
    assert!(matches!(unit.wired, Some(Wired::MidiOut(_))), "an unregistered box type no longer tears the unit down");
    // The build's readAllParameters mirror: ONE initial CC (controller 74, round(0.5 * 127) = 64) at 0 ms.
    {
        let midi = engine.midi_out.borrow();
        assert_eq!(midi.queued().len(), 1);
        let cc = &midi.queued()[0];
        assert_eq!((cc.status, cc.data1, cc.data2, cc.time_ms), (0xB2, 74, 64, 0.0));
    }
    engine.midi_out.borrow_mut().drain_queue(|_| {});
    // A live note-on becomes a timed note-on record AND sets the unit's note-indicator bit.
    super::note_signal_to_unit(&unit, super::NoteSignal::On {pitch: 60, velocity: 0.9});
    let stopped = abi::BlockFlags::create(false, false, false, false);
    let blocks = [abi::Block {index: 0, flags: stopped, p0: 0.0, p1: 5.0, s0: 0, s1: 128, bpm: 120.0}];
    engine.context.process(&engine_env::process_info::ProcessInfo {blocks: &blocks});
    {
        let midi = engine.midi_out.borrow();
        assert_eq!(midi.queued().len(), 1);
        let note_on = &midi.queued()[0];
        assert_eq!(note_on.device, 0);
        // channel 2, pitch 60, Math.round(0.9 * 127) = 114; time = (0/sr + 0s) * 1000 + delay 10 = 10 ms.
        assert_eq!((note_on.status, note_on.data1, note_on.data2, note_on.len), (0x92, 60, 114, 3));
        assert_eq!(note_on.time_ms, 10.0);
    }
    assert!(note_bit(&unit, 60), "the pulled note-on lights the unit's note indicator");
    engine.midi_out.borrow_mut().drain_queue(|_| {});
    // The note-off releases the bit and emits the note-off record.
    super::note_signal_to_unit(&unit, super::NoteSignal::Off {pitch: 60});
    let blocks = [abi::Block {index: 0, flags: stopped, p0: 5.0, p1: 10.0, s0: 0, s1: 128, bpm: 120.0}];
    engine.context.process(&engine_env::process_info::ProcessInfo {blocks: &blocks});
    {
        let midi = engine.midi_out.borrow();
        assert_eq!(midi.queued().len(), 1);
        let note_off = &midi.queued()[0];
        assert_eq!((note_off.status, note_off.data1, note_off.data2), (0x82, 60, 0));
    }
    assert!(!note_bit(&unit, 60), "the note-off clears the indicator bit");
}

#[test]
fn a_channel_edit_flushes_held_notes_and_a_value_edit_emits_a_cc() {
    let _guard = pull_lock();
    let mut engine = engine_with_devices();
    engine.graph = midi_out_graph();
    engine.observe_midi_outputs();
    let mut unit = engine.build_unit(UNIT);
    engine.reconcile_one(&mut unit);
    engine.midi_out.borrow_mut().drain_queue(|_| {}); // drop the initial CC push
    // Hold a note, then edit the channel: the subscription flushes a note-off ON THE OLD channel.
    super::note_signal_to_unit(&unit, super::NoteSignal::On {pitch: 64, velocity: 1.0});
    let stopped = abi::BlockFlags::create(false, false, false, false);
    let blocks = [abi::Block {index: 0, flags: stopped, p0: 0.0, p1: 5.0, s0: 0, s1: 128, bpm: 120.0}];
    engine.context.process(&engine_env::process_info::ProcessInfo {blocks: &blocks});
    engine.midi_out.borrow_mut().drain_queue(|_| {}); // drop the note-on
    engine.graph.transaction(&[Update::Primitive {
        address: Address::of(MIDI_DEV, vec![super::MIDI_OUT_CHANNEL_KEY]),
        old: FieldValue::Int32(2), new: FieldValue::Int32(5)
    }], &engine.registry).expect("edit channel");
    {
        let midi = engine.midi_out.borrow();
        assert_eq!(midi.queued().len(), 1);
        let flushed = &midi.queued()[0];
        assert_eq!((flushed.status, flushed.data1, flushed.time_ms), (0x82, 64, 10.0), "note-off on the OLD channel at the delay");
    }
    engine.midi_out.borrow_mut().drain_queue(|_| {});
    // A plain CC value edit surfaces at the next block, ON THE NEW channel, at 0 ms (TS default time).
    engine.graph.transaction(&[Update::Primitive {
        address: Address::of(MIDI_PARAM, vec![super::MIDI_OUT_PARAM_VALUE_KEY]),
        old: FieldValue::Float32(0.5), new: FieldValue::Float32(1.0)
    }], &engine.registry).expect("edit cc value");
    engine.context.process(&engine_env::process_info::ProcessInfo {blocks: &blocks});
    let midi = engine.midi_out.borrow();
    assert_eq!(midi.queued().len(), 1);
    let cc = &midi.queued()[0];
    assert_eq!((cc.status, cc.data1, cc.data2, cc.time_ms), (0xB5, 74, 127, 0.0));
}

#[test]
fn transport_commands_schedule_start_stop_and_song_position() {
    let mut engine = engine_with_devices();
    engine.graph = midi_out_graph();
    engine.observe_midi_outputs();
    engine.play();
    engine.pause();
    engine.set_position(3840.0);
    crate::midi_output::process_transport_clock(&engine.midi_out, &[], engine.sample_rate);
    let midi = engine.midi_out.borrow();
    let queued = midi.queued();
    assert_eq!(queued.len(), 3);
    assert_eq!((queued[0].status, queued[0].len, queued[0].time_ms), (0xFA, 1, 10.0), "play schedules Start");
    assert_eq!((queued[1].status, queued[1].len), (0xFC, 1), "pause schedules Stop");
    // SongPosition: Math.floor(3840 / 96) = 40 -> lsb 40, msb 0.
    assert_eq!((queued[2].status, queued[2].data1, queued[2].data2, queued[2].len), (0xF2, 40, 0, 3));
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

// A chain-edit REORDER must never terminate a survivor (a bridge-backed device — NeuralAmp / Werkstatt /
// Apparat / Spielwerk — would otherwise leak its JS-side instance on every reorder); removing a device
// from the chain must terminate it EXACTLY ONCE (never twice, never skipped). `TestEffect` here declares
// a `terminate` export (a nonzero sentinel slot; native builds never call through the table, but
// `device_terminate_count` still counts the attempt, mirroring `call_device_field_changed`'s native probe).
#[test]
fn removing_an_effect_terminates_it_once_and_a_reorder_terminates_none() {
    let mut engine = engine_with_devices();
    engine.devices[1].terminate_index = 777; // the "TestEffect" device type declares `terminate`
    engine.graph = unit_graph();
    let mut unit = engine.build_unit(UNIT);
    // Connect FX_B (index 1) so the chain is [FX_A(0), FX_B(1)].
    engine.graph.transaction(&[Update::Pointer {
        address: Address::of(FX_B, vec![HOST_KEY]), old: None, new: Some(Address::of(UNIT, vec![UNIT_AUDIO_KEY]))
    }], &engine.registry).expect("connect FX_B");
    engine.reconcile_one(&mut unit);
    let before_reorder = crate::device_terminate_count();

    // A pure REORDER (swap indices): both FX_A and FX_B survive, neither is terminated.
    engine.graph.transaction(&[
        Update::Primitive {address: Address::of(FX_A, vec![EFFECT_INDEX_KEY]), old: FieldValue::Int32(0), new: FieldValue::Int32(1)},
        Update::Primitive {address: Address::of(FX_B, vec![EFFECT_INDEX_KEY]), old: FieldValue::Int32(1), new: FieldValue::Int32(0)}
    ], &engine.registry).expect("swap indices");
    engine.reconcile_one(&mut unit);
    assert_eq!(crate::device_terminate_count(), before_reorder, "a chain reorder terminates zero devices");

    // Disconnect FX_A (a genuine removal, the chain becomes [FX_B] only): terminated exactly once.
    engine.graph.transaction(&[Update::Pointer {
        address: Address::of(FX_A, vec![HOST_KEY]), old: Some(Address::of(UNIT, vec![UNIT_AUDIO_KEY])), new: None
    }], &engine.registry).expect("disconnect FX_A");
    engine.reconcile_one(&mut unit);
    assert_eq!(crate::device_terminate_count(), before_reorder + 1, "removing FX_A terminates it exactly once");

    // Reconciling again with nothing changed must not re-terminate anything (idempotent).
    engine.reconcile_one(&mut unit);
    assert_eq!(crate::device_terminate_count(), before_reorder + 1, "an unrelated reconcile never re-terminates");
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
    use super::tracks::{read_audio_region, AUDIO_REGION_FADING_KEY};
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
    use super::tracks::read_audio_region;
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
    use super::tracks::read_audio_region;
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
fn a_transient_marker_drag_live_updates_a_time_stretch_region() {
    // Editing a transient marker in the studio (issue #114) must reach the running time-stretch sequencer:
    // the markers live on the SOURCE FILE, not the region or play-mode box, so `build_audio_region` gives each
    // marker its own drag monitor. Regression for "moving a transient does nothing until reload".
    use super::tracks::{build_audio_region, unsubscribe_audio_region, AudioTrackContent};
    use value::region::RegionCollection;
    const REGION: Uuid = [80u8; 16];
    const FILE: Uuid = [81u8; 16];
    const STRETCH: Uuid = [82u8; 16];
    const W0: Uuid = [83u8; 16];
    const W1: Uuid = [84u8; 16];
    const T0: Uuid = [85u8; 16];
    const T1: Uuid = [86u8; 16];
    let mut engine = engine_with_devices();
    engine.graph = BoxGraph::from_boxes(vec![
        graph_box(FILE, "AudioFileBox", &[(10, FieldValue::Hook)]),
        graph_box(T0, "TransientMarkerBox", &[(1, FieldValue::Pointer(Some(Address::of(FILE, vec![10])))), (2, FieldValue::Float32(0.0))]),
        graph_box(T1, "TransientMarkerBox", &[(1, FieldValue::Pointer(Some(Address::of(FILE, vec![10])))), (2, FieldValue::Float32(0.5))]),
        graph_box(STRETCH, "AudioTimeStretchBox", &[(1, FieldValue::Hook), (2, FieldValue::Int32(1)), (3, FieldValue::Float32(1.0))]),
        graph_box(W0, "WarpMarkerBox", &[(1, FieldValue::Pointer(Some(Address::of(STRETCH, vec![1])))), (2, FieldValue::Int32(0)), (3, FieldValue::Float32(0.0))]),
        graph_box(W1, "WarpMarkerBox", &[(1, FieldValue::Pointer(Some(Address::of(STRETCH, vec![1])))), (2, FieldValue::Int32(3840)), (3, FieldValue::Float32(1.0))]),
        graph_box(REGION, "AudioRegionBox", &[
            (2, FieldValue::Pointer(Some(Address::box_of(FILE)))), (8, FieldValue::Pointer(Some(Address::box_of(STRETCH)))),
            (10, FieldValue::Int32(0)), (11, FieldValue::Float32(3840.0))
        ])
    ]);
    let content: super::tracks::SharedAudioTrack = Rc::new(RefCell::new(AudioTrackContent {
        uuid: [88u8; 16], regions: RegionCollection::new(), clips: Vec::new()
    }));
    let tempo_map = Rc::new(RefCell::new(TempoMap::fixed(120.0)));
    let mark = super::DirtyMark {units: Rc::new(RefCell::new(Vec::new())), unit: [88u8; 16]};
    let region_changes = Rc::new(RefCell::new(super::Members::default()));
    let binding = build_audio_region(&mut engine.graph, &content, REGION, &tempo_map, &mark, &region_changes)
        .expect("a time-stretch region builds");
    assert_eq!(content.borrow().regions.iter().next().expect("one region").transients, vec![0.0, 0.5],
        "transients read at build");
    // DRAG T1 0.5 -> 0.8: the per-marker monitor re-reads the region's transients live.
    engine.graph.transaction(&[Update::Primitive {
        address: Address::of(T1, vec![2]),
        old: FieldValue::Float32(0.5), new: FieldValue::Float32(0.75)
    }], &engine.registry).expect("drag transient marker");
    assert_eq!(content.borrow().regions.iter().next().expect("one region").transients, vec![0.0, 0.75],
        "a transient DRAG live-updates the region's transient positions (kept sorted)");
    unsubscribe_audio_region(&mut engine.graph, binding);
}

#[test]
fn switching_play_mode_live_rebinds_so_new_box_field_edits_take_effect() {
    // Bug: after switching a region TO time-stretch, changing Once/Repeat/Pingpong (or transpose/rate) did nothing
    // until save+reopen — `playmode_sub` was bound once to the play-mode target present AT BUILD (here: none, the
    // region starts native) and never re-resolved when the pointer was repointed to the new box. The pointer
    // monitor must queue a region rebuild on repoint so the new box's subsequent field edits are seen live.
    use super::tracks::{build_audio_region, unsubscribe_audio_region, AudioTrackContent, AUDIO_REGION_PLAYMODE_KEY};
    use crate::time_stretch::TransientPlayMode;
    use value::region::RegionCollection;
    const REGION: Uuid = [90u8; 16];
    const FILE: Uuid = [91u8; 16];
    const STRETCH: Uuid = [92u8; 16];
    const W0: Uuid = [93u8; 16];
    const W1: Uuid = [94u8; 16];
    let mut engine = engine_with_devices();
    engine.graph = BoxGraph::from_boxes(vec![
        graph_box(FILE, "AudioFileBox", &[(10, FieldValue::Hook)]),
        // A time-stretch play-mode box exists (mode 1 = Repeat) but the region starts NATIVE (playMode = None).
        graph_box(STRETCH, "AudioTimeStretchBox", &[(1, FieldValue::Hook), (2, FieldValue::Int32(1)), (3, FieldValue::Float32(1.0))]),
        graph_box(W0, "WarpMarkerBox", &[(1, FieldValue::Pointer(Some(Address::of(STRETCH, vec![1])))), (2, FieldValue::Int32(0)), (3, FieldValue::Float32(0.0))]),
        graph_box(W1, "WarpMarkerBox", &[(1, FieldValue::Pointer(Some(Address::of(STRETCH, vec![1])))), (2, FieldValue::Int32(3840)), (3, FieldValue::Float32(1.0))]),
        graph_box(REGION, "AudioRegionBox", &[
            (2, FieldValue::Pointer(Some(Address::box_of(FILE)))),
            (AUDIO_REGION_PLAYMODE_KEY, FieldValue::Pointer(None)),
            (10, FieldValue::Int32(0)), (11, FieldValue::Float32(3840.0))
        ])
    ]);
    let content: super::tracks::SharedAudioTrack = Rc::new(RefCell::new(AudioTrackContent {
        uuid: [99u8; 16], regions: RegionCollection::new(), clips: Vec::new()
    }));
    let tempo_map = Rc::new(RefCell::new(TempoMap::fixed(120.0)));
    let mark = super::DirtyMark {units: Rc::new(RefCell::new(Vec::new())), unit: [99u8; 16]};
    let region_changes = Rc::new(RefCell::new(super::Members::default()));
    let binding = build_audio_region(&mut engine.graph, &content, REGION, &tempo_map, &mark, &region_changes)
        .expect("native region builds");
    assert!(content.borrow().regions.iter().next().expect("one region").time_stretch.is_none(), "starts native");
    // SWITCH to time-stretch: repoint the region's play-mode pointer to the new box.
    engine.graph.transaction(&[Update::Pointer {
        address: Address::of(REGION, vec![AUDIO_REGION_PLAYMODE_KEY]),
        old: None, new: Some(Address::box_of(STRETCH))
    }], &engine.registry).expect("switch to time-stretch");
    assert!(region_changes.borrow().removed.contains(&REGION) && region_changes.borrow().added.contains(&REGION),
        "repointing the play-mode pointer queues a full region rebuild (else the new box's subs never bind)");
    // Play out the queued rebuild the way reconcile_audio_regions would: drop the stale binding, rebuild fresh.
    content.borrow_mut().regions.retain(|region| region.region_uuid != REGION);
    unsubscribe_audio_region(&mut engine.graph, binding);
    region_changes.borrow_mut().removed.clear();
    region_changes.borrow_mut().added.clear();
    let binding = build_audio_region(&mut engine.graph, &content, REGION, &tempo_map, &mark, &region_changes)
        .expect("rebuilt time-stretch region");
    assert_eq!(content.borrow().regions.iter().next().expect("one region").time_stretch.as_ref()
        .expect("now time-stretch").transient_play_mode, TransientPlayMode::Repeat, "rebuilt region reads the new box");
    // THE FIX: editing Once/Repeat/Pingpong on the now-bound box must re-read the region live (Repeat -> Once).
    engine.graph.transaction(&[Update::Primitive {
        address: Address::of(STRETCH, vec![2]),
        old: FieldValue::Int32(1), new: FieldValue::Int32(0)
    }], &engine.registry).expect("change transient play-mode");
    assert_eq!(content.borrow().regions.iter().next().expect("one region").time_stretch.as_ref()
        .expect("still time-stretch").transient_play_mode, TransientPlayMode::Once,
        "a transient-play-mode edit updates the region live after a live play-mode switch");
    unsubscribe_audio_region(&mut engine.graph, binding);
}

#[test]
fn read_audio_region_converts_seconds_time_base_to_ppqn() {
    // A no-stretch (NoWarp) region uses the SECONDS time-base: duration / loop-duration are in seconds and
    // MUST be converted to ppqn, else the region reads as a few pulses and plays nothing (the bug).
    use super::tracks::read_audio_region;
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
    assert_eq!(sets[0].borrow().regions.len(), 1, "with its one audio region");
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
    assert_eq!(unit.audio_track_sets.borrow()[0].borrow().regions.len(), 1, "the player reads the unit's audio region");
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
        child_enabled_key: CHILD_ENABLED_KEY, child_mute_key: 0, child_solo_key: 0
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
        cell_instrument_field: CELL_INSTRUMENT_FIELD, cell_midi_field: 0, cell_audio_field: 0,
        child_enabled_key: 0, child_mute_key: 0, child_solo_key: 0
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
fn live_note_signal_reaches_a_cell_composites_sequencer() {
    // A CELL-based composite dropped live notes: `build_cell` moved its sequencer into the pull link with
    // no retained handle, so `collect_note_sources` skipped cells (on-screen keys / MIDI stayed silent
    // while sequenced playback worked). The retained `note_source` clone shares the pull link's `Rc`.
    const CELL: Uuid = [40u8; 16];
    const CELL_INSTRUMENT_FIELD: u16 = 50;
    let mut engine = engine_with_devices();
    engine.composites = vec![CompositeSpec {
        box_type: "TestComposite".to_string(), children_field: CHILDREN_FIELD, index_key: 0, exclude_key: 0,
        cell_instrument_field: CELL_INSTRUMENT_FIELD, cell_midi_field: 0, cell_audio_field: 0,
        child_enabled_key: 0, child_mute_key: 0, child_solo_key: 0
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
    // A raw note-on routes to the cell's sequencer and emits at the next block, transport STOPPED.
    super::note_signal_to_unit(&unit, super::NoteSignal::On {pitch: 60, velocity: 0.9});
    let mut sources: Vec<engine_env::note_event_instrument::SharedNoteEventSource> = Vec::new();
    match unit.wired.as_ref().expect("wired after reconcile") {
        Wired::Composite(composite) => composite.binding.collect_note_sources(&mut sources),
        _ => panic!("expected a composite chain")
    }
    assert_eq!(sources.len(), 1, "the cell's sequencer is a live-note injection target");
    let stopped = engine_env::block_flags::BlockFlags::create(false, false, false, false);
    let mut events: Vec<engine_env::event::Event> = Vec::new();
    sources[0].borrow_mut().process_notes(0.0, 5.0, stopped, &mut |event| events.push(event));
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], engine_env::event::Event::NoteStart {pitch: 60, ..}));
    // The note-off releases it in the following block.
    super::note_signal_to_unit(&unit, super::NoteSignal::Off {pitch: 60});
    events.clear();
    sources[0].borrow_mut().process_notes(5.0, 10.0, stopped, &mut |event| events.push(event));
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], engine_env::event::Event::NoteComplete {pitch: 60, ..}));
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
fn solo_forces_other_strips_silent_keeping_the_output_bus_audible() {
    use super::{UNIT_SOLO_KEY, UNIT_OUTPUT_KEY, BUS_ENABLED_KEY};
    const UNIT_A: Uuid = [60u8; 16];
    const INSTR_A: Uuid = [61u8; 16];
    const UNIT_C: Uuid = [62u8; 16];
    const INSTR_C: Uuid = [63u8; 16];
    const BUS_UNIT: Uuid = [64u8; 16];
    const BUS_BOX: Uuid = [65u8; 16];
    let unit_fields = |solo: bool| alloc::vec![
        (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook),
        (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook),
        (UNIT_SOLO_KEY, FieldValue::Boolean(solo))
    ];
    let mut engine = engine_with_devices();
    let mut a_fields = unit_fields(false);
    a_fields.push((UNIT_OUTPUT_KEY, FieldValue::Pointer(Some(Address::of(BUS_BOX, vec![6]))))); // A -> the bus input
    engine.graph = BoxGraph::from_boxes(vec![
        graph_box(UNIT_A, "AudioUnitBox", &a_fields),
        graph_box(INSTR_A, "TestInstrument", &[(HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT_A, vec![UNIT_INPUT_KEY]))))]),
        graph_box(UNIT_C, "AudioUnitBox", &unit_fields(false)),
        graph_box(INSTR_C, "TestInstrument", &[(HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT_C, vec![UNIT_INPUT_KEY]))))]),
        graph_box(BUS_UNIT, "AudioUnitBox", &unit_fields(false)),
        graph_box(BUS_BOX, "AudioBusBox", &[
            (HOST_KEY, FieldValue::Pointer(Some(Address::of(BUS_UNIT, vec![UNIT_INPUT_KEY])))),
            (6, FieldValue::Hook),
            (BUS_ENABLED_KEY, FieldValue::Boolean(true))
        ])
    ]);
    for uuid in [BUS_UNIT, UNIT_A, UNIT_C] {
        let mut unit = engine.build_unit(uuid);
        engine.reconcile_one(&mut unit);
        engine.audio_units.push(unit);
    }
    engine.resolve_outputs();
    let params_of = |engine: &Engine, uuid: Uuid| engine.audio_units.iter()
        .find(|unit| unit.unit == uuid).expect("unit").strip_params.clone();
    let set_solo = |engine: &mut Engine, uuid: Uuid, from: bool, to: bool| engine.graph.transaction(&[Update::Primitive {
        address: Address::of(uuid, vec![UNIT_SOLO_KEY]),
        old: FieldValue::Boolean(from), new: FieldValue::Boolean(to)
    }], &engine.registry).expect("toggle solo");
    // Soloing A silences C, keeps A and its OUTPUT BUS audible (virtual solo along the routing).
    set_solo(&mut engine, UNIT_A, false, true);
    engine.update_solo();
    assert!(!params_of(&engine, UNIT_A).forced_silent.get(), "the soloed unit stays audible");
    assert!(params_of(&engine, UNIT_C).forced_silent.get(), "a non-soloed unit is forced silent");
    assert!(!params_of(&engine, BUS_UNIT).forced_silent.get(), "the soloed unit's output bus stays audible");
    // Unsolo: everything audible again.
    set_solo(&mut engine, UNIT_A, true, false);
    engine.update_solo();
    assert!(!params_of(&engine, UNIT_A).forced_silent.get());
    assert!(!params_of(&engine, UNIT_C).forced_silent.get());
    assert!(!params_of(&engine, BUS_UNIT).forced_silent.get());
    // Soloing the BUS keeps its FEEDER (A) audible, silences the unrelated C.
    set_solo(&mut engine, BUS_UNIT, false, true);
    engine.update_solo();
    assert!(!params_of(&engine, BUS_UNIT).forced_silent.get(), "the soloed bus stays audible");
    assert!(!params_of(&engine, UNIT_A).forced_silent.get(), "the bus feeder stays audible (virtual solo)");
    assert!(params_of(&engine, UNIT_C).forced_silent.get(), "an unrelated unit is forced silent");
}

#[test]
fn an_automated_solo_curve_forces_other_strips_silent() {
    // #305 (solo half): a Value track automating UNIT A's solo (key 15) must silence the non-soloed unit C while
    // playing, exactly like a manual solo. Solo is engine-level, so `resolve_automated_solo` writes the curve's
    // on/off into A's static solo cell and re-runs `update_solo`. Before the fix the curve was never bound.
    use super::{UNIT_SOLO_KEY, UNIT_OUTPUT_KEY, BUS_ENABLED_KEY};
    const UNIT_A: Uuid = [70u8; 16];
    const INSTR_A: Uuid = [71u8; 16];
    const UNIT_C: Uuid = [72u8; 16];
    const INSTR_C: Uuid = [73u8; 16];
    const BUS_UNIT: Uuid = [74u8; 16];
    const BUS_BOX: Uuid = [75u8; 16];
    const VTRACK: Uuid = [76u8; 16];
    const VREGION: Uuid = [77u8; 16];
    const VCOLL: Uuid = [78u8; 16];
    const VEVENT: Uuid = [79u8; 16];
    let unit_fields = || alloc::vec![
        (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook),
        (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook),
        (UNIT_SOLO_KEY, FieldValue::Boolean(false))
    ];
    let mut engine = engine_with_devices();
    let mut a_fields = unit_fields();
    a_fields.push((UNIT_OUTPUT_KEY, FieldValue::Pointer(Some(Address::of(BUS_BOX, vec![6]))))); // A -> the bus input
    engine.graph = BoxGraph::from_boxes(vec![
        graph_box(UNIT_A, "AudioUnitBox", &a_fields),
        graph_box(INSTR_A, "TestInstrument", &[(HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT_A, vec![UNIT_INPUT_KEY]))))]),
        graph_box(UNIT_C, "AudioUnitBox", &unit_fields()),
        graph_box(INSTR_C, "TestInstrument", &[(HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT_C, vec![UNIT_INPUT_KEY]))))]),
        graph_box(BUS_UNIT, "AudioUnitBox", &unit_fields()),
        graph_box(BUS_BOX, "AudioBusBox", &[
            (HOST_KEY, FieldValue::Pointer(Some(Address::of(BUS_UNIT, vec![UNIT_INPUT_KEY])))),
            (6, FieldValue::Hook),
            (BUS_ENABLED_KEY, FieldValue::Boolean(true))
        ]),
        // A Value track automating UNIT A's solo, one event at 1.0 (soloed) covering the region.
        graph_box(VTRACK, "TrackBox", &[
            (2, FieldValue::Pointer(Some(Address::of(UNIT_A, vec![UNIT_SOLO_KEY])))),
            (3, FieldValue::Hook)
        ]),
        graph_box(VREGION, "ValueRegionBox", &[
            (1, FieldValue::Pointer(Some(Address::of(VTRACK, vec![3])))),
            (2, FieldValue::Pointer(Some(Address::of(VCOLL, vec![2])))),
            (10, FieldValue::Int32(0)), (11, FieldValue::Int32(3840)), (12, FieldValue::Int32(0)), (13, FieldValue::Int32(3840))
        ]),
        graph_box(VCOLL, "ValueEventCollectionBox", &[(1, FieldValue::Hook), (2, FieldValue::Hook)]),
        graph_box(VEVENT, "ValueEventBox", &[
            (1, FieldValue::Pointer(Some(Address::of(VCOLL, vec![1])))), (10, FieldValue::Int32(0)), (13, FieldValue::Float32(1.0))
        ])
    ]);
    for uuid in [BUS_UNIT, UNIT_A, UNIT_C] {
        let mut unit = engine.build_unit(uuid);
        engine.reconcile_one(&mut unit); // binds A's solo automation curve (first reconcile)
        engine.audio_units.push(unit);
    }
    engine.resolve_outputs();
    let params_of = |engine: &Engine, uuid: Uuid| engine.audio_units.iter()
        .find(|unit| unit.unit == uuid).expect("unit").strip_params.clone();
    // Nothing is statically soloed yet, so every strip is audible.
    engine.update_solo();
    assert!(!params_of(&engine, UNIT_C).forced_silent.get(), "no solo yet: C is audible");
    // Resolve the automation at a position the curve covers: A becomes soloed, silencing C, A + its bus stay audible.
    engine.resolve_automated_solo(0.0);
    assert!(params_of(&engine, UNIT_A).solo.get(), "the solo curve (event 1.0) wrote the unit's solo cell");
    assert!(!params_of(&engine, UNIT_A).forced_silent.get(), "the automation-soloed unit stays audible");
    assert!(params_of(&engine, UNIT_C).forced_silent.get(), "a non-soloed unit is forced silent by the automated solo");
    assert!(!params_of(&engine, BUS_UNIT).forced_silent.get(), "the soloed unit's output bus stays audible");
}

#[test]
fn detaching_solo_automation_restores_the_static_solo_cell_from_the_field() {
    // `resolve_automated_solo` writes the solo curve's value into the static solo cell. Detaching the automation
    // (a rebind that finds no track) must restore that cell from the FIELD — the field subscription only fires on a
    // field edit, not on a track detach — else the unit would stay soloed forever after its automation is removed.
    use super::UNIT_SOLO_KEY;
    let mut engine = engine_with_devices();
    engine.graph = BoxGraph::from_boxes(vec![
        graph_box(UNIT, "AudioUnitBox", &[
            (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook), (UNIT_INPUT_KEY, FieldValue::Hook),
            (UNIT_AUDIO_KEY, FieldValue::Hook), (UNIT_SOLO_KEY, FieldValue::Boolean(false))
        ]),
        graph_box(INSTR, "TestInstrument", &[(HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_INPUT_KEY]))))])
    ]);
    let mut unit = engine.build_unit(UNIT);
    engine.bind_strip_automation(&mut unit); // no solo track attached
    // Simulate a prior `resolve_automated_solo` having left the cell hot (soloed), diverging from the field (false).
    unit.strip_params.solo.set(true);
    engine.solo_dirty.set(false);
    engine.bind_strip_automation(&mut unit); // rebind with no track -> restore from the field
    assert!(!unit.strip_params.solo.get(), "detach restored the static solo cell from the field (false)");
    assert!(engine.solo_dirty.get(), "detach re-armed the solo resolution so forced_silent reverts");
    engine.teardown_unit(unit);
}

#[test]
fn an_automated_parameter_broadcasts_its_unit_value_at_its_field_address() {
    const VTRACK: Uuid = [45u8; 16];
    const VREGION: Uuid = [46u8; 16];
    const VCOL: Uuid = [47u8; 16];
    const VEVENT: Uuid = [48u8; 16];
    let mut engine = engine_with_devices();
    engine.graph = BoxGraph::from_boxes(vec![
        graph_box(UNIT, "AudioUnitBox", &[
            (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook),
            (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook),
            (UNIT_VOLUME_KEY, FieldValue::Float32(0.0))
        ]),
        graph_box(INSTR, "TestInstrument", &[(HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_INPUT_KEY]))))]),
        // A VALUE track automating the unit's strip volume.
        graph_box(VTRACK, "TrackBox", &[
            (2, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_VOLUME_KEY])))),
            (3, FieldValue::Hook)
        ]),
        graph_box(VREGION, "ValueRegionBox", &[
            (1, FieldValue::Pointer(Some(Address::of(VTRACK, vec![3])))),
            (2, FieldValue::Pointer(Some(Address::of(VCOL, vec![2])))),
            (10, FieldValue::Int32(0)), (11, FieldValue::Int32(3840)),
            (12, FieldValue::Int32(0)), (13, FieldValue::Int32(3840))
        ]),
        graph_box(VCOL, "ValueEventCollectionBox", &[(1, FieldValue::Hook), (2, FieldValue::Hook)]),
        graph_box(VEVENT, "ValueEventBox", &[
            (1, FieldValue::Pointer(Some(Address::of(VCOL, vec![1])))),
            (10, FieldValue::Int32(0)), (13, FieldValue::Float32(0.75))
        ])
    ]);
    let mut unit = engine.build_unit(UNIT);
    engine.reconcile_one(&mut unit);
    // The armed strip-volume parameter registered a FLOAT broadcast at (UNIT, [volume]) carrying the
    // current unit value (TS `onStartAutomation` -> `broadcastFloat(adapter.address, getUnitValue)`).
    let volume_entry = (0..engine.broadcasts.len()).find(|index| {
        let entry = engine.broadcasts.entry(*index).expect("entry");
        entry.uuid == UNIT && entry.keys == vec![UNIT_VOLUME_KEY] && entry.package_type == crate::broadcast::PACKAGE_FLOAT
    });
    assert!(volume_entry.is_some(), "the automated volume broadcasts at its field address");
    // Detach the automation track: the rebind drops the slot; the sweep unregisters the entry.
    engine.graph.transaction(&[Update::Pointer {
        address: Address::of(VTRACK, vec![2]), old: Some(Address::of(UNIT, vec![UNIT_VOLUME_KEY])), new: None
    }], &engine.registry).expect("detach automation");
    engine.reconcile_one(&mut unit);
    engine.broadcasts.sweep();
    let still_there = (0..engine.broadcasts.len()).any(|index| {
        let entry = engine.broadcasts.entry(index).expect("entry");
        entry.uuid == UNIT && entry.keys == vec![UNIT_VOLUME_KEY]
    });
    assert!(!still_there, "detaching the track unregisters the parameter broadcast");
}

#[test]
fn a_device_param_automation_rebind_keeps_its_ui_broadcast_alive() {
    // A device param's automated value drives a UI broadcast at its field address (the knob animates). Every
    // automation edit re-observes the device's params (rebind_one). rebind_one held the OLD handles + the device
    // pull alive while re-registering, so the register dedup treated the outgoing slot as the winner and SKIPPED
    // the new one; the sweep then dropped the stale slot, leaving NO live broadcast — the knob froze while audio
    // kept updating (audio reads the handle directly). A fresh load registered once cleanly, which is why
    // save+load "fixed" it. The rebind must leave a LIVE broadcast matching the current handle's slot.
    use super::{DeviceParams, ParamNode};
    const DEV: Uuid = [80u8; 16];
    const TRACK: Uuid = [81u8; 16];
    const REGION: Uuid = [82u8; 16];
    const COL: Uuid = [83u8; 16];
    const EVENT: Uuid = [84u8; 16];
    const PATH: u16 = 11;
    let mut engine = engine_with_devices();
    engine.graph = BoxGraph::from_boxes(vec![
        graph_box(DEV, "TestEffect", &[(PATH, FieldValue::Float32(0.0))]),
        graph_box(TRACK, "TrackBox", &[
            (2, FieldValue::Pointer(Some(Address::of(DEV, vec![PATH])))),
            (3, FieldValue::Hook)
        ]),
        graph_box(REGION, "ValueRegionBox", &[
            (1, FieldValue::Pointer(Some(Address::of(TRACK, vec![3])))),
            (2, FieldValue::Pointer(Some(Address::of(COL, vec![2])))),
            (10, FieldValue::Int32(0)), (11, FieldValue::Int32(3840)),
            (12, FieldValue::Int32(0)), (13, FieldValue::Int32(3840))
        ]),
        graph_box(COL, "ValueEventCollectionBox", &[(1, FieldValue::Hook), (2, FieldValue::Hook)]),
        graph_box(EVENT, "ValueEventBox", &[
            (1, FieldValue::Pointer(Some(Address::of(COL, vec![1])))),
            (10, FieldValue::Int32(0)), (13, FieldValue::Float32(0.75))
        ])
    ]);
    let invalidate: Rc<dyn Fn()> = Rc::new(|| {});
    let (handles, field_subs, collections, _armed) = engine.observe_params(DEV, &[alloc::vec![PATH]], &invalidate);
    struct StubSink;
    impl crate::param_automation::ParamSink for StubSink {
        fn set_params(&mut self, _: alloc::vec::Vec<crate::param_automation::ParamHandle>, _: bool) {}
        fn state_ptr(&self) -> u32 { 0 }
    }
    let mut params = DeviceParams {
        device_uuid: DEV, reg: stub_device(DEVICE_KIND_AUDIO_EFFECT), state_ptr: 0,
        sink: ParamNode::Audio(Rc::new(RefCell::new(StubSink))),
        paths: alloc::vec![alloc::vec![PATH]], handles, field_subs, collections,
        observe_subs: Vec::new(), pointer_field_subs: Vec::new(), sidechain_paths: Vec::new(),
        param_hub_sub: None, sample_hub_sub: None, broadcast_slots: Vec::new()
    };
    let entry_ptr = |engine: &Engine| (0..engine.broadcasts.len()).find_map(|index| {
        let entry = engine.broadcasts.entry(index).expect("entry");
        (entry.uuid == DEV && entry.keys == vec![PATH] && entry.package_type == crate::broadcast::PACKAGE_FLOAT && entry.alive())
            .then_some(entry.ptr)
    });
    assert!(entry_ptr(&engine).is_some(), "initial bind registers a live broadcast at the param address");
    // An automation edit re-observes the params. The UI broadcast must stay live AND point at the CURRENT slot.
    engine.rebind_one(&mut params, &invalidate, 0.0);
    engine.broadcasts.sweep();
    let live = entry_ptr(&engine).expect("the rebind leaves a LIVE broadcast at the param address");
    let handle_ptr = params.handles[0].broadcast.as_ref().expect("automated handle has a slot").borrow().as_ptr() as u32;
    assert_eq!(live, handle_ptr, "the live broadcast matches the current handle's slot, not a stale dead one");
}

#[test]
fn a_launched_value_clip_replaces_the_region_automation() {
    const VCLIP: Uuid = [40u8; 16];
    const VCLIP_COLLECTION: Uuid = [41u8; 16];
    const VCLIP_EVENT: Uuid = [42u8; 16];
    let path: Vec<u16> = vec![4];
    let mut graph = BoxGraph::from_boxes(vec![
        graph_box(DEVICE, "RevampDeviceBox", &[]),
        graph_box(TRACK, "TrackBox", &[
            (2, FieldValue::Pointer(Some(Address::of(DEVICE, path.clone())))),
            (3, FieldValue::Hook),
            (super::TRACK_CLIPS_KEY, FieldValue::Hook)
        ]),
        graph_box(REGION, "ValueRegionBox", &[
            (1, FieldValue::Pointer(Some(Address::of(TRACK, vec![3])))),
            (2, FieldValue::Pointer(Some(Address::of(VCOLLECTION, vec![2])))),
            (10, FieldValue::Int32(0)), (11, FieldValue::Int32(3840)),
            (12, FieldValue::Int32(0)), (13, FieldValue::Int32(3840))
        ]),
        graph_box(VCOLLECTION, "ValueEventCollectionBox", &[(1, FieldValue::Hook), (2, FieldValue::Hook)]),
        graph_box(EVENT, "ValueEventBox", &[
            (1, FieldValue::Pointer(Some(Address::of(VCOLLECTION, vec![1])))),
            (10, FieldValue::Int32(0)), (13, FieldValue::Float32(0.7))
        ]),
        // The launchable VALUE clip: one bar long, a single event at 0.9.
        graph_box(VCLIP, "ValueClipBox", &[
            (1, FieldValue::Pointer(Some(Address::of(TRACK, vec![super::TRACK_CLIPS_KEY])))),
            (2, FieldValue::Pointer(Some(Address::of(VCLIP_COLLECTION, vec![2])))),
            (10, FieldValue::Int32(960))
        ]),
        graph_box(VCLIP_COLLECTION, "ValueEventCollectionBox", &[(1, FieldValue::Hook), (2, FieldValue::Hook)]),
        graph_box(VCLIP_EVENT, "ValueEventBox", &[
            (1, FieldValue::Pointer(Some(Address::of(VCLIP_COLLECTION, vec![1])))),
            (10, FieldValue::Int32(0)), (13, FieldValue::Float32(0.9))
        ])
    ]);
    let sequencer = clip_rc();
    let (curve, _, collections, rebind_uuids) = build_param_track(&mut graph, DEVICE, &path, &sequencer);
    let curve = curve.expect("a targeting track with a region -> a curve");
    assert_eq!(rebind_uuids, vec![REGION, VCLIP], "the region and the value clip are bound for re-binds");
    // Timeline automation resolves while nothing is launched.
    assert_eq!(curve.value_at(0.0), Some(0.7));
    // Launching the clip replaces the timeline value (the section starts at the queried position).
    sequencer.borrow_mut().schedule_play(TRACK, VCLIP);
    assert_eq!(curve.value_at(0.0), Some(0.9));
    // The clip's curve reads modulo ITS duration while it keeps playing.
    assert_eq!(curve.value_at(1920.0), Some(0.9));
    // A scheduled stop hands back to the timeline at the boundary.
    sequencer.borrow_mut().schedule_stop(TRACK);
    assert_eq!(curve.value_at(3840.0), Some(0.7));
    assert!(!collections.is_empty());
}

#[test]
fn build_param_track_resolves_the_full_field_path_at_any_depth() {
    // A three-level path — deeper than the old packed u32 key could ever represent — resolves the track.
    let deep = [16u16, 5, 10];
    let mut graph = deep_automation_graph(&deep);
    let (curve, track_uuid, collections, _) = build_param_track(&mut graph, DEVICE, &deep, &clip_rc());
    let curve = curve.expect("the parameter at the deep path has an automation track");
    assert_eq!(track_uuid, Some(TRACK), "the targeting track is found (its region hub is then watched)");
    assert_eq!(collections.len(), 1, "its one value region's collection is observed");
    assert_eq!(curve.value_at(0.0), Some(0.7), "and the curve reads its event through that path");
    // A different path on the same device has no track.
    let (none, _, _, _) = build_param_track(&mut graph, DEVICE, &[16, 5, 11], &clip_rc());
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

    let (curve_a, track_a, cols_a, _) = build_param_track(&mut graph, DEVICE, &path_a, &clip_rc());
    assert_eq!(track_a, Some(TRACK), "param A resolves to its own track");
    assert_eq!(cols_a.len(), 1, "param A observes ONLY its own track's value region");
    assert_eq!(curve_a.expect("curve A").value_at(0.0), Some(0.7));

    let (curve_b, track_b, cols_b, _) = build_param_track(&mut graph, DEVICE, &path_b, &clip_rc());
    assert_eq!(track_b, Some(TRACK_B), "param B resolves to the OTHER track");
    assert_eq!(cols_b.len(), 1, "param B observes ONLY its own track's value region");
    assert_eq!(curve_b.expect("curve B").value_at(0.0), Some(0.3));
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
    let curve = build_param_track(&mut graph, DEVICE, &path, &clip_rc()).0.expect("two regions -> a curve");

    assert_eq!(curve.value_at(-10.0), Some(0.2), "before the first region: its incoming value");
    assert_eq!(curve.value_at(50.0), Some(0.2), "inside region A");
    assert_eq!(curve.value_at(150.0), Some(0.2), "in the gap after A: A's HELD outgoing value, not B's");
    assert_eq!(curve.value_at(250.0), Some(0.8), "inside region B");
    assert_eq!(curve.value_at(500.0), Some(0.8), "past the last region: B's HELD outgoing value");
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
    let (curve, track_uuid, collections, _) = build_param_track(&mut graph, CHILD, &[4], &clip_rc());
    assert_eq!(track_uuid, Some(TRACK), "the track targeting the child's value field is found");
    assert_eq!(collections.len(), 1, "its one value region's collection is observed");
    assert_eq!(curve.expect("child param has an automation curve").value_at(0.0), Some(0.7),
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
fn adding_an_effect_to_the_output_unit_wires_it_live() {
    // The output unit is structurally a terminal bus (sum -> fx -> strip): it must reconcile like any bus so a
    // LIVE effect add is wired into the running master chain, not silently dropped until the next save + reload.
    // Regression for "a compressor/gate added to the master output does nothing until reload".
    use super::{UNIT_OUTPUT_KEY, BUS_ENABLED_KEY};
    let _ = UNIT_OUTPUT_KEY;
    const OUT_UNIT: Uuid = [70u8; 16];
    const OUT_BUS: Uuid = [71u8; 16];
    const FX: Uuid = [72u8; 16];
    const TYPE_KEY: u16 = 1; // AudioUnitBox `type`; "output" marks THE terminal master unit
    let mut engine = engine_with_devices();
    engine.graph = BoxGraph::from_boxes(vec![
        graph_box(OUT_UNIT, "AudioUnitBox", &[
            (TYPE_KEY, FieldValue::String("output".into())),
            (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook),
            (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook)
        ]),
        graph_box(OUT_BUS, "AudioBusBox", &[
            (HOST_KEY, FieldValue::Pointer(Some(Address::of(OUT_UNIT, vec![UNIT_INPUT_KEY])))),
            (6, FieldValue::Hook),
            (BUS_ENABLED_KEY, FieldValue::Boolean(true))
        ]),
        graph_box(FX, "TestEffect", &[
            (HOST_KEY, FieldValue::Pointer(Some(Address::of(OUT_UNIT, vec![UNIT_AUDIO_KEY])))),
            (EFFECT_INDEX_KEY, FieldValue::Int32(0))
        ])
    ]);
    // Drive the production reconcile loop: the output unit enters via the audio-units membership add.
    engine.unit_changes.borrow_mut().added.push(OUT_UNIT);
    engine.reconcile_units();
    let unit = engine.audio_units.iter().find(|unit| unit.unit == OUT_UNIT)
        .expect("the output unit reconciles like a normal bus unit (not a static singleton)");
    match unit.wired.as_ref().expect("wired after reconcile") {
        Wired::Bus(bus) => {
            // The master sum is shared (kept out of `nodes` so a teardown never removes it), so the output unit's
            // nodes are the built effect + strip, and its device_params carry the live-added effect.
            assert_eq!(bus.device_params.len(), 1, "the live-added output effect is built into the chain");
            assert!(bus.nodes.len() >= 2, "the effect + strip are wired ({} nodes)", bus.nodes.len());
        }
        _ => panic!("expected the output unit to reconcile as a Bus")
    }
    // And the terminal wiring: `render` reads the output unit's strip output, not the raw master sum.
    assert!(engine.output_bus.is_some(), "the output unit republished its strip as the render buffer");
}

#[test]
fn a_pointer_head_field_observation_tracks_the_target_box_and_the_repoint() {
    // The Zeitgeist shape: the device observes `[10, 10]` / `[10, 11]`, where key 10 on its own box is
    // the `groove` POINTER to a GrooveShuffleBox carrying `amount` (10) and `duration` (11). The engine
    // must deliver the TARGET box's values (catch-up + edits) and re-resolve on a repoint / clear.
    const ZDEV: Uuid = [40u8; 16];
    const GROOVE_A: Uuid = [41u8; 16];
    const GROOVE_B: Uuid = [42u8; 16];
    let mut engine = Engine::new(48_000.0);
    engine.graph = BoxGraph::from_boxes(vec![
        graph_box(ZDEV, "ZeitgeistDeviceBox", &[(10, FieldValue::Pointer(Some(Address::box_of(GROOVE_A))))]),
        graph_box(GROOVE_A, "GrooveShuffleBox", &[(10, FieldValue::Float32(0.6)), (11, FieldValue::Int32(480))]),
        graph_box(GROOVE_B, "GrooveShuffleBox", &[(10, FieldValue::Float32(0.25)), (11, FieldValue::Int32(960))])
    ]);
    let reg = crate::DeviceReg {field_changed_index: 7, ..stub_device(abi::DEVICE_KIND_MIDI_EFFECT)};
    let paths = vec![
        crate::FieldObs {path: vec![10, 10], target_key: 0},
        crate::FieldObs {path: vec![10, 11], target_key: 0}
    ];
    let deliveries = || core::mem::take(unsafe { crate::FIELD_DELIVERIES.get() });
    deliveries();
    let base = engine.graph.subscription_count();
    let (subs, pointer_subs) = engine.observe_fields(ZDEV, reg, 0, &paths);
    assert_eq!(deliveries(), vec![
        (0, abi::FIELD_KIND_FLOAT, 0.6f32.to_bits(), 0),
        (1, abi::FIELD_KIND_INT, 480, 0)
    ], "catch-up delivers the CONNECTED groove box's values across the pointer");
    let edit = |engine: &mut Engine, uuid: Uuid, key: u16, old: FieldValue, new: FieldValue|
        engine.graph.transaction(&[Update::Primitive {address: Address::of(uuid, vec![key]), old, new}],
            &engine.registry).expect("edit");
    edit(&mut engine, GROOVE_A, 10, FieldValue::Float32(0.6), FieldValue::Float32(0.9));
    assert_eq!(deliveries(), vec![(0, abi::FIELD_KIND_FLOAT, 0.9f32.to_bits(), 0)],
        "a target field edit is delivered live");
    let repoint = |engine: &mut Engine, old: Option<Address>, new: Option<Address>|
        engine.graph.transaction(&[Update::Pointer {address: Address::of(ZDEV, vec![10]), old, new}],
            &engine.registry).expect("repoint");
    repoint(&mut engine, Some(Address::box_of(GROOVE_A)), Some(Address::box_of(GROOVE_B)));
    assert_eq!(deliveries(), vec![
        (0, abi::FIELD_KIND_FLOAT, 0.25f32.to_bits(), 0),
        (1, abi::FIELD_KIND_INT, 960, 0)
    ], "a repoint delivers the NEW target's values");
    edit(&mut engine, GROOVE_A, 10, FieldValue::Float32(0.9), FieldValue::Float32(0.1));
    assert_eq!(deliveries(), vec![], "the old target is no longer observed");
    edit(&mut engine, GROOVE_B, 11, FieldValue::Int32(960), FieldValue::Int32(1920));
    assert_eq!(deliveries(), vec![(1, abi::FIELD_KIND_INT, 1920, 0)], "the new target's edits are delivered");
    repoint(&mut engine, Some(Address::box_of(GROOVE_B)), None);
    assert_eq!(deliveries(), vec![], "an unbound pointer delivers nothing (the device keeps its last values)");
    edit(&mut engine, GROOVE_B, 11, FieldValue::Int32(1920), FieldValue::Int32(480));
    assert_eq!(deliveries(), vec![], "no target, no delivery");
    for sub in subs {
        engine.graph.unsubscribe(sub);
    }
    for cell in pointer_subs {
        if let Some(sub) = cell.take() {
            engine.graph.unsubscribe(sub);
        }
    }
    assert_eq!(engine.graph.subscription_count(), base, "teardown releases every observation (no leak)");
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

#[test]
fn a_value_track_on_the_mute_field_installs_the_strip_mute_automation() {
    // #305: a Value track targeting the UNIT's mute (key 14) must install the strip's mute automation source, so an
    // automated mute is applied (and broadcast to the UI). Before the fix `bind_strip_automation` only observed
    // volume/panning, so the mute curve was never bound and the automation did nothing.
    const VTRACK: Uuid = [30u8; 16];
    const VREGION: Uuid = [31u8; 16];
    const VCOLL: Uuid = [32u8; 16];
    const VEVENT: Uuid = [33u8; 16];
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
            (2, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_MUTE_KEY])))),
            (3, FieldValue::Hook)
        ]),
        graph_box(VREGION, "ValueRegionBox", &[
            (1, FieldValue::Pointer(Some(Address::of(VTRACK, vec![3])))),
            (2, FieldValue::Pointer(Some(Address::of(VCOLL, vec![2])))),
            (10, FieldValue::Int32(0)), (11, FieldValue::Int32(3840)), (12, FieldValue::Int32(0)), (13, FieldValue::Int32(3840))
        ]),
        graph_box(VCOLL, "ValueEventCollectionBox", &[(1, FieldValue::Hook), (2, FieldValue::Hook)]),
        graph_box(VEVENT, "ValueEventBox", &[
            (1, FieldValue::Pointer(Some(Address::of(VCOLL, vec![1])))), (10, FieldValue::Int32(0)), (13, FieldValue::Float32(1.0))
        ])
    ]);
    engine.graph = BoxGraph::from_boxes(boxes);
    let mut unit = engine.build_unit(UNIT);
    engine.bind_strip_automation(&mut unit);
    let muted_at_zero = {
        let mute_source = unit.strip_automation.mute.borrow();
        let mute_source = mute_source.as_ref().expect("a mute value track installs the strip mute automation source");
        mute_source(0.0) >= 0.5
    };
    assert!(muted_at_zero, "the mute curve (event 1.0) resolves to muted at position 0");
    engine.teardown_unit(unit);
}

#[test]
fn update_positions_gate_on_transporting_blocks() {
    // TS `UpdateClock.process` skips a block without `BlockFlag.transporting`: a PAUSED quantum (the
    // free-running block whose pulse range keeps advancing at a non-song position) must yield NO update
    // positions, so automated parameters HOLD their last value and the UI broadcast stays still (BUG:
    // paused automation kept executing and animating the knobs).
    let _guard = pull_lock();
    let paused = [engine_env::block::Block {index: 0, flags: engine_env::block_flags::BlockFlags::create(false, false, false, false),
        p0: 500.0, p1: 505.12, s0: 0, s1: 128, bpm: 120.0}];
    let playing = [engine_env::block::Block {index: 0, flags: engine_env::block_flags::BlockFlags::create(true, false, true, false),
        p0: 500.0, p1: 505.12, s0: 0, s1: 128, bpm: 120.0}];
    {
        let pull = unsafe { crate::PULL.get() };
        pull.clock_armed = true;
        pull.blocks = paused.as_ptr();
        pull.block_count = 1;
    }
    assert!(crate::host_first_update_position(500.0).is_infinite(), "a paused quantum yields no update positions");
    assert!(crate::host_next_update_position(500.0).is_infinite(), "a paused quantum never advances the update loop");
    {
        let pull = unsafe { crate::PULL.get() };
        pull.blocks = playing.as_ptr();
    }
    assert_eq!(crate::host_first_update_position(500.0), 500.0, "a transporting quantum keeps the inclusive grid seed");
    assert_eq!(crate::host_next_update_position(500.0), 510.0, "a transporting quantum advances strictly on the grid");
    {
        let pull = unsafe { crate::PULL.get() };
        pull.clock_armed = false;
        pull.blocks = core::ptr::null();
        pull.block_count = 0;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// EFFECT COMPOSITES: a parallel FX stack as ONE member of an audio chain.
// ─────────────────────────────────────────────────────────────────────────────

const COMP: Uuid = [20u8; 16];
const ENTRY_A: Uuid = [21u8; 16];
const ENTRY_B: Uuid = [22u8; 16];
const ENTRY_C: Uuid = [23u8; 16];
const ENTRY_D: Uuid = [24u8; 16];
const NESTED_A: Uuid = [23u8; 16];
const NESTED_B: Uuid = [24u8; 16];

// The registered field keys, mirroring EFFECT_COMPOSITES in core-wasm/src/engine-modules.ts.
const ENTRIES_FIELD: u16 = 10;
const INPUT_TAP_FIELD: u16 = 11;
const DRY_KEY: u16 = 12;
const WET_KEY: u16 = 13;
const CROSSOVER1_KEY: u16 = 14;
const CROSSOVER2_KEY: u16 = 15;
const CROSSOVER3_KEY: u16 = 16;
const ENTRY_INDEX_KEY: u16 = 3;
const ENTRY_CHAIN_FIELD: u16 = 2;
const ENTRY_LABEL_KEY: u16 = 4;
const ENTRY_GAIN_KEY: u16 = 40;
const ENTRY_PAN_KEY: u16 = 43;
const ENTRY_MUTE_KEY: u16 = 41;
const ENTRY_SOLO_KEY: u16 = 42;
const ENTRY_COMPOSITE_KEY: u16 = 1; // the entry's mandatory `composite` pointer

fn engine_with_composite() -> Engine {
    let mut engine = engine_with_devices();
    engine.register_effect_composite("TestComposite".to_string(), DEVICE_KIND_AUDIO_EFFECT as u8,
        crate::Distributor::Broadcast, ENTRIES_FIELD, ENTRY_INDEX_KEY, ENTRY_CHAIN_FIELD, ENTRY_LABEL_KEY,
        ENTRY_GAIN_KEY, ENTRY_PAN_KEY, ENTRY_MUTE_KEY, ENTRY_SOLO_KEY, DRY_KEY, WET_KEY, INPUT_TAP_FIELD,
        [0, 0, 0]);
    engine
}

fn entry_box(uuid: Uuid, index: i32, label: &str) -> GraphBox {
    graph_box(uuid, "TestCompositeCell", &[
        (ENTRY_COMPOSITE_KEY, FieldValue::Pointer(Some(Address::of(COMP, vec![ENTRIES_FIELD])))),
        (ENTRY_CHAIN_FIELD, FieldValue::Hook),
        (ENTRY_INDEX_KEY, FieldValue::Int32(index)),
        (ENTRY_LABEL_KEY, FieldValue::String(label.to_string())),
        (ENTRY_GAIN_KEY, FieldValue::Float32(0.0)),
        (ENTRY_PAN_KEY, FieldValue::Float32(0.0)),
        (ENTRY_MUTE_KEY, FieldValue::Boolean(false)),
        (ENTRY_SOLO_KEY, FieldValue::Boolean(false))
    ])
}

// A unit whose audio chain holds ONE composite (index 0) with two entries; entry A holds one nested
// effect, entry B is empty (an identity branch). NESTED_B exists but is unattached, so it can join later.
fn fx_composite_graph() -> BoxGraph {
    BoxGraph::from_boxes(vec![
        graph_box(UNIT, "AudioUnitBox", &[
            (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook),
            (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook)
        ]),
        graph_box(INSTR, "TestInstrument", &[
            (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_INPUT_KEY]))))
        ]),
        graph_box(COMP, "TestComposite", &[
            (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_AUDIO_KEY])))),
            (EFFECT_INDEX_KEY, FieldValue::Int32(0)),
            (DEVICE_ENABLED_KEY, FieldValue::Boolean(true)),
            (ENTRIES_FIELD, FieldValue::Hook),
            (INPUT_TAP_FIELD, FieldValue::Hook),
            (DRY_KEY, FieldValue::Float32(f32::NEG_INFINITY)),
            (WET_KEY, FieldValue::Float32(0.0))
        ]),
        entry_box(ENTRY_A, 0, "A"),
        entry_box(ENTRY_B, 1, "B"),
        graph_box(NESTED_A, "TestEffect", &[
            (HOST_KEY, FieldValue::Pointer(Some(Address::of(ENTRY_A, vec![ENTRY_CHAIN_FIELD])))),
            (EFFECT_INDEX_KEY, FieldValue::Int32(0)),
            (DEVICE_ENABLED_KEY, FieldValue::Boolean(true))
        ]),
        graph_box(NESTED_B, "TestEffect", &[
            (HOST_KEY, FieldValue::Pointer(None)),
            (EFFECT_INDEX_KEY, FieldValue::Int32(0)),
            (DEVICE_ENABLED_KEY, FieldValue::Boolean(true))
        ])
    ])
}

// The composite binding of the unit's first audio member.
fn composite_of(unit: &AudioUnitBinding) -> &crate::effect_composite::EffectCompositeBinding {
    match unit.wired.as_ref().expect("wired after reconcile") {
        Wired::Leaf(chain) => match &chain.audio.first().expect("a composite member").proc {
            ProcHandle::EffectComposite(binding) => binding,
            _ => panic!("expected the audio member to be an effect composite")
        },
        _ => panic!("expected a leaf chain")
    }
}

#[test]
fn a_composite_joins_an_audio_chain_as_one_member_wired_distributor_in_mix_out() {
    let mut engine = engine_with_composite();
    engine.graph = fx_composite_graph();
    let mut unit = engine.build_unit(UNIT);
    engine.reconcile_one(&mut unit);
    let (instr_node, audio) = leaf_nodes(&unit);
    assert_eq!(audio.len(), 1, "the whole stack is ONE member of the unit chain");
    let (distributor, mix) = {
        let binding = composite_of(&unit);
        assert_eq!(binding.entry_count(), 2, "both entries built");
        (binding.distributor_id, binding.mix_id)
    };
    assert_eq!(audio[0], mix, "the chain continues from the composite's MIX");
    // The upstream must feed the DISTRIBUTOR, not the mix: that is what `input_node` expresses.
    let edges = leaf_edges(&unit);
    assert!(edges.contains(&(instr_node, distributor)),
        "the instrument feeds the composite's distributor");
    assert!(!edges.contains(&(instr_node, mix)), "and NOT its mix");
}

#[test]
fn an_entry_join_keeps_every_surviving_processor_and_the_composite_s_own_nodes() {
    let mut engine = engine_with_composite();
    engine.graph = fx_composite_graph();
    let mut unit = engine.build_unit(UNIT);
    engine.reconcile_one(&mut unit);
    let (distributor_before, mix_before, chain_a_before) = {
        let binding = composite_of(&unit);
        (binding.distributor_id, binding.mix_id, binding.entry_chain_len(ENTRY_A).expect("entry A"))
    };
    assert_eq!(chain_a_before, 1, "entry A holds one nested effect");
    assert_eq!(composite_of(&unit).entry_chain_len(ENTRY_B), Some(0), "entry B is an identity branch");
    // Attach NESTED_B into entry B's chain through a real transaction.
    let connect = Update::Pointer {
        address: Address::of(NESTED_B, vec![HOST_KEY]),
        old: None,
        new: Some(Address::of(ENTRY_B, vec![ENTRY_CHAIN_FIELD]))
    };
    engine.graph.transaction(&[connect], &engine.registry).expect("connect NESTED_B");
    engine.reconcile_one(&mut unit);
    let binding = composite_of(&unit);
    assert_eq!(binding.entry_chain_len(ENTRY_B), Some(1), "entry B took the joiner");
    assert_eq!(binding.entry_chain_len(ENTRY_A), Some(1), "entry A is untouched");
    // The composite's OWN nodes persist, so the unit chain around it is never re-wired.
    assert_eq!(binding.distributor_id, distributor_before, "the distributor persists across an entry edit");
    assert_eq!(binding.mix_id, mix_before, "and so does the mix");
}

#[test]
fn muting_an_entry_silences_only_that_entry() {
    let mut engine = engine_with_composite();
    engine.graph = fx_composite_graph();
    let mut unit = engine.build_unit(UNIT);
    engine.reconcile_one(&mut unit);
    assert_eq!(composite_of(&unit).entry_silent(ENTRY_A), Some(false), "nothing is silent initially");
    let mute = Update::Primitive {
        address: Address::of(ENTRY_A, vec![ENTRY_MUTE_KEY]),
        old: FieldValue::Boolean(false),
        new: FieldValue::Boolean(true)
    };
    engine.graph.transaction(&[mute], &engine.registry).expect("mute entry A");
    engine.reconcile_one(&mut unit);
    let binding = composite_of(&unit);
    assert_eq!(binding.entry_silent(ENTRY_A), Some(true), "the muted entry is silent");
    assert_eq!(binding.entry_silent(ENTRY_B), Some(false), "its sibling is untouched");
}

// A pure REORDER (swap two entries' index fields, no chain change) must re-point each survivor onto its new
// distributor branch. Broadcast makes this audibly a no-op, but a positional distributor (a stereo split) reads
// the branch by position, so a survivor left on its old branch would silently swap the channels.
#[test]
fn reordering_entries_rewires_each_to_its_new_branch() {
    let mut engine = engine_with_composite();
    engine.graph = fx_composite_graph();
    let mut unit = engine.build_unit(UNIT);
    engine.reconcile_one(&mut unit);
    assert_eq!(composite_of(&unit).entry_branch(ENTRY_A), Some(0), "A starts on branch 0");
    assert_eq!(composite_of(&unit).entry_branch(ENTRY_B), Some(1), "B starts on branch 1");
    let swap = [
        Update::Primitive {
            address: Address::of(ENTRY_A, vec![ENTRY_INDEX_KEY]),
            old: FieldValue::Int32(0), new: FieldValue::Int32(1)
        },
        Update::Primitive {
            address: Address::of(ENTRY_B, vec![ENTRY_INDEX_KEY]),
            old: FieldValue::Int32(1), new: FieldValue::Int32(0)
        }
    ];
    engine.graph.transaction(&swap, &engine.registry).expect("swap entry order");
    engine.reconcile_one(&mut unit);
    let binding = composite_of(&unit);
    assert_eq!(binding.entry_branch(ENTRY_A), Some(1), "A moved to branch 1");
    assert_eq!(binding.entry_branch(ENTRY_B), Some(0), "B moved to branch 0");
    assert_eq!(binding.entry_count(), 2, "both entries survived the reorder");
}

#[test]
fn soloing_one_entry_silences_every_sibling() {
    let mut engine = engine_with_composite();
    engine.graph = fx_composite_graph();
    let mut unit = engine.build_unit(UNIT);
    engine.reconcile_one(&mut unit);
    let solo = Update::Primitive {
        address: Address::of(ENTRY_B, vec![ENTRY_SOLO_KEY]),
        old: FieldValue::Boolean(false),
        new: FieldValue::Boolean(true)
    };
    engine.graph.transaction(&[solo], &engine.registry).expect("solo entry B");
    engine.reconcile_one(&mut unit);
    {
        let binding = composite_of(&unit);
        // Solo is a CROSS-entry fact, exactly like the mixer's: it silences the OTHERS.
        assert_eq!(binding.entry_silent(ENTRY_B), Some(false), "the soloed entry plays");
        assert_eq!(binding.entry_silent(ENTRY_A), Some(true), "its non-soloed sibling is silenced");
    }
    // Un-soloing restores every sibling.
    let unsolo = Update::Primitive {
        address: Address::of(ENTRY_B, vec![ENTRY_SOLO_KEY]),
        old: FieldValue::Boolean(true),
        new: FieldValue::Boolean(false)
    };
    engine.graph.transaction(&[unsolo], &engine.registry).expect("un-solo entry B");
    engine.reconcile_one(&mut unit);
    assert_eq!(composite_of(&unit).entry_silent(ENTRY_A), Some(false), "un-solo restores the sibling");
}

// A composite with two EMPTY entries (identity branches) whose gains differ, so the two are separable in the
// rendered mix. Dry is off and wet at unity, so the output is exactly the entry strips' sum.
fn entry_box_gain(uuid: Uuid, index: i32, label: &str, gain_db: f32) -> GraphBox {
    graph_box(uuid, "TestCompositeCell", &[
        (ENTRY_COMPOSITE_KEY, FieldValue::Pointer(Some(Address::of(COMP, vec![ENTRIES_FIELD])))),
        (ENTRY_CHAIN_FIELD, FieldValue::Hook),
        (ENTRY_INDEX_KEY, FieldValue::Int32(index)),
        (ENTRY_LABEL_KEY, FieldValue::String(label.to_string())),
        (ENTRY_GAIN_KEY, FieldValue::Float32(gain_db)),
        (ENTRY_PAN_KEY, FieldValue::Float32(0.0)),
        (ENTRY_MUTE_KEY, FieldValue::Boolean(false)),
        (ENTRY_SOLO_KEY, FieldValue::Boolean(false))
    ])
}

fn fx_render_graph(gain_a_db: f32, gain_b_db: f32) -> BoxGraph {
    BoxGraph::from_boxes(vec![
        graph_box(UNIT, "AudioUnitBox", &[
            (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook),
            (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook)
        ]),
        graph_box(INSTR, "TestInstrument", &[
            (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_INPUT_KEY]))))
        ]),
        graph_box(COMP, "TestComposite", &[
            (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_AUDIO_KEY])))),
            (EFFECT_INDEX_KEY, FieldValue::Int32(0)),
            (DEVICE_ENABLED_KEY, FieldValue::Boolean(true)),
            (ENTRIES_FIELD, FieldValue::Hook),
            (INPUT_TAP_FIELD, FieldValue::Hook),
            (DRY_KEY, FieldValue::Float32(f32::NEG_INFINITY)),
            (WET_KEY, FieldValue::Float32(0.0))
        ]),
        entry_box_gain(ENTRY_A, 0, "A", gain_a_db),
        entry_box_gain(ENTRY_B, 1, "B", gain_b_db)
    ])
}

// Feed a DC of 1.0 straight into the distributor (reconcile re-points it at the silent stub instrument, so
// this is re-applied every call) and render enough quanta for the strip de-click ramps to settle; return the
// composite's steady-state mix output.
fn render_mix(engine: &mut Engine, unit: &AudioUnitBinding) -> (f32, f32) {
    let dc = shared_audio_buffer();
    {
        let mut buffer = dc.borrow_mut();
        for index in 0..engine_env::RENDER_QUANTUM {
            buffer.left[index] = 1.0;
            buffer.right[index] = 1.0;
        }
    }
    composite_of(unit).set_audio_source(dc);
    let block = abi::Block {index: 0, flags: abi::BlockFlags::create(true, false, false, false),
        p0: 0.0, p1: 1.0, s0: 0, s1: engine_env::RENDER_QUANTUM as u32, bpm: 120.0};
    for _ in 0..16 {
        engine.context.process(&engine_env::process_info::ProcessInfo {blocks: &[block]});
    }
    let out = composite_of(unit).mix_output.borrow();
    (out.left[0], out.right[0])
}

fn set_bool(engine: &mut Engine, uuid: Uuid, key: u16, from: bool, to: bool) {
    engine.graph.transaction(&[Update::Primitive {
        address: Address::of(uuid, vec![key]),
        old: FieldValue::Boolean(from), new: FieldValue::Boolean(to)
    }], &engine.registry).expect("toggle bool field");
}

// Render through the PRODUCTION reconcile loop: the unit lives in `engine.audio_units` and a field edit must
// enqueue it into `dirty_units` for `reconcile_units` to pick up — exactly the live path (a manual
// `reconcile_one` bypasses that enqueue). Returns the composite's steady-state mix output.
fn render_mix_live(engine: &mut Engine, unit_uuid: Uuid) -> (f32, f32) {
    let dc = shared_audio_buffer();
    {
        let mut buffer = dc.borrow_mut();
        for index in 0..engine_env::RENDER_QUANTUM {
            buffer.left[index] = 1.0;
            buffer.right[index] = 1.0;
        }
    }
    let mix_output = {
        let unit = engine.audio_units.iter().find(|binding| binding.unit == unit_uuid).expect("unit");
        let composite = composite_of(unit);
        composite.set_audio_source(dc);
        composite.mix_output.clone()
    };
    let block = abi::Block {index: 0, flags: abi::BlockFlags::create(true, false, false, false),
        p0: 0.0, p1: 1.0, s0: 0, s1: engine_env::RENDER_QUANTUM as u32, bpm: 120.0};
    for _ in 0..16 {
        engine.context.process(&engine_env::process_info::ProcessInfo {blocks: &[block]});
    }
    let out = mix_output.borrow();
    (out.left[0], out.right[0])
}

#[test]
fn muting_an_entry_through_the_production_loop_removes_it_from_the_mix() {
    let mut engine = engine_with_composite();
    engine.graph = fx_render_graph(0.0, -12.0);
    engine.unit_changes.borrow_mut().added.push(UNIT);
    engine.reconcile_units();
    let (base_left, _) = render_mix_live(&mut engine, UNIT);
    assert!((base_left - 1.251).abs() < 0.02, "both entries sum into the mix (got {base_left})");
    set_bool(&mut engine, ENTRY_A, ENTRY_MUTE_KEY, false, true);
    engine.reconcile_units(); // the edit must enqueue the unit; a drain that no-ops here IS the live bug
    let (muted_left, _) = render_mix_live(&mut engine, UNIT);
    assert!((muted_left - 0.251).abs() < 0.02, "muting A leaves only B (got {muted_left})");
}

#[test]
fn soloing_an_entry_through_the_production_loop_keeps_only_that_entry() {
    let mut engine = engine_with_composite();
    engine.graph = fx_render_graph(0.0, -12.0);
    engine.unit_changes.borrow_mut().added.push(UNIT);
    engine.reconcile_units();
    set_bool(&mut engine, ENTRY_A, ENTRY_SOLO_KEY, false, true);
    engine.reconcile_units();
    let (solo_left, _) = render_mix_live(&mut engine, UNIT);
    assert!((solo_left - 1.0).abs() < 0.02, "soloing A keeps A (~1.0), not B's ~0.25 (got {solo_left})");
}

#[test]
fn panning_an_entry_through_the_production_loop_removes_its_right_channel() {
    let mut engine = engine_with_composite();
    engine.graph = fx_render_graph(0.0, -12.0);
    engine.unit_changes.borrow_mut().added.push(UNIT);
    engine.reconcile_units();
    engine.graph.transaction(&[Update::Primitive {
        address: Address::of(ENTRY_A, vec![ENTRY_PAN_KEY]),
        old: FieldValue::Float32(0.0), new: FieldValue::Float32(-1.0)
    }], &engine.registry).expect("pan A hard left");
    engine.reconcile_units();
    let (_, pan_right) = render_mix_live(&mut engine, UNIT);
    assert!((pan_right - 0.251).abs() < 0.02, "A drops off the right, leaving only B (got {pan_right})");
}

fn engine_with_frequency_composite() -> Engine {
    let mut engine = engine_with_devices();
    engine.register_effect_composite("TestComposite".to_string(), DEVICE_KIND_AUDIO_EFFECT as u8,
        crate::Distributor::Frequency, ENTRIES_FIELD, ENTRY_INDEX_KEY, ENTRY_CHAIN_FIELD, ENTRY_LABEL_KEY,
        ENTRY_GAIN_KEY, ENTRY_PAN_KEY, ENTRY_MUTE_KEY, ENTRY_SOLO_KEY, DRY_KEY, WET_KEY, INPUT_TAP_FIELD,
        [CROSSOVER1_KEY, 0, 0]);
    engine
}

fn frequency_render_graph() -> BoxGraph {
    BoxGraph::from_boxes(vec![
        graph_box(UNIT, "AudioUnitBox", &[
            (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook),
            (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook)
        ]),
        graph_box(INSTR, "TestInstrument", &[
            (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_INPUT_KEY]))))
        ]),
        graph_box(COMP, "TestComposite", &[
            (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_AUDIO_KEY])))),
            (EFFECT_INDEX_KEY, FieldValue::Int32(0)),
            (DEVICE_ENABLED_KEY, FieldValue::Boolean(true)),
            (ENTRIES_FIELD, FieldValue::Hook),
            (INPUT_TAP_FIELD, FieldValue::Hook),
            (DRY_KEY, FieldValue::Float32(f32::NEG_INFINITY)),
            (WET_KEY, FieldValue::Float32(0.0)),
            (CROSSOVER1_KEY, FieldValue::Float32(1_000.0))
        ]),
        entry_box_gain(ENTRY_A, 0, "Low", 0.0),
        entry_box_gain(ENTRY_B, 1, "High", 0.0)
    ])
}

fn engine_with_frequency_composite_bands() -> Engine {
    let mut engine = engine_with_devices();
    engine.register_effect_composite("TestComposite".to_string(), DEVICE_KIND_AUDIO_EFFECT as u8,
        crate::Distributor::Frequency, ENTRIES_FIELD, ENTRY_INDEX_KEY, ENTRY_CHAIN_FIELD, ENTRY_LABEL_KEY,
        ENTRY_GAIN_KEY, ENTRY_PAN_KEY, ENTRY_MUTE_KEY, ENTRY_SOLO_KEY, DRY_KEY, WET_KEY, INPUT_TAP_FIELD,
        [CROSSOVER1_KEY, CROSSOVER2_KEY, CROSSOVER3_KEY]);
    engine
}

fn frequency_render_graph_4() -> BoxGraph {
    BoxGraph::from_boxes(vec![
        graph_box(UNIT, "AudioUnitBox", &[
            (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook),
            (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook)
        ]),
        graph_box(INSTR, "TestInstrument", &[
            (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_INPUT_KEY]))))
        ]),
        graph_box(COMP, "TestComposite", &[
            (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_AUDIO_KEY])))),
            (EFFECT_INDEX_KEY, FieldValue::Int32(0)),
            (DEVICE_ENABLED_KEY, FieldValue::Boolean(true)),
            (ENTRIES_FIELD, FieldValue::Hook),
            (INPUT_TAP_FIELD, FieldValue::Hook),
            (DRY_KEY, FieldValue::Float32(f32::NEG_INFINITY)),
            (WET_KEY, FieldValue::Float32(0.0)),
            (CROSSOVER1_KEY, FieldValue::Float32(200.0)),
            (CROSSOVER2_KEY, FieldValue::Float32(1_000.0)),
            (CROSSOVER3_KEY, FieldValue::Float32(5_000.0))
        ]),
        entry_box_gain(ENTRY_A, 0, "Low", 0.0),
        entry_box_gain(ENTRY_B, 1, "LowMid", 0.0),
        entry_box_gain(ENTRY_C, 2, "HighMid", 0.0),
        entry_box_gain(ENTRY_D, 3, "High", 0.0)
    ])
}

// Feed a steady sine into the distributor and return the mix output's RMS relative to the input's, over the
// settled tail. An allpass reconstruction preserves magnitude, so a band that actually carries the tone gives ~1.
fn frequency_sine_rms_ratio(engine: &mut Engine, unit: &AudioUnitBinding, freq: f32) -> f64 {
    let src = shared_audio_buffer();
    composite_of(unit).set_audio_source(src.clone());
    let block = abi::Block {index: 0, flags: abi::BlockFlags::create(true, false, false, false),
        p0: 0.0, p1: 1.0, s0: 0, s1: engine_env::RENDER_QUANTUM as u32, bpm: 120.0};
    let step = 2.0 * core::f32::consts::PI * freq / 48_000.0;
    let mut phase = 0.0f32;
    let (mut energy_in, mut energy_out) = (0.0f64, 0.0f64);
    for round in 0..24 {
        {
            let mut buffer = src.borrow_mut();
            for index in 0..engine_env::RENDER_QUANTUM {
                let value = math::sin(phase);
                buffer.left[index] = value;
                buffer.right[index] = value;
                phase += step;
            }
        }
        engine.context.process(&engine_env::process_info::ProcessInfo {blocks: &[block]});
        if round >= 12 {
            let out = composite_of(unit).mix_output.borrow();
            let input = src.borrow();
            for index in 0..engine_env::RENDER_QUANTUM {
                energy_in += (input.left[index] as f64).powi(2);
                energy_out += (out.left[index] as f64).powi(2);
            }
        }
    }
    (energy_out / energy_in).sqrt()
}

#[test]
fn a_four_band_split_keeps_the_two_highest_bands_audible() {
    for &(freq, band) in &[(8_000.0f32, "top"), (2_500.0f32, "high-mid")] {
        let mut engine = engine_with_frequency_composite_bands();
        engine.graph = frequency_render_graph_4();
        let mut unit = engine.build_unit(UNIT);
        engine.reconcile_one(&mut unit);
        let ratio = frequency_sine_rms_ratio(&mut engine, &unit, freq);
        assert!(ratio > 0.9, "the {band} band must pass a {freq}Hz tone (out/in RMS {ratio})");
    }
}

#[test]
fn a_frequency_composite_routes_dc_to_the_low_band_only() {
    let mut engine = engine_with_frequency_composite();
    engine.graph = frequency_render_graph();
    let mut unit = engine.build_unit(UNIT);
    engine.reconcile_one(&mut unit);
    let (left, right) = render_mix(&mut engine, &unit);
    // DC (0 Hz) passes the lowpass band at unity and is blocked by the highpass band, so the two empty bands sum
    // back to the input (1.0), NOT to 2.0 as a broadcast to both entries would. This is the whole point of the
    // Linkwitz-Riley split, and it proves the Frequency distributor is wired end to end.
    assert!((left - 1.0).abs() < 0.02, "DC reaches only the low band, summing to 1.0 (got {left})");
    assert!((right - 1.0).abs() < 0.02, "and the same on the right (got {right})");
}

#[test]
fn muting_an_entry_removes_it_from_the_rendered_mix() {
    let mut engine = engine_with_composite();
    engine.graph = fx_render_graph(0.0, -12.0); // A at 0 dB (~1.0), B at -12 dB (~0.25)
    let mut unit = engine.build_unit(UNIT);
    engine.reconcile_one(&mut unit);
    let (base_left, _) = render_mix(&mut engine, &unit);
    assert!((base_left - 1.251).abs() < 0.02, "both entries sum into the mix (got {base_left})");
    set_bool(&mut engine, ENTRY_A, ENTRY_MUTE_KEY, false, true);
    engine.reconcile_one(&mut unit);
    let (muted_left, _) = render_mix(&mut engine, &unit);
    assert!((muted_left - 0.251).abs() < 0.02, "muting A leaves only B in the mix (got {muted_left})");
}

#[test]
fn soloing_an_entry_keeps_only_that_entry_in_the_rendered_mix() {
    let mut engine = engine_with_composite();
    engine.graph = fx_render_graph(0.0, -12.0); // A at 0 dB (~1.0), B at -12 dB (~0.25)
    let mut unit = engine.build_unit(UNIT);
    engine.reconcile_one(&mut unit);
    set_bool(&mut engine, ENTRY_A, ENTRY_SOLO_KEY, false, true);
    engine.reconcile_one(&mut unit);
    let (solo_left, _) = render_mix(&mut engine, &unit);
    assert!((solo_left - 1.0).abs() < 0.02,
        "soloing A keeps A (~1.0) and silences B; a wrong-chain solo would read B's ~0.25 (got {solo_left})");
}

#[test]
fn panning_an_entry_hard_left_removes_its_right_channel_from_the_mix() {
    let mut engine = engine_with_composite();
    engine.graph = fx_render_graph(0.0, -12.0);
    let mut unit = engine.build_unit(UNIT);
    engine.reconcile_one(&mut unit);
    let (_, base_right) = render_mix(&mut engine, &unit);
    assert!((base_right - 1.251).abs() < 0.02, "both entries feed the right channel (got {base_right})");
    engine.graph.transaction(&[Update::Primitive {
        address: Address::of(ENTRY_A, vec![ENTRY_PAN_KEY]),
        old: FieldValue::Float32(0.0), new: FieldValue::Float32(-1.0)
    }], &engine.registry).expect("pan A hard left");
    engine.reconcile_one(&mut unit);
    let (pan_left, pan_right) = render_mix(&mut engine, &unit);
    assert!((pan_left - 1.251).abs() < 0.02, "A stays full on the left (got {pan_left})");
    assert!((pan_right - 0.251).abs() < 0.02, "A drops off the right, leaving only B (got {pan_right})");
}

#[test]
fn disabling_a_nested_effect_bypasses_it_edge_only_keeping_its_processor() {
    let mut engine = engine_with_composite();
    engine.graph = fx_composite_graph();
    let mut unit = engine.build_unit(UNIT);
    engine.reconcile_one(&mut unit);
    let wired_before = composite_of(&unit).entry_wired_count(ENTRY_A).expect("entry A");
    let disable = Update::Primitive {
        address: Address::of(NESTED_A, vec![DEVICE_ENABLED_KEY]),
        old: FieldValue::Boolean(true),
        new: FieldValue::Boolean(false)
    };
    engine.graph.transaction(&[disable], &engine.registry).expect("disable NESTED_A");
    engine.reconcile_one(&mut unit);
    let binding = composite_of(&unit);
    assert_eq!(binding.entry_chain_len(ENTRY_A), Some(1),
        "the disabled effect is still OWNED (its processor + DSP state survive)");
    assert!(binding.entry_wired_count(ENTRY_A).expect("entry A") < wired_before,
        "but it is no longer WIRED: the bypass is edge-only");
}

#[test]
fn removing_the_composite_tears_down_its_whole_subtree() {
    let mut engine = engine_with_composite();
    engine.graph = fx_composite_graph();
    let mut unit = engine.build_unit(UNIT);
    engine.reconcile_one(&mut unit);
    let nodes_before = engine.context.debug_counts()[0];
    let subs_before = engine.graph.subscription_count();
    // Detach the composite from the unit's audio chain: every entry, nested effect, node and
    // subscription it owns must go with it — a leak here is what a stale sub / node would be.
    let detach = Update::Pointer {
        address: Address::of(COMP, vec![HOST_KEY]),
        old: Some(Address::of(UNIT, vec![UNIT_AUDIO_KEY])),
        new: None
    };
    engine.graph.transaction(&[detach], &engine.registry).expect("detach the composite");
    engine.reconcile_one(&mut unit);
    match unit.wired.as_ref().expect("wired") {
        Wired::Leaf(chain) => assert!(chain.audio.is_empty(), "the composite left the chain"),
        _ => panic!("expected a leaf chain")
    }
    assert!(engine.context.debug_counts()[0] < nodes_before, "its nodes are gone");
    assert!(engine.graph.subscription_count() <= subs_before,
        "and it leaked no graph subscriptions");
}

const NESTED_COMP: Uuid = [25u8; 16];
const NESTED_ENTRY: Uuid = [26u8; 16];

// Entry A's chain holds a SECOND composite instead of a plain effect, so a stack contains a stack.
fn nested_composite_graph() -> BoxGraph {
    BoxGraph::from_boxes(vec![
        graph_box(UNIT, "AudioUnitBox", &[
            (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook),
            (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook)
        ]),
        graph_box(INSTR, "TestInstrument", &[
            (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_INPUT_KEY]))))
        ]),
        graph_box(COMP, "TestComposite", &[
            (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_AUDIO_KEY])))),
            (EFFECT_INDEX_KEY, FieldValue::Int32(0)),
            (DEVICE_ENABLED_KEY, FieldValue::Boolean(true)),
            (ENTRIES_FIELD, FieldValue::Hook), (INPUT_TAP_FIELD, FieldValue::Hook),
            (DRY_KEY, FieldValue::Float32(f32::NEG_INFINITY)), (WET_KEY, FieldValue::Float32(0.0))
        ]),
        entry_box(ENTRY_A, 0, "A"),
        // The INNER composite lives in entry A's chain, exactly where a plain effect would.
        graph_box(NESTED_COMP, "TestComposite", &[
            (HOST_KEY, FieldValue::Pointer(Some(Address::of(ENTRY_A, vec![ENTRY_CHAIN_FIELD])))),
            (EFFECT_INDEX_KEY, FieldValue::Int32(0)),
            (DEVICE_ENABLED_KEY, FieldValue::Boolean(true)),
            (ENTRIES_FIELD, FieldValue::Hook), (INPUT_TAP_FIELD, FieldValue::Hook),
            (DRY_KEY, FieldValue::Float32(f32::NEG_INFINITY)), (WET_KEY, FieldValue::Float32(0.0))
        ]),
        graph_box(NESTED_ENTRY, "TestCompositeCell", &[
            (ENTRY_COMPOSITE_KEY, FieldValue::Pointer(Some(Address::of(NESTED_COMP, vec![ENTRIES_FIELD])))),
            (ENTRY_CHAIN_FIELD, FieldValue::Hook),
            (ENTRY_INDEX_KEY, FieldValue::Int32(0)),
            (ENTRY_LABEL_KEY, FieldValue::String("inner".to_string())),
            (ENTRY_GAIN_KEY, FieldValue::Float32(0.0)),
            (ENTRY_MUTE_KEY, FieldValue::Boolean(false)),
            (ENTRY_SOLO_KEY, FieldValue::Boolean(false))
        ]),
        graph_box(NESTED_A, "TestEffect", &[
            (HOST_KEY, FieldValue::Pointer(Some(Address::of(NESTED_ENTRY, vec![ENTRY_CHAIN_FIELD])))),
            (EFFECT_INDEX_KEY, FieldValue::Int32(0)),
            (DEVICE_ENABLED_KEY, FieldValue::Boolean(true))
        ])
    ])
}

#[test]
fn a_composite_nests_inside_an_entry_of_another_composite() {
    let mut engine = engine_with_composite();
    engine.graph = nested_composite_graph();
    let mut unit = engine.build_unit(UNIT);
    engine.reconcile_one(&mut unit);
    // "In theory, stacks can be nested indefinitely": an entry's chain is built by the SAME member machinery
    // as any chain, so the inner stack is just a member of the outer entry — no special case anywhere.
    let outer = composite_of(&unit);
    assert_eq!(outer.entry_count(), 1, "the outer stack has one entry");
    assert_eq!(outer.entry_chain_len(ENTRY_A), Some(1), "whose chain holds exactly one member");
    let inner = outer.nested_composite(ENTRY_A, NESTED_COMP).expect("the entry's member IS a composite");
    assert_eq!(inner.entry_count(), 1, "and the inner stack built its own entry");
    assert_eq!(inner.entry_chain_len(NESTED_ENTRY), Some(1), "holding the leaf effect");
    // The inner stack's own nodes are distinct from the outer's: it is a full composite, not a shortcut.
    assert_ne!(inner.distributor_id, outer.distributor_id);
    assert_ne!(inner.mix_id, outer.mix_id);
}

#[test]
fn tearing_down_an_outer_composite_takes_the_nested_one_with_it() {
    let mut engine = engine_with_composite();
    engine.graph = nested_composite_graph();
    let mut unit = engine.build_unit(UNIT);
    engine.reconcile_one(&mut unit);
    let nodes_before = engine.context.debug_counts()[0];
    let subs_before = engine.graph.subscription_count();
    let detach = Update::Pointer {
        address: Address::of(COMP, vec![HOST_KEY]),
        old: Some(Address::of(UNIT, vec![UNIT_AUDIO_KEY])),
        new: None
    };
    engine.graph.transaction(&[detach], &engine.registry).expect("detach the outer composite");
    engine.reconcile_one(&mut unit);
    // The whole cascade goes: outer nodes, its entry, the INNER composite's nodes + entry + leaf effect.
    assert!(engine.context.debug_counts()[0] < nodes_before, "every nested node is gone");
    assert!(engine.graph.subscription_count() <= subs_before, "and nothing in the cascade leaked a subscription");
    // Neither composite's output nor either input tap may outlive the teardown.
    for uuid in [COMP, NESTED_COMP] {
        assert!(engine.output_registry.resolve(&Address::of(uuid, vec![])).is_none(), "output unregistered");
        assert!(engine.output_registry.resolve(&Address::of(uuid, vec![INPUT_TAP_FIELD])).is_none(),
            "input tap unregistered");
    }
}

#[test]
fn the_composite_input_tap_is_a_distinct_address_from_its_output() {
    let mut engine = engine_with_composite();
    engine.graph = fx_composite_graph();
    let mut unit = engine.build_unit(UNIT);
    engine.reconcile_one(&mut unit);
    let (distributor, mix) = {
        let binding = composite_of(&unit);
        (binding.distributor_id, binding.mix_id)
    };
    // The user's requirement: "a nested plugin with sidechain [can] pick the input of the container". The tap
    // lives at the composite's `input` VERTEX, which is why `resolve_one_sidechain` tries the FULL target
    // address first — a pointer at the box itself still resolves to the composite's mixed OUTPUT.
    let tap = engine.output_registry.resolve(&Address::of(COMP, vec![INPUT_TAP_FIELD]))
        .expect("the input tap is registered at the composite's `input` field");
    assert_eq!(tap.processor, distributor, "the tap is produced by the DISTRIBUTOR");
    let output = engine.output_registry.resolve(&Address::of(COMP, vec![]))
        .expect("the composite's output is registered at its box address");
    assert_eq!(output.processor, mix, "while the box address is the composite's mixed output");
    assert!(!Rc::ptr_eq(&tap.buffer, &output.buffer), "input and output are different signals");
}

// Turning `dry` / `wet` / an entry's `gain` must reach the DSP cells LIVE. Reading the fields once at build
// left every knob dead until a reload (which rebuilt the composite and re-read them) — the classic symptom.
// The strip's own rule: sync the field into the shared Cell, which the node reads each block.
#[test]
fn dry_wet_and_entry_gain_reach_the_dsp_live_without_a_reload() {
    let mut engine = engine_with_composite();
    engine.graph = fx_composite_graph();
    let mut unit = engine.build_unit(UNIT);
    engine.reconcile_one(&mut unit);
    assert_eq!(composite_of(&unit).dry_db(), f32::NEG_INFINITY, "the box default: dry silent");
    assert_eq!(composite_of(&unit).wet_db(), 0.0, "and wet at unity");
    // Turn dry fully up and wet fully out — the user's report.
    engine.graph.transaction(&[
        Update::Primitive {
            address: Address::of(COMP, vec![DRY_KEY]),
            old: FieldValue::Float32(f32::NEG_INFINITY), new: FieldValue::Float32(0.0)
        },
        Update::Primitive {
            address: Address::of(COMP, vec![WET_KEY]),
            old: FieldValue::Float32(0.0), new: FieldValue::Float32(f32::NEG_INFINITY)
        }
    ], &engine.registry).expect("turn the dry / wet knobs");
    // NO reconcile, NO reload: the cells must already carry it (the node reads them every block).
    assert_eq!(composite_of(&unit).dry_db(), 0.0, "dry reached the DSP live");
    assert_eq!(composite_of(&unit).wet_db(), f32::NEG_INFINITY, "and so did wet");
    // An entry's gain is a DRAG: it must land in the strip's cell without re-wiring the chain per tick.
    engine.graph.transaction(&[Update::Primitive {
        address: Address::of(ENTRY_A, vec![ENTRY_GAIN_KEY]),
        old: FieldValue::Float32(0.0), new: FieldValue::Float32(-6.0)
    }], &engine.registry).expect("drag the entry gain");
    assert_eq!(composite_of(&unit).entry_gain_db(ENTRY_A), Some(-6.0), "the entry gain reached the DSP live");
}

const WET_TRACK: Uuid = [30u8; 16];
const WET_REGION: Uuid = [31u8; 16];
const WET_COLLECTION: Uuid = [32u8; 16];
const WET_EVENT: Uuid = [33u8; 16];

// A composite whose `wet` is targeted by a Value track — what automating the Wet knob produces.
fn wet_automation_graph() -> BoxGraph {
    BoxGraph::from_boxes(vec![
        graph_box(UNIT, "AudioUnitBox", &[
            (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook),
            (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook)
        ]),
        graph_box(INSTR, "TestInstrument", &[
            (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_INPUT_KEY]))))
        ]),
        graph_box(COMP, "TestComposite", &[
            (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_AUDIO_KEY])))),
            (EFFECT_INDEX_KEY, FieldValue::Int32(0)),
            (DEVICE_ENABLED_KEY, FieldValue::Boolean(true)),
            (ENTRIES_FIELD, FieldValue::Hook), (INPUT_TAP_FIELD, FieldValue::Hook),
            (DRY_KEY, FieldValue::Float32(f32::NEG_INFINITY)), (WET_KEY, FieldValue::Float32(0.0))
        ]),
        entry_box(ENTRY_A, 0, "A"),
        // The Value track targeting the composite's `wet` (key 2 is the track's `target`).
        graph_box(WET_TRACK, "TrackBox", &[
            (1, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_TRACKS_KEY])))),
            (2, FieldValue::Pointer(None)), // target: attached LIVE by the test
            (TRACK_TYPE_KEY, FieldValue::Int32(2)), // Value
            (TRACK_REGIONS_KEY, FieldValue::Hook),
            (super::TRACK_CLIPS_KEY, FieldValue::Hook),
            (TRACK_ENABLED_KEY, FieldValue::Boolean(true))
        ]),
        graph_box(WET_REGION, "ValueRegionBox", &[
            (1, FieldValue::Pointer(Some(Address::of(WET_TRACK, vec![TRACK_REGIONS_KEY])))),
            (2, FieldValue::Pointer(Some(Address::of(WET_COLLECTION, vec![2])))),
            (10, FieldValue::Int32(0)), (11, FieldValue::Int32(3840)),
            (12, FieldValue::Int32(0)), (13, FieldValue::Int32(3840))
        ]),
        graph_box(WET_COLLECTION, "ValueEventCollectionBox", &[(1, FieldValue::Hook), (2, FieldValue::Hook)]),
        graph_box(WET_EVENT, "ValueEventBox", &[
            (1, FieldValue::Pointer(Some(Address::of(WET_COLLECTION, vec![1])))),
            (10, FieldValue::Int32(0)), (13, FieldValue::Float32(0.25))
        ])
    ])
}

// The automation ATTACHED but with no events drawn yet — what "create automation" leaves you with. The track
// aims at `wet` and owns a region, but its curve is empty.
fn wet_automation_graph_without_events() -> BoxGraph {
    BoxGraph::from_boxes(vec![
        graph_box(UNIT, "AudioUnitBox", &[
            (UNIT_TRACKS_KEY, FieldValue::Hook), (UNIT_MIDI_KEY, FieldValue::Hook),
            (UNIT_INPUT_KEY, FieldValue::Hook), (UNIT_AUDIO_KEY, FieldValue::Hook)
        ]),
        graph_box(INSTR, "TestInstrument", &[
            (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_INPUT_KEY]))))
        ]),
        graph_box(COMP, "TestComposite", &[
            (HOST_KEY, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_AUDIO_KEY])))),
            (EFFECT_INDEX_KEY, FieldValue::Int32(0)),
            (DEVICE_ENABLED_KEY, FieldValue::Boolean(true)),
            (ENTRIES_FIELD, FieldValue::Hook), (INPUT_TAP_FIELD, FieldValue::Hook),
            (DRY_KEY, FieldValue::Float32(f32::NEG_INFINITY)), (WET_KEY, FieldValue::Float32(0.0))
        ]),
        entry_box(ENTRY_A, 0, "A"),
        graph_box(WET_TRACK, "TrackBox", &[
            (1, FieldValue::Pointer(Some(Address::of(UNIT, vec![UNIT_TRACKS_KEY])))),
            (2, FieldValue::Pointer(Some(Address::of(COMP, vec![WET_KEY])))),
            (TRACK_TYPE_KEY, FieldValue::Int32(2)), // Value
            (TRACK_REGIONS_KEY, FieldValue::Hook),
            (super::TRACK_CLIPS_KEY, FieldValue::Hook),
            (TRACK_ENABLED_KEY, FieldValue::Boolean(true))
        ]),
        graph_box(WET_REGION, "ValueRegionBox", &[
            (1, FieldValue::Pointer(Some(Address::of(WET_TRACK, vec![TRACK_REGIONS_KEY])))),
            (2, FieldValue::Pointer(Some(Address::of(WET_COLLECTION, vec![2])))),
            (10, FieldValue::Int32(0)), (11, FieldValue::Int32(3840)),
            (12, FieldValue::Int32(0)), (13, FieldValue::Int32(3840))
        ]),
        // The curve exists but is EMPTY: no ValueEventBox points at it.
        graph_box(WET_COLLECTION, "ValueEventCollectionBox", &[(1, FieldValue::Hook), (2, FieldValue::Hook)])
    ])
}

// Attaching automation must NOT move the control. The UI slot carries a UNIT value, so seeding it with 0.0
// when the curve yields nothing pinned EVERY knob in openDAW to its minimum the moment automation was created
// (`resolve` only writes the slot while the curve covers the position, so the seed was never corrected).
// Publishing NaN says "I have no value": the UI then keeps showing the parameter's own STORAGE value, which is
// the only side that knows the parameter's ValueMapping and can map it.
#[test]
fn attaching_automation_with_no_events_does_not_move_the_control() {
    let mut engine = engine_with_composite();
    engine.graph = wet_automation_graph_without_events();
    let mut unit = engine.build_unit(UNIT);
    engine.reconcile_one(&mut unit);
    let published = engine.broadcasts.live_slot(COMP, &[WET_KEY], crate::broadcast::PACKAGE_FLOAT)
        .expect("an automated parameter registers its UI slot, so a later curve value can animate the knob");
    let value = published.borrow()[0];
    assert!(value.is_nan(), "no curve value -> publish NaN ('keep your storage value'), NOT 0.0 (= knob min)");
}

// Automating `wet` must install the curve the MIX NODE reads. A composite is not a plugin, so it has no
// DeviceParams — `rebind_automation`'s device visitor never reaches dry / wet, and binding them only at BUILD
// left an attached curve driving nothing: the UI indicated the automation while the DSP ignored it.
#[test]
fn automating_wet_installs_the_curve_the_mix_reads() {
    let mut engine = engine_with_composite();
    engine.graph = wet_automation_graph();
    let mut unit = engine.build_unit(UNIT);
    engine.reconcile_one(&mut unit);
    assert!(!composite_of(&unit).wet_automated(), "nothing is automated before the track is aimed");
    // ATTACH the automation live, exactly as the user does by automating the Wet knob. This is the case that
    // broke: a RELOAD worked (build re-read the graph with the track already there), a live attach did not.
    let attach = Update::Pointer {
        address: Address::of(WET_TRACK, vec![2]),
        old: None,
        new: Some(Address::of(COMP, vec![WET_KEY]))
    };
    engine.graph.transaction(&[attach], &engine.registry).expect("aim the track at `wet`");
    engine.reconcile_one(&mut unit);
    assert!(composite_of(&unit).wet_automated(), "the curve now drives `wet` — with no reload");
    assert!(!composite_of(&unit).dry_automated(), "and only `wet`: `dry` has no track");
}

// The entry PAN reaches the strip live (a drag), like the gain — the strip is a real ChannelStripProcessor,
// so panning is a genuine per-entry control, not pinned to centre.
#[test]
fn entry_pan_reaches_the_strip_live() {
    let mut engine = engine_with_composite();
    engine.graph = fx_composite_graph();
    let mut unit = engine.build_unit(UNIT);
    engine.reconcile_one(&mut unit);
    assert_eq!(composite_of(&unit).entry_pan(ENTRY_A), Some(0.0), "centred by default");
    engine.graph.transaction(&[Update::Primitive {
        address: Address::of(ENTRY_A, vec![ENTRY_PAN_KEY]),
        old: FieldValue::Float32(0.0), new: FieldValue::Float32(-1.0)
    }], &engine.registry).expect("pan hard left");
    assert_eq!(composite_of(&unit).entry_pan(ENTRY_A), Some(-1.0), "the pan reached the strip live");
}
