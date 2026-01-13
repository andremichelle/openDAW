import {describe, expect, it} from "vitest"
import {
    Groove,
    GrooveChain,
    GrooveFunction,
    GroovePattern,
    GroovePatternFunction,
    QuantisedGrooveFunction
} from "./grooves"
import {PPQN, ppqn} from "./ppqn"
import {moebiusEase, Random} from "@moises-ai/lib-std"

const createMEGroove = (duration: ppqn, amount: number) => new GroovePattern({
    duration: (): ppqn => duration,
    fx: x => moebiusEase(x, amount),
    fy: y => moebiusEase(y, 1.0 - amount)
} satisfies GroovePatternFunction)

const createOffsetGroove = (offset: ppqn): Groove => ({
    warp: (position: ppqn): ppqn => position + offset,
    unwarp: (position: ppqn): ppqn => position - offset
})

const groovePingPong = (groove: Groove, x: ppqn) => expect(groove.unwarp(groove.warp(x))).toBeCloseTo(x, 7)
const bijectivePingPong = (func: GrooveFunction, x: ppqn) => expect(func.fy(func.fx(x))).toBeCloseTo(x, 7)

describe("Grooves", () => {
    it("should be revertible", () => {
        const G = createMEGroove(PPQN.SemiQuaver * 2, 0.5)
        groovePingPong(G, PPQN.SemiQuaver)
        groovePingPong(G, PPQN.SemiQuaver * 1.2)
        groovePingPong(G, PPQN.SemiQuaver * 1.23)
        groovePingPong(G, PPQN.SemiQuaver * 1.234)
        groovePingPong(G, PPQN.SemiQuaver * 1.2345678)
    })
    it("should be chainable", () => {
        const A = createMEGroove(PPQN.SemiQuaver * 2, 0.50)
        const B = createMEGroove(PPQN.SemiQuaver * 3, 0.75)
        const C = createOffsetGroove(PPQN.SemiQuaver)
        const D = createMEGroove(PPQN.SemiQuaver * 7, 0.66)
        const G = new GrooveChain([A, B, C, D])
        groovePingPong(G, PPQN.SemiQuaver)
        groovePingPong(G, PPQN.SemiQuaver * 1.2)
        groovePingPong(G, PPQN.SemiQuaver * 1.23)
        groovePingPong(G, PPQN.SemiQuaver * 1.234)
        groovePingPong(G, PPQN.SemiQuaver * 1.2345678)
    })
})

describe("QuantisedGrooveFunction", () => {
    it("2 values [0,1]", () => {
        const func = new QuantisedGrooveFunction(new Float32Array([0.0, 1.0]))
        expect(func.fx(0.0)).toBe(0.0)
        expect(func.fy(0.0)).toBe(0.0)
        expect(func.fx(0.3)).toBe(0.3)
        expect(func.fy(0.3)).toBe(0.3)
        expect(func.fx(0.5)).toBe(0.5)
        expect(func.fy(0.5)).toBe(0.5)
        expect(func.fx(0.7)).toBe(0.7)
        expect(func.fy(0.7)).toBe(0.7)
        expect(func.fx(1.0)).toBe(1.0)
        expect(func.fy(1.0)).toBe(1.0)
    })
    it("3 values [0,0.5,1]", () => {
        const func = new QuantisedGrooveFunction(new Float32Array([0.0, 0.5, 1.0]))
        expect(func.fx(0.0)).toBe(0.0)
        expect(func.fx(0.3)).toBe(0.3)
        expect(func.fx(0.7)).toBe(0.7)
        expect(func.fx(0.5)).toBe(0.5)
        expect(func.fx(1.0)).toBe(1.0)
    })
    it("3 values [0,0.6,1]", () => {
        const func = new QuantisedGrooveFunction(new Float64Array([0.0, 0.6, 1.0]))
        expect(func.fx(0.50)).toBe(0.6)
        expect(func.fx(0.25)).toBe(0.3)
        expect(func.fy(0.6)).toBe(0.5)
        expect(func.fy(0.3)).toBe(0.25)
    })
    it("3 values [0,0.77,1]", () => {
        const func = new QuantisedGrooveFunction(new Float64Array([0.0, 0.77, 1.0]))
        bijectivePingPong(func, 0.00)
        bijectivePingPong(func, 0.50)
        bijectivePingPong(func, 0.13)
        bijectivePingPong(func, 0.13)
        bijectivePingPong(func, 0.59)
        bijectivePingPong(func, 1.00)
    })
    it("random values", () => {
        const func = new QuantisedGrooveFunction(Random.monotoneAscending(new Float32Array(9), 128))
        bijectivePingPong(func, 0.00)
        bijectivePingPong(func, 0.50)
        bijectivePingPong(func, 0.13)
        bijectivePingPong(func, 0.13)
        bijectivePingPong(func, 0.59)
        bijectivePingPong(func, 1.00)
    })
})