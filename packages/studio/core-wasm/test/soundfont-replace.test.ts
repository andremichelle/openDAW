// Live error 1220: "memory access out of bounds" inside apply_updates right after a Soundfont track was deleted
// (device + its SoundfontFileBox), a new Soundfont instrument was created, given another soundfont file and a
// note region. This replays that sequence headless while rendering, in the orders the log allows.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {
    AudioUnitBox, CaptureMidiBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, SoundfontDeviceBox,
    SoundfontFileBox, TrackBox
} from "@opendaw/studio-boxes"
import type {BoxGraph} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {encodeSoundfont} from "../src/soundfont-simplify"

const FRAMES = 48000

const blob = (frames: number, presets: number): ArrayBuffer => encodeSoundfont({
    samples: [{pcm: new Float32Array(frames).fill(0.5), sampleRate: 48000, loopStart: 0, loopEnd: frames}],
    presets: Array.from({length: presets}, () => [{
        keyLo: 0, keyHi: 127, velLo: 0, velHi: 127, sampleIndex: 0, rootKey: 60, loopMode: 0, pan: 0.0,
        attack: 0.001, decay: 0.005, sustain: 1.0, release: 0.05
    }])
})

type Unit = {unit: AudioUnitBox, device: SoundfontDeviceBox, track: TrackBox}

const createUnit = (source: BoxGraph<BoxIO.TypeMap>, index: number, file?: SoundfontFileBox): Unit => {
    const {rootBox, primaryAudioBusBox} = mandatory(source)
    const unit = AudioUnitBox.create(source, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits); box.output.refer(primaryAudioBusBox.input); box.index.setValue(index)
    })
    unit.capture.refer(CaptureMidiBox.create(source, UUID.generate()))
    const device = SoundfontDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.input)
        if (file !== undefined) {box.file.refer(file)}
    })
    const track = TrackBox.create(source, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes); box.enabled.setValue(true); box.index.setValue(0)
        box.target.refer(unit); box.tracks.refer(unit.tracks)
    })
    return {unit, device, track}
}

const addRegion = (source: BoxGraph<BoxIO.TypeMap>, track: TrackBox, withNote: boolean): void => {
    const events = NoteEventCollectionBox.create(source, UUID.generate())
    if (withNote) {
        NoteEventBox.create(source, UUID.generate(), box => {
            box.events.refer(events.events); box.position.setValue(0); box.duration.setValue(100_000)
            box.pitch.setValue(60); box.velocity.setValue(1.0); box.cent.setValue(0)
        })
    }
    NoteRegionBox.create(source, UUID.generate(), box => {
        box.regions.refer(track.regions); box.events.refer(events.owners)
        box.position.setValue(0); box.duration.setValue(100_000); box.loopDuration.setValue(100_000)
    })
}

let skeletonMandatory: Map<BoxGraph<BoxIO.TypeMap>, ReturnType<typeof ProjectSkeleton.empty>["mandatoryBoxes"]> = new Map()
const mandatory = (source: BoxGraph<BoxIO.TypeMap>) => skeletonMandatory.get(source)!

type Scenario = {deliverFirst: boolean, renderBeforeDeliver: boolean, regionWithNote: boolean, sameFileUuid: boolean}

const run = async ({deliverFirst, renderBeforeDeliver, regionWithNote, sameFileUuid}: Scenario) => {
    const skeleton = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const source = skeleton.boxGraph
    skeletonMandatory.set(source, skeleton.mandatoryBoxes)
    const {engine, memory, drainSoundfonts} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    const render = (quanta: number) => {for (let q = 0; q < quanta; q++) {engine.render()}}
    const fileUuidA = UUID.generate()
    source.beginTransaction()
    const fileA = SoundfontFileBox.create(source, fileUuidA, box => box.fileName.setValue("a.sf2"))
    const first = createUnit(source, 1, fileA)
    addRegion(source, first.track, true)
    source.endTransaction()
    await sync.settle(); engine.bind(); await sync.settle()
    if (deliverFirst) {drainSoundfonts(() => blob(FRAMES, 4))}
    engine.set_metronome_enabled(0)
    engine.stop(); engine.play()
    render(50)
    source.beginTransaction()
    first.unit.delete()
    fileA.delete()
    source.endTransaction()
    await sync.settle()
    render(20)
    source.beginTransaction()
    const second = createUnit(source, 1)
    source.endTransaction()
    await sync.settle()
    render(20)
    source.beginTransaction()
    const fileB = SoundfontFileBox.create(source, sameFileUuid ? fileUuidA : UUID.generate(),
        box => box.fileName.setValue("b.sf2"))
    second.device.file.refer(fileB)
    source.endTransaction()
    await sync.settle()
    if (renderBeforeDeliver) {render(20)}
    drainSoundfonts(() => blob(FRAMES * 2, 1))
    render(20)
    source.beginTransaction()
    addRegion(source, second.track, regionWithNote)
    source.endTransaction()
    await sync.settle()
    render(100)
    source.beginTransaction()
    second.device.presetIndex.setValue(3)
    source.endTransaction()
    await sync.settle()
    render(100)
    sync.close()
}

describe("replacing a soundfont track (live error 1220)", () => {
    const scenarios: Array<Scenario> = []
    for (const deliverFirst of [true, false]) {
        for (const renderBeforeDeliver of [true, false]) {
            for (const regionWithNote of [true, false]) {
                for (const sameFileUuid of [true, false]) {
                    scenarios.push({deliverFirst, renderBeforeDeliver, regionWithNote, sameFileUuid})
                }
            }
        }
    }
    scenarios.forEach(scenario => it(JSON.stringify(scenario), async () => {
        await expect(run(scenario)).resolves.toBeUndefined()
    }))
})
