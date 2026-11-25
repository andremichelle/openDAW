// Automation behind delay compensation under tempo automation (#482): a tempo ramp from 90 to 180 bpm, a constant
// signal and a step at beat 1, on a Stereo Tool's volume (a device) or on the channel strip's mute. Render A puts a Werkstatt with 1000 frames of declared
// latency before the Stereo Tool, render B does not. Compensated, A is B delayed by exactly 1000 frames, so the
// lagged update clock lands the step on the same sample relative to the audio.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {Interpolation} from "@opendaw/lib-dsp"
import type {BoxGraph, Field} from "@opendaw/lib-box"
import {
    ApparatDeviceBox,
    AudioUnitBox,
    NoteEventBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    StereoToolDeviceBox,
    TrackBox,
    ValueEventBox,
    ValueEventCollectionBox,
    ValueRegionBox
} from "@opendaw/studio-boxes"
import {InterpolationFieldAdapter, ProjectSkeleton, ScriptCompiler, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {leftChannel} from "./helpers/effect-harness"
import {registerWerkstatt, werkstattDelay} from "./helpers/compensation-harness"

const DC = `class Processor {
    on = false
    noteOn() { this.on = true }
    noteOff() {}
    process(output, block) {
        if (!this.on) return
        for (let i = block.s0; i < block.s1; i++) { output[0][i] += 0.5; output[1][i] += 0.5 }
    }
}`

const DELAY = 1000
const SWITCH = 960
const QUANTA = 320

const valueEvents = (source: BoxGraph, collection: ValueEventCollectionBox,
                     events: ReadonlyArray<[number, number, Interpolation]>): void =>
    events.forEach(([position, value, interpolation], index) =>
        ValueEventBox.create(source, UUID.generate(), box => {
            box.position.setValue(position)
            box.value.setValue(value)
            box.index.setValue(index)
            box.slope.setValue(NaN)
            box.events.refer(collection.events)
            InterpolationFieldAdapter.write(box.interpolation, interpolation)
        }))

const automate = (source: BoxGraph, target: Field, tracks: Field, events: ReadonlyArray<[number, number, Interpolation]>) => {
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Value)
        box.enabled.setValue(true)
        box.index.setValue(1)
        box.target.refer(target)
        box.tracks.refer(tracks)
    })
    const collection = ValueEventCollectionBox.create(source, UUID.generate())
    valueEvents(source, collection, events)
    ValueRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(collection.owners)
        box.position.setValue(0)
        box.duration.setValue(3840 * 4)
        box.loopDuration.setValue(3840 * 4)
    })
}

type Target = "device" | "strip"

const render = async (latent: boolean, target: Target): Promise<Float32Array> => {
    const skeleton = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox, timelineBox}} = skeleton
    const werkstatts: Array<{ uuid: string, code: string }> = []
    source.beginTransaction()
    timelineBox.tempoTrack.enabled.setValue(true)
    timelineBox.tempoTrack.events.targetVertex.ifSome(vertex => {
        const collection = vertex.box as ValueEventCollectionBox
        valueEvents(source, collection, [[0, 90, Interpolation.Linear], [3840, 180, Interpolation.Linear]])
    })
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    const apparat = ApparatDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.code.setValue("// @apparat js 1 1\n" + DC)
    })
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.enabled.setValue(true)
        box.index.setValue(0)
        box.target.refer(unit)
        box.tracks.refer(unit.tracks)
    })
    const notes = NoteEventCollectionBox.create(source, UUID.generate())
    NoteEventBox.create(source, UUID.generate(), box => {
        box.events.refer(notes.events)
        box.position.setValue(0)
        box.duration.setValue(100_000)
        box.pitch.setValue(60)
        box.velocity.setValue(1.0)
        box.cent.setValue(0)
    })
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(notes.owners)
        box.position.setValue(0)
        box.duration.setValue(100_000)
        box.loopDuration.setValue(100_000)
    })
    if (latent) {werkstatts.push(werkstattDelay(source, unit.audioEffects, 0, DELAY, DELAY))}
    const tool = StereoToolDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(1)
        box.volume.setValue(0.0)
        box.panning.setValue(0.0)
        box.stereo.setValue(0.0)
    })
    if (target === "device") {
        automate(source, tool.volume, unit.tracks, [[0, 0.75, Interpolation.None], [SWITCH, 0.0, Interpolation.None]])
    } else {
        automate(source, unit.mute, unit.tracks, [[0, 0.0, Interpolation.None], [SWITCH, 1.0, Interpolation.None]])
    }
    source.endTransaction()
    new Function(ScriptCompiler.wrap({headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
        UUID.toString(apparat.address.uuid), 1, DC))()
    werkstatts.forEach(registerWerkstatt)
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle(); engine.bind(); await sync.settle()
    engine.set_metronome_enabled(0)
    for (let quantum = 0; quantum < 8; quantum++) {engine.render()}
    engine.stop(); engine.play()
    const len = engine.output_len() >>> 0
    const out = new Float32Array(QUANTA * len)
    for (let quantum = 0; quantum < QUANTA; quantum++) {
        engine.render()
        out.set(new Float32Array(memory.buffer, engine.output_ptr(), len), quantum * len)
    }
    return leftChannel(out)
}

// the first frame after the plateau where the level fell below half of it
const edgeOf = (signal: Float32Array): number => {
    const plateau = signal.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)
    const start = signal.findIndex(sample => Math.abs(sample) > plateau * 0.5)
    return start + signal.subarray(start).findIndex(sample => Math.abs(sample) < plateau * 0.5)
}

describe("automation behind delay compensation under tempo automation", () => {
    it.each<Target>(["device", "strip"])("lands the %s step on the same sample relative to the delayed audio", async target => {
        const reference = await render(false, target)
        const latent = await render(true, target)
        const referenceEdge = edgeOf(reference)
        const latentEdge = edgeOf(latent)
        expect(referenceEdge).toBeGreaterThan(DELAY)
        expect(latentEdge - DELAY - referenceEdge).toBe(0)
        const shifted = latent.subarray(DELAY, DELAY + reference.length - DELAY)
        const difference = shifted.reduce((max, sample, index) => Math.max(max, Math.abs(sample - reference[index])), 0)
        expect(difference).toBeLessThan(1.0e-6)
    }, 60000)
})
