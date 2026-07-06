// Regression for "recording a take breaks the memory on pause": when a sample's slot is freed between the
// engine's request and the async delivery (the AudioFileBox delete/recreate churn RecordAudio does when it
// finalizes a take), `sample_allocate` returns 0 for the now-dead handle. `drainResourceRequests` (boot.ts)
// must NOT write the frames at address 0 — that obliterated the engine's own memory and the next `render()`
// trapped with "memory access out of bounds". It must skip the delivery instead.
import {describe, expect, it} from "vitest"
import {AudioData} from "@opendaw/lib-dsp"
import type {UUID} from "@opendaw/lib-std"
import type {EngineToClient} from "@opendaw/studio-adapters"
import {drainResourceRequests} from "../../../studio/core-wasm/src/boot"
import type {EngineExports} from "../../../studio/core-wasm/src/engine-exports"

const UUID_SCRATCH = 2048 // where the mock hands out the request uuid buffer (distinct from the regions below)
const SENTINEL_AT = 0     // the address the bug wrote to
const WRITE_AT = 4096     // the pointer the mock hands out for a LIVE handle

type Calls = {allocations: Array<readonly [number, number]>, ready: Array<readonly [number, number, number, number]>}

const mockEngine = (allocResult: number, calls: Calls): EngineExports => {
    let served = false
    return {
        input_reserve: (_length: number): number => UUID_SCRATCH,
        sample_take_request: (_outPtr: number): number => served ? -1 : (served = true, 7),
        sample_allocate: (handle: number, byteLength: number): number => {
            calls.allocations.push([handle, byteLength])
            return allocResult
        },
        sample_set_ready: (handle: number, frameCount: number, channelCount: number, sampleRate: number): void => {
            calls.ready.push([handle, frameCount, channelCount, sampleRate])
        },
        soundfont_take_request: (_outPtr: number): number => -1
    } as unknown as EngineExports
}

const mockClient = (audio: AudioData): EngineToClient => ({
    fetchAudio: (_uuid: UUID.Bytes): Promise<AudioData> => Promise.resolve(audio),
    log: (_message: string): void => {}
} as unknown as EngineToClient)

const testAudio = (): AudioData => {
    const audio = AudioData.create(48000, 64, 2)
    audio.frames.forEach(frame => frame.fill(0.5))
    return audio
}

const drain = async (engine: EngineExports, memory: WebAssembly.Memory, client: EngineToClient): Promise<void> => {
    const pending = new Set<Promise<unknown>>()
    drainResourceRequests(engine, memory, client, pending, 48000, () => {})
    await Promise.all([...pending])
}

describe("boot dead-handle guard", () => {
    it("never writes at address 0 when sample_allocate returns 0 (dead handle)", async () => {
        const memory = new WebAssembly.Memory({initial: 4, maximum: 16, shared: true})
        new Uint8Array(memory.buffer, SENTINEL_AT, 256).fill(0xAB) // pre-fill where the bug wrote
        const calls: Calls = {allocations: [], ready: []}
        await drain(mockEngine(0, calls), memory, mockClient(testAudio()))
        expect(calls.allocations).toHaveLength(1) // it DID request the allocation
        expect(calls.ready, "no set_ready on a dead handle").toHaveLength(0)
        const region = new Uint8Array(memory.buffer, SENTINEL_AT, 256)
        expect(region.every(byte => byte === 0xAB), "address 0 must be untouched").toBe(true)
    })
    it("delivers normally when sample_allocate returns a live pointer", async () => {
        const memory = new WebAssembly.Memory({initial: 4, maximum: 16, shared: true})
        const calls: Calls = {allocations: [], ready: []}
        await drain(mockEngine(WRITE_AT, calls), memory, mockClient(testAudio()))
        expect(calls.ready).toEqual([[7, 64, 2, 48000]])
        const bytesPerChannel = 64 * Float32Array.BYTES_PER_ELEMENT
        const left = new Float32Array(memory.buffer, WRITE_AT, 64)
        const right = new Float32Array(memory.buffer, WRITE_AT + bytesPerChannel, 64)
        expect(left.every(sample => sample === 0.5), "channel 0 written").toBe(true)
        expect(right.every(sample => sample === 0.5), "channel 1 written").toBe(true)
    })
})
