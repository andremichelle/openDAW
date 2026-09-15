import {describe, expect, it} from "vitest"
import {centerCard, placeCard} from "./TourPlacement"

const viewport = {width: 1000, height: 600}
const card = {width: 200, height: 100}

describe("TourPlacement", () => {
    it("centers without an anchor", () => {
        expect(centerCard(card, viewport)).toEqual({x: 400, y: 250, side: undefined, notch: 0})
    })
    it("places below a header group and points the notch at its center", () => {
        const layout = placeCard({x: 100, y: 10, width: 60, height: 20}, card, viewport, "below")
        expect(layout.side).toBe("below")
        expect(layout.y).toBe(42)
        expect(layout.x).toBe(30)
        expect(layout.notch).toBe(100)
    })
    it("clamps to the viewport edge and keeps the notch inside the card", () => {
        const layout = placeCard({x: 0, y: 10, width: 20, height: 20}, card, viewport, "below")
        expect(layout.x).toBe(8)
        expect(layout.notch).toBe(20)
    })
    it("flips to the opposite side when the preferred side has no room", () => {
        const layout = placeCard({x: 100, y: 550, width: 60, height: 40}, card, viewport, "below")
        expect(layout.side).toBe("above")
        expect(layout.y).toBe(438)
    })
    it("keeps the preferred side on a tie and clamps into the viewport", () => {
        const small = {width: 100, height: 100}
        const layout = placeCard({x: 10, y: 10, width: 80, height: 80}, card, small, "right")
        expect(layout).toEqual({x: 8, y: 8, side: "right", notch: 42})
    })
    it("centers over the anchor without a notch and clamps into the viewport", () => {
        expect(placeCard({x: 600, y: 100, width: 400, height: 400}, card, viewport, "center"))
            .toEqual({x: 700, y: 250, side: undefined, notch: 0})
        expect(placeCard({x: 900, y: 550, width: 400, height: 400}, card, viewport, "center"))
            .toEqual({x: 792, y: 492, side: undefined, notch: 0})
    })
    it("places to the right of a panel with a vertical notch", () => {
        const layout = placeCard({x: 0, y: 40, width: 300, height: 500}, card, viewport, "right")
        expect(layout).toEqual({x: 312, y: 240, side: "right", notch: 50})
    })
})
