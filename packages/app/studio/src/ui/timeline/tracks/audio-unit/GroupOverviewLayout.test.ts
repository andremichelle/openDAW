import {describe, expect, it} from "vitest"
import {groupOverviewLayout} from "./GroupOverviewLayout"

describe("folded group clip overview", () => {
    it("clips times to the viewport and keeps child colors on separate stripes", () => {
        const lines = groupOverviewLayout([
            [{position: -10, complete: 20, hue: 320, mute: false}],
            [{position: 30, complete: 110, hue: 110, mute: true},
                {position: 120, complete: 130, hue: 50, mute: false}]
        ], 48, 100, value => value)
        expect(lines).toHaveLength(2)
        expect(lines[0]).toMatchObject({x: 0, width: 20, hue: 320, muted: false})
        expect(lines[1]).toMatchObject({x: 30, width: 70, hue: 110, muted: true})
        expect(lines[0].y + lines[0].height).toBeLessThan(lines[1].y)
    })
    it("fits many child lanes inside a short group row", () => {
        const lanes = Array.from({length: 100}, () => [{position: 0, complete: 1, hue: 0, mute: false}])
        const lines = groupOverviewLayout(lanes, 40, 100, value => value * 10)
        expect(lines).toHaveLength(100)
        expect(lines.every(line => line.y >= 0 && line.y + line.height <= 40 && line.height > 0)).toBe(true)
        expect(groupOverviewLayout([], 40, 100, value => value)).toEqual([])
    })
})
