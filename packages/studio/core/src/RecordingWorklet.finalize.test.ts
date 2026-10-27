import {describe, expect, it, vi} from "vitest"
import {Procedure, RuntimeNotification, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {RenderQuantum} from "@opendaw/lib-dsp"
import type {RingBuffer} from "@opendaw/studio-adapters"
import type {SampleService} from "./samples"

// Live errors 1166/1167: Firefox passed the boot storage probe, then rejected getDirectory() when the stopped
// recording was saved. #finalize awaited the save unguarded, so the take crashed the studio instead of staying.
const appenders: Array<Procedure<Array<Float32Array>>> = []
vi.mock("@opendaw/studio-adapters", async importOriginal => {
    const original = await importOriginal<typeof import("@opendaw/studio-adapters")>()
    return {
        ...original,
        RingBuffer: {
            ...original.RingBuffer,
            reader: (_config: RingBuffer.Config, append: Procedure<Array<Float32Array>>): RingBuffer.Reader => {
                appenders.push(append)
                return {stop: () => {}}
            }
        }
    }
})

Reflect.set(globalThis, "AudioWorkletNode", class {
    readonly port: MessagePort = new MessageChannel().port1
    readonly context: BaseAudioContext
    readonly channelCount: number
    constructor(context: BaseAudioContext, _name: string, options: AudioWorkletNodeOptions) {
        this.context = context
        this.channelCount = options.channelCount ?? 1
    }
})

const infos: Array<RuntimeNotification.InfoRequest> = []
RuntimeNotifier.install({
    info: request => {
        infos.push(request)
        return Promise.resolve()
    },
    approve: () => Promise.resolve(true),
    progress: () => ({unknownProgress: () => {}, terminate: () => {}}) as unknown as RuntimeNotification.ProgressUpdater,
    notify: () => {}
} as RuntimeNotification.Notifier)

describe("RecordingWorklet finalize when storage rejects the save (live errors 1166/1167)", () => {
    it("keeps the take loaded in memory and tells the user instead of crashing", async () => {
        const {RecordingWorklet} = await import("./RecordingWorklet")
        const context = {sampleRate: 48000} as BaseAudioContext
        const config = {sab: new SharedArrayBuffer(8), numChunks: 1, numberOfChannels: 1, bufferSize: RenderQuantum}
        const worklet = new RecordingWorklet(context, UUID.generate(), config)
        const storageError = new Error("Storage not available (SecurityError: Security error when calling GetDirectory)")
        worklet.sampleService = {importRecording: () => Promise.reject(storageError)} as unknown as SampleService
        worklet.bpm = 120
        const saved = vi.fn()
        worklet.onSaved = saved
        const unhandled: Array<unknown> = []
        const settled = new Promise<void>(resolve => {
            worklet.subscribe(state => {
                if (state.type === "loaded") {resolve()}
            })
            process.on("unhandledRejection", onUnhandled)
            function onUnhandled(reason: unknown) {
                unhandled.push(reason)
                resolve()
            }
        })
        const append = appenders.at(-1)
        expect(append).toBeDefined()
        for (let chunk = 0; chunk < 4; chunk++) {append?.([new Float32Array(RenderQuantum).fill(0.5)])}
        worklet.limit(3 * RenderQuantum)
        await settled
        await new Promise(resolve => setTimeout(resolve, 0))
        process.removeAllListeners("unhandledRejection")
        expect(unhandled.map(String)).toEqual([])
        expect(worklet.state.type).toBe("loaded")
        expect(worklet.data.unwrap("data").numberOfFrames).toBe(3 * RenderQuantum)
        expect(worklet.peaks.nonEmpty()).toBe(true)
        expect(worklet.meta.unwrap("meta")).toMatchObject({
            name: "Recording", bpm: 120, sample_rate: 48000, duration: 3 * RenderQuantum / 48000, origin: "recording"
        })
        expect(saved).toHaveBeenCalledOnce()
        expect(infos.length).toBe(1)
        expect(infos[0].headline).toBe("Storage Unavailable")
        expect(infos[0].message).toContain("GetDirectory")
    })
})
