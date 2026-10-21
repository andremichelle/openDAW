// Builders shared by the delay compensation tests: impulse instruments, a neutral look-ahead Compressor, buses,
// a Werkstatt script that delays by a fixed number of frames, and a render loop over the full engine.
import {UUID} from "@opendaw/lib-std"
import {
    ApparatDeviceBox,
    AudioBusBox,
    AudioUnitBox,
    CompressorDeviceBox,
    NoteEventBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    TrackBox,
    WerkstattDeviceBox
} from "@opendaw/studio-boxes"
import type {BoxGraph, Field} from "@opendaw/lib-box"
import {ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {Pointers} from "@opendaw/studio-enums"
import {loadFullEngine} from "./load-full-engine"
import {connectSyncToEngine} from "./connect-sync"
import {leftChannel} from "./effect-harness"

export const IMPULSE = `class Processor {
    pending = false
    noteOn() { this.pending = true }
    noteOff() {}
    process(output, block) {
        if (this.pending) { output[0][block.s0] += 0.5; output[1][block.s0] += 0.5; this.pending = false }
    }
}`

export type Skeleton = ReturnType<typeof ProjectSkeleton.empty>

export const impulseUnit = (skeleton: Skeleton, index: number, scripts: Array<string>): AudioUnitBox => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = skeleton
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(index)
    })
    const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.code.setValue("// @apparat js 1 1\n" + IMPULSE)
    })
    scripts.push(UUID.toString(apparat.address.uuid))
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
        box.duration.setValue(100_000)
        box.pitch.setValue(60)
        box.velocity.setValue(1.0)
        box.cent.setValue(0)
    })
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(events.owners)
        box.position.setValue(0)
        box.duration.setValue(100_000)
        box.loopDuration.setValue(100_000)
    })
    return unit
}

export const neutralCompressor = (source: BoxGraph, host: Field<Pointers.AudioEffectHost>, lookahead: boolean): CompressorDeviceBox =>
    CompressorDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(host)
        box.index.setValue(0)
        box.lookahead.setValue(lookahead)
        box.threshold.setValue(0.0)
        box.ratio.setValue(1.0)
        box.knee.setValue(0.0)
        box.inputgain.setValue(0.0)
        box.makeup.setValue(0.0)
        box.automakeup.setValue(false)
        box.mix.setValue(1.0)
    })

export const busUnit = (skeleton: Skeleton, index: number): { bus: AudioBusBox, unit: AudioUnitBox } => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = skeleton
    const bus = AudioBusBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioBusses)
        box.output.refer(primaryAudioBusBox.input)
        box.label.setValue("Bus")
    })
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.type.setValue("bus")
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(index)
    })
    bus.output.refer(unit.input)
    return {bus, unit}
}

export const build = (populate: (skeleton: Skeleton, scripts: Array<string>) => void) => {
    const skeleton = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const scripts: Array<string> = []
    skeleton.boxGraph.beginTransaction()
    populate(skeleton, scripts)
    skeleton.boxGraph.endTransaction()
    scripts.forEach(uuid => new Function(ScriptCompiler.wrap(
        {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}, uuid, 1, IMPULSE))())
    return skeleton.boxGraph
}

export const start = async (source: BoxGraph) => {
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    const len = engine.output_len() >>> 0
    const play = (quanta: number) => {
        engine.stop(); engine.play()
        const out = new Float32Array(quanta * len)
        for (let quantum = 0; quantum < quanta; quantum++) {
            engine.render()
            out.set(new Float32Array(memory.buffer, engine.output_ptr(), len), quantum * len)
        }
        return leftChannel(out)
    }
    const idle = (quanta: number) => {for (let quantum = 0; quantum < quanta; quantum++) {engine.render()}}
    idle(8)
    return {engine, memory, sync, play, idle}
}

export const peaks = (signal: Float32Array): Array<[number, number]> => Array.from(signal)
    .map((value, index): [number, number] => [index, Number(value.toFixed(3))])
    .filter(([, value]) => Math.abs(value) > 0.01)

export const delayScript = (frames: number, declared: number) => `class Processor {
    constructor() { this.latency = ${declared}; this.ring = [new Float32Array(${frames}), new Float32Array(${frames})]; this.cursor = 0 }
    process({src, out}, {s0, s1}) {
        for (let i = s0; i < s1; i++) {
            for (let channel = 0; channel < 2; channel++) {
                out[channel][i] = this.ring[channel][this.cursor]
                this.ring[channel][this.cursor] = src[channel][i]
            }
            this.cursor = (this.cursor + 1) % ${frames}
        }
    }
}`

// A Werkstatt delaying by `frames` and declaring `declared` frames of latency; register with `registerWerkstatt`.
export const werkstattDelay = (source: BoxGraph, host: Field<Pointers.AudioEffectHost>, index: number,
                               frames: number, declared: number): { uuid: string, code: string } => {
    const code = delayScript(frames, declared)
    const box = WerkstattDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(host)
        box.index.setValue(index)
        box.code.setValue("// @werkstatt js 1 1\n" + code)
    })
    return {uuid: UUID.toString(box.address.uuid), code}
}

export const registerWerkstatt = ({uuid, code}: { uuid: string, code: string }): void => new Function(ScriptCompiler.wrap(
    {headerTag: "werkstatt", registryName: "werkstattProcessors", functionName: "werkstatt"}, uuid, 1, code))()
