import {afterEach, beforeEach, describe, expect, it} from "vitest"
import {OpfsProtocol} from "@opendaw/lib-fusion"
import {installInferenceConfig} from "./InferenceConfig"
import {Inference} from "./Inference"
import {TaskDefinition} from "./Task"
import {TaskRegistry} from "./registry"
import {TempoDetectionInput, TempoDetectionOutput} from "./tasks/TempoDetectionTask"
import {MainToWorker, WorkerToMain} from "./workers/protocol"

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

    respondTo(message: MainToWorker): WorkerToMain | undefined {
        switch (message.kind) {
            case "load":     return {kind: "loaded", id: message.id, inputs: ["mix"], outputs: ["bpm"]}
            case "release":  return {kind: "ok", id: message.id}
            case "shutdown": return {kind: "ok", id: message.id}
            case "run":      return undefined // the regression test controls "run" responses manually
        }
    }
}

const oneByteWithKnownSha = async (): Promise<{bytes: Uint8Array, sha: string}> => {
    const bytes = new Uint8Array([1])
    const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
    const sha = Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("")
    return {bytes, sha}
}

const registryBackdoor = TaskRegistry as Record<string, TaskDefinition<TempoDetectionInput, TempoDetectionOutput>>
const originalTempoTask = registryBackdoor["tempo-detection"]

describe("Inference", () => {
    let opfs: FakeOpfs
    let worker: FakeWorker

    beforeEach(async () => {
        opfs = new FakeOpfs()
        installInferenceConfig({opfs})
        worker = new FakeWorker()
        const {bytes, sha} = await oneByteWithKnownSha()
        opfs.files.set("inference/models/tempo-detection/v1/model.onnx", bytes)
        opfs.files.set("inference/models/tempo-detection/v1/meta.json",
            new TextEncoder().encode(JSON.stringify({sha256: sha, bytes: 1, version: "v1", downloadedAt: 0})))
        registryBackdoor["tempo-detection"] = {
            key: "tempo-detection",
            model: {url: "https://example.com/m.onnx", sha256: sha, bytes: 1, version: "v1"},
            executionProviders: ["wasm"],
            run: async (_input, env) => {
                await env.session({})
                return {bpm: 120, confidence: 1, topCandidates: []}
            }
        }
        Inference.install({opfs, workerFactory: () => worker as unknown as Worker})
    })

    afterEach(() => {
        registryBackdoor["tempo-detection"] = originalTempoTask
    })

    it("defers a provider reload until an in-flight run of that task finishes", async () => {
        await Inference.preload("tempo-detection", {executionProvider: "wasm"})
        const runPromise = Inference.run("tempo-detection", {audio: new Float32Array(0), sampleRate: 11025})
        await new Promise(resolve => setTimeout(resolve, 0))
        const runMessages = worker.received.filter(message => message.kind === "run")
        expect(runMessages).toHaveLength(1)

        const preloadPromise = Inference.preload("tempo-detection", {executionProvider: "webgpu"})
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(worker.received.filter(message => message.kind === "release")).toHaveLength(0)

        worker.emit({kind: "result", id: runMessages[0].id, output: {}})
        await expect(runPromise).resolves.toEqual({bpm: 120, confidence: 1, topCandidates: []})
        await preloadPromise
        expect(worker.received.filter(message => message.kind === "release")).toHaveLength(1)
        expect(worker.received.filter(message => message.kind === "load")).toHaveLength(2)
    })

    it("acquire() with a matching executionProvider reuses an already-preloaded session", async () => {
        await Inference.preload("tempo-detection", {executionProvider: "webgpu"})
        const handle = await Inference.acquire("tempo-detection", {executionProvider: "webgpu"})
        expect(worker.received.filter(message => message.kind === "load")).toHaveLength(1)
        expect(worker.received.filter(message => message.kind === "release")).toHaveLength(0)
        handle.terminate()
    })
})
