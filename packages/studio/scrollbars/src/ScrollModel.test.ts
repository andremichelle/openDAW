import {describe, expect, it} from "vitest"
import {ScrollModel} from "./ScrollModel"

const create = (visibleSize: number, contentSize: number): ScrollModel => {
    const model = new ScrollModel()
    model.visibleSize = visibleSize
    model.contentSize = contentSize
    return model
}

describe("ScrollModel", () => {
    it("is not scrollable while the content fits", () => {
        const model = create(400, 300)
        model.position = 100
        expect(model.scrollable()).toBe(false)
        expect(model.position).toBe(0)
    })
    it("keeps the pixel position when the content grows", () => {
        const model = create(400, 1000)
        model.position = 150
        model.contentSize = 2000
        expect(model.position).toBe(150)
    })
    it("keeps the pixel position when the content shrinks but still overflows", () => {
        const model = create(400, 2000)
        model.position = 300
        model.contentSize = 1000
        expect(model.position).toBe(300)
    })
    it("clamps the position when the content shrinks below it", () => {
        const model = create(400, 2000)
        model.position = 1500
        model.contentSize = 1000
        expect(model.position).toBe(600)
    })
    it("resets to zero when the content no longer overflows", () => {
        const model = create(400, 1000)
        model.position = 300
        model.contentSize = 400
        expect(model.position).toBe(0)
        model.contentSize = 1000
        expect(model.position).toBe(0)
    })
    it("does not stay pinned to the end when the content grows", () => {
        const model = create(400, 1000)
        model.position = 600
        expect(model.normalized).toBe(1.0)
        model.contentSize = 1200
        expect(model.position).toBe(600)
    })
    it("advances one pixel per step while the content grows in lockstep (track resize auto-scroll)", () => {
        const model = create(382, 436)
        for (let step = 1; step <= 500; step++) {
            model.position += 1
            model.contentSize += 1
            expect(model.position).toBe(step)
        }
    })
    it("round-trips integer positions for many overflow sizes", () => {
        for (let contentSize = 401; contentSize < 3000; contentSize += 7) {
            const model = create(400, contentSize)
            for (let position = 0; position <= contentSize - 400; position += 13) {
                model.position = position
                expect(model.position).toBe(position)
            }
        }
    })
    it("clamps positions outside the range", () => {
        const model = create(400, 1000)
        model.position = -50
        expect(model.position).toBe(0)
        model.position = 5000
        expect(model.position).toBe(600)
    })
    it("moves by a delta in pixels", () => {
        const model = create(400, 1000)
        model.position = 100
        model.moveBy(25)
        expect(model.position).toBe(125)
    })
})
