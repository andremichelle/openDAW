import {describe, expect, it} from "vitest"
import {MutableObservableOption} from "@opendaw/lib-std"
import {AudioRegionBoxAdapter} from "@opendaw/studio-adapters"
import {AudioFadeReveal} from "./AudioFadeReveal"

// the reveal only compares regions by identity
const regionOf = (name: string): AudioRegionBoxAdapter => ({name}) as unknown as AudioRegionBoxAdapter

const setup = () => {
    const hovered = new MutableObservableOption<AudioRegionBoxAdapter>()
    const reveal = new AudioFadeReveal(hovered)
    const moved: Array<AudioRegionBoxAdapter> = []
    reveal.subscribe(region => moved.push(region))
    return {hovered, reveal, moved}
}

describe("AudioFadeReveal", () => {
    it("a region nobody hovers has invisible handles", () => {
        const {reveal} = setup()
        expect(reveal.opacityOf(regionOf("a"))).toBe(0)
    })
    it("fades in over 150 ms once hovered", () => {
        const {hovered, reveal} = setup()
        const region = regionOf("a")
        hovered.wrap(region)
        expect(reveal.opacityOf(region)).toBe(0)
        reveal.advance(75)
        expect(reveal.opacityOf(region)).toBeCloseTo(0.5, 6)
        reveal.advance(75)
        expect(reveal.opacityOf(region)).toBe(1)
        reveal.advance(500)
        expect(reveal.opacityOf(region)).toBe(1)
    })
    it("fades out over 150 ms once left, then forgets the region", () => {
        const {hovered, reveal, moved} = setup()
        const region = regionOf("a")
        hovered.wrap(region)
        reveal.advance(150)
        hovered.clear()
        expect(reveal.opacityOf(region)).toBe(1)
        reveal.advance(60)
        expect(reveal.opacityOf(region)).toBeCloseTo(0.6, 6)
        reveal.advance(90)
        expect(reveal.opacityOf(region)).toBe(0)
        moved.length = 0
        reveal.advance(100)
        expect(moved).toEqual([])
    })
    it("turns around in the middle when the pointer comes back", () => {
        const {hovered, reveal} = setup()
        const region = regionOf("a")
        hovered.wrap(region)
        reveal.advance(150)
        hovered.clear()
        reveal.advance(75)
        hovered.wrap(region)
        reveal.advance(30)
        expect(reveal.opacityOf(region)).toBeCloseTo(0.7, 6)
    })
    it("moving from one region to the next fades one out while the other fades in", () => {
        const {hovered, reveal, moved} = setup()
        const [left, right] = [regionOf("left"), regionOf("right")]
        hovered.wrap(left)
        reveal.advance(150)
        hovered.wrap(right)
        moved.length = 0
        reveal.advance(30)
        expect(reveal.opacityOf(left)).toBeCloseTo(0.8, 6)
        expect(reveal.opacityOf(right)).toBeCloseTo(0.2, 6)
        expect(moved).toEqual([left, right])
        reveal.advance(150)
        expect([reveal.opacityOf(left), reveal.opacityOf(right)]).toEqual([0, 1])
    })
    it("tells nobody about a region that did not move", () => {
        const {hovered, reveal, moved} = setup()
        const region = regionOf("a")
        hovered.wrap(region)
        reveal.advance(150)
        moved.length = 0
        reveal.advance(16)
        expect(moved).toEqual([])
    })
})
