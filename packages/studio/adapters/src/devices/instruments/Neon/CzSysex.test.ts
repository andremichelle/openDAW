import {describe, expect, it} from "vitest"
import {CzSysex, CzTone} from "./CzSysex"

const envelope = (rates: number[], levels: number[], sustain: number, end: number) =>
    ({rates, levels, sustain, end})

const tone: CzTone = {
    lineSelect: 3,
    modulation: 1,
    octave: 1,
    detuneNote: -19,
    detuneFine: -33,
    vibratoWave: 2,
    vibratoDelay: 40,
    vibratoRate: 65,
    vibratoDepth: 12,
    lines: [
        {
            wave1: 5, wave2: 2, dcwKeyFollow: 3, dcaKeyFollow: 7,
            pitchEnv: envelope([99, 50, 0, 0, 0, 0, 0, 0], [70, 0, 0, 0, 0, 0, 0, 0], 0, 2),
            dcwEnv: envelope([99, 80, 60, 0, 0, 0, 0, 0], [99, 60, 30, 0, 0, 0, 0, 0], 2, 3),
            dcaEnv: envelope([99, 70, 50, 30, 0, 0, 0, 0], [99, 80, 40, 0, 0, 0, 0, 0], 3, 4)
        },
        {
            wave1: 0, wave2: 0, dcwKeyFollow: 0, dcaKeyFollow: 9,
            pitchEnv: envelope([0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0], 0, 1),
            dcwEnv: envelope([99, 0, 0, 0, 0, 0, 0, 0], [99, 0, 0, 0, 0, 0, 0, 0], 1, 2),
            dcaEnv: envelope([99, 40, 0, 0, 0, 0, 0, 0], [99, 0, 0, 0, 0, 0, 0, 0], 1, 2)
        }
    ]
}

describe("CzSysex", () => {
    it("encodes a 264-byte CZ-101 dump", () => {
        const bytes = CzSysex.encode(tone)
        expect(bytes.length).toBe(264)
        expect(bytes[0]).toBe(0xF0)
        expect(bytes[1]).toBe(0x44)
        expect(bytes[bytes.length - 1]).toBe(0xF7)
        expect(CzSysex.isToneDump(bytes)).toBe(true)
        for (const byte of bytes.slice(7, -1)) {
            expect(byte).toBeLessThan(0x10) // nibbleized payload
        }
    })

    it("round-trips every field through encode -> decode", () => {
        expect(CzSysex.decode(CzSysex.encode(tone))).toEqual(tone)
    })

    it("round-trips the resonance waves and their shared window", () => {
        const resonant: CzTone = {...tone, modulation: 0, lines: [
            {...tone.lines[0], wave1: 7, wave2: 8}, // trapezoid window, second wave = res trapezoid
            {...tone.lines[1], wave1: 6, wave2: 0}
        ]}
        expect(CzSysex.decode(CzSysex.encode(resonant))).toEqual(resonant)
    })

    it("rejects garbage", () => {
        expect(CzSysex.isToneDump(new Uint8Array([1, 2, 3]))).toBe(false)
        expect(() => CzSysex.decode(new Uint8Array(300))).toThrow()
    })
})
