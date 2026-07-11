use super::*;
use super::params::{refresh_params, automation_invalidate};

// A node's PROFILER label: the device's box type + a short uuid (reconcile-time, report-only).
pub(crate) fn device_label(graph: &BoxGraph, device_uuid: &Uuid) -> String {
    let name = graph.find_box(device_uuid).map_or("<device>", |device_box| device_box.name.as_str());
    format!("{} {:02x}{:02x}", name, device_uuid[0], device_uuid[1])
}

// Count a tape unit's bound audio regions (total + how many run the time-stretch strategy), for the
// player's reconcile-time pre-warm.
pub(crate) fn tape_region_counts(track_sets: &SharedAudioTrackSets) -> (usize, usize) {
    let mut stretch = 0;
    let mut total = 0;
    for track in track_sets.borrow().iter() {
        for region in track.borrow().regions.iter() {
            total += 1;
            if region.time_stretch.is_some() {
                stretch += 1;
            }
        }
    }
    (stretch, total)
}

impl Engine {

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
    /// Wire a FROZEN unit: the `FrozenPlayback` node (transport-aligned PCM) feeds the LIVE channel strip;
    /// `resolve_outputs` routes the strip and `resolve_sends` taps the player output like any pre-strip.
    pub(crate) fn reconcile_frozen(&mut self, unit: &mut AudioUnitBinding, data: Rc<crate::frozen::FrozenData>) {
        self.teardown_unit_wired(unit);
        let player = Rc::new(RefCell::new(crate::frozen::FrozenPlayback::new(data, self.tempo_map.clone())));
        let player_output = player.borrow().audio_output();
        let player_id = self.context.register_processor(player);
        self.context.set_label(player_id, format!("frozen {:02x}{:02x}", unit.unit[0], unit.unit[1]));
        let strip = Rc::new(RefCell::new(ChannelStripProcessor::new(unit.strip_params.clone(), unit.strip_automation.clone(), self.sample_rate)));
        strip.borrow_mut().set_audio_source(player_output.clone());
        let strip_output = strip.borrow().audio_output();
        let strip_meter = strip.borrow().meter_slot();
        self.broadcasts.register(unit.unit, &[], crate::broadcast::PACKAGE_FLOAT_ARRAY, &strip_meter);
        let strip_id = self.context.register_processor(strip);
        self.context.set_label(strip_id, format!("strip:frozen {:02x}{:02x}", unit.unit[0], unit.unit[1]));
        self.context.register_edge(player_id, strip_id);
        self.output_registry.register(Address::of(unit.unit, vec![]), strip_output.clone(), strip_id);
        unit.wired = Some(Wired::Frozen(FrozenWired {
            player_id, pre_strip: player_output, strip_id, strip_output, edges: vec![(player_id, strip_id)]
        }));
    }

    pub(crate) fn reconcile_bus(&mut self, unit: &mut AudioUnitBinding, bus_uuid: Uuid, signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>) {
        self.teardown_unit_wired(unit);
        // THE output (terminal master) unit is a bus whose SUM is the engine's shared master-sum node (every unit
        // routes into it via `sum_of(None)`), and whose STRIP output is what `render` reads. So it reuses `master`
        // instead of creating a fresh sum, and keeps `master_id` OUT of `nodes` so a chain-edit teardown never
        // removes the shared master. Every other bus builds its own sum.
        let is_output = self.is_output_unit(unit.unit);
        let (sum, sum_id, sum_buffer) = if is_output {
            let master = self.master.clone().expect("master-sum exists before the output unit reconciles");
            let buffer = master.borrow().audio_output();
            (master, self.master_id, buffer)
        } else {
            let buffer = shared_audio_buffer();
            let sum = Rc::new(RefCell::new(AudioBusProcessor::new(buffer.clone())));
            let id = self.context.register_processor(sum.clone());
            self.context.set_label(id, format!("bus-sum {:02x}{:02x}", bus_uuid[0], bus_uuid[1]));
            (sum, id, buffer)
        };
        self.bus_registry.insert(bus_uuid, (sum.clone(), sum_id));
        // Register the RAW SUM (pre-fx, pre-strip, pre-mute) under the AudioBusBox uuid so a sidechain pointer
        // that targets this bus (e.g. a vocoder modulated by a MUTED submix) taps its full signal. Mirrors TS
        // `AudioBusProcessor` registering `adapter.address -> #audioOutput` (the sum), NOT the strip output.
        self.output_registry.register(Address::of(bus_uuid, vec![]), sum_buffer.clone(), sum_id);
        let mut nodes = if is_output { Vec::new() } else { vec![sum_id] };
        let mut edges: Vec<(NodeId, NodeId)> = Vec::new();
        let mut device_params: Vec<DeviceParams> = Vec::new();
        let mut sidechains: Vec<SidechainBinding> = Vec::new();
        let mut subs: Vec<SubscriptionId> = Vec::new();
        // A disabled bus (`enabled` = 4) sums nothing (emits silence). The master never disables (it is the output).
        if !is_output {
            let sum_enable = sum.clone();
            subs.push(self.graph.catchup_and_subscribe(Address::of(bus_uuid, vec![BUS_ENABLED_KEY]), move |value| {
                if let Some(enabled) = value.as_bool() { sum_enable.borrow_mut().set_enabled(enabled) }
            }));
        }
        // The bus's own audio-effect chain (host 23), ordered by index, enabled only: sum -> fx0 -> ... Each
        // enabled / disabled effect gets a `This` monitor so a toggle re-wires (wholesale, like a chain edit).
        let mut source = sum_buffer.clone();
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
            // The effect's own output under its box uuid, for direct sidechain targeting (see
            // `take_or_build_audio`); torn down via `device_params` in `teardown_wired_value`.
            self.output_registry.register(Address::of(device_uuid, vec![]), source.clone(), node_id);
            let meter_slot = node.borrow().meter_slot();
            self.broadcasts.register(device_uuid, &[], crate::broadcast::PACKAGE_FLOAT_ARRAY, &meter_slot);
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
        self.broadcasts.register(unit.unit, &[], crate::broadcast::PACKAGE_FLOAT_ARRAY, &strip_meter);
        let strip_id = self.context.register_processor(strip);
        self.context.set_label(strip_id, format!("strip:bus {:02x}{:02x}", bus_uuid[0], bus_uuid[1]));
        self.context.register_edge(source_id, strip_id);
        edges.push((source_id, strip_id));
        nodes.push(strip_id);
        self.output_registry.register(Address::of(unit.unit, vec![]), strip_output.clone(), strip_id);
        // The terminal master unit's strip output IS the engine's final render buffer: republish it on every
        // rebuild so `render` reads the current chain (an added / removed master effect takes effect live).
        if is_output {
            self.output_bus = Some(strip_output.clone());
        }
        unit.wired = Some(Wired::Bus(BusWired {
            bus_uuid, sum_buffer, pre_strip, pre_strip_node, strip_id, strip_output, nodes, edges, device_params, sidechains, subs
        }));
    }

    /// Reconcile a unit's processor graph to its current chains. Resolve the instrument; dispatch to the
    /// per-member LEAF path (instrument + midi-fx + audio-fx) or the COMPOSITE path. A unit with no resolvable
    /// instrument is left silent (its wiring fully torn down). The only per-device knowledge is the
    /// box-type -> plugin table.
    pub(crate) fn reconcile_chain(&mut self, unit: &mut AudioUnitBinding) {
        // A rewire tears down (or reuses) the strip; drop the current output route first so no stale summed
        // source / edge survives. `resolve_outputs` (end of `reconcile_units`) re-routes the rebuilt strip.
        self.unwire_output_route(unit);
        // A FROZEN unit plays its pre-rendered PCM instead of its chain (TS `AudioDeviceChain.#wire`'s
        // frozen branch): player -> LIVE strip; sends read the player output. Unfreezing re-wires the chain.
        if let Some(data) = self.frozen_of(&unit.unit) {
            return self.reconcile_frozen(unit, data);
        }
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
            self.reconcile_composite(unit, instrument_uuid, spec, &signal, &invalidate, &rewire);
        } else if box_name == TAPE_BOX_TYPE {
            self.reconcile_tape(unit, instrument_uuid, &signal, &invalidate, &rewire); // audio unit: player -> fx -> strip
        } else if box_name == MIDI_OUT_BOX_TYPE {
            self.reconcile_midi_out(unit, instrument_uuid, &invalidate, &rewire); // MIDI out: silent node -> fx -> strip
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
    pub(crate) fn reconcile_tape(&mut self, unit: &mut AudioUnitBinding, instrument_uuid: Uuid, signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>, rewire: &Rc<dyn Fn()>) {
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
                if let Some(node) = tape.monitor_node {
                    self.context.remove_processor(node);
                }
                self.output_registry.remove(&Address::of(unit.unit, vec![]));
                self.output_registry.remove(&Address::of(tape.instrument_uuid, vec![]));
                for member in tape.audio {
                    pool.insert(member.uuid, member);
                }
            }
            Some(other) => self.teardown_wired_value(unit.unit, other),
            None => {}
        }
        let player = Rc::new(RefCell::new(AudioRegionPlayer::new(unit.audio_track_sets.clone(), self.sample_rate, self.tempo_map.clone(), self.clip_sequencer.clone())));
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
        self.broadcasts.register(instrument_uuid, &[], crate::broadcast::PACKAGE_FLOAT_ARRAY, &player_meter);
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
        // EFFECTS monitoring (an armed audio track): inject the staged live input after the player, PRE-FX.
        let monitor_node = self.monitor_channels_of(&unit.unit).map(|(left, right)| {
            let mixer = Rc::new(RefCell::new(crate::monitor::MonitorMix::new(output.clone(), left, right)));
            let mixer_id = self.context.register_processor(mixer);
            self.context.set_label(mixer_id, alloc::string::String::from("monitor-mix"));
            self.context.register_edge(output_node, mixer_id);
            edges.push((output_node, mixer_id));
            output_node = mixer_id;
            mixer_id
        });
        let include_fx = self.unit_options(&unit.unit).include_audio_effects;
        for member in &audio_members {
            if !include_fx {
                break; // a STEM export with includeAudioEffects=false: the fx chain is left unwired
            }
            if !self.device_enabled(member.uuid) {
                continue;
            }
            if let ProcHandle::Audio(node) = &member.proc {
                node.borrow_mut().set_audio_source(output.clone());
            }
            let node_id = member.node_id.expect("member.node_id");
            self.context.register_edge(output_node, node_id);
            edges.push((output_node, node_id));
            output = member.output.clone().expect("member.output");
            output_node = node_id;
        }
        let strip = Rc::new(RefCell::new(ChannelStripProcessor::new(unit.strip_params.clone(), unit.strip_automation.clone(), self.sample_rate)));
        strip.borrow_mut().set_audio_source(output.clone());
        let strip_output = strip.borrow().audio_output();
        let strip_meter = strip.borrow().meter_slot();
        self.broadcasts.register(unit.unit, &[], crate::broadcast::PACKAGE_FLOAT_ARRAY, &strip_meter);
        let strip_id = self.context.register_processor(strip);
        self.context.set_label(strip_id, format!("strip:tape {:02x}{:02x}", unit.unit[0], unit.unit[1]));
        self.context.register_edge(output_node, strip_id);
        edges.push((output_node, strip_id));
        // The strip's output is routed to the unit's OUTPUT bus by `resolve_outputs` (not wired to master here).
        self.output_registry.register(Address::of(unit.unit, vec![]), strip_output.clone(), strip_id);
        unit.wired = Some(Wired::Tape(TapeWired {player, enabled_sub, player_id, instrument_uuid, audio: audio_members, pre_strip: output, pre_strip_node: output_node, strip_id, strip_output, edges, monitor_node}));
    }

    /// The MIDI-OUTPUT instrument path (TS `MIDIOutputDeviceProcessor`, engine-side like the tape): the
    /// unit's note stream — folded through its midi-fx pull chain, exactly like a leaf instrument — becomes
    /// queued MIDI messages (drained by `midi_out_take`), and the node's SILENT output still runs the unit's
    /// audio-fx chain + channel strip (mirroring TS, which wires the unit over the device's untouched
    /// `AudioBuffer`, so meters / sends / routing behave identically). Pulling marks the unit's note bits,
    /// so the note indicators light up (a deliberate improvement over pre-fix TS, fixed there too).
    /// Rebuilt wholesale on a chain edit; fx members are pooled so survivors keep their DSP state and the
    /// sequencer persists while the instrument box survives (held notes preserved).
    pub(crate) fn reconcile_midi_out(&mut self, unit: &mut AudioUnitBinding, instrument_uuid: Uuid, invalidate: &Rc<dyn Fn()>, rewire: &Rc<dyn Fn()>) {
        let mut pool: BTreeMap<Uuid, Member> = BTreeMap::new();
        let mut sequencer_keep: Option<(Uuid, SharedNoteEventSource)> = None;
        // The previous CC state (param box uuid -> last emitted value): carried into the rebuilt bindings so
        // a chain edit never re-emits unchanged CCs (TS keeps its AutomatableParameters across such edits).
        let mut previous_cc: Vec<(Uuid, f32)> = Vec::new();
        let mut first_build = true;
        match unit.wired.take() {
            Some(Wired::MidiOut(previous)) => {
                first_build = false;
                previous_cc = previous.node.borrow().cc_snapshot();
                for sub in previous.subs {
                    self.graph.unsubscribe(sub);
                }
                for sub in previous.cc_subs {
                    self.graph.unsubscribe(sub);
                }
                for collection in previous.cc_collections {
                    collection.terminate(&mut self.graph);
                }
                for (source, target) in &previous.edges {
                    self.context.remove_edge(*source, *target);
                }
                self.context.remove_processor(previous.strip_id);
                self.context.remove_processor(previous.node_id);
                if let Some(node) = previous.monitor_node {
                    self.context.remove_processor(node);
                }
                self.output_registry.remove(&Address::of(unit.unit, vec![]));
                self.output_registry.remove(&Address::of(previous.instrument_uuid, vec![]));
                sequencer_keep = Some((previous.instrument_uuid, previous.sequencer));
                for member in previous.midi {
                    pool.insert(member.uuid, member);
                }
                for member in previous.audio {
                    pool.insert(member.uuid, member);
                }
            }
            Some(other) => self.teardown_wired_value(unit.unit, other),
            None => {}
        }
        // The live control cells (TS reads the box per block / per event; the node reads these instead).
        let channel = self.graph.field_value(&Address::of(instrument_uuid, vec![MIDI_OUT_CHANNEL_KEY]))
            .and_then(|value| value.as_int32()).unwrap_or(0);
        let target = self.graph.target_of(&Address::of(instrument_uuid, vec![MIDI_OUT_DEVICE_KEY])).map(|address| address.uuid);
        let controls = MidiOutControls::new(channel, target);
        let mut subs: Vec<SubscriptionId> = Vec::new();
        // `enabled` (TS `box.enabled.catchupAndSubscribe`): disabling stops the pull; the wasm side also
        // clears the unit's note indicator (the TS-side fix clears its NoteBroadcaster via `reset()`).
        let enabled_controls = controls.clone();
        let enabled_bits = unit.note_bits.clone();
        subs.push(self.graph.catchup_and_subscribe(Address::of(instrument_uuid, vec![DEVICE_ENABLED_KEY]), move |value| {
            if let Some(enabled) = value.as_bool() {
                enabled_controls.enabled.set(enabled);
                if !enabled {
                    engine_env::telemetry::clear_note_bits(&enabled_bits);
                }
            }
        }));
        // `channel` (TS `box.channel.subscribe`, NO catch-up — the initial value was read above): a change
        // flushes note-offs for the held notes ON THE OLD channel, then adopts the new one.
        let channel_controls = controls.clone();
        let channel_midi = self.midi_out.clone();
        subs.push(self.graph.subscribe_vertex(Propagation::This, Address::of(instrument_uuid, vec![MIDI_OUT_CHANNEL_KEY]),
            Box::new(move |_graph, update| {
                if let Update::Primitive {new, ..} = update {
                    if let Some(new_channel) = new.as_int32() {
                        midi_output::flush_channel_change(&channel_controls, &channel_midi, new_channel);
                    }
                }
            })));
        // The `device` pointer (TS resolves `device.targetVertex` per block): re-point live.
        let target_controls = controls.clone();
        subs.push(self.graph.subscribe_vertex(Propagation::This, Address::of(instrument_uuid, vec![MIDI_OUT_DEVICE_KEY]),
            Box::new(move |_graph, update| {
                if let Update::Pointer {new, ..} = update {
                    target_controls.target.set(new.as_ref().map(|address| address.uuid));
                }
            })));
        // The `parameters` hub (TS `box.parameters.pointerHub.catchupAndSubscribe` binding each child): a
        // membership change rebuilds this wiring, re-binding the CC set. The subscribe-time catch-up must
        // NOT rewire (it reports the members just bound below), hence the flag.
        let catching_up = Rc::new(Cell::new(true));
        let hub_flag = catching_up.clone();
        let hub_rewire = rewire.clone();
        subs.push(self.graph.subscribe_pointer_hub(Address::of(instrument_uuid, vec![MIDI_OUT_PARAMETERS_KEY]),
            Box::new(move |_graph, _event| {
                if !hub_flag.get() {
                    hub_rewire();
                }
            })));
        catching_up.set(false);
        // The CC parameter bindings (TS `bindParameter` per MIDIOutputParameterBox).
        let mut cc_subs: Vec<SubscriptionId> = Vec::new();
        let mut cc_collections: Vec<ValueCollection> = Vec::new();
        let cc = self.build_midi_out_cc(instrument_uuid, invalidate, &previous_cc, &mut cc_subs, &mut cc_collections);
        let node = Rc::new(RefCell::new(MidiOutProcessor::new(self.sample_rate, controls.clone(), self.midi_out.clone(), Some(unit.note_bits.clone()))));
        let node_output = node.borrow().audio_output();
        // The unit's midi-fx members (reusing survivors, like a leaf) folded into the node's pull chain.
        let mut midi_members: Vec<Member> = Vec::new();
        for uuid in unit.midi.sorted() {
            let device = self.graph.find_box(&uuid).and_then(|device_box| self.device_for_type(&device_box.name));
            if let Some(device) = device {
                if device.kind == DEVICE_KIND_MIDI_EFFECT {
                    midi_members.push(self.take_or_build_midi(&mut pool, uuid, device, invalidate, rewire));
                }
            }
        }
        let sequencer: SharedNoteEventSource = match sequencer_keep {
            Some((uuid, kept)) if uuid == instrument_uuid => kept,
            _ => {
                let sequencer = Rc::new(RefCell::new(NoteSequencer::new(Box::new(BoundNoteTracks {tracks: unit.track_sets.clone()}), self.clip_sequencer.clone())));
                sequencer.borrow_mut().bind_truncate_preference(self.truncate_pref.clone());
                sequencer
            }
        };
        let mut pull = PullLink::Source(sequencer.clone());
        for member in &midi_members {
            if !self.device_enabled(member.uuid) {
                continue; // a disabled midi-fx is bypassed (left out of the pull chain), like `wire_cluster`
            }
            if let ProcHandle::Midi(effect) = &member.proc {
                pull = PullLink::MidiFx {effect: effect.clone(), upstream: Rc::new(pull)};
            }
        }
        {
            let mut node_mut = node.borrow_mut();
            node_mut.set_pull_chain(pull);
            node_mut.set_cc(cc);
        }
        let node_id = self.context.register_processor(node.clone());
        self.context.set_label(node_id, format!("midi-out {:02x}{:02x}", unit.unit[0], unit.unit[1]));
        // The node's (silent) output under the device box uuid, so a sidechain pointer targeting the device
        // resolves like it does for every built device (TS registers every processor's audioOutput).
        self.output_registry.register(Address::of(instrument_uuid, vec![]), node_output.clone(), node_id);
        // The unit's AUDIO-effects chain over the silent output + the channel strip, exactly like the tape.
        let signal = unit.mark.signal();
        let mut audio_members: Vec<Member> = Vec::new();
        for uuid in unit.audio.sorted() {
            let device = self.graph.find_box(&uuid).and_then(|device_box| self.device_for_type(&device_box.name));
            if let Some(device) = device {
                if device.kind == DEVICE_KIND_AUDIO_EFFECT {
                    audio_members.push(self.take_or_build_audio(&mut pool, uuid, device, &signal, invalidate, rewire));
                }
            }
        }
        for (_, member) in core::mem::take(&mut pool) {
            self.terminate_member(member);
        }
        let mut edges: Vec<(NodeId, NodeId)> = Vec::new();
        let mut output = node_output;
        let mut output_node = node_id;
        let monitor_node = self.monitor_channels_of(&unit.unit).map(|(left, right)| {
            let mixer = Rc::new(RefCell::new(crate::monitor::MonitorMix::new(output.clone(), left, right)));
            let mixer_id = self.context.register_processor(mixer);
            self.context.set_label(mixer_id, alloc::string::String::from("monitor-mix"));
            self.context.register_edge(output_node, mixer_id);
            edges.push((output_node, mixer_id));
            output_node = mixer_id;
            mixer_id
        });
        let include_fx = self.unit_options(&unit.unit).include_audio_effects;
        for member in &audio_members {
            if !include_fx {
                break; // a STEM export with includeAudioEffects=false: the fx chain is left unwired
            }
            if !self.device_enabled(member.uuid) {
                continue;
            }
            if let ProcHandle::Audio(fx_node) = &member.proc {
                fx_node.borrow_mut().set_audio_source(output.clone());
            }
            let fx_id = member.node_id.expect("member.node_id");
            self.context.register_edge(output_node, fx_id);
            edges.push((output_node, fx_id));
            output = member.output.clone().expect("member.output");
            output_node = fx_id;
        }
        let strip = Rc::new(RefCell::new(ChannelStripProcessor::new(unit.strip_params.clone(), unit.strip_automation.clone(), self.sample_rate)));
        strip.borrow_mut().set_audio_source(output.clone());
        let strip_output = strip.borrow().audio_output();
        let strip_meter = strip.borrow().meter_slot();
        self.broadcasts.register(unit.unit, &[], crate::broadcast::PACKAGE_FLOAT_ARRAY, &strip_meter);
        let strip_id = self.context.register_processor(strip);
        self.context.set_label(strip_id, format!("strip:midi-out {:02x}{:02x}", unit.unit[0], unit.unit[1]));
        self.context.register_edge(output_node, strip_id);
        edges.push((output_node, strip_id));
        self.output_registry.register(Address::of(unit.unit, vec![]), strip_output.clone(), strip_id);
        if first_build {
            node.borrow().read_all_parameters(); // the TS constructor's `readAllParameters()` initial CC push
        }
        unit.wired = Some(Wired::MidiOut(MidiOutWired {
            node, node_id, instrument_uuid, sequencer, controls, midi: midi_members, audio: audio_members,
            pre_strip: output, pre_strip_node: output_node, strip_id, strip_output, edges, subs, cc_subs,
            cc_collections, monitor_node
        }));
    }

    /// Bind the current `MIDIOutputParameterBox` children (the `parameters` hub) into CC bindings: each
    /// gets a live `controller` cell and an automation-aware value handle over its `value` field (the TS
    /// adapter maps it `ValueMapping.unipolar()`, an identity). A binding whose param survived a rebuild
    /// carries its last emitted value over (no spurious CC); a joiner seeds from the field silently (TS
    /// `bindParameter` emits nothing until the value changes).
    pub(crate) fn build_midi_out_cc(&mut self, instrument_uuid: Uuid, invalidate: &Rc<dyn Fn()>, previous: &[(Uuid, f32)],
                         subs: &mut Vec<SubscriptionId>, collections: &mut Vec<ValueCollection>) -> Vec<CcBinding> {
        let param_boxes: Vec<Uuid> = self.graph.incoming(&Address::of(instrument_uuid, vec![MIDI_OUT_PARAMETERS_KEY]))
            .into_iter().map(|address| address.uuid).collect();
        let mut result = Vec::with_capacity(param_boxes.len());
        for (index, param_uuid) in param_boxes.into_iter().enumerate() {
            let controller = Rc::new(Cell::new(64)); // the box default; the catch-up overwrites it
            let controller_cell = controller.clone();
            subs.push(self.graph.catchup_and_subscribe(Address::of(param_uuid, vec![MIDI_OUT_PARAM_CONTROLLER_KEY]), move |value| {
                if let Some(id) = value.as_int32() {
                    controller_cell.set(id);
                }
            }));
            let (handle, param_subs, param_collections, _) =
                self.observe_param(param_uuid, &[MIDI_OUT_PARAM_VALUE_KEY], index as u32, invalidate);
            subs.extend(param_subs);
            collections.extend(param_collections);
            let last = previous.iter().find(|(uuid, _)| uuid == &param_uuid)
                .map(|(_, value)| *value).unwrap_or_else(|| handle.field.get());
            result.push(CcBinding {param: param_uuid, controller, handle, last: Cell::new(last)});
        }
        result
    }

    /// The COMPOSITE-instrument path (e.g. Playfield): tear down the old wiring and rebuild the child cascade
    /// wholesale (per-child lifecycle is internal to the `composite` module), then wrap the unit's own AUDIO
    /// effects around the sum (`sum -> fx0 -> ... -> strip`, like a leaf / tape unit — without this a Playfield
    /// unit's effect chain was silently dropped). Pooled like tape: survivors keep their DSP state across the
    /// wholesale rebuild. The unit's MIDI-fx chain is still not wrapped (each slot pulls its own note source).
    /// Mapping-agnostic — `spec` names the slot collection.
    pub(crate) fn reconcile_composite(&mut self, unit: &mut AudioUnitBinding, instrument_uuid: Uuid, spec: CompositeSpec,
                           signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>, rewire: &Rc<dyn Fn()>) {
        // Pool the previous unit-fx members so survivors keep their DSP state (compressor ballistics, delay
        // tails); the composite cascade + strip are rebuilt wholesale.
        let mut pool: BTreeMap<Uuid, Member> = BTreeMap::new();
        match unit.wired.take() {
            Some(Wired::Composite(composite)) => {
                self.graph.unsubscribe(composite.enabled_sub);
                for (source, target) in &composite.tail_edges {
                    self.context.remove_edge(*source, *target);
                }
                self.context.remove_processor(composite.strip_id);
                if let Some(node) = composite.monitor_node {
                    self.context.remove_processor(node);
                }
                self.output_registry.remove(&Address::of(unit.unit, vec![]));
                for member in composite.audio {
                    pool.insert(member.uuid, member);
                }
                self.teardown_composite(composite.binding);
            }
            Some(other) => self.teardown_wired_value(unit.unit, other),
            None => {}
        }
        let track_sets = unit.track_sets.clone();
        // The unit's own MIDI-effect chain (host 21), built fresh (the composite is rebuilt wholesale) and folded
        // into EVERY child's note-pull chain below, so a unit-level midi effect (e.g. Zeitgeist) warps the notes
        // feeding the composite instrument — exactly like a leaf unit, whose `wire_cluster` folds them onto its
        // note source. Without this the whole chain was silently dropped for a composite instrument (Playfield).
        let mut unit_midi_pool: BTreeMap<Uuid, Member> = BTreeMap::new();
        let mut unit_midi_members: Vec<Member> = Vec::new();
        for uuid in unit.midi.sorted() {
            if let Some(device) = self.graph.find_box(&uuid).and_then(|device_box| self.device_for_type(&device_box.name)) {
                if device.kind == DEVICE_KIND_MIDI_EFFECT {
                    unit_midi_members.push(self.take_or_build_midi(&mut unit_midi_pool, uuid, device, invalidate, rewire));
                }
            }
        }
        let unit_midi: Vec<Rc<PluginMidiEffect>> = unit_midi_members.iter()
            .filter(|member| self.device_enabled(member.uuid))
            .filter_map(|member| match &member.proc {
                ProcHandle::Midi(effect) => Some(effect.clone()),
                _ => None
            })
            .collect();
        let binding = self.build_composite(&track_sets, instrument_uuid, &spec, signal, invalidate, unit_midi_members, unit_midi);
        // The unit's AUDIO-effects chain over the sum (reusing survivors, building joiners, terminating leavers)
        // exactly like a leaf / tape unit.
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
        // Wire sum -> fx0 -> ... (a disabled effect is SKIPPED, its processor + state untouched) -> strip; the
        // strip's output is routed to the unit's OUTPUT bus by `resolve_outputs` (not master here).
        let mut tail_edges: Vec<(NodeId, NodeId)> = Vec::new();
        let mut output = binding.sum_buffer.clone();
        let mut output_node = binding.sum_id;
        // EFFECTS monitoring: inject the staged live input after the composite sum, PRE-FX.
        let monitor_node = self.monitor_channels_of(&unit.unit).map(|(left, right)| {
            let mixer = Rc::new(RefCell::new(crate::monitor::MonitorMix::new(output.clone(), left, right)));
            let mixer_id = self.context.register_processor(mixer);
            self.context.set_label(mixer_id, alloc::string::String::from("monitor-mix"));
            self.context.register_edge(output_node, mixer_id);
            tail_edges.push((output_node, mixer_id));
            output_node = mixer_id;
            mixer_id
        });
        let include_fx = self.unit_options(&unit.unit).include_audio_effects;
        for member in &audio_members {
            if !include_fx {
                break; // a STEM export with includeAudioEffects=false: the fx chain is left unwired
            }
            if !self.device_enabled(member.uuid) {
                continue;
            }
            if let ProcHandle::Audio(node) = &member.proc {
                node.borrow_mut().set_audio_source(output.clone());
            }
            let node_id = member.node_id.expect("member.node_id");
            self.context.register_edge(output_node, node_id);
            tail_edges.push((output_node, node_id));
            output = member.output.clone().expect("member.output");
            output_node = node_id;
        }
        let pre_strip = output.clone();
        let pre_strip_node = output_node;
        let strip = Rc::new(RefCell::new(ChannelStripProcessor::new(unit.strip_params.clone(), unit.strip_automation.clone(), self.sample_rate)));
        strip.borrow_mut().set_audio_source(output);
        let strip_output = strip.borrow().audio_output();
        let strip_meter = strip.borrow().meter_slot();
        self.broadcasts.register(unit.unit, &[], crate::broadcast::PACKAGE_FLOAT_ARRAY, &strip_meter);
        let strip_id = self.context.register_processor(strip);
        self.context.set_label(strip_id, format!("strip:composite {:02x}{:02x}", unit.unit[0], unit.unit[1]));
        self.context.register_edge(pre_strip_node, strip_id);
        tail_edges.push((pre_strip_node, strip_id));
        self.output_registry.register(Address::of(unit.unit, vec![]), strip_output.clone(), strip_id);
        // Each child's parameters are pushed as it is built (a joiner), inside `build_one_child`; no blanket
        // re-push here, so a per-child reconcile never touches an existing slot's parameters.
        let enabled_mark = unit.mark.clone();
        let enabled_sub = self.graph.subscribe_vertex(Propagation::This,
            Address::of(instrument_uuid, vec![DEVICE_ENABLED_KEY]),
            Box::new(move |_graph, _update| enabled_mark.mark()));
        unit.wired = Some(Wired::Composite(CompositeWired {binding, audio: audio_members, pre_strip, pre_strip_node, strip_id, strip_output, tail_edges, enabled_sub, monitor_node}));
    }

    /// The LEAF-instrument per-member path, mirroring TS `AudioDeviceChain`: keep the existing device
    /// processors, create only the joiners, terminate only the leavers, then re-wire EDGES ONLY. A processor
    /// that survives keeps its instance (and so its DSP state — voices, delay tails, filter history); only
    /// joiners are built + bound (re-binding re-runs the device `init`, which resets DSP, so survivors must be
    /// left untouched). The channel strip persists across reconciles too.
    pub(crate) fn reconcile_leaf(&mut self, unit: &mut AudioUnitBinding, instrument_uuid: Uuid, instrument_device: DeviceReg,
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
                if let Some(node) = chain.monitor_node {
                    self.context.remove_processor(node); // the injector is rebuilt fresh by `wire_cluster`
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
            _ => {
                let sequencer = Rc::new(RefCell::new(NoteSequencer::new(Box::new(BoundNoteTracks {tracks: unit.track_sets.clone()}), self.clip_sequencer.clone())));
                sequencer.borrow_mut().bind_truncate_preference(self.truncate_pref.clone());
                sequencer
            }
        };
        // Edge-only re-wire: instrument -> fx0 -> ... (a leaf has no choke), then -> strip; the strip's output is
        // routed to the unit's OUTPUT bus by `resolve_outputs` (not master here).
        let monitor = self.monitor_channels_of(&unit.unit);
        let include_fx = self.unit_options(&unit.unit).include_audio_effects;
        let (output, output_node, mut edges, monitor_node) = self.wire_cluster(&instrument, instrument_uuid, &sequencer, &midi_members, &audio_members, &[], &[], None, monitor, include_fx);
        // The channel strip terminates the chain; reuse it across reconciles (it carries no DSP state, just the
        // shared volume / panning / mute), re-pointing its source at the new tail.
        let (strip, strip_id, strip_output) = match strip_keep {
            Some(existing) => existing,
            None => {
                let strip = Rc::new(RefCell::new(ChannelStripProcessor::new(unit.strip_params.clone(), unit.strip_automation.clone(), self.sample_rate)));
                let strip_output = strip.borrow().audio_output();
                let strip_meter = strip.borrow().meter_slot();
                self.broadcasts.register(unit.unit, &[], crate::broadcast::PACKAGE_FLOAT_ARRAY, &strip_meter);
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
            pre_strip: output, pre_strip_node: output_node, strip_id, strip_output, edges, monitor_node
        }));
    }

    /// Whether a device box is `enabled` (default true): a disabled audio / midi effect is bypassed — skipped
    /// in the chain wiring, its processor + params + DSP state left fully intact.
    pub(crate) fn device_enabled(&self, uuid: Uuid) -> bool {
        self.graph.field_value(&Address::of(uuid, vec![DEVICE_ENABLED_KEY])).and_then(|value| value.as_bool()).unwrap_or(true)
    }

    /// A TARGETED `This` monitor on a device's `enabled` field: a toggle fires `rewire` (mark + enqueue the
    /// unit), so `reconcile_leaf` re-wires the chain edge-only, skipping / including the toggled effect.
    pub(crate) fn subscribe_enabled(&mut self, uuid: Uuid, rewire: &Rc<dyn Fn()>) -> SubscriptionId {
        let rewire = rewire.clone();
        self.graph.subscribe_vertex(Propagation::This, Address::of(uuid, vec![DEVICE_ENABLED_KEY]),
            Box::new(move |_graph, _update| rewire()))
    }

    /// Reuse the pooled instrument processor (a survivor: its voices live on) or build + bind a fresh one (a
    /// joiner). A pooled entry of a different role under this uuid is terminated and rebuilt.
    pub(crate) fn take_or_build_instrument(&mut self, pool: &mut BTreeMap<Uuid, Member>, uuid: Uuid, device: DeviceReg,
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
        // The instrument's RAW output under its box uuid, so a sidechain pointer targeting THIS device taps it
        // directly (TS: every device processor registers `adapter.address -> output`). A composite SLOT child
        // overwrites this with its post-fx cluster output right after (its child uuid IS the instrument uuid).
        self.output_registry.register(Address::of(uuid, vec![]), output.clone(), node_id);
        // Live telemetry: the instrument's output peaks (TS `PeakBroadcaster(adapter.address)`). The unit's
        // 128-bit note set broadcasts separately (the binding's `note_bits`, marked from the pull path).
        let meter_slot = instrument.borrow().meter_slot();
        self.broadcasts.register(uuid, &[], crate::broadcast::PACKAGE_FLOAT_ARRAY, &meter_slot);

        let enabled_sub = self.subscribe_enabled(uuid, rewire);
        Member {uuid, proc: ProcHandle::Instrument(instrument), node_id: Some(node_id), output: Some(output), params, sidechain: None, enabled_sub}
    }

    /// Reuse the pooled midi-fx (a survivor) or build + bind a fresh one (a joiner). A midi-fx has no audio
    /// node; it is folded into the instrument's pull chain.
    pub(crate) fn take_or_build_midi(&mut self, pool: &mut BTreeMap<Uuid, Member>, uuid: Uuid, device: DeviceReg,
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
        // Live telemetry: the fx's 128-bit note set (TS midi effects own a `NoteBroadcaster` at the device address).
        let note_bits = effect.note_bits_slot();
        self.broadcasts.register(uuid, &[], crate::broadcast::PACKAGE_INT_ARRAY, &note_bits);
        let enabled_sub = self.subscribe_enabled(uuid, rewire);
        Member {uuid, proc: ProcHandle::Midi(effect), node_id: None, output: None, params, sidechain: None, enabled_sub}
    }

    /// Reuse the pooled audio-fx (a survivor: its delay tail / filter history live on) or build + bind a fresh
    /// one (a joiner), creating its sidechain ports + their targeted pointer monitors. The resolve pass wires
    /// the sidechain edges.
    pub(crate) fn take_or_build_audio(&mut self, pool: &mut BTreeMap<Uuid, Member>, uuid: Uuid, device: DeviceReg,
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
        // The effect's own output under its box uuid, so a sidechain pointer targeting THIS device taps it
        // directly (TS: every device processor registers `adapter.address -> output`).
        self.output_registry.register(Address::of(uuid, vec![]), output.clone(), node_id);
        // Live telemetry: the effect's output peaks (TS `PeakBroadcaster(adapter.address)`).
        let meter_slot = node.borrow().meter_slot();
        self.broadcasts.register(uuid, &[], crate::broadcast::PACKAGE_FLOAT_ARRAY, &meter_slot);
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
    #[allow(clippy::too_many_arguments)] // a cluster wirer takes one input per facet (instrument + midi + audio + routing)
    pub(crate) fn wire_cluster(&mut self, instrument: &Member, instrument_uuid: Uuid, sequencer: &SharedNoteEventSource,
                    midi: &[Member], audio: &[Member], unit_midi: &[Rc<PluginMidiEffect>], choke: &[i32], gate: Option<&Rc<Cell<bool>>>,
                    monitor: Option<(i32, i32)>, include_fx: bool) -> (SharedAudioBuffer, NodeId, Vec<(NodeId, NodeId)>, Option<NodeId>) {
        let mut pull = match gate {
            // A composite SLOT: routed through `SlotRoute` so its choke records inject and its silent gate
            // (pad mute / solo) drops note starts live, no rebuild.
            Some(gate) => PullLink::SlotRoute {upstream: sequencer.clone(), choke: Rc::from(choke.to_vec()), gate: gate.clone()},
            None => PullLink::Source(sequencer.clone())
        };
        // The OWNING UNIT's midi-fx (a composite slot only): folded at the pull base, below the slot's own midi,
        // so a unit-level effect (e.g. Zeitgeist) warps the notes feeding this pad — the composite mirror of a
        // leaf unit folding its midi chain onto the note source. Empty for a leaf (its `midi` IS the unit chain).
        for effect in unit_midi {
            pull = PullLink::MidiFx {effect: effect.clone(), upstream: Rc::new(pull)};
        }
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
        let mut output = instrument.output.clone().expect("instrument.output");
        let mut output_node = instrument.node_id.expect("instrument.node_id");
        // EFFECTS monitoring: the injector ADDS the staged live input into the instrument's output IN PLACE
        // (TS `MonitoringMixProcessor` sits post-instrument, PRE-FX), ordered before every chain consumer.
        let monitor_node = monitor.map(|(left, right)| {
            let mixer = Rc::new(RefCell::new(crate::monitor::MonitorMix::new(output.clone(), left, right)));
            let mixer_id = self.context.register_processor(mixer);
            self.context.set_label(mixer_id, alloc::string::String::from("monitor-mix"));
            self.context.register_edge(output_node, mixer_id);
            edges.push((output_node, mixer_id));
            output_node = mixer_id;
            mixer_id
        });
        for member in audio {
            if !include_fx {
                break; // a STEM export with includeAudioEffects=false: the whole unit fx chain is left unwired
            }
            if !self.device_enabled(member.uuid) {
                continue; // a disabled audio-fx is BYPASSED: not wired into the signal path; processor untouched
            }
            if let ProcHandle::Audio(node) = &member.proc {
                node.borrow_mut().set_audio_source(output.clone());
            }
            let node_id = member.node_id.expect("member.node_id");
            self.context.register_edge(output_node, node_id);
            edges.push((output_node, node_id));
            output = member.output.clone().expect("member.output");
            output_node = node_id;
        }
        (output, output_node, edges, monitor_node)
    }

    /// Reconcile a composite SLOT's cluster EDGE-ONLY (build when `prev` is `None`): pool the previous members,
    /// rebuild from the current midi/audio uuid lists (reusing survivors, building joiners, terminating leavers),
    /// reuse the note source while the instrument survives, then re-wire (skipping disabled devices). Mirrors
    /// `reconcile_leaf` minus the channel-strip tail (the caller appends the slot's sum edge). `rewire` is the
    /// slot's own re-wire signal (a member `enabled` toggle re-runs THIS, not the unit chain).
    #[allow(clippy::too_many_arguments)] // the reconcile cascade threads its signal/invalidate/rewire context
    pub(crate) fn reconcile_slot_cluster(&mut self, prev: Option<SlotCluster>, instrument_uuid: Uuid, device: DeviceReg,
                                         midi_uuids: &[Uuid], audio_uuids: &[Uuid], track_sets: &SharedTrackSets, unit_midi: &[Rc<PluginMidiEffect>],
                                         choke: &[i32], gate: &Rc<Cell<bool>>, signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>, rewire: &Rc<dyn Fn()>) -> SlotCluster {
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
            _ => {
                let sequencer = Rc::new(RefCell::new(NoteSequencer::new(Box::new(BoundNoteTracks {tracks: track_sets.clone()}), self.clip_sequencer.clone())));
                sequencer.borrow_mut().bind_truncate_preference(self.truncate_pref.clone());
                sequencer
            }
        };
        let (output, output_node, internal_edges, _) = self.wire_cluster(&instrument, instrument_uuid, &sequencer, &midi_members, &audio_members, unit_midi, choke, Some(gate), None, true);
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
                     midi: &[Uuid], audio: &[Uuid], unit_midi: &[Rc<PluginMidiEffect>], signal: &Rc<dyn Fn()>, invalidate: &Rc<dyn Fn()>) -> BuiltCluster {
        let mut device_params: Vec<DeviceParams> = Vec::new();
        // Each midi-fx binds its parameters too, so a midi-fx parameter is automatable like an audio device's.
        let mut chain = source;
        // The OWNING UNIT's midi-fx folded at the base (below the cell's own midi), so a unit-level effect (e.g.
        // Zeitgeist) warps the notes feeding this cell — the composite mirror of a leaf unit's note-source fold.
        for effect in unit_midi {
            chain = PullLink::MidiFx {effect: effect.clone(), upstream: Rc::new(chain)};
        }
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
        // The instrument's RAW output under its box uuid, for direct sidechain targeting (see `take_or_build_
        // instrument`); torn down via the cell's `device_params` in `teardown_child`.
        self.output_registry.register(Address::of(instrument_uuid, vec![]), output.clone(), instrument_id);
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
            // The effect's own output under its box uuid, for direct sidechain targeting (see
            // `take_or_build_audio`); torn down via the cell's `device_params` in `teardown_child`.
            self.output_registry.register(Address::of(device_uuid, vec![]), output.clone(), node_id);
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
}
