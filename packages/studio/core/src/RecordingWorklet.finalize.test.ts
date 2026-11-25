import {describe, expect, it, vi} from "vitest"
import {Procedure, RuntimeNotification, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {RenderQuantum} from "@opendaw/lib-dsp"
import type {RingBuffer} from "@opendaw/studio-adapters"
import type {SampleService} from "./samples"

// Live errors 1166/1167: Firefox passed the boot storage probe, then rejected getDirectory() when the stopped
// recording was saved. #finalize awaited the save unguarded, so the take crashed the studio.
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
const approvals: Array<RuntimeNotification.ApproveRequest> = []
RuntimeNotifier.install({
    info: request => {
        infos.push(request)
        return Promise.resolve()
    },
    approve: request => {
        approvals.push(request)
        return Promise.resolve(false)
    },
    progress: () => ({unknownProgress: () => {}, terminate: () => {}}) as unknown as RuntimeNotification.ProgressUpdater,
    notify: () => {}
} as RuntimeNotification.Notifier)

// A take that cannot be stored is gone after a reload, so it fails, and its audio is handed out to be downloaded.
describe("RecordingWorklet finalize when storage rejects the save (live errors 1166/1167)", () => {
    const record = async (onFailed: boolean) => {
        const {RecordingWorklet} = await import("./RecordingWorklet")
        const context = {sampleRate: 48000} as BaseAudioContext
        const config = {sab: new SharedArrayBuffer(8), numChunks: 1, numberOfChannels: 1, bufferSize: RenderQuantum}
        const worklet = new RecordingWorklet(context, UUID.generate(), config)
        const storageError = new Error("Storage not available (SecurityError: Security error when calling GetDirectory)")
        worklet.sampleService = {importRecording: () => Promise.reject(storageError)} as unknown as SampleService
        worklet.bpm = 120
        const saved = vi.fn()
        const failed = vi.fn()
        worklet.onSaved = saved
        if (onFailed) {worklet.onFailed = failed}
        const unhandled: Array<unknown> = []
        const onUnhandled = (reason: unknown) => {unhandled.push(reason)}
        process.on("unhandledRejection", onUnhandled)
        const settled = new Promise<void>(resolve => {
            worklet.subscribe(state => {
                if (state.type === "error") {resolve()}
            })
        })
        const append = appenders.at(-1)
        expect(append).toBeDefined()
        for (let chunk = 0; chunk < 4; chunk++) {append?.([new Float32Array(RenderQuantum).fill(0.5)])}
        worklet.limit(3 * RenderQuantum)
        await settled
        await new Promise(resolve => setTimeout(resolve, 0))
        process.off("unhandledRejection", onUnhandled)
        return {worklet, saved, failed, unhandled, storageError}
    }
    it("fails the take without crashing and hands the error and the audio to onFailed", async () => {
        infos.length = 0
        approvals.length = 0
        const {worklet, saved, failed, unhandled, storageError} = await record(true)
        expect(unhandled.map(String)).toEqual([])
        expect(worklet.state).toMatchObject({type: "error", cause: storageError})
        expect(worklet.data.isEmpty()).toBe(true)
        expect(saved).not.toHaveBeenCalled()
        expect(failed).toHaveBeenCalledOnce()
        const [{error, audio}] = failed.mock.calls[0]
        expect(error).toBe(storageError)
        expect(audio.numberOfFrames).toBe(3 * RenderQuantum)
        expect(audio.frames[0].every((value: number) => value === 0.5)).toBe(true)
        expect(infos.length).toBe(0)
        expect(approvals.length).toBe(0)
    })
    it("offers the take as a download itself when nobody listens to onFailed", async () => {
        infos.length = 0
        approvals.length = 0
        const {saved, unhandled} = await record(false)
        expect(unhandled.map(String)).toEqual([])
        expect(saved).not.toHaveBeenCalled()
        expect(approvals.length).toBe(1)
        expect(approvals[0]).toMatchObject({headline: "Recording Not Saved", approveText: "Download WAV", cancelText: "Discard"})
        expect(approvals[0].message).toContain("GetDirectory")
    })
})
