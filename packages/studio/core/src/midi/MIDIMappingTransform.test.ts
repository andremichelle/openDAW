import {describe, expect, it} from "vitest"
import {Option} from "@opendaw/lib-std"
import {
    MIDIEncoding,
    MIDIMappingSettings,
    MIDIMappingState,
    MIDIMappingTransform,
    MIDITakeover
} from "./MIDIMappingTransform"

const settings = (min: number, max: number, takeover: MIDITakeover,
                  encoding: MIDIEncoding = MIDIEncoding.Absolute): MIDIMappingSettings =>
    ({min, max, takeover, encoding})

const controllerOf = (value: number): number => value > 64 ? 0.5 + (value - 63) / 128 : value < 64 ? value / 128 : 0.5

const unwrap = (option: Option<number>): number => option.unwrap("expected a value")

describe("MIDIMappingTransform absolute", () => {
    it("jumps over the full range", () => {
        const state = new MIDIMappingState()
        expect(unwrap(MIDIMappingTransform.apply(settings(0, 1, MIDITakeover.Jump), state, 127, 0.3))).toBeCloseTo(1, 6)
        expect(unwrap(MIDIMappingTransform.apply(settings(0, 1, MIDITakeover.Jump), state, 0, 0.3))).toBeCloseTo(0, 6)
    })

    it("maps 64 to the exact centre like MidiData.asValue", () => {
        const state = new MIDIMappingState()
        expect(unwrap(MIDIMappingTransform.apply(settings(0, 1, MIDITakeover.Jump), state, 64, 0.3))).toBe(0.5)
        expect(unwrap(MIDIMappingTransform.apply(settings(0, 1, MIDITakeover.Jump), state, 63, 0.3))).toBe(63 / 128)
        expect(unwrap(MIDIMappingTransform.apply(settings(0, 1, MIDITakeover.Jump), state, 65, 0.3))).toBe(0.5 + 2 / 128)
    })

    it("scales into min and max", () => {
        const state = new MIDIMappingState()
        expect(unwrap(MIDIMappingTransform.apply(settings(0.2, 0.6, MIDITakeover.Jump), state, 127, 0.3))).toBeCloseTo(0.6, 6)
        expect(unwrap(MIDIMappingTransform.apply(settings(0.2, 0.6, MIDITakeover.Jump), state, 0, 0.3))).toBeCloseTo(0.2, 6)
    })

    it("inverts when min is greater than max", () => {
        const state = new MIDIMappingState()
        expect(unwrap(MIDIMappingTransform.apply(settings(1, 0, MIDITakeover.Jump), state, 127, 0.3))).toBeCloseTo(0, 6)
        expect(unwrap(MIDIMappingTransform.apply(settings(1, 0, MIDITakeover.Jump), state, 0, 0.3))).toBeCloseTo(1, 6)
    })
})

describe("MIDIMappingTransform pickup", () => {
    const pickup = settings(0, 1, MIDITakeover.Pickup)

    it("waits until the controller crosses the current value", () => {
        const state = new MIDIMappingState()
        expect(MIDIMappingTransform.apply(pickup, state, 10, 0.5).isEmpty()).toBe(true)
        expect(MIDIMappingTransform.apply(pickup, state, 20, 0.5).isEmpty()).toBe(true)
        expect(unwrap(MIDIMappingTransform.apply(pickup, state, 70, 0.5))).toBeCloseTo(controllerOf(70), 6)
        expect(unwrap(MIDIMappingTransform.apply(pickup, state, 30, controllerOf(70)))).toBeCloseTo(controllerOf(30), 6)
    })

    it("picks up within one step of the current value", () => {
        const state = new MIDIMappingState()
        expect(unwrap(MIDIMappingTransform.apply(pickup, state, 64, controllerOf(64)))).toBeCloseTo(controllerOf(64), 6)
    })

    it("picks up an inverted mapping in controller space", () => {
        const state = new MIDIMappingState()
        const inverted = settings(1, 0, MIDITakeover.Pickup)
        expect(MIDIMappingTransform.apply(inverted, state, 20, 0.25).isEmpty()).toBe(true)
        expect(unwrap(MIDIMappingTransform.apply(inverted, state, 100, 0.25))).toBeCloseTo(1 - controllerOf(100), 6)
    })

    it("releases the pickup when the value was changed elsewhere", () => {
        const state = new MIDIMappingState()
        MIDIMappingTransform.apply(pickup, state, 64, controllerOf(64))
        expect(MIDIMappingTransform.apply(pickup, state, 30, 0.9).isEmpty()).toBe(true)
    })
})

describe("MIDIMappingTransform value scaling", () => {
    const scaling = settings(0, 1, MIDITakeover.Scaling)

    it("records the first controller value without moving", () => {
        const state = new MIDIMappingState()
        expect(MIDIMappingTransform.apply(scaling, state, 32, 0.5).isEmpty()).toBe(true)
    })

    it("converges toward the end of travel", () => {
        const state = new MIDIMappingState()
        MIDIMappingTransform.apply(scaling, state, 32, 0.5)
        const expected = 0.5 + 0.5 * (controllerOf(64) - controllerOf(32)) / (1 - controllerOf(32))
        const next = unwrap(MIDIMappingTransform.apply(scaling, state, 64, 0.5))
        expect(next).toBeCloseTo(expected, 6)
        expect(unwrap(MIDIMappingTransform.apply(scaling, state, 127, next))).toBeCloseTo(1, 6)
        expect(unwrap(MIDIMappingTransform.apply(scaling, state, 0, 1))).toBeCloseTo(0, 6)
    })

    it("stays inside the range when inverted", () => {
        const state = new MIDIMappingState()
        const inverted = settings(1, 0, MIDITakeover.Scaling)
        let current = 0.4
        const sweep = [...Array.from({length: 128}, (_, index) => index), ...Array.from({length: 128}, (_, index) => 127 - index)]
        sweep.forEach(value => MIDIMappingTransform.apply(inverted, state, value, current).ifSome(next => {
            expect(next).toBeGreaterThanOrEqual(0)
            expect(next).toBeLessThanOrEqual(1)
            current = next
        }))
        expect(current).toBeCloseTo(1, 6)
    })
})

describe("MIDIMappingTransform relative", () => {
    it("decodes two's complement", () => {
        expect(MIDIMappingTransform.decodeRelative(MIDIEncoding.TwosComplement, 1)).toBe(1)
        expect(MIDIMappingTransform.decodeRelative(MIDIEncoding.TwosComplement, 127)).toBe(-1)
        expect(MIDIMappingTransform.decodeRelative(MIDIEncoding.TwosComplement, 65)).toBe(-63)
    })

    it("decodes binary offset", () => {
        expect(MIDIMappingTransform.decodeRelative(MIDIEncoding.BinaryOffset, 65)).toBe(1)
        expect(MIDIMappingTransform.decodeRelative(MIDIEncoding.BinaryOffset, 63)).toBe(-1)
        expect(MIDIMappingTransform.decodeRelative(MIDIEncoding.BinaryOffset, 64)).toBe(0)
    })

    it("decodes sign bit", () => {
        expect(MIDIMappingTransform.decodeRelative(MIDIEncoding.SignBit, 1)).toBe(1)
        expect(MIDIMappingTransform.decodeRelative(MIDIEncoding.SignBit, 65)).toBe(-1)
    })

    it("steps the current value and clamps to the range", () => {
        const state = new MIDIMappingState()
        const relative = settings(0, 1, MIDITakeover.Pickup, MIDIEncoding.TwosComplement)
        expect(unwrap(MIDIMappingTransform.apply(relative, state, 1, 0.5))).toBeCloseTo(0.5 + 1 / 128, 6)
        expect(unwrap(MIDIMappingTransform.apply(relative, state, 3, 0.999))).toBeCloseTo(1, 6)
        const narrow = settings(0.2, 0.6, MIDITakeover.Jump, MIDIEncoding.TwosComplement)
        expect(unwrap(MIDIMappingTransform.apply(narrow, state, 127, 0.2))).toBeCloseTo(0.2, 6)
    })
})
