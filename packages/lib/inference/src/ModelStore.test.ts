import {beforeEach, describe, expect, it, vi} from "vitest"
import {OpfsProtocol} from "@opendaw/lib-fusion"
import {installInferenceConfig} from "./InferenceConfig"
import {ModelStore} from "./ModelStore"
import {ModelDescriptor} from "./Task"

class FakeOpfs implements OpfsProtocol {
    readonly files = new Map<string, Uint8Array>()
    async write(path: string, data: Uint8Array): Promise<void> {this.files.set(path, data)}
    async read(path: string): Promise<Uint8Array> {
        const data = this.files.get(path)
        if (data === undefined) {throw new Error(`No such file: ${path}`)}
        return data
    }
    async exists(path: string): Promise<boolean> {return this.files.has(path)}
    async delete(path: string): Promise<void> {
        for (const key of [...this.files.keys()]) {
            if (key === path || key.startsWith(`${path}/`)) {this.files.delete(key)}
        }
    }
    async list(): Promise<ReadonlyArray<OpfsProtocol.Entry>> {return []}
}

const sha256OfBytes = async (bytes: Uint8Array): Promise<string> => {
    const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
    return Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("")
}

const makeFetchResponse = (bytes: Uint8Array, opts?: {ok?: boolean, status?: number, contentLength?: number}) => {
    const headers = new Headers()
    headers.set("Content-Length", String(opts?.contentLength ?? bytes.length))
    return {
        ok: opts?.ok ?? true,
        status: opts?.status ?? 200,
        statusText: opts?.status === 200 || opts?.status === undefined ? "OK" : "Bad",
        headers,
        body: new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(bytes)
                controller.close()
            }
        })
    } as unknown as Response
}

describe("ModelStore", () => {
    let opfs: FakeOpfs
    let bytes: Uint8Array
    let model: ModelDescriptor

    beforeEach(async () => {
        opfs = new FakeOpfs()
        installInferenceConfig({opfs})
        bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
        const sha = await sha256OfBytes(bytes)
        model = {
            url: "https://example.com/test.onnx",
            sha256: sha,
            bytes: bytes.length,
            version: "v1"
        }
    })

    it("downloads, verifies, and caches a model on first call", async () => {
        const fetchMock = vi.fn(async () => makeFetchResponse(bytes))
        vi.stubGlobal("fetch", fetchMock)
        const result = await ModelStore.ensure("test-task", model)
        expect(result).toEqual(bytes)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(opfs.files.has("inference/models/test-task/v1/model.onnx")).toBe(true)
        expect(opfs.files.has("inference/models/test-task/v1/meta.json")).toBe(true)
    })

    it("reads from cache on second call", async () => {
        const fetchMock = vi.fn(async () => makeFetchResponse(bytes))
        vi.stubGlobal("fetch", fetchMock)
        await ModelStore.ensure("test-task", model)
        const second = await ModelStore.ensure("test-task", model)
        expect(second).toEqual(bytes)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it("never fetches without approval, including if a probed cache entry disappears", async () => {
        const fetchMock = vi.fn(async () => makeFetchResponse(bytes))
        vi.stubGlobal("fetch", fetchMock)
        await expect(ModelStore.ensure("test-task", model, {allowDownload: false})).rejects.toThrow(/confirmation/)
        expect(fetchMock).not.toHaveBeenCalled()
        await ModelStore.ensure("test-task", model)
        expect(await ModelStore.isCached("test-task", model)).toBe(true)
        expect(await ModelStore.ensure("test-task", model, {allowDownload: false})).toEqual(bytes)
        opfs.files.delete("inference/models/test-task/v1/model.onnx")
        await expect(ModelStore.ensure("test-task", model, {allowDownload: false})).rejects.toThrow(/confirmation/)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it("re-downloads when sha256 in meta does not match", async () => {
        const fetchMock = vi.fn(async () => makeFetchResponse(bytes))
        vi.stubGlobal("fetch", fetchMock)
        await ModelStore.ensure("test-task", model)
        const newModel: ModelDescriptor = {...model, sha256: "0".repeat(64)}
        await expect(ModelStore.ensure("test-task", newModel)).rejects.toThrow(/SHA-256 mismatch/)
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it("rejects if downloaded bytes do not match expected sha256", async () => {
        const wrongModel: ModelDescriptor = {...model, sha256: "0".repeat(64)}
        const fetchMock = vi.fn(async () => makeFetchResponse(bytes))
        vi.stubGlobal("fetch", fetchMock)
        await expect(ModelStore.ensure("test-task", wrongModel)).rejects.toThrow(/SHA-256 mismatch/)
        expect(opfs.files.has("inference/models/test-task/v1/model.onnx")).toBe(false)
    })

    it("rejects on non-OK response", async () => {
        vi.stubGlobal("fetch", vi.fn(async () =>
            makeFetchResponse(new Uint8Array(0), {ok: false, status: 404})))
        await expect(ModelStore.ensure("test-task", model)).rejects.toThrow(/Model fetch failed/)
    })

    it("reports progress during download", async () => {
        const progress: Array<number> = []
        vi.stubGlobal("fetch", vi.fn(async () => makeFetchResponse(bytes)))
        await ModelStore.ensure("test-task", model, {progress: value => progress.push(value)})
        expect(progress.length).toBeGreaterThan(0)
        expect(progress[progress.length - 1]).toBeCloseTo(1.0, 5)
    })

    it("emits progress(1.0) on cache hit without fetching", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => makeFetchResponse(bytes)))
        await ModelStore.ensure("test-task", model)
        const fetchMock2 = vi.fn(async () => makeFetchResponse(bytes))
        vi.stubGlobal("fetch", fetchMock2)
        const progress: Array<number> = []
        await ModelStore.ensure("test-task", model, {progress: value => progress.push(value)})
        expect(progress).toEqual([1.0])
        expect(fetchMock2).not.toHaveBeenCalled()
    })

    it("evicts a specific version", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => makeFetchResponse(bytes)))
        await ModelStore.ensure("test-task", model)
        await ModelStore.evict("test-task", "v1")
        expect(opfs.files.has("inference/models/test-task/v1/model.onnx")).toBe(false)
    })

    it("evicts all versions of a task", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => makeFetchResponse(bytes)))
        await ModelStore.ensure("test-task", model)
        await ModelStore.evict("test-task")
        expect([...opfs.files.keys()].some(k => k.startsWith("inference/models/test-task"))).toBe(false)
    })

    it("treats different model versions as separate cache entries", async () => {
        const fetchMock = vi.fn(async () => makeFetchResponse(bytes))
        vi.stubGlobal("fetch", fetchMock)
        await ModelStore.ensure("test-task", model)
        const v2: ModelDescriptor = {...model, version: "v2"}
        await ModelStore.ensure("test-task", v2)
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(opfs.files.has("inference/models/test-task/v1/model.onnx")).toBe(true)
        expect(opfs.files.has("inference/models/test-task/v2/model.onnx")).toBe(true)
    })
})
