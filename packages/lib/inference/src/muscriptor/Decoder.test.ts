import {describe, expect, it} from "vitest"
import {MuScriptorDecoder} from "./Decoder"

const program = (n: number): number => 1135 + n
const pitch = (n: number): number => 1004 + n
const at = (tick: number): number => 3 + tick
const ON = 1133, OFF = 1132, TIE = 1134
const begin = (decoder: MuScriptorDecoder, offset = 0, end = 5): number[] => {
    const prefix = decoder.beginChunk(offset, end)
    prefix.slice(1).forEach(token => decoder.feed(token))
    // Simulate the model emitting the first chunk's unforced prologue.
    if (offset === 0) {decoder.feed(TIE)}
    return prefix
}

describe("MuScriptor MIDI decoding", () => {
    it("lets the model generate the first prologue and only forces later continuations", () => {
        const decoder = new MuScriptorDecoder()
        expect(decoder.beginChunk(0, 5)).toEqual([1395])
        ;[program(33), pitch(40), TIE, ON, pitch(40)].forEach(token => decoder.feed(token))
        expect(begin(decoder, 5, 10)).toEqual([1395, program(33), pitch(40), TIE])
        ;[at(20), program(33), OFF, pitch(40)].forEach(token => decoder.feed(token))
        expect(decoder.finish(10)).toMatchObject([{instrument: "Electric Bass", start: 0, end: 5.2, pitch: 40}])
    })
    it("keeps simultaneous same-pitch instruments independent", () => {
        const decoder = new MuScriptorDecoder()
        begin(decoder)
        ;[at(10), program(0), ON, pitch(60), program(24), ON, pitch(60),
            at(50), program(0), OFF, pitch(60), at(80), program(24), OFF, pitch(60)].forEach(token => decoder.feed(token))
        expect(decoder.finish(5).map(note => [note.instrument, note.start, note.end])).toEqual([
            ["Acoustic Piano", 0.1, 0.5], ["Acoustic Guitar", 0.1, 0.8]
        ])
    })
    it("carries sustained notes across a chunk without retriggering", () => {
        const decoder = new MuScriptorDecoder()
        begin(decoder)
        ;[at(490), program(0), ON, pitch(60)].forEach(token => decoder.feed(token))
        expect(begin(decoder, 5, 10)).toEqual([1395, program(0), pitch(60), TIE])
        ;[at(20), program(0), OFF, pitch(60)].forEach(token => decoder.feed(token))
        expect(decoder.finish(10)).toMatchObject([{start: 4.9, end: 5.2, pitch: 60}])
    })
    it("repeated attacks close the preceding note of that instrument", () => {
        const decoder = new MuScriptorDecoder()
        begin(decoder)
        ;[program(0), ON, pitch(60), at(50), pitch(60), at(100), OFF, pitch(60)].forEach(token => decoder.feed(token))
        expect(decoder.finish(5).map(note => [note.start, note.end])).toEqual([[0, 0.5], [0.5, 1]])
    })
    it("decodes drums without a pitched program or velocity and clips the end", () => {
        const decoder = new MuScriptorDecoder()
        begin(decoder, 0, 0.505)
        ;[at(50), 1265 + 36, at(51), 1265 + 38].forEach(token => decoder.feed(token))
        expect(decoder.finish(0.505)).toMatchObject([{instrument: "Drums", program: 128,
            isDrum: true, pitch: 36, start: 0.5, end: 0.505}])
    })
    it("ignores notes emitted past a chunk and drops invalid zero-duration events", () => {
        const decoder = new MuScriptorDecoder()
        begin(decoder)
        ;[program(0), ON, pitch(60), OFF, pitch(60), at(501), ON, pitch(64)].forEach(token => decoder.feed(token))
        expect(decoder.finish(5)).toEqual([])
    })
    it("does not invent a long sustain for unclosed end-of-file notes", () => {
        const decoder = new MuScriptorDecoder()
        begin(decoder)
        ;[at(10), program(0), ON, pitch(60)].forEach(token => decoder.feed(token))
        expect(decoder.finish(5)[0].end).toBeCloseTo(0.11)
    })
})
