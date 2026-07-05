// The engine wasm module's export surface, shared by every host that instantiates it (the wasm app's own
// worklet, the offline perf renderer, and the studio's wasm engine processor).
export type EngineExports = {
    init: (sampleRate: number) => void
    device_alloc: (size: number) => number
    device_register: (processIndex: number, stateSize: number, kind: number, initIndex: number, parameterChangedIndex: number, fieldChangedIndex: number, sampleChangedIndex: number, soundfontChangedIndex: number, resetIndex: number, midiEffectsField: number, audioEffectsField: number, paramCollectionField: number, sampleCollectionField: number) => number
    // Map a device-box type to the just-registered device: the box-type UTF-8 name is written into the
    // input buffer (nameLen bytes) first. This is the device table the engine instantiates boxes through.
    device_set_box_type: (deviceId: number, nameLen: number) => void
    // Register a composite box type (a box hosting a child collection of its own instruments): the composite
    // box-type UTF-8 name is written into the input buffer (nameLen bytes) first, then its child collection's
    // host field key + the child index/routing key are passed. Mirrors device_set_box_type.
    composite_register: (nameLen: number, childrenField: number, indexKey: number, excludeKey: number, cellInstrumentField: number, cellMidiField: number, cellAudioField: number, childEnabledKey: number, childMuteKey: number, childSoloKey: number) => void
    input_ptr: () => number
    input_capacity: () => number
    input_reserve: (len: number) => number // ensure the input scratch holds `len`, grow if needed, return its (current) ptr
    apply_updates: (len: number) => number
    bind: () => number
    render: () => void
    output_ptr: () => number
    output_len: () => number
    heap_used: () => number
    heap_claimed: () => number
    engine_state_ptr: () => number
    engine_state_len: () => number
    set_metronome_enabled: (enabled: number) => void
    checksum_ptr: () => number
    // Live-telemetry BROADCAST TABLE: the engine registers meter / note-activity slots at reconcile;
    // `broadcast_generation` bumps whenever the table changed, so a worklet re-reads it (via
    // `broadcast_entry`, one fixed 48-byte record per entry) and re-registers its LiveStreamBroadcaster
    // packages as views over wasm memory. `broadcast_set_active` round-trips the UI subscription flag.
    broadcast_generation: () => number
    broadcast_count: () => number
    broadcast_entry: (index: number, outPtr: number) => number
    broadcast_set_active: (index: number, active: number) => void
    // Transport: `play` starts advancing, `pause` freezes (state kept), `stop` rewinds to 0 + resets all
    // plugins, `set_position` moves the playhead keeping all plugin state (the TS engine's `setPosition`).
    play: () => void
    pause: () => void
    stop: () => void
    set_position: (position: number) => void
    // LIVE note signals (the studio's on-screen keys / pads / MIDI input): write the target AudioUnitBox
    // uuid into the input buffer (16 bytes) first. A raw note-on sustains until its note-off; an audition
    // stops itself after `duration` pulses. They sound while the transport is stopped too.
    note_signal_on: (pitch: number, velocity: number) => void
    note_signal_off: (pitch: number) => void
    note_signal_audition: (pitch: number, duration: number, velocity: number) => void
    // CLIP LAUNCHING: write the 16-byte uuid into the input buffer first — a CLIP uuid for play (the
    // engine resolves its track), a TRACK uuid for stop. Transitions queue as 20-byte records
    // [uuid 16][kind u32 LE: 0 started, 1 stopped, 2 obsolete] drained via `clip_changes_take` (reserve
    // `clip_changes_count() * 20` input bytes first) for notifyClipSequenceChanges.
    schedule_clip_play: () => void
    schedule_clip_stop: () => void
    clip_changes_count: () => number
    clip_changes_take: (outPtr: number) => number
    // A device imports this from `env`; the loader binds it so the device PULLS its own input events for a
    // pulse range (Route A), writing EventRecords into the descriptor scratch and returning the count.
    host_pull_events: (from: number, to: number, flags: number, outPtr: number, max: number) => number
    // Maps a pulse position to its sample offset in the current quantum; a generative device (arp) times
    // its emitted events with it.
    host_pulse_to_offset: (pulse: number) => number
    // Route D parameter hooks. `host_bind_parameter` registers a parameter by its field-key path (a u16
    // slice in the device's memory) from `init`, returning its id (the host is mapping-agnostic — the device
    // maps). `host_update_parameters` pulls the device's parameters that changed at a position into a
    // ParamChange scratch, returning the count. `host_next_update_position` returns the next update-clock
    // position after a pulse (or +Infinity when the device has no automation), so the render fragments at it.
    host_bind_parameter: (pathPtr: number, pathLen: number) => number
    host_update_parameters: (position: number, outPtr: number, max: number) => number
    host_first_update_position: (at: number) => number
    host_next_update_position: (after: number) => number
    // Route F (samples). A device imports `host_resolve_sample` from `env` to resolve a sample handle to its
    // resident frames during render. The other three are the off-render load handshake the worklet drives:
    // `sample_take_request` pops a queued load (writing its 16-byte uuid to outPtr, returning the handle or
    // -1), `sample_allocate` reserves the decoded byte length and returns the pointer, `sample_set_ready`
    // marks it resolvable once the frames are written.
    host_resolve_sample: (handle: number, outPtr: number) => number
    host_resolve_soundfont: (handle: number, outPtr: number) => number
    host_observe_soundfont: (pathPtr: number, pathLen: number) => number
    soundfont_take_request: (outPtr: number) => number
    soundfont_allocate: (handle: number, byteLength: number) => number
    soundfont_set_ready: (handle: number) => void
    // A scriptable device imports this from `env`; the engine writes the current device box's 16 uuid bytes to
    // `outPtr` (called from the device's `init`), so the script bridge can key its registry lookup by uuid.
    host_self_uuid: (outPtr: number) => void
    host_observe_sample: (pathPtr: number, pathLen: number) => number
    host_observe_field: (pathPtr: number, pathLen: number) => number
    // Observe a device's POINTER field and deliver the TARGET box's string field through `field_changed`
    // (the NeuralAmp's model JSON on its NeuralAmpModelBox); shares the `host_observe_field` id space.
    host_observe_target_string: (pathPtr: number, pathLen: number, fieldKey: number) => number
    // Route B/C (audio input ports). A device imports these: `host_bind_sidechain` declares a sidechain port by
    // its pointer field-key path (returns the port id 2+); `host_resolve_input` resolves a port id to its
    // stereo buffer during render (id 1 the through-signal).
    host_bind_sidechain: (pathPtr: number, pathLen: number) => number
    host_resolve_input: (id: number, outPtr: number) => number
    sample_take_request: (outPtr: number) => number
    sample_allocate: (handle: number, byteLength: number) => number
    sample_set_ready: (handle: number, frameCount: number, channelCount: number, sampleRate: number) => void
}
