// Deleting a Convolver while playback runs, with the IR absent, pending, mid-load or loaded, with and
// without its AudioFileBox: the engine keeps rendering finite audio.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioFileBox, ConvolverDeviceBox} from "@opendaw/studio-boxes"
import {buildEffectProject, allFinite} from "./helpers/effect-harness"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"

const RATE = 48000

const makeIr = (seconds: number): Float32Array => {
    const frames = RATE * seconds
    const planes = new Float32Array(frames * 2)
    let seed = 7
    for (let i = 0; i < planes.length; i++) {
        seed = (seed * 48271) % 2147483647
        planes[i] = ((seed / 2147483647) * 2 - 1) * 0.05 * Math.exp(-i / (frames * 0.3))
    }
    return planes
}

type Scenario = {withIr: boolean, deliverIr: boolean, deleteFile: boolean, loadQuanta: number, seconds: number}

const run = async ({withIr, deliverIr, deleteFile, loadQuanta, seconds}: Scenario): Promise<void> => {
    let device: ConvolverDeviceBox | null = null
    let fileBox: AudioFileBox | null = null
    const graph = buildEffectProject(0.3, (source, unit) => {
        if (withIr) {
            fileBox = AudioFileBox.create(source, UUID.generate(), box => {
                box.startInSeconds.setValue(0.0)
                box.endInSeconds.setValue(seconds)
                box.fileName.setValue("ir")
            })
        }
        device = ConvolverDeviceBox.create(source, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
            if (fileBox !== null) {box.file.refer(fileBox)}
        })
        return device
    })
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, graph)
    await sync.settle(); engine.bind(); await sync.settle()
    if (deliverIr) {
        const planes = makeIr(seconds)
        for (; ;) {
            const handle = engine.sample_take_request(engine.input_reserve(16))
            if (handle < 0) {break}
            const pointer = engine.sample_allocate(handle, planes.byteLength)
            new Float32Array(memory.buffer, pointer, planes.length).set(planes)
            engine.sample_set_ready(handle, RATE * seconds, 2, RATE)
        }
    }
    engine.set_metronome_enabled(0)
    engine.stop(); engine.play()
    for (let q = 0; q < loadQuanta; q++) {engine.render()}
    graph.beginTransaction()
    device!.delete()
    if (deleteFile && fileBox !== null) {(fileBox as AudioFileBox).delete()}
    graph.endTransaction()
    await sync.settle()
    const len = engine.output_len() >>> 0
    for (let q = 0; q < 64; q++) {
        engine.render()
        expect(allFinite(new Float32Array(memory.buffer, engine.output_ptr(), len))).toBe(true)
    }
}

describe("convolver live deletion", () => {
    it("no IR", async () => run({withIr: false, deliverIr: false, deleteFile: false, loadQuanta: 32, seconds: 2}), 30000)
    it("IR pending (not delivered)", async () => run({withIr: true, deliverIr: false, deleteFile: false, loadQuanta: 32, seconds: 2}), 30000)
    it("IR loaded", async () => run({withIr: true, deliverIr: true, deleteFile: false, loadQuanta: 256, seconds: 2}), 30000)
    it("IR mid-load", async () => run({withIr: true, deliverIr: true, deleteFile: false, loadQuanta: 4, seconds: 8}), 30000)
    it("IR loaded, file deleted too", async () => run({withIr: true, deliverIr: true, deleteFile: true, loadQuanta: 256, seconds: 2}), 30000)
    it("IR mid-load, file deleted too", async () => run({withIr: true, deliverIr: true, deleteFile: true, loadQuanta: 4, seconds: 8}), 30000)
})
