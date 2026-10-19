import {describe, expect, it, vi} from "vitest"
import {ByteArrayInput, ByteArrayOutput} from "./data"
import {SyncStream} from "./sync-stream"
import {Schema} from "./schema"

/* ------------------------------------------------------------------ *
 * Minimal stub that fulfils the Schema.IO<T> contract.
 * We serialise a single signed 32-bit integer (4 bytes).
 * ------------------------------------------------------------------ */
type Sample = { n: number }

const makeIO = (): Schema.IO<Sample> => ({
    bytesTotal: 4,
    object: {n: 0},
    write(out: ByteArrayOutput) {
        out.writeInt(this.object.n)
    },
    read(inp: ByteArrayInput) {
        this.object.n = inp.readInt()
    }
})

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */
describe("SyncStream", () => {
    it("round-trips data from sender to receiver exactly once", () => {
        const io = makeIO()

        const spy = vi.fn()

        /* ----------------------  set up writer / reader  ---------------------- */
        // buffer is supplied by the receiver; +1 byte for the state flag
        const reader = SyncStream.reader(io, obj => {
            // verify the incoming value
            expect(obj.n).toBe(42)
            // mutate after read to be sure the writer does not see it
            obj.n = 99
            spy()
        })

        const writer = SyncStream.writer(io, reader.buffer, obj => {
            obj.n = 42
        })

        /* -------------------------  perform I/O  ------------------------------ */
        while (!writer.tryWrite()) {}
        while (!reader.tryRead()) {}
        expect(spy).toHaveBeenCalled()
    })

    // the audio thread writes once per block and the main thread reads once per frame, so no call may be wasted
    it("delivers a state on every write and read call when the other side keeps up", () => {
        const readerIO = makeIO()
        const writerIO = makeIO()
        const received: Array<number> = []
        const reader = SyncStream.reader(readerIO, obj => received.push(obj.n))
        let counter = 0
        const writer = SyncStream.writer(writerIO, reader.buffer, obj => {obj.n = ++counter})
        const results: Array<[boolean, boolean]> = []
        for (let frame = 0; frame < 5; frame++) {results.push([writer.tryWrite(), reader.tryRead()])}
        expect(results).toEqual(Array.from({length: 5}, () => [true, true]))
        expect(received).toEqual([1, 2, 3, 4, 5])
    })

    it("does not overwrite a state the reader has not taken yet, nor read the same state twice", () => {
        const readerIO = makeIO()
        const writerIO = makeIO()
        const received: Array<number> = []
        const reader = SyncStream.reader(readerIO, obj => received.push(obj.n))
        let counter = 0
        const writer = SyncStream.writer(writerIO, reader.buffer, obj => {obj.n = ++counter})
        expect(reader.tryRead()).toBe(false)
        expect(writer.tryWrite()).toBe(true)
        expect(writer.tryWrite()).toBe(false)
        expect(writer.tryWrite()).toBe(false)
        expect(reader.tryRead()).toBe(true)
        expect(reader.tryRead()).toBe(false)
        expect(writer.tryWrite()).toBe(true)
        expect(reader.tryRead()).toBe(true)
        expect(received).toEqual([1, 2])
    })

    it("rejects buffers that are too small", () => {
        const io = makeIO()
        const tiny = new SharedArrayBuffer(1) // definitely smaller than bytesTotal + 1

        expect(() => SyncStream.writer(io, tiny, () => undefined)).toThrow()
    })
})