// @vitest-environment jsdom

import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {createElement} from "./create-element"
import {Inject} from "./inject"

// Simulates a script-blocking extension that swaps the global Function constructor (live 1143)
const stubGlobalFunction = () => {
    vi.stubGlobal("Function", function FakeFunction() {})
    expect((() => 0) instanceof Function).toBe(false)
}

const asElement = (value: unknown): HTMLElement => {
    expect(value).toBeInstanceOf(HTMLElement)
    return value as HTMLElement
}

describe("createElement", () => {
    const frames: Array<FrameRequestCallback> = []
    const flushFrames = () => {
        const pending = frames.splice(0, frames.length)
        pending.forEach(callback => callback(0))
    }

    beforeEach(() => vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frames.push(callback)
        return frames.length
    }))
    afterEach(() => {
        vi.unstubAllGlobals()
        frames.length = 0
        document.body.replaceChildren()
    })

    it("onInit runs once with the created element", () => {
        const onInit = vi.fn((_element: Element) => {})
        const div = asElement(createElement("div", {onInit}))
        expect(onInit).toHaveBeenCalledTimes(1)
        expect(onInit).toHaveBeenCalledWith(div)
    })

    it("onInit accepts every single-argument function kind", () => {
        const seen: Array<Element> = []
        class Holder {
            static collect(element: Element) {seen.push(element)}
        }
        const arrow = asElement(createElement("div", {onInit: (element: Element) => seen.push(element)}))
        const expression = asElement(createElement("div", {onInit: function (element: Element) {seen.push(element)}}))
        const method = asElement(createElement("div", {onInit: Holder.collect}))
        const bound = asElement(createElement("div", {onInit: Holder.collect.bind(Holder)}))
        expect(seen).toEqual([arrow, expression, method, bound])
    })

    it("onInit undefined is ignored", () => {
        expect(() => createElement("div", {onInit: undefined})).not.toThrow()
    })

    it("onInit rejects non-functions and wrong arity", () => {
        expect(() => createElement("div", {onInit: () => {}})).toThrow("must be a Function with a single argument")
        expect(() => createElement("div", {onInit: (_a: Element, _b: number) => {}}))
            .toThrow("must be a Function with a single argument")
        expect(() => createElement("div", {onInit: "text"})).toThrow("must be a Function with a single argument")
        expect(() => createElement("div", {onInit: null})).toThrow("must be a Function with a single argument")
        expect(() => createElement("div", {onInit: {}})).toThrow("must be a Function with a single argument")
    })

    it("onConnect waits for the element to be connected", () => {
        const onConnect = vi.fn((_element: Element) => {})
        const div = asElement(createElement("div", {onConnect}))
        expect(onConnect).not.toHaveBeenCalled()
        flushFrames()
        expect(onConnect).not.toHaveBeenCalled()
        expect(frames.length).toBe(1)
        document.body.append(div)
        flushFrames()
        expect(onConnect).toHaveBeenCalledTimes(1)
        expect(onConnect).toHaveBeenCalledWith(div)
        expect(frames.length).toBe(0)
    })

    it("onConnect rejects non-functions and wrong arity", () => {
        expect(() => createElement("div", {onConnect: () => {}})).toThrow("must be a Function with a single argument")
        expect(() => createElement("div", {onConnect: 1})).toThrow("must be a Function with a single argument")
        expect(() => createElement("div", {onConnect: undefined})).not.toThrow()
    })

    it("onInit and onConnect survive a replaced global Function", () => {
        stubGlobalFunction()
        const onInit = vi.fn((_element: Element) => {})
        const onConnect = vi.fn((_element: Element) => {})
        const div = asElement(createElement("div", {onInit, onConnect}))
        expect(onInit).toHaveBeenCalledWith(div)
        document.body.append(div)
        flushFrames()
        expect(onConnect).toHaveBeenCalledWith(div)
        expect(() => createElement("div", {onInit: () => {}})).toThrow("must be a Function with a single argument")
    })

    it("factories, elements, refs and attributes keep working with a replaced global Function", () => {
        stubGlobalFunction()
        const ref = Inject.ref<HTMLSpanElement>()
        const Label = ({text}: { text: string }) => createElement("span", {ref, className: "label"}, text)
        const div = asElement(createElement("div", {id: "root", "data-x": "1"}, createElement(Label, {text: "hello"})))
        expect(div.id).toBe("root")
        expect(div.getAttribute("data-x")).toBe("1")
        expect(ref.get()).toBe(div.firstElementChild)
        expect(ref.get().className).toBe("label")
        expect(ref.get().textContent).toBe("hello")
        expect(createElement(div, null)).toBe(div)
    })

    it("factory with two parameters consumes the children", () => {
        const Wrapper = (_attributes: Readonly<Record<string, unknown>>, children?: ReadonlyArray<unknown>) =>
            createElement("div", {className: "wrapper"}, ...(children ?? []))
        const div = asElement(createElement(Wrapper, null, createElement("b", null, "x"), "y"))
        expect(div.className).toBe("wrapper")
        expect(div.childNodes.length).toBe(2)
        expect(div.innerHTML).toBe("<b>x</b>y")
    })
})
