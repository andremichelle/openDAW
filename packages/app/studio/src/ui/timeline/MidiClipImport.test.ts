import {describe, expect, it} from "vitest"
import {MidiFile} from "@opendaw/lib-midi"

const clip = (...words: number[]): ArrayBuffer => {
    const buffer = new ArrayBuffer((words.length + 2) * 4)
    const view = new DataView(buffer)
    view.setUint32(0, 0x534d4632)
    view.setUint32(4, 0x434c4950)
    words.forEach((word, index) => view.setUint32((index + 2) * 4, word))
    return buffer
}

const header = [0x00400000, 0x00300060, 0x00400018, 0xf0200000, 0, 0, 0]
const end = [0xf0210000, 0, 0, 0]

describe("MIDI Clip File import", () => {
    it("preserves musical ticks, simultaneous events, groups and 16-bit note velocity", () => {
        const file = MidiFile.decoder(clip(
            ...header,
            0x00400030,                        // Delta of 48 ticks
            0x40903c00, 0x80010000,             // MIDI 2.0 note on, group 0
            0x41903c00, 0x00000000,             // Simultaneous zero-velocity MIDI 2.0 note on, group 1
            0xd0100000, 0x02faf080, 0, 0,        // Tempo packet is consumed without shifting the next event
            0x00400060,
            0x40803c00, 0,
            0x21903c00,                        // MIDI 1.0 velocity zero is note off, group 1
            ...end
        )).decode()
        expect(file.timeDivision).toBe(96)
        expect(file.tracks.map(track => track.umpGroup)).toEqual([0, 1])
        const voices = file.tracks.map(track => {
            const [, events] = Array.from(track.controlEvents)[0]
            return events.flatMap(event => {
                const result: Array<[number, number, number | null]> = []
                event.accept({
                    noteOn: (note, velocity) => result.push([event.ticks, note, velocity]),
                    noteOff: note => result.push([event.ticks, note, null])
                })
                return result
            })
        })
        expect(voices).toEqual([
            [[48, 60, 32769 / 65535], [144, 60, null]],
            [[48, 60, 0], [144, 60, null]]
        ])
    })

    it("rejects a truncated UMP or an absent End of Clip", () => {
        expect(() => MidiFile.decoder(clip(...header, 0x40903c00)).decode()).toThrow("Truncated")
        expect(() => MidiFile.decoder(clip(...header)).decode()).toThrow("Missing")
    })

    it("keeps the existing Standard MIDI File decoder", () => {
        const midi = Uint8Array.from([
            0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96,
            0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 12,
            0, 0x90, 60, 100, 96, 0x80, 60, 0, 0, 0xff, 0x2f, 0
        ])
        const file = MidiFile.decoder(midi.buffer).decode()
        expect(file.timeDivision).toBe(96)
        expect(file.tracks[0].umpGroup).toBeUndefined()
        const [[, events]] = Array.from(file.tracks[0].controlEvents)
        expect(events.map(event => event.ticks)).toEqual([0, 96])
    })
})
