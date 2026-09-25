import {beforeEach, describe, expect, it, vi} from "vitest"
import {Option} from "@opendaw/lib-std"
import {OpfsProtocol} from "@opendaw/lib-fusion"
import {installInferenceConfig} from "./InferenceConfig"
import {EngineHost, splitProgress} from "./EngineHost"
import {MainToWorker, WorkerToMain} from "./workers/protocol"
import {tensor} from "./Tensor"

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

class FakeWorker {
    readonly #listeners = new Map<string, Set<(event: Event) => void>>()
    readonly received: Array<MainToWorker> = []
    #readyEmitted = false

    addEventListener(type: string, listener: (event: Event) => void): void {
        let set = this.#listeners.get(type)
        if (set === undefined) {set = new Set(); this.#listeners.set(type, set)}
        set.add(listener)
        if (type === "message" && !this.#readyEmitted) {
            this.#readyEmitted = true
            queueMicrotask(() => this.emit({kind: "ready"}))
        }
    }

    removeEventListener(type: string, listener: (event: Event) => void): void {
        this.#listeners.get(type)?.delete(listener)
    }

    postMessage(message: MainToWorker): void {
        this.received.push(message)
        // Auto-respond on next microtask
        queueMicrotask(() => {
            const response = this.respondTo(message)
            if (response !== undefined) {this.emit(response)}
        })
    }

    terminate(): void {this.#listeners.clear()}

    emit(message: WorkerToMain): void {
        const event = new MessageEvent<WorkerToMain>("message", {data: message})
        const listeners = this.#listeners.get("message")
        if (listeners === undefined) {return}
        for (const listener of [...listeners]) {listener(event)}
    }

    emitError(message: string): void {
        // ErrorEvent isn't a Node global; a plain object is all EngineHost reads from it.
        const event = {message} as unknown as Event
        const listeners = this.#listeners.get("error")
        if (listeners === undefined) {return}
        for (const listener of [...listeners]) {listener(event)}
    }

    respondTo(message: MainToWorker): WorkerToMain | undefined {
        switch (message.kind) {
            case "load":     return {kind: "loaded", id: message.id, inputs: ["mix"], outputs: ["drums", "bass", "other", "vocals"]}
            case "release":  return {kind: "ok", id: message.id}
            case "shutdown": return {kind: "ok", id: message.id}
            case "run":      return {
                kind: "result",
                id: message.id,
                output: {result: tensor("float32", new Float32Array([42]), [1])}
            }
        }
    }
}

const validSha = "0".repeat(64)
const oneByteWithKnownSha = async (): Promise<{bytes: Uint8Array, sha: string}> => {
    const bytes = new Uint8Array([1])
    const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
    const sha = Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("")
    return {bytes, sha}
}

describe("EngineHost", () => {
    let opfs: FakeOpfs

    beforeEach(() => {
        opfs = new FakeOpfs()
        installInferenceConfig({opfs})
    })

    const makeHost = (worker: FakeWorker = new FakeWorker()): {host: EngineHost, worker: FakeWorker} => {
        const host = new EngineHost({workerFactory: () => worker as unknown as Worker})
        return {host, worker}
    }

    it("loads a model and forwards bytes to the worker", async () => {
        const {bytes, sha} = await oneByteWithKnownSha()
        opfs.files.set("inference/models/t/v1/model.onnx", bytes)
        opfs.files.set("inference/models/t/v1/meta.json",
            new TextEncoder().encode(JSON.stringify({
                sha256: sha, bytes: 1, version: "v1", downloadedAt: 0
            })))
        const {host, worker} = makeHost()
        await host.ensureLoaded("t", {
            url: "https://example.com/m.onnx", sha256: sha, bytes: 1, version: "v1"
        }, [])
        const loadMessage = worker.received.find(message => message.kind === "load")
        expect(loadMessage).toBeDefined()
        expect(loadMessage?.kind === "load" && loadMessage.taskKey === "t").toBe(true)
    })

    it("queues run calls FIFO", async () => {
        const {bytes, sha} = await oneByteWithKnownSha()
        opfs.files.set("inference/models/t/v1/model.onnx", bytes)
        opfs.files.set("inference/models/t/v1/meta.json",
            new TextEncoder().encode(JSON.stringify({
                sha256: sha, bytes: 1, version: "v1", downloadedAt: 0
            })))
        const {host} = makeHost()
        await host.ensureLoaded("t", {
            url: "https://example.com/m.onnx", sha256: sha, bytes: 1, version: "v1"
        }, [])
        const order: Array<number> = []
        const work = (label: number, delay: number) =>
            host.enqueue(async () => {
                order.push(label)
                await new Promise(resolve => setTimeout(resolve, delay))
                return label
            })
        const results = await Promise.all([work(1, 5), work(2, 1), work(3, 1)])
        expect(results).toEqual([1, 2, 3])
        expect(order).toEqual([1, 2, 3])
    })

    it("propagates errors from the worker as rejections", async () => {
        const worker = new FakeWorker()
        worker.respondTo = (message: MainToWorker) =>
            ({kind: "error", id: message.id, message: "boom"})
        const {host} = makeHost(worker)
        const {bytes, sha} = await oneByteWithKnownSha()
        opfs.files.set("inference/models/t/v1/model.onnx", bytes)
        opfs.files.set("inference/models/t/v1/meta.json",
            new TextEncoder().encode(JSON.stringify({
                sha256: sha, bytes: 1, version: "v1", downloadedAt: 0
            })))
        await expect(host.ensureLoaded("t", {
            url: "https://example.com/m.onnx", sha256: sha, bytes: 1, version: "v1"
        }, [])).rejects.toThrow(/boom/)
    })

    it("aborts ensureLoaded when signal is already aborted", async () => {
        const {bytes, sha} = await oneByteWithKnownSha()
        opfs.files.set("inference/models/t/v1/model.onnx", bytes)
        opfs.files.set("inference/models/t/v1/meta.json",
            new TextEncoder().encode(JSON.stringify({
                sha256: sha, bytes: 1, version: "v1", downloadedAt: 0
            })))
        const {host} = makeHost()
        const controller = new AbortController()
        controller.abort()
        await expect(host.ensureLoaded(
            "t",
            {url: "https://example.com/m.onnx", sha256: sha, bytes: 1, version: "v1"},
            [],
            {signal: controller.signal}
        )).rejects.toThrow()
    })

    it("shutdown terminates the worker and clears state", async () => {
        const {bytes, sha} = await oneByteWithKnownSha()
        opfs.files.set("inference/models/t/v1/model.onnx", bytes)
        opfs.files.set("inference/models/t/v1/meta.json",
            new TextEncoder().encode(JSON.stringify({
                sha256: sha, bytes: 1, version: "v1", downloadedAt: 0
            })))
        const {host, worker} = makeHost()
        const terminateSpy = vi.spyOn(worker, "terminate")
        await host.ensureLoaded("t", {
            url: "https://example.com/m.onnx", sha256: sha, bytes: 1, version: "v1"
        }, [])
        await host.shutdown()
        expect(terminateSpy).toHaveBeenCalled()
    })

    it("rejects in-flight calls when the worker crashes instead of hanging forever", async () => {
        const worker = new FakeWorker()
        const originalRespondTo = worker.respondTo.bind(worker)
        worker.respondTo = message => message.kind === "run" ? undefined : originalRespondTo(message)
        const {host} = makeHost(worker)
        const {bytes, sha} = await oneByteWithKnownSha()
        opfs.files.set("inference/models/t/v1/model.onnx", bytes)
        opfs.files.set("inference/models/t/v1/meta.json",
            new TextEncoder().encode(JSON.stringify({
                sha256: sha, bytes: 1, version: "v1", downloadedAt: 0
            })))
        await host.ensureLoaded("t", {
            url: "https://example.com/m.onnx", sha256: sha, bytes: 1, version: "v1"
        }, [])
        const run = host.sessionRunFor("t", Option.None)
        const pending = run({})
        await Promise.resolve() // let #dispatch register the call and post it before crashing
        worker.emitError("boom")
        await expect(pending).rejects.toThrow(/crashed/)
    })

    it("respawns a worker after a crash instead of hanging forever", async () => {
        const workers: Array<FakeWorker> = []
        const host = new EngineHost({
            workerFactory: () => {
                const worker = new FakeWorker()
                workers.push(worker)
                return worker as unknown as Worker
            }
        })
        const {bytes, sha} = await oneByteWithKnownSha()
        opfs.files.set("inference/models/t/v1/model.onnx", bytes)
        opfs.files.set("inference/models/t/v1/meta.json",
            new TextEncoder().encode(JSON.stringify({
                sha256: sha, bytes: 1, version: "v1", downloadedAt: 0
            })))
        await host.ensureLoaded("t", {
            url: "https://example.com/m.onnx", sha256: sha, bytes: 1, version: "v1"
        }, [])
        expect(workers).toHaveLength(1)
        workers[0].emitError("boom")
        await expect(host.ensureLoaded("t", {
            url: "https://example.com/m.onnx", sha256: sha, bytes: 1, version: "v1"
        }, [])).resolves.toBeUndefined()
        expect(workers).toHaveLength(2)
    })
})

describe("splitProgress", () => {
    it("scales download into 0..share and inference into share..1", () => {
        const seen: Array<number> = []
        const {download, inference} = splitProgress(value => seen.push(value), 0.5)
        download(0)
        download(1)
        inference(0)
        inference(1)
        expect(seen).toEqual([0, 0.5, 0.5, 1])
    })

    it("uses a no-op when overall is undefined", () => {
        const {download, inference} = splitProgress(undefined, 0.5)
        // should not throw
        download(0.5)
        inference(0.5)
    })

    it("supports asymmetric splits", () => {
        const seen: Array<number> = []
        const {download, inference} = splitProgress(value => seen.push(value), 0.2)
        download(1.0)
        inference(0.5)
        expect(seen[0]).toBeCloseTo(0.2)
        expect(seen[1]).toBeCloseTo(0.6)
    })
})
