import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {FloatArray, int, isDefined, Procedure, UUID} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {SampleLoaderState, SampleMetaData} from "@opendaw/studio-adapters"

// Riffle (20 Nov 2026): a sample that was fetched fine failed the project load because its cache write failed
const storage = vi.hoisted(() => ({
    saveError: null as unknown,
    saved: 0,
    gate: Promise.resolve() as Promise<void>
}))

vi.mock("../Workers", async () => {
    const {Communicator, Messenger} = await import("@opendaw/lib-runtime")
    const {SamplePeakWorker} = await import("@opendaw/lib-fusion")
    const name = `peaks-${Math.random()}`
    SamplePeakWorker.install(Messenger.for(new BroadcastChannel(name)))
    type Protocol = import("@opendaw/lib-fusion").SamplePeakProtocol
    const peaks = Communicator.sender<Protocol>(Messenger.for(new BroadcastChannel(name)).channel("peaks"),
        router => new class implements Protocol {
            async generateAsync(progress: Procedure<number>, shifts: Uint8Array, frames: ReadonlyArray<FloatArray>,
                                numFrames: int, numChannels: int): Promise<ArrayBufferLike> {
                return router.dispatchAndReturn(this.generateAsync, progress, shifts, frames, numFrames, numChannels)
            }
        })
    return {Workers: {Peak: peaks}}
})

vi.mock("./SampleStorage", () => ({
    SampleStorage: {
        get: () => ({
            load: async () => {throw new DOMException("not stored", "NotFoundError")},
            save: async () => {
                storage.saved++
                await storage.gate
                if (isDefined(storage.saveError)) {throw storage.saveError}
            }
        })
    }
}))

import {GlobalSampleLoaderManager} from "./GlobalSampleLoaderManager"

const meta: SampleMetaData = {name: "Kick", bpm: 120, duration: 0.02, sample_rate: 48000, origin: "openDAW"}
const audio = (): AudioData => {
    const data = AudioData.create(48000, 960, 1)
    data.frames[0].fill(0.5)
    return data
}
const settled = (manager: GlobalSampleLoaderManager, uuid: UUID.Bytes): Promise<SampleLoaderState> => {
    const loader = manager.getOrCreate(uuid)
    return new Promise(resolve => loader.subscribe(state => {
        if (state.type === "loaded" || state.type === "error") {resolve(state)}
    }))
}

describe("GlobalSampleLoaderManager when the cache write fails", () => {
    beforeEach(() => {
        storage.saveError = null
        storage.saved = 0
        storage.gate = Promise.resolve()
        vi.spyOn(console, "warn").mockImplementation(() => {})
        vi.spyOn(console, "debug").mockImplementation(() => {})
    })
    afterEach(() => vi.restoreAllMocks())

    it("keeps a fetched sample in memory when the disk is full", async () => {
        storage.saveError = new DOMException("No space available for this operation", "QuotaExceededError")
        const data = audio()
        const manager = new GlobalSampleLoaderManager({fetch: async () => [data, meta]})
        const uuid = UUID.generate()
        const state = await settled(manager, uuid)
        expect(state.type).toBe("loaded")
        const loader = manager.getOrCreate(uuid)
        expect(loader.data.unwrap()).toBe(data)
        expect(loader.peaks.nonEmpty()).toBe(true)
        expect(loader.meta.unwrap()).toEqual(meta)
        expect(storage.saved).toBe(1)
        await expect(manager.getAudioData(uuid)).resolves.toBe(data)
    })

    it("counts a sample as in use until its save is done and loads it then", async () => {
        const {promise, resolve} = Promise.withResolvers<void>()
        storage.gate = promise
        const manager = new GlobalSampleLoaderManager({fetch: async () => [audio(), meta]})
        const uuid = UUID.generate()
        const loaded = settled(manager, uuid)
        await vi.waitFor(() => expect(storage.saved).toBe(1))
        expect(manager.isInUse(uuid)).toBe(true)
        expect(manager.getOrCreate(uuid).state.type).not.toBe("loaded")
        resolve()
        expect((await loaded).type).toBe("loaded")
        await vi.waitFor(() => expect(manager.isInUse(uuid)).toBe(false))
    })

    it("keeps a fetched sample in memory when the storage is gone", async () => {
        storage.saveError = new DOMException("Storage not available (InvalidStateError: x)", "InvalidStateError")
        const manager = new GlobalSampleLoaderManager({fetch: async () => [audio(), meta]})
        expect((await settled(manager, UUID.generate())).type).toBe("loaded")
    })

    it("serves later loaders of the same sample from memory without fetching again", async () => {
        storage.saveError = new DOMException("No space", "QuotaExceededError")
        const fetch = vi.fn(async (): Promise<[AudioData, SampleMetaData]> => [audio(), meta])
        const manager = new GlobalSampleLoaderManager({fetch})
        const uuid = UUID.generate()
        const subscription = manager.register(uuid)
        await settled(manager, uuid)
        manager.invalidate(uuid)
        await settled(manager, uuid)
        expect(fetch).toHaveBeenCalledTimes(2)
        subscription.terminate()
    })

    it("still fails when the fetch itself fails, and keeps the original error as cause", async () => {
        const error = new TypeError("Failed to fetch")
        const manager = new GlobalSampleLoaderManager({fetch: async () => {throw error}})
        const uuid = UUID.generate()
        const state = await settled(manager, uuid)
        expect(state).toEqual({type: "error", reason: "Failed to fetch", cause: error})
        const rejection = await manager.getAudioData(uuid).then(() => null, (reason: unknown) => reason)
        expect(rejection).toBeInstanceOf(Error)
        expect((rejection as Error).message).toBe("Failed to fetch")
        expect((rejection as Error).cause).toBe(error)
        expect(storage.saved).toBe(0)
    })
})
