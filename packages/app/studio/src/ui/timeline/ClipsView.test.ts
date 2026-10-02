import {describe, expect, it} from "vitest"
import {DefaultObservableValue} from "@opendaw/lib-std"
import {ClipsView} from "@/ui/timeline/ClipsView"

const create = () => new ClipsView(new DefaultObservableValue(true))

describe("ClipsView", () => {
    it("starts with the minimum columns, three visible, no scroll", () => {
        const view = create()
        expect(view.columns.getValue()).toBe(16)
        expect(view.count.getValue()).toBe(3)
        expect(view.scroll.getValue()).toBe(0)
    })
    describe("reset", () => {
        it("keeps the minimum when nothing or little is occupied", () => {
            const view = create()
            view.reset(-1) // no clips
            expect(view.columns.getValue()).toBe(16)
            view.reset(0)
            expect(view.columns.getValue()).toBe(16)
            view.reset(3)
            expect(view.columns.getValue()).toBe(16)
        })
        it("leaves one free column after the highest occupied index", () => {
            const view = create()
            view.reset(15)
            expect(view.columns.getValue()).toBe(17)
            view.reset(40)
            expect(view.columns.getValue()).toBe(42)
        })
        it("resets scroll and keeps the previous visible count", () => {
            const view = create()
            view.setCount(5, 100)
            view.scrollBy(4)
            view.reset(20)
            expect(view.scroll.getValue()).toBe(0)
            expect(view.count.getValue()).toBe(5)
        })
    })
    describe("setCount", () => {
        it("clamps to at least one", () => {
            const view = create()
            view.setCount(0, 100)
            expect(view.count.getValue()).toBe(1)
            view.setCount(-3, 100)
            expect(view.count.getValue()).toBe(1)
        })
        it("clamps to fit and to columns", () => {
            const view = create()
            view.setCount(12, 8)
            expect(view.count.getValue()).toBe(8)
            view.setCount(30, 100)
            expect(view.count.getValue()).toBe(16)
        })
        it("keeps one column when nothing fits", () => {
            const view = create()
            view.setCount(5, 0)
            expect(view.count.getValue()).toBe(1)
        })
        it("re-clamps scroll when growing past the end", () => {
            const view = create()
            view.scrollTo(13)
            expect(view.scroll.getValue()).toBe(13)
            view.setCount(8, 100)
            expect(view.scroll.getValue()).toBe(8)
        })
        it("keeps scroll when shrinking", () => {
            const view = create()
            view.scrollTo(10)
            view.setCount(1, 100)
            expect(view.scroll.getValue()).toBe(10)
        })
    })
    describe("scroll", () => {
        it("clamps to [0, columns - visible]", () => {
            const view = create()
            view.scrollBy(-5)
            expect(view.scroll.getValue()).toBe(0)
            view.scrollBy(100)
            expect(view.scroll.getValue()).toBe(13)
            view.scrollBy(-2)
            expect(view.scroll.getValue()).toBe(11)
        })
        it("cannot scroll when everything is visible", () => {
            const view = create()
            view.setCount(16, 100)
            view.scrollBy(1)
            expect(view.scroll.getValue()).toBe(0)
        })
    })
    describe("ensureColumn", () => {
        it("grows so one free column follows the index", () => {
            const view = create()
            view.ensureColumn(15)
            expect(view.columns.getValue()).toBe(17)
            view.ensureColumn(30)
            expect(view.columns.getValue()).toBe(32)
        })
        it("never shrinks", () => {
            const view = create()
            view.ensureColumn(30)
            view.ensureColumn(2)
            expect(view.columns.getValue()).toBe(32)
        })
    })
    describe("reveal", () => {
        it("does nothing when the column is inside the view", () => {
            const view = create()
            view.scrollTo(4)
            view.reveal(4)
            view.reveal(6)
            expect(view.scroll.getValue()).toBe(4)
        })
        it("scrolls left so the column is the first cell", () => {
            const view = create()
            view.scrollTo(8)
            view.reveal(2)
            expect(view.scroll.getValue()).toBe(2)
        })
        it("scrolls right so the column is the last cell", () => {
            const view = create()
            view.reveal(10)
            expect(view.scroll.getValue()).toBe(8)
        })
        it("reveals a freshly grown column", () => {
            const view = create()
            view.ensureColumn(20)
            view.reveal(21)
            expect(view.scroll.getValue()).toBe(19)
        })
    })
})
