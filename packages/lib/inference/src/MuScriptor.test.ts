import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {MuScriptor} from "./MuScriptor"
import {ModelStore} from "./ModelStore"
import {MUSCRIPTOR_ASSETS} from "./muscriptor/Model"

class TestWorker extends EventTarget {
    readonly terminate = vi.fn()
    readonly postMessage = vi.fn()
    respond(data: unknown): void {this.dispatchEvent(new MessageEvent("message", {data}))}
}
const input = {channels: [new Float32Array(16000)], sampleRate: 16000, start: 0, end: 1}

describe("MuScriptor worker lifecycle", () => {
    beforeEach(() => {
        vi.stubGlobal("navigator", {gpu: {requestAdapter: async () => ({features: new Set(["shader-f16"])})}})
        vi.spyOn(ModelStore, "isCached").mockResolvedValue(false)
        vi.spyOn(ModelStore, "ensure").mockImplementation(async (_key, _model, options) => {
            options?.progress?.(1)
            return new Uint8Array([1, 2, 3])
        })
    })
    afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals()})

    it("reports missing asset bytes without fetching weights", async () => {
        expect(await MuScriptor.requiredDownloadBytes()).toBe(616274526)
        vi.mocked(ModelStore.isCached).mockImplementation(async key => !key.endsWith("model.onnx.data"))
        expect(await MuScriptor.requiredDownloadBytes()).toBe(MUSCRIPTOR_ASSETS["model.onnx.data"].bytes)
        vi.mocked(ModelStore.isCached).mockResolvedValue(true)
        expect(await MuScriptor.requiredDownloadBytes()).toBe(0)
        expect(ModelStore.ensure).not.toHaveBeenCalled()
    })

    it("uses cache-only model reads when no download was approved", async () => {
        vi.mocked(ModelStore.isCached).mockResolvedValue(true)
        const worker = new TestWorker()
        const result = MuScriptor.run(input, {allowDownload: false, signal: new AbortController().signal, progress() {},
            workerFactory: () => worker as unknown as Worker})
        await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce())
        worker.respond({kind: "result", notes: []})
        await result
        expect(vi.mocked(ModelStore.ensure).mock.calls.every(([, , options]) => options?.allowDownload === false)).toBe(true)
    })

    it("rejects unsupported GPUs before downloading weights", async () => {
        vi.stubGlobal("navigator", {})
        await expect(MuScriptor.run(input, {allowDownload: true, signal: new AbortController().signal, progress() {}})).rejects.toThrow(/FP16/)
        expect(ModelStore.ensure).not.toHaveBeenCalled()
    })
    it("returns notes and releases the dedicated worker on success", async () => {
        const worker = new TestWorker(), progress = vi.fn()
        const result = MuScriptor.run(input, {allowDownload: true, signal: new AbortController().signal, progress,
            workerFactory: () => worker as unknown as Worker})
        await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce())
        worker.respond({kind: "result", notes: []})
        expect(await result).toEqual([])
        expect(worker.terminate).toHaveBeenCalledOnce()
        expect(ModelStore.ensure).toHaveBeenCalledTimes(4)
        expect(progress.mock.calls.at(-1)?.[0]).toEqual({phase: "download", value: 1})
    })
    it("cancellation terminates an in-flight GPU worker immediately", async () => {
        const worker = new TestWorker(), controller = new AbortController()
        const result = MuScriptor.run(input, {allowDownload: true, signal: controller.signal, progress() {},
            workerFactory: () => worker as unknown as Worker})
        await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce())
        const rejected = expect(result).rejects.toThrow()
        controller.abort()
        await rejected
        expect(worker.terminate).toHaveBeenCalledOnce()
    })
    it("identifies cached model loading without calling it a download", async () => {
        vi.mocked(ModelStore.isCached).mockResolvedValue(true)
        const worker = new TestWorker(), progress = vi.fn()
        const result = MuScriptor.run(input, {allowDownload: true, signal: new AbortController().signal, progress,
            workerFactory: () => worker as unknown as Worker})
        await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce())
        worker.respond({kind: "result", notes: []})
        await result
        expect(progress.mock.calls.at(-1)?.[0]).toEqual({phase: "cache", value: 1})
    })
    it("releases the worker on model errors without fabricating a result", async () => {
        const worker = new TestWorker()
        const result = MuScriptor.run(input, {allowDownload: true, signal: new AbortController().signal, progress() {},
            workerFactory: () => worker as unknown as Worker})
        await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce())
        worker.respond({kind: "error", message: "GPU memory exhausted"})
        await expect(result).rejects.toThrow("GPU memory exhausted")
        expect(worker.terminate).toHaveBeenCalledOnce()
    })
    it("cancellation while downloading never starts a GPU worker", async () => {
        const controller = new AbortController(), factory = vi.fn()
        vi.mocked(ModelStore.ensure).mockImplementation(async () => {controller.abort(); return new Uint8Array(1)})
        await expect(MuScriptor.run(input, {allowDownload: true, signal: controller.signal, progress() {}, workerFactory: factory})).rejects.toThrow()
        expect(factory).not.toHaveBeenCalled()
    })
})
