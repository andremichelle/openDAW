// Live errors 1280-1305: a 245,756 frame mono sample (983,024 bytes, 16 bytes below 15 wasm pages) made talc
// 5.0.3 grow the engine memory to 4 GiB in one `sample_allocate`: every fresh heap it claimed was a few bytes
// too small, so it claimed again until the memory was full. The sample then landed above 2 GiB and its pointer
// read negative in JS ("Start offset -1834992 is outside the bounds of the buffer").
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioFileBox, ConvolverDeviceBox} from "@opendaw/studio-boxes"
import type {AudioData} from "@opendaw/lib-dsp"
import type {EngineToClient} from "@opendaw/studio-adapters"
import {buildEffectProject} from "./helpers/effect-harness"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {drainResourceRequests} from "../src/boot"
import {EngineExports, withUnsignedPointers} from "../src/engine-exports"

const PAGE = 65536

const project = () => buildEffectProject(0.3, (source, unit) => {
    const file = AudioFileBox.create(source, UUID.generate(), fileBox => {
        fileBox.startInSeconds.setValue(0.0)
        fileBox.endInSeconds.setValue(4.0)
        fileBox.fileName.setValue("boundary.wav")
    })
    return ConvolverDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(0)
        box.file.refer(file)
    })
})

const loadSample = async (byteLength: number) => {
    const {engine, memory} = await loadFullEngine()
    const sync = connectSyncToEngine(engine, memory, project())
    await sync.settle(); engine.bind(); await sync.settle()
    const numberOfFrames = byteLength / Float32Array.BYTES_PER_ELEMENT
    const frames = new Float32Array(numberOfFrames).fill(0.25)
    const audio = {numberOfFrames, numberOfChannels: 1, sampleRate: 48000, frames: [frames]} as unknown as AudioData
    const logs: Array<string> = []
    const errors: Array<unknown> = []
    const engineToClient = {
        fetchAudio: () => Promise.resolve(audio),
        log: (message: string) => logs.push(message)
    } as unknown as EngineToClient
    const before = memory.buffer.byteLength
    const pending = new Set<Promise<unknown>>()
    drainResourceRequests(engine, memory, engineToClient, pending, 48000, reason => errors.push(reason))
    await Promise.all(Array.from(pending))
    return {grown: memory.buffer.byteLength - before, logs, errors}
}

describe("allocations just below a wasm page multiple (1280-1305)", () => {
    // every size whose 4-byte frames end within the 24 bytes talc 5.0.3 undersized
    for (const byteLength of [15 * PAGE - 16, 15 * PAGE - 20, 256 * PAGE - 16, 256 * PAGE - 20]) {
        it(`a ${byteLength} byte sample grows the memory by its own size only`, async () => {
            const {grown, logs, errors} = await loadSample(byteLength)
            expect(errors).toEqual([])
            expect(logs).toEqual([])
            expect(grown).toBeLessThan(byteLength + 4 * 1024 * 1024)
        })
    }
})

describe("engine pointers above 2 GiB", () => {
    it("arrive unsigned", () => {
        const raw = {
            input_reserve: () => -16, sample_allocate: () => -1834992, output_len: () => 256
        } as unknown as EngineExports
        const engine = withUnsignedPointers(raw)
        expect(engine.input_reserve(16)).toBe(0xFFFFFFF0)
        expect(engine.sample_allocate(1, 4)).toBe(0xFFE40010)
        expect(engine.output_len()).toBe(256)
    })
})
