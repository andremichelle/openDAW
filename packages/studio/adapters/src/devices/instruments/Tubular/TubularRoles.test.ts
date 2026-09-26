import {describe, expect, it} from "vitest"
import {Tubular} from "../TubularDeviceBoxAdapter"

const describeRoles = (algorithm: number) => Tubular.roles(algorithm - 1)
    .map(({carrier, targets, feedback}, index) => `${index + 1}${feedback ? "*" : ""}:${carrier ? "out" : targets.join("+")}`)

describe("Tubular.roles", () => {
    it("reads algorithm 1 as two stacks", () => {
        expect(describeRoles(1)).toStrictEqual(["1:out", "2:1", "3:out", "4:3", "5:4", "6*:5"])
    })
    it("reads algorithm 5 as three pairs", () => {
        expect(describeRoles(5)).toStrictEqual(["1:out", "2:1", "3:out", "4:3", "5:out", "6*:5"])
    })
    it("reads algorithm 16 as one carrier fed by three branches", () => {
        expect(describeRoles(16)).toStrictEqual(["1:out", "2:1", "3:1", "4:3", "5:1", "6*:5"])
    })
    it("reads algorithm 32 as six carriers", () => {
        expect(describeRoles(32)).toStrictEqual(["1:out", "2:out", "3:out", "4:out", "5:out", "6*:out"])
    })
    it("reads algorithm 22 as three parallel carriers under one modulator", () => {
        expect(describeRoles(22)).toStrictEqual(["1:out", "2:1", "3:out", "4:out", "5:out", "6*:3+4+5"])
    })
})
