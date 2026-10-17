import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {Nullable} from "@opendaw/lib-std"
import {BridgeShared} from "./BridgeLink"
import {NativeEnginePort} from "./NativeEnginePort"

// stands in for the engine process's end of the connection
class FakeSocket {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static last: FakeSocket
    readyState = FakeSocket.CONNECTING
    binaryType = ""
    onopen: Nullable<() => void> = null
    onmessage: Nullable<(event: { data: ArrayBuffer }) => void> = null
    onclose: Nullable<(event: { code: number, wasClean: boolean }) => void> = null
    onerror: Nullable<() => void> = null
    constructor(readonly url: string) {FakeSocket.last = this}
    send(_bytes: ArrayBuffer): void {}
    close(): void {}
    open(): void {
        this.readyState = FakeSocket.OPEN
        this.onopen?.()
    }
}

const noop = () => {}

const createPort = (onLost: (message: string) => void): NativeEnginePort => new NativeEnginePort("ws://engine", 48_000, {
    syncStreamBuffer: new SharedArrayBuffer(64), controlFlagsBuffer: new SharedArrayBuffer(4)
}, noop, noop, noop, noop, noop, noop, onLost, [])

describe("NativeEnginePort", () => {
    const original = globalThis.WebSocket
    beforeEach(() => {
        vi.useFakeTimers()
        globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    })
    afterEach(() => {
        globalThis.WebSocket = original
        vi.useRealTimers()
    })

    it("reports an engine that could not start, with the reason", () => {
        const lost = vi.fn()
        createPort(lost)
        const socket = FakeSocket.last
        socket.open()
        socket.onmessage?.({data: new BridgeShared("engine").encode({type: "failed", reason: "no wasm"})})
        socket.onclose?.({code: 1005, wasClean: true})
        expect(lost).toHaveBeenCalledTimes(1)
        expect(lost.mock.calls[0][0]).toContain("no wasm")
    })

    it("stays quiet when the engine closes the connection cleanly", () => {
        const lost = vi.fn()
        createPort(lost)
        FakeSocket.last.open()
        FakeSocket.last.onclose?.({code: 1005, wasClean: true})
        expect(lost).not.toHaveBeenCalled()
    })

    it("reports an engine process that went away", () => {
        const lost = vi.fn()
        createPort(lost)
        FakeSocket.last.open()
        FakeSocket.last.onclose?.({code: 1006, wasClean: false})
        expect(lost).toHaveBeenCalledWith("The audio engine stopped unexpectedly.")
    })
})
