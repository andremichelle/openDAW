// Shared harness for audio-effect device tests: a clean scriptable Apparat sine instrument voices a note into a
// unit's audio-fx chain, where the test attaches ONE effect box (via `addEffect`) and configures it. Returns a
// render() that plays and captures the interleaved stereo output. (Tape units bypass the audio-fx chain, so a
// leaf instrument is used; the Apparat sine is finite and known — unlike a default Vaporisateur, which NaNs.)
import {UUID} from "@opendaw/lib-std"
import {ApparatDeviceBox, AudioUnitBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import type {Box, BoxGraph} from "@opendaw/lib-box"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./load-full-engine"
import {connectSyncToEngine} from "./connect-sync"

// A sine synth with a controllable peak gain (velocity * `gain`), so the effect has a finite, known input.
const synth = (gain: number) => `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, phase: 0, gain: velocity * ${gain}, freq: 440 * Math.pow(2, (pitch - 69) / 12)}) }
    noteOff(id) { this.voices = this.voices.filter(v => v.id !== id) }
    process(output, block) {
        const [l, r] = output
        for (const voice of this.voices) {
            for (let i = block.s0; i < block.s1; i++) {
                const s = Math.sin(voice.phase * Math.PI * 2) * voice.gain
                l[i] += s; r[i] += s
                voice.phase += voice.freq / sampleRate
            }
        }
    }
}`

// Build a project: unit + Apparat sine (peak `gain`) + a note; `addEffect(source, unit)` attaches the effect on
// `unit.audioEffects`. Seeds the Apparat script into the registry (as engine-host would). Returns the box graph.
export const buildEffectProject = (gain: number, addEffect: (source: BoxGraph, unit: AudioUnitBox) => Box): BoxGraph => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const code = synth(gain)
    let apparatUuid = ""
    source.beginTransaction()
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.code.setValue("// @apparat js 1 1\n" + code)
    })
    apparatUuid = UUID.toString(apparat.address.uuid)
    addEffect(source, unit)
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    NoteEventBox.create(source, UUID.generate(), box => {
        box.events.refer(events.events)
        box.position.setValue(0)
        box.duration.setValue(10_000)
        box.pitch.setValue(60)
        box.velocity.setValue(1.0)
        box.cent.setValue(0)
    })
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.position.setValue(0)
        box.duration.setValue(10_000)
        box.loopDuration.setValue(10_000)
    })
    source.endTransaction()
    new Function(ScriptCompiler.wrap(
        {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}, apparatUuid, 1, code))()
    return source
}

// Render the project through the full engine, returning the interleaved (planar L|R per quantum) output.
export const renderEffect = async (source: BoxGraph, quanta = 32): Promise<Float32Array> => {
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    engine.stop(); engine.play()
    const out = new Float32Array(quanta * len)
    for (let q = 0; q < quanta; q++) {
        engine.render()
        out.set(new Float32Array(memory.buffer, engine.output_ptr(), len), q * len)
    }
    return out
}

export const peakOf = (buffer: Float32Array): number => buffer.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)
export const allFinite = (buffer: Float32Array): boolean => buffer.every(sample => Number.isFinite(sample))
