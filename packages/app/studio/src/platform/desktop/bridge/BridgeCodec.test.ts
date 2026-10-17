import {describe, expect, it} from "vitest"
import {BridgeShared} from "./BridgeLink"

describe("BridgeCodec", () => {
    const roundTrip = (value: unknown, from = new BridgeShared("studio"), to = new BridgeShared("engine")) =>
        to.decode(from.encode({type: "message", data: value}))

    it("keeps primitives, arrays, objects, maps and sets", () => {
        const value = {a: 1.5, b: "text ünïcødé 🎹", c: [true, false, null, undefined], d: new Map([["k", 2]]), e: new Set([3]), f: -0, g: NaN}
        const decoded = roundTrip(value) as { type: string, data: typeof value }
        expect(decoded.type).toBe("message")
        expect(decoded.data.a).toBe(1.5)
        expect(decoded.data.b).toBe("text ünïcødé 🎹")
        expect(decoded.data.c).toEqual([true, false, null, undefined])
        expect(decoded.data.d.get("k")).toBe(2)
        expect(decoded.data.e.has(3)).toBe(true)
        expect(Object.is(decoded.data.f, -0)).toBe(true)
        expect(decoded.data.g).toBeNaN()
    })

    it("copies array buffers and typed arrays including views with an offset", () => {
        const backing = new Float32Array([1, 2, 3, 4])
        const view = new Float32Array(backing.buffer, 4, 2)
        const decoded = roundTrip({buffer: new Uint8Array([7, 8]).buffer, view, uuid: new Uint8Array(16).fill(9)}) as {
            data: { buffer: ArrayBuffer, view: Float32Array, uuid: Uint8Array }
        }
        expect(Array.from(new Uint8Array(decoded.data.buffer))).toEqual([7, 8])
        expect(decoded.data.view).toBeInstanceOf(Float32Array)
        expect(Array.from(decoded.data.view)).toEqual([2, 3])
        expect(decoded.data.uuid.length).toBe(16)
    })

    it("carries errors with message and stack", () => {
        const decoded = roundTrip(new Error("boom")) as { data: Error }
        expect(decoded.data).toBeInstanceOf(Error)
        expect(decoded.data.message).toBe("boom")
    })

    it("maps a shared buffer to the same local copy on every arrival", () => {
        const studio = new BridgeShared("studio")
        const engine = new BridgeShared("engine")
        const shared = new SharedArrayBuffer(8)
        const first = roundTrip(shared, studio, engine) as { data: SharedArrayBuffer }
        const second = roundTrip(shared, studio, engine) as { data: SharedArrayBuffer }
        expect(first.data).toBeInstanceOf(SharedArrayBuffer)
        expect(first.data).not.toBe(shared)
        expect(first.data).toBe(second.data)
        expect(first.data.byteLength).toBe(8)
        expect(engine.isReceived(studio.idOf(shared))).toBe(true)
        const back = roundTrip(first.data, engine, studio) as { data: SharedArrayBuffer }
        expect(back.data).toBe(shared)
    })

    it("numbers buffers per side so ids never collide", () => {
        const studio = new BridgeShared("studio")
        const engine = new BridgeShared("engine")
        expect(studio.idOf(new SharedArrayBuffer(1)) % 2).toBe(0)
        expect(engine.idOf(new SharedArrayBuffer(1)) % 2).toBe(1)
        expect(engine.own().length).toBe(1)
    })

    it("relays message ports when both sides link them, else a port arrives inert", () => {
        const {port1} = new MessageChannel()
        const relay = {name: "relay"}
        const studio = new BridgeShared("studio", {idOfPort: () => 6, portOf: () => undefined})
        const engine = new BridgeShared("engine", {idOfPort: () => 0, portOf: id => id === 6 ? relay : undefined})
        const linked = roundTrip({port: port1}, studio, engine) as { data: { port: unknown } }
        expect(linked.data.port).toBe(relay)
        const inert = roundTrip({port: port1}) as { data: { port: { postMessage: unknown } } }
        expect(inert.data.port).not.toBe(relay)
        expect(typeof inert.data.port.postMessage).toBe("function")
        port1.close()
    })
})
