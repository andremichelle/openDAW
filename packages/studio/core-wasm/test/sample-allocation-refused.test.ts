// Live errors 1227-1238: five long stems (124 MB each as f32) did not fit into the engine memory and
// `sample_allocate` aborted the whole engine ("memory allocation of 123808480 bytes failed"). An allocation
// that cannot be satisfied must leave the engine running: the sample plays as one frame of silence and the
// failure is logged. Drives the worklet's own load path (`drainResourceRequests`) on the real engine.wasm.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioFileBox, ConvolverDeviceBox} from "@opendaw/studio-boxes"
import type {AudioData} from "@opendaw/lib-dsp"
import type {EngineToClient} from "@opendaw/studio-adapters"
import {buildEffectProject} from "./helpers/effect-harness"
import {loadFullEngine} from "./helpers/load-full-engine"
import {connectSyncToEngine} from "./helpers/connect-sync"
import {drainResourceRequests} from "../src/boot"

// 2 x 0x1FFFFFE0 frames x 4 bytes is just under 4 GiB: a valid u32 byte length that wasm32 can never hold
const HugeFrames = 0x1FFFFFE0

const project = () => buildEffectProject(0.3, (source, unit) => {
    const file = AudioFileBox.create(source, UUID.generate(), fileBox => {
        fileBox.startInSeconds.setValue(0.0)
        fileBox.endInSeconds.setValue(4.0)
        fileBox.fileName.setValue("huge.wav")
    })
    return ConvolverDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(0)
        box.file.refer(file)
    })
})

describe("a sample that does not fit into the engine memory (1227-1238)", () => {
    it("loads as silence, is logged, and the engine keeps rendering", async () => {
        const {engine, memory} = await loadFullEngine()
        const sync = connectSyncToEngine(engine, memory, project())
        await sync.settle(); engine.bind(); await sync.settle()
        const logs: Array<string> = []
        const errors: Array<unknown> = []
        const huge = {
            numberOfFrames: HugeFrames, numberOfChannels: 2, sampleRate: 44100,
            frames: [new Float32Array(0), new Float32Array(0)]
        } as unknown as AudioData
        const engineToClient = {
            fetchAudio: () => Promise.resolve(huge),
            log: (message: string) => logs.push(message)
        } as unknown as EngineToClient
        const pending = new Set<Promise<unknown>>()
        drainResourceRequests(engine, memory, engineToClient, pending, 48000, reason => errors.push(reason))
        expect(pending.size).toBe(1)
        await Promise.all(Array.from(pending))
        expect(errors).toEqual([])
        expect(logs.some(message => message.includes("does not fit"))).toBe(true)
        engine.set_metronome_enabled(0)
        engine.stop(); engine.play()
        for (let quantum = 0; quantum < 32; quantum++) {engine.render()}
        const output = new Float32Array(memory.buffer, engine.output_ptr(), engine.output_len() >>> 0)
        expect(output.every(Number.isFinite)).toBe(true)
    })
})
