import {readFileSync} from "fs"
import {describe, expect, it} from "vitest"
import {WasmProtocol} from "./WasmProtocol"
import {WasmRuntime} from "./WasmRuntime"
import {WasmWorker} from "./WasmWorker"

const fixture = readFileSync(new URL("./fixture/test-module.b64", import.meta.url), "utf8")
const testModule = new WebAssembly.Module(Buffer.from(fixture, "base64"))
// the smallest valid module: no memory, no alloc
const emptyModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))

// the worker side runs in this thread behind a MessageChannel, every endpoint created is counted
const inProcess = () => {
    let created = 0
    const factory: WasmProtocol.EndpointFactory = receive => {
        created++
        const channel = new MessageChannel()
        new WasmRuntime({
            post: (message, transfer) => channel.port2.postMessage(message, transfer),
            listen: listener => channel.port2.onmessage = (event: MessageEvent<WasmProtocol.ToWorker>) =>
                listener(event.data)
        })
        channel.port1.onmessage = (event: MessageEvent<WasmProtocol.FromWorker>) => receive(event.data)
        return {
            send: (message, transfer) => channel.port1.postMessage(message, transfer),
            terminate: () => {
                channel.port1.close()
                channel.port2.close()
            }
        }
    }
    return {factory, created: () => created}
}

const create = (module: WebAssembly.Module = testModule) => {
    const endpoint = inProcess()
    const worker = WasmWorker.create({name: "test", module, endpoint: endpoint.factory})
    return {worker, created: endpoint.created}
}

const bytes = (...values: Array<number>): ArrayBuffer => new Uint8Array(values).buffer
const count = (worker: WasmWorker, options: Partial<WasmWorker.CallOptions> = {}): Promise<number> =>
    worker.call("count", new ArrayBuffer(0), {maxResultBytes: 4, ...options})
        .then(output => new Int32Array(output)[0])

describe("WasmWorker", () => {
    it("calls an export with the input bytes and resolves with what it wrote", async () => {
        const {worker} = create()
        const output = await worker.call("reverse", bytes(1, 2, 3, 4, 5), {maxResultBytes: 16})
        expect([...new Uint8Array(output)]).toEqual([5, 4, 3, 2, 1])
        worker.terminate()
    })

    it("transfers the input instead of copying it", async () => {
        const {worker} = create()
        const input = bytes(1, 2, 3)
        const result = worker.call("reverse", input, {maxResultBytes: 3})
        expect(input.byteLength).toBe(0)
        await result
        worker.terminate()
    })

    it("runs calls one after another and answers each with its own result", async () => {
        const {worker} = create()
        const results = await Promise.all([count(worker), count(worker), count(worker)])
        expect(results).toEqual([1, 2, 3])
        worker.terminate()
    })

    it("grows the module's memory for inputs larger than it has", async () => {
        const {worker} = create()
        const input = new Uint8Array(300_000).map((_, index) => index % 251)
        const expected = [...input].reverse()
        const output = await worker.call("reverse", input.buffer, {maxResultBytes: input.length})
        expect([...new Uint8Array(output)]).toEqual(expected)
        worker.terminate()
    })

    it("rejects a negative result, an overflow and an unknown method, and carries on", async () => {
        const {worker} = create()
        await expect(worker.call("fail", new ArrayBuffer(0), {maxResultBytes: 4}))
            .rejects.toThrow("test.fail: 'fail' failed with -1")
        await expect(worker.call("overflow", new ArrayBuffer(0), {maxResultBytes: 4}))
            .rejects.toThrow("larger than 4 bytes")
        await expect(worker.call("missing", new ArrayBuffer(0), {maxResultBytes: 4}))
            .rejects.toThrow("no method 'missing'")
        await expect(worker.call("alloc", new ArrayBuffer(0), {maxResultBytes: 4}))
            .rejects.toThrow("no method 'alloc'")
        expect(await count(worker)).toBe(1)
        worker.terminate()
    })

    it("starts a fresh instance after a trap", async () => {
        const {worker, created} = create()
        expect(await count(worker)).toBe(1)
        expect(await count(worker)).toBe(2)
        await expect(worker.call("trap", new ArrayBuffer(0), {maxResultBytes: 4})).rejects.toThrow("test.trap")
        expect(await count(worker)).toBe(1)
        expect(created()).toBe(1)
        worker.terminate()
    })

    it("removes an aborted call from the queue before the worker sees it", async () => {
        const {worker} = create()
        const controller = new AbortController()
        const first = count(worker)
        const second = count(worker, {signal: controller.signal})
        controller.abort()
        await expect(second).rejects.toThrow("aborted")
        expect(await first).toBe(1)
        expect(await count(worker)).toBe(2)
        worker.terminate()
    })

    it("discards the result of an aborted running call and lets the next one wait for it", async () => {
        const {worker, created} = create()
        const controller = new AbortController()
        const running = count(worker, {signal: controller.signal})
        const next = count(worker)
        controller.abort()
        await expect(running).rejects.toThrow("aborted")
        expect(await next).toBe(2)
        expect(created()).toBe(1)
        worker.terminate()
    })

    it("restarts the worker for an aborted running call in restart mode", async () => {
        const {worker, created} = create()
        expect(await count(worker)).toBe(1)
        const controller = new AbortController()
        const running = count(worker, {signal: controller.signal, abort: "restart"})
        controller.abort()
        await expect(running).rejects.toThrow("aborted")
        expect(created()).toBe(2)
        expect(await count(worker)).toBe(1)
        worker.terminate()
    })

    it("ignores what a replaced worker still sends", async () => {
        const replaced: Array<(message: WasmProtocol.FromWorker) => void> = []
        const factory: WasmProtocol.EndpointFactory = receive => {
            replaced.push(receive)
            return inProcess().factory(receive)
        }
        const worker = WasmWorker.create({name: "test", module: testModule, endpoint: factory})
        const controller = new AbortController()
        const running = count(worker, {signal: controller.signal, abort: "restart"})
        controller.abort()
        await expect(running).rejects.toThrow("aborted")
        replaced[0]({type: "broken", reason: "late news from the old worker"})
        expect(await count(worker)).toBe(1)
        worker.terminate()
    })

    it("rejects a call whose input cannot be sent and carries on", async () => {
        const {worker} = create()
        const input = bytes(1, 2, 3)
        await worker.call("reverse", input, {maxResultBytes: 3})
        await expect(worker.call("reverse", input, {maxResultBytes: 3})).rejects.toThrow()
        expect(await count(worker)).toBe(1)
        worker.terminate()
    })

    it("rejects at once when the signal has already aborted", async () => {
        const {worker} = create()
        const controller = new AbortController()
        controller.abort()
        await expect(count(worker, {signal: controller.signal})).rejects.toThrow("aborted")
        expect(await count(worker)).toBe(1)
        worker.terminate()
    })

    it("rejects pending and later calls once terminated", async () => {
        const {worker} = create()
        const running = count(worker)
        const queued = count(worker)
        worker.terminate()
        await expect(running).rejects.toThrow("test is terminated")
        await expect(queued).rejects.toThrow("test is terminated")
        await expect(count(worker)).rejects.toThrow("test is terminated")
    })

    it("reports a module that does not follow the convention and does not restart it", async () => {
        const {worker, created} = create(emptyModule)
        await expect(count(worker)).rejects.toThrow("the module exports no memory")
        await new Promise(resolve => setTimeout(resolve, 10))
        expect(created()).toBe(1)
        await expect(count(worker)).rejects.toThrow("the module exports no memory")
        worker.terminate()
    })
})
