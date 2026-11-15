import {describe, expect, it} from "vitest"
import {SurgeonModel} from "./SurgeonModel"

// reference values printed by the engine: cargo run -p device-surgeon --example vectors (in crates)
describe("SurgeonModel against the engine", () => {
    const {unit, generation, random, rollAll, favourite, step, laneValue, unitAt, Index, Kind} = SurgeonModel
    it("rolls like the engine", () => {
        expect(unit(1, 0, 0, 1)).toBe(Math.fround(0.50477314))
        expect(unit(21, 3, 2, 1)).toBe(Math.fround(0.28574818))
        expect(unit(99_999, 31, 300, 7)).toBe(Math.fround(0.02251333))
        expect(unit(4_294_967_295, 7, 1, 4)).toBe(Math.fround(0.02390045))
    })
    it("counts replacements like the engine", () => {
        expect(generation(21, 3, 300, 0.15)).toBe(44)
        expect(generation(1, 0, 40, 0.12)).toBe(10)
        expect(generation(7, 5, 1000, 0.5)).toBe(500)
    })
    it("Random all draws the engine's pitch loop and lanes", () => {
        const one = random(1)
        expect(one.pitch.steps).toBe(12)
        expect(one.pitch.seed).toBe(23279)
        expect(one.pitch.mutate).toBeCloseTo(0.23064053, 6)
        expect(one.pitch.range).toBeCloseTo(11.174789, 5)
        expect(one.pitch.density).toBeCloseTo(0.6000297, 6)
        expect(one.pitch.tie).toBeCloseTo(0.08223343, 6)
        expect(one.pitch.accent).toBeCloseTo(0.76266265, 6)
        expect(one.lanes.map(({steps, seed}) => [steps, seed])).toEqual([[3, 99441], [15, 86569], [16, 91146], [7, 74378]])
        expect(one.lanes.map(lane => laneValue(lane, 37))).toEqual([0.29165804, 0.62977594, 0.8033653, 0.23951209].map(Math.fround))
        const five = random(5)
        expect([five.pitch.steps, five.pitch.seed]).toEqual([14, 43573])
        expect(five.lanes.map(({steps, seed}) => [steps, seed])).toEqual([[8, 88686], [6, 13438], [12, 84779], [11, 59241]])
        const twelve = random(12)
        expect([twelve.pitch.steps, twelve.pitch.seed]).toEqual([12, 89564])
    })
    it("the All button adds the engine's slide chance and keeps Mutate and Rate", () => {
        const current = favourite()
        current.rate = 2
        current.pitch.mutate = 0.07
        current.lanes[2].mutate = 0.33
        expect(random(1).pitch.slide).toBe(0)
        expect(rollAll(current, 1).pitch.slide).toBeCloseTo(0.02338326, 6)
        expect(rollAll(current, 5).pitch.slide).toBeCloseTo(0.18679655, 6)
        expect(rollAll(current, 12).pitch.slide).toBeCloseTo(0.4517516, 6)
        const {pitch, lanes, base, amounts, rate} = rollAll(current, 5)
        const approved = random(5)
        expect({base, amounts}).toEqual({base: approved.base, amounts: approved.amounts})
        expect({...pitch, slide: 0, mutate: 0}).toEqual({...approved.pitch, mutate: 0})
        expect(lanes.map(({steps, seed}) => [steps, seed])).toEqual(approved.lanes.map(({steps, seed}) => [steps, seed]))
        expect([rate, pitch.mutate, lanes.map(lane => lane.mutate)]).toEqual([2, 0.07, [0, 0, 0.33, 0]])
    })
    it("Random all draws the engine's steps", () => {
        const expected: ReadonlyArray<readonly [number, number, number]> = [
            [-0.36812988, 0.43501884, 0], [-5.6120086, 0.62917185, 0], [0.7373281, 0.40266836, 0], [-0.7231595, 0.6727505, 0],
            [-10.508426, 0.34990615, 0], [-3.131737, 0.5383785, 2], [-3.7176168, 0.32103747, 0], [10.150981, 0.32452202, 2],
            [2.3986757, 0.35805053, 2], [10.342976, 0.9345379, 2], [3.9555461, 0.7617347, 0], [-3.0441341, 0.8052729, 0],
            [-0.36812988, 0.43501884, 0], [-5.6120086, 0.62917185, 0], [-6.422956, 0.91029996, 1], [-0.7231595, 0.6727505, 0],
            [-6.2097764, 0.7554514, 0], [-3.131737, 0.5383785, 2], [-3.7176168, 0.32103747, 0], [10.150981, 0.32452202, 2]]
        const {pitch} = random(1)
        expected.forEach(([offset, velocity, kind], position) => {
            const actual = step(pitch, position)
            expect(actual.offset).toBeCloseTo(offset, 4)
            expect(actual.velocity).toBeCloseTo(velocity, 5)
            expect(actual.kind).toBe([Kind.Play, Kind.Tie, Kind.Rest][kind])
        })
    })
    it("Random all draws the engine's sound and mapping", () => {
        const base = [0.6857508, 0.1070224, 0.6417892, 0.41034135, 0.125, 0.20898457, 0.17783831, 0.2854716, 0, 0.25,
            0.018195964, 0.007894725, 0.45472923, 0.75, 0.22195932, 0.41581023]
        const amounts = [[0, 0, 0, 0], [0, 0.5414741, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0.040186584, 0, 0],
            [0.77077305, 0, 0, 0], [0, 0, -0.2503534, 0], [0.24239352, -0.25127807, 0, 0], [0, 0, 0, 0], [0.9070463, 0, 0, 0],
            [0, 0, 0, 0], [-0.18372208, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]
        const one = random(1)
        base.forEach((value, index) => expect(one.base[index]).toBeCloseTo(value, 5))
        amounts.forEach((row, param) => row.forEach((value, lane) => expect(one.amounts[param][lane]).toBeCloseTo(value, 5)))
        expect(unitAt(one, Index.Feedback, 37)).toBeCloseTo(0.44802976, 5)
        expect(unitAt(random(5), Index.Feedback, 37)).toBeCloseTo(0.051889516, 5)
        expect(unitAt(random(12), Index.Feedback, 37)).toBeCloseTo(0.6320036, 5)
    })
})
