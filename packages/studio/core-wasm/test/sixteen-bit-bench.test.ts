// What a 16 bit sample costs to read: the same project is rendered with its sample resident as floats and as
// 16 bit, and the time per quantum is compared. Eight audio tracks read one long stereo sample at 44.1 kHz, so
// every reader resamples. Node runs the same wasm as the worklet, so the ratio transfers.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {
    AudioFileBox, AudioRegionBox, AudioSignalsmithBox, AudioTimeStretchBox, AudioUnitBox, TapeDeviceBox, TrackBox, TransientMarkerBox,
    ValueEventCollectionBox, WarpMarkerBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {TransientPlayMode} from "@opendaw/studio-enums"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

type Mode = "native" | "grain" | "signalsmith"
type Format = "float32" | "int16"

const RATE = 44_100
const SECONDS = 20
const FRAMES = RATE * SECONDS
const TRACKS = 8
const QUANTA = 3_000

const noise = (): Int16Array => {
    const planar = new Int16Array(FRAMES * 2)
    let seed = 0x0BAD_CAFE
    for (let index = 0; index < planar.length; index++) {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
        planar[index] = ((seed >>> 16) - 32_768) >> 2
    }
    return planar
}

const project = (mode: Mode): BoxGraph => {
    const {boxGraph: source, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    source.beginTransaction()
    const file = AudioFileBox.create(source, UUID.generate(), box => {
        box.startInSeconds.setValue(0.0)
        box.endInSeconds.setValue(SECONDS)
        box.fileName.setValue("bench")
    })
    for (let index = 0; index < 40; index++) {
        TransientMarkerBox.create(source, UUID.generate(), box => {
            box.owner.refer(file.transientMarkers)
            box.position.setValue(index * 0.5)
        })
    }
    for (let index = 0; index < TRACKS; index++) {
        const unit = AudioUnitBox.create(source, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(index + 1)
        })
        TapeDeviceBox.create(source, UUID.generate(), box => box.host.refer(unit.input))
        const track = TrackBox.create(source, UUID.generate(), box => {
            box.type.setValue(TrackType.Audio)
            box.enabled.setValue(true)
            box.index.setValue(0)
            box.target.refer(unit)
            box.tracks.refer(unit.tracks)
        })
        const events = ValueEventCollectionBox.create(source, UUID.generate())
        const region = AudioRegionBox.create(source, UUID.generate(), box => {
            box.position.setValue(0)
            box.duration.setValue(38_400)
            box.loopDuration.setValue(38_400)
            box.gain.setValue(-18.0)
            box.regions.refer(track.regions)
            box.file.refer(file)
            box.events.refer(events.owners)
        })
        if (mode !== "native") {
            const stretch = mode === "signalsmith"
                ? AudioSignalsmithBox.create(source, UUID.generate(), box => box.transpose.setValue(index - 4))
                : AudioTimeStretchBox.create(source, UUID.generate(), box => box.transientPlayMode.setValue(TransientPlayMode.Repeat))
            WarpMarkerBox.create(source, UUID.generate(), box => {
                box.owner.refer(stretch.warpMarkers)
                box.position.setValue(0)
                box.seconds.setValue(0.0)
            })
            WarpMarkerBox.create(source, UUID.generate(), box => {
                box.owner.refer(stretch.warpMarkers)
                box.position.setValue(38_400)
                box.seconds.setValue(SECONDS * 0.8)
            })
            region.playMode.refer(stretch)
        }
    }
    source.endTransaction()
    return source
}

// microseconds per quantum, the median of all quanta
const measure = async (source: BoxGraph, planar: Int16Array, format: Format): Promise<number> => {
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, source)
    await sync.settle()
    engine.bind()
    await sync.settle()
    engine.set_metronome_enabled(0)
    for (; ;) {
        const handle = engine.sample_take_request(engine.input_reserve(16))
        if (handle < 0) {break}
        if (format === "int16") {
            const pointer = engine.sample_allocate(handle, planar.length * 2)
            new Int16Array(memory.buffer, pointer, planar.length).set(planar)
            engine.sample_set_ready_i16(handle, FRAMES, 2, RATE)
        } else {
            const pointer = engine.sample_allocate(handle, planar.length * 4)
            const target = new Float32Array(memory.buffer, pointer, planar.length)
            for (let index = 0; index < planar.length; index++) {target[index] = planar[index] / 32_768}
            engine.sample_set_ready(handle, FRAMES, 2, RATE)
        }
    }
    await sync.settle()
    engine.stop()
    engine.play()
    for (let quantum = 0; quantum < 200; quantum++) {engine.render()}
    const times = new Float64Array(QUANTA)
    for (let quantum = 0; quantum < QUANTA; quantum++) {
        const start = performance.now()
        engine.render()
        times[quantum] = (performance.now() - start) * 1000.0
    }
    return times.sort()[QUANTA >> 1]
}

describe("16 bit samples: read cost", () => {
    const planar = noise()
    for (const mode of ["native", "grain", "signalsmith"] as const) {
        it(`${mode}: 16 bit frames cost about what floats cost`, async () => {
            const source = project(mode)
            const rounds: Array<[number, number]> = []
            for (let round = 0; round < 3; round++) {
                rounds.push([await measure(source, planar, "float32"), await measure(source, planar, "int16")])
            }
            const floats = Math.min(...rounds.map(([float]) => float))
            const ints = Math.min(...rounds.map(([, int]) => int))
            console.log(`${mode}: ${TRACKS} tracks, float ${floats.toFixed(1)} us, 16 bit ${ints.toFixed(1)} us per quantum, ratio ${(ints / floats).toFixed(3)}`)
            expect(ints / floats).toBeLessThan(1.25)
        }, 600_000)
    }
})
