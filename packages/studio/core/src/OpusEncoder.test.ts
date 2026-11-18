import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {Errors, Procedure} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {OpusEncoder} from "./OpusEncoder"

const muxer = vi.hoisted(() => ({packets: 0}))

vi.mock("mediabunny", () => ({
    BufferTarget: class {buffer = new ArrayBuffer(4)},
    OggOutputFormat: class {},
    Output: class {
        addAudioTrack(): void {}
        async start(): Promise<void> {}
        async finalize(): Promise<void> {}
    },
    EncodedAudioPacketSource: class {
        async add(): Promise<void> {muxer.packets++}
    },
    EncodedPacket: {fromEncodedChunk: (chunk: unknown) => chunk}
}))

class FakeAudioData {
    readonly numberOfFrames: number
    constructor(init: { numberOfFrames: number }) {this.numberOfFrames = init.numberOfFrames}
    close(): void {}
}

type EncoderInit = { output: (chunk: unknown, meta: unknown) => void, error: Procedure<unknown> }

// Takes one queued block a millisecond after each encode, like a busy encoder working through its queue.
class FakeEncoder extends EventTarget {
    static instances: Array<FakeEncoder> = []
    static firesDequeue = true
    static drains = true
    state: "unconfigured" | "configured" | "closed" = "unconfigured"
    maxQueued = 0
    readonly #init: EncoderInit
    readonly #queue: Array<FakeAudioData> = []
    readonly #flushes: Array<{ resolve: () => void, reject: Procedure<unknown> }> = []
    constructor(init: EncoderInit) {
        super()
        this.#init = init
        FakeEncoder.instances.push(this)
    }
    get encodeQueueSize(): number {return this.#queue.length}
    configure(): void {this.state = "configured"}
    encode(block: FakeAudioData): void {
        this.#queue.push(block)
        this.maxQueued = Math.max(this.maxQueued, this.#queue.length)
        if (FakeEncoder.drains) {setTimeout(() => this.#takeOne(), 1)}
    }
    flush(): Promise<void> {
        if (this.#queue.length === 0) {return Promise.resolve()}
        return new Promise((resolve, reject) => this.#flushes.push({resolve, reject}))
    }
    close(): void {
        this.state = "closed"
        this.#flushes.splice(0).forEach(({reject}) => reject(new DOMException("Aborted due to close()", "AbortError")))
    }
    #takeOne(): void {
        if (this.state === "closed") {return}
        this.#queue.shift()
        this.#init.output({byteLength: 1}, undefined)
        if (FakeEncoder.firesDequeue) {this.dispatchEvent(new Event("dequeue"))}
        if (this.#queue.length === 0) {this.#flushes.splice(0).forEach(({resolve}) => resolve())}
    }
}

const settings: OpusEncoder.Settings = {
    numberOfChannels: 1, bitrate: 24, complexity: 10, frameDuration: 20_000, variable: true, application: "audio"
}

const render = (seconds: number, sampleRate: number = OpusEncoder.SampleRate): AudioData =>
    AudioData.create(sampleRate, Math.round(seconds * sampleRate), 2)

const settle = (millis: number) => new Promise(resolve => setTimeout(resolve, millis))

describe("OpusEncoder", () => {
    beforeEach(() => {
        FakeEncoder.instances = []
        FakeEncoder.firesDequeue = true
        FakeEncoder.drains = true
        muxer.packets = 0
        vi.stubGlobal("AudioEncoder", FakeEncoder)
        vi.stubGlobal("AudioData", FakeAudioData)
    })
    afterEach(() => vi.unstubAllGlobals())
    it("is not supported without WebCodecs", async () => {
        vi.unstubAllGlobals()
        expect(await OpusEncoder.isSupported(settings)).toBe(false)
    })
    it("encodes every one-second block and muxes every packet", async () => {
        const ogg = await OpusEncoder.encode(render(5), settings)
        expect(ogg.byteLength).toBe(4)
        expect(muxer.packets).toBe(5)
        expect(FakeEncoder.instances[0].state).toBe("closed")
    })
    it("keeps at most four blocks waiting in the encoder", async () => {
        await OpusEncoder.encode(render(12), settings)
        // Without the cap all twelve blocks are queued at once.
        expect(FakeEncoder.instances[0].maxQueued).toBeLessThanOrEqual(4)
        expect(muxer.packets).toBe(12)
    })
    it("keeps feeding an encoder that never fires dequeue", async () => {
        FakeEncoder.firesDequeue = false
        await OpusEncoder.encode(render(8), settings)
        expect(FakeEncoder.instances[0].maxQueued).toBeLessThanOrEqual(4)
        expect(muxer.packets).toBe(8)
    })
    it("stops a pending flush on abort and closes the encoder", async () => {
        FakeEncoder.drains = false
        const controller = new AbortController()
        const encoding = OpusEncoder.encode(render(2), settings, undefined, controller.signal)
        await settle(5)
        controller.abort()
        await expect(encoding).rejects.toBe(Errors.AbortError)
        expect(FakeEncoder.instances[0].state).toBe("closed")
        expect(muxer.packets).toBe(0)
    })
    it("stops while waiting for the encoder to take queued blocks", async () => {
        FakeEncoder.drains = false
        const controller = new AbortController()
        const encoding = OpusEncoder.encode(render(8), settings, undefined, controller.signal)
        await settle(5)
        expect(FakeEncoder.instances[0].encodeQueueSize).toBe(4)
        controller.abort()
        await expect(encoding).rejects.toBe(Errors.AbortError)
        expect(FakeEncoder.instances[0].state).toBe("closed")
    })
    it("refuses a signal that is already aborted", async () => {
        const controller = new AbortController()
        controller.abort()
        await expect(OpusEncoder.encode(render(1), settings, undefined, controller.signal)).rejects.toBe(Errors.AbortError)
        expect(FakeEncoder.instances).toHaveLength(0)
    })
    it("refuses audio that is not 48 kHz instead of mislabelling it", async () => {
        await expect(OpusEncoder.encode(render(1, 44_100), settings)).rejects.toThrow("got 44100 Hz")
    })
})
