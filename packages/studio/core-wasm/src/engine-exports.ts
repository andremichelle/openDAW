// The engine wasm module's export surface, shared by every host that instantiates it (the wasm app's own
// worklet, the offline perf renderer, and the studio's wasm engine processor).
import {decodeUtf8} from "./utf8"

export type EngineExports = {
    init: (sampleRate: number) => void
    device_alloc: (size: number) => number
    // `terminateIndex` fires once, ONLY when the device's INSTANCE dies (a genuine removal — never a
    // chain-edit survivor): releases resources it holds outside its state block (e.g. a bridge's JS-side
    // instance). 0 when the device exports none.
    device_register: (processIndex: number, stateSize: number, kind: number, initIndex: number, parameterChangedIndex: number, fieldChangedIndex: number, sampleChangedIndex: number, soundfontChangedIndex: number, resetIndex: number, terminateIndex: number, midiEffectsField: number, audioEffectsField: number, paramCollectionField: number, sampleCollectionField: number) => number
    // Map a device-box type to the just-registered device: the box-type UTF-8 name is written into the
    // input buffer (nameLen bytes) first. This is the device table the engine instantiates boxes through.
    device_set_box_type: (deviceId: number, nameLen: number) => void
    // Register a composite box type (a box hosting a child collection of its own instruments): the composite
    // box-type UTF-8 name is written into the input buffer (nameLen bytes) first, then its child collection's
    // host field key + the child index/routing key are passed. Mirrors device_set_box_type.
    composite_register: (nameLen: number, childrenField: number, indexKey: number, excludeKey: number, cellInstrumentField: number, cellMidiField: number, cellAudioField: number, childEnabledKey: number, childMuteKey: number, childSoloKey: number) => void
    effect_composite_register: (nameLen: number, kind: number, distributor: number, entriesField: number, indexKey: number, chainField: number, labelKey: number, gainKey: number, panKey: number, muteKey: number, soloKey: number, dryKey: number, wetKey: number, inputTapField: number) => void
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
    // Metronome preferences (TS preferences.settings.metronome), forwarded from the engine-preferences
    // channel: click gain in dB (<= 0), beat sub-division (1|2|4|8), monophonic (a new click fades the
    // previous over 5ms).
    set_metronome_gain: (gainDb: number) => void
    set_metronome_beat_sub_division: (division: number) => void
    set_metronome_monophonic: (enabled: number) => void
    // Custom CLICK SOUNDS (TS EngineCommands.loadClickSound, the frozen-audio pattern): `click_allocate`
    // reserves `frameCount * channels` f32 (planar); the writer fills the planes, then `set_click_sound`
    // attaches them as click `index` (0 downbeat, 1 beat) keeping the PCM's own sample rate.
    click_allocate: (frameCount: number, channels: number) => number
    set_click_sound: (index: number, frameCount: number, channels: number, sampleRate: number) => void
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
    // RECORDING (TS EngineCommands.prepareRecordingState/stopRecording/ignoreNoteRegion): count_in_bars
    // comes from the caller's preferences; the ignored region uuid is written into the input scratch first.
    prepare_recording_state: (countIn: number, countInBars: number) => void
    stop_recording: () => void
    ignore_note_region: () => void
    // EFFECTS monitoring (TS EngineCommands.updateMonitoringMap): `set_monitoring_map` reads `count`
    // records of [unit uuid 16][left ch i32 LE][right ch i32 LE] (right -1 = mono) from the input scratch;
    // the worklet stages live input channels at `monitor_input_ptr` (8 x 128 f32, channel-planar) BEFORE
    // each render and forwards each mapped unit's strip output from `monitor_output_ptr` on its 2nd output.
    set_monitoring_map: (count: number) => void
    monitor_input_ptr: () => number
    monitor_output_ptr: () => number
    // STEM export (TS exportConfiguration.stems): `set_stem_export` reads `count` records of
    // [unit uuid 16][flags u32 LE: 1 includeAudioEffects, 2 includeSends, 4 useInstrumentOutput,
    // 8 skipChannelStrip] from the input scratch BEFORE bind; each render fills the staging at
    // `stem_output_ptr` (stem i -> planar channels 2i / 2i+1).
    // `metronomeStem` (TS exportConfiguration.metronome.stem) appends the metronome as ONE further pair after
    // the unit stems; it is part of this call because it sizes the same staging allocation.
    set_stem_export: (count: number, metronomeStem: number) => void
    stem_output_ptr: () => number
    // FROZEN units (TS EngineCommands.setFrozenAudio): `frozen_allocate` reserves the FINAL planar stereo
    // buffer (always frameCount * 2 f32); the writer fills plane 0 (and plane 1 when stereo), then attaches
    // it to the unit whose uuid sits in the input scratch — `set_frozen_audio` takes the buffer as-is
    // (a mono freeze duplicates plane 0 in place, no copy); clear re-wires the live chain.
    frozen_allocate: (frameCount: number, channels: number) => number
    set_frozen_audio: (frameCount: number, channels: number, sampleRate: number) => void
    clear_frozen_audio: () => void
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
    // MARKER-STATE notifications (TS EngineToClient.switchMarkerState): the active marker or its play
    // count moved (a section repeat, a fall-through, a seek into another section). Changes queue as
    // 24-byte records [uuid 16][count u32 LE][flag u32 LE: 1 active marker, 0 none] drained via
    // `marker_changes_take` (reserve `marker_changes_count() * 24` input bytes first).
    marker_changes_count: () => number
    marker_changes_take: (outPtr: number) => number
    // MIDI-OUT drain (TS MIDISender feed): every MIDI-output unit's queued messages + the transport
    // clock, drained once per quantum into the studio's unchanged MIDISender SAB ring. 16-byte records
    // [device u32 LE][status u8][data1 u8][data2 u8][length u8][timeMs f64 LE] (reserve
    // `midi_out_count() * 16` input bytes first). `device` is a stable first-seen index resolved to the
    // MIDIOutputBox.id string via `midi_out_device_id` (UTF-8 written to outPtr, byte length returned,
    // 0 = unknown), so the host caches the mapping.
    midi_out_count: () => number
    midi_out_take: (outPtr: number) => number
    midi_out_device_id: (num: number, outPtr: number, max: number) => number
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
    // The project's tuning reference in Hz (TS EngineContext.baseFrequency, RootBox.baseFrequency): a device
    // whose TS counterpart tunes against it (the Vaporisateur) pulls it per note-on.
    host_base_frequency: () => number
    sample_take_request: (outPtr: number) => number
    sample_allocate: (handle: number, byteLength: number) => number
    sample_set_ready: (handle: number, frameCount: number, channelCount: number, sampleRate: number) => void
    // Recording/loop/note preferences (TS settings.recording.allowTakes, settings.playback.pauseOnLoopDisabled,
    // settings.playback.truncateNotesAtRegionEnd): the loop-wrap gate, pause-at-loop-end, and live note
    // truncation the sequencers read per block.
    set_allow_takes: (enabled: number) => void
    set_pause_on_loop_disabled: (enabled: number) => void
    set_truncate_notes_at_region_end: (enabled: number) => void
    // PANIC readout: the engine's panic handler (and a device's, via the shared host_panic deposit) formats
    // the panic message + location into a static buffer BEFORE trapping. After catching the RuntimeError the
    // host reads it back here, so a production panic is never anonymous (panic=abort strips it otherwise).
    panic_message_ptr: () => number
    panic_message_len: () => number
}

// Read the panic message the trapped engine left behind (empty when the failure was not a wasm panic).
// Decoded WITHOUT TextDecoder — the AudioWorkletGlobalScope has none, and this runs exactly when a
// worklet must report a panic.
export const readPanicMessage = (exports: EngineExports, memory: WebAssembly.Memory): string => {
    const length = exports.panic_message_len()
    if (length === 0) {return ""}
    return decodeUtf8(new Uint8Array(memory.buffer, exports.panic_message_ptr(), length))
}
