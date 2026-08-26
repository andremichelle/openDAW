use super::*;
use super::params::automation_invalidate;

impl Engine {

    /// Re-resolve EVERY unit's sidechain bindings against the current graph, diff-based so it is a no-op when
    /// nothing moved. For each declared port: follow the device pointer to its target box, look that box's
    /// output up in the registry, and if the source NODE differs from what is wired, swap the producer ->
    /// consumer edge. Then, if any port changed, rebuild the effect's sidechain set from the currently-resolved
    /// ports. An unresolved port (pointer unset / target not built / target gone) clears its edge and is absent
    /// from the rebuilt set, so the device falls back to MAIN. This one pass handles re-pointing, detach, a
    /// source unit (re)building with a new buffer, and load build order uniformly. Run only when a reconcile
    /// did work (a membership change or an enqueued unit), so an idle transaction does nothing here.
    pub(crate) fn resolve_sidechains(&mut self) {
        let mut units = core::mem::take(&mut self.audio_units);
        for unit in &mut units {
            match &mut unit.wired {
                Some(Wired::Leaf(chain)) => {
                    // `visit_member_sidechains` recurses into an effect composite's entries, so a device
                    // nested inside a stack re-resolves exactly like a top-level one.
                    for member in &mut chain.audio {
                        visit_member_sidechains(member, &mut |binding| self.resolve_one_sidechain(binding));
                    }
                }
                Some(Wired::Composite(composite)) => {
                    composite.binding.for_each_sidechain(&mut |binding| self.resolve_one_sidechain(binding));
                    for member in &mut composite.audio {
                        visit_member_sidechains(member, &mut |binding| self.resolve_one_sidechain(binding));
                    }
                }
                Some(Wired::Tape(tape)) => {
                    for member in &mut tape.audio {
                        visit_member_sidechains(member, &mut |binding| self.resolve_one_sidechain(binding));
                    }
                }
                Some(Wired::Bus(bus)) => {
                    for member in &mut bus.audio {
                        visit_member_sidechains(member, &mut |binding| self.resolve_one_sidechain(binding));
                    }
                }
                Some(Wired::Frozen(_)) => {} // pre-rendered: no live devices, no sidechains
                Some(Wired::MidiOut(midi)) => {
                    for member in &mut midi.audio {
                        visit_member_sidechains(member, &mut |binding| self.resolve_one_sidechain(binding));
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
    pub(crate) fn resolve_one_sidechain(&mut self, binding: &mut SidechainBinding) {
        let mut changed = false;
        let mut sources: Vec<(u32, SharedAudioBuffer)> = Vec::new();
        for port in &mut binding.ports {
            let target = self.graph.target_of(&Address::of(binding.device_uuid, port.path.clone())).cloned();
            let resolution = target.and_then(|target| {
                // A pointer at a FIELD of a box resolves by its FULL address first: that is how a device nested
                // in an effect composite taps the composite's INPUT (its `input` vertex, registered to the
                // distributor's tap) rather than the composite's mixed output. A pointer at a BOX carries an
                // empty path, so its full address IS the bare uuid — every existing target resolves as before.
                if let Some(output) = self.output_registry.resolve(&target) {
                    return Some((output.processor, output.buffer.clone()));
                }
                // The sidechain pointer targets a UNIT (its strip output), a BUS (its raw sum), or a DEVICE.
                // Every BUILT device registers its own output under its box uuid (mirroring TS, where every
                // device processor registers `adapter.address -> output`), so a device target taps that device's
                // raw signal — before later fx and before the strip. Only a target that was never built (a
                // disabled bus / cell effect, an unknown device type) falls back through the device's `host`
                // pointer (field 1) to the owning unit's strip output; without either, detection falls back to
                // the effect's own (hot) main input.
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

    /// The summing bus of a route: a REGISTERED (non-primary) bus's sum, or the master fallback (`None` =
    /// the primary bus). `None` result = the bus vanished (teardown races resolve to a no-op).
    pub(crate) fn sum_of(&self, bus: Option<Uuid>) -> Option<(Rc<RefCell<AudioBusProcessor>>, NodeId)> {
        match bus {
            Some(bus_uuid) => self.bus_registry.get(&bus_uuid).map(|(sum, id)| (sum.clone(), *id)),
            None => self.master.clone().map(|master| (master, self.master_id))
        }
    }

    /// Drop a unit's current OUTPUT route (the strip -> target bus summed source + ordering edge). A torn-down
    /// bus is already absent from `bus_registry` (its sum + incoming edges vanished with it), so its source
    /// removal is simply skipped.
    pub(crate) fn unwire_output_route(&mut self, unit: &mut AudioUnitBinding) {
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
    pub(crate) fn resolve_outputs(&mut self) {
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
    pub(crate) fn resolve_one_output(&mut self, unit: &mut AudioUnitBinding) {
        if self.is_output_unit(unit.unit) {
            return; // terminal master: its strip output IS the render buffer (published by `reconcile_bus`), not routed onward
        }
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
    pub(crate) fn reconcile_sends(&mut self, unit: &mut AudioUnitBinding) {
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
    pub(crate) fn build_send(&mut self, send_uuid: Uuid, mark: &DirtyMark, invalidate: &Rc<dyn Fn()>) -> SendBinding {
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
    pub(crate) fn bind_send_automation(&mut self, send: &mut SendBinding, invalidate: &Rc<dyn Fn()>) {
        const SEND_GAIN: Decibel = Decibel::new(-72.0, -12.0, 0.0); // TS AuxSendBoxAdapter ValueMapping.DefaultDecibel
        let automation = send.automation.clone();
        self.bind_gain_pan_automation(send.send_uuid, SEND_GAIN_KEY, SEND_PAN_KEY, SEND_GAIN, None,
            &automation, &mut send.param_subs, &mut send.param_collections, invalidate);
    }

    /// Tear down one aux send: detach its source + target edges (and its summed output), then drop the node +
    /// subscriptions.
    pub(crate) fn teardown_send(&mut self, send: SendBinding) {
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
    pub(crate) fn teardown_sends(&mut self, unit: &mut AudioUnitBinding) {
        for send in core::mem::take(&mut unit.sends) {
            self.teardown_send(send);
        }
    }

    /// Re-resolve EVERY unit's aux sends against the current graph (source tap + target bus), diff-based. Run
    /// with `resolve_outputs` at the end of a working `reconcile_units`.
    pub(crate) fn resolve_sends(&mut self) {
        let mut units = core::mem::take(&mut self.audio_units);
        for unit in &mut units {
            // A STEM export with includeSends=false leaves this unit's aux sends unwired (TS skips them).
            let tap = if self.unit_options(&unit.unit).include_sends {
                unit.wired.as_ref().map(|wired| wired.pre_strip())
            } else {
                None
            };
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
    pub(crate) fn resolve_one_send(&mut self, send: &mut SendBinding, tap: &Option<(NodeId, SharedAudioBuffer)>) {
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
}
