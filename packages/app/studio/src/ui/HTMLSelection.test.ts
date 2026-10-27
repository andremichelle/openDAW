// @vitest-environment jsdom

import {afterEach, beforeEach, describe, expect, it} from "vitest"
import {HTMLSelection} from "@/ui/HTMLSelection"

// Live error 1190: Shift+click after the last clicked entry was hidden (collapsed folder) read nodes[-1].classList
describe("HTMLSelection", () => {
    let container: HTMLElement
    let folder: HTMLElement
    let entries: ReadonlyArray<HTMLElement>
    let selection: HTMLSelection
    const entry = (name: string): HTMLElement => {
        const element = document.createElement("div")
        element.setAttribute("data-selection", "")
        element.textContent = name
        return element
    }
    // jsdom has no PointerEvent and reports listener exceptions to window instead of throwing
    const press = (target: HTMLElement, init: MouseEventInit = {}): ReadonlyArray<unknown> => {
        const errors: Array<unknown> = []
        const onError = (event: ErrorEvent) => {
            errors.push(event.error)
            event.preventDefault()
        }
        window.addEventListener("error", onError)
        target.dispatchEvent(new MouseEvent("pointerdown", {bubbles: true, ...init}))
        window.removeEventListener("error", onError)
        return errors
    }
    const selectedNames = () => selection.getSelected().map(element => element.textContent)
    beforeEach(() => {
        container = document.createElement("div")
        folder = document.createElement("div")
        entries = ["a", "b", "c", "d", "e"].map(entry)
        container.append(entries[0], entries[1])
        folder.append(entries[2], entries[3])
        container.append(folder, entries[4])
        document.body.append(container)
        selection = new HTMLSelection(container)
    })
    afterEach(() => {
        selection.terminate()
        container.remove()
    })
    it("selects a range with shift", () => {
        press(entries[1])
        press(entries[3], {shiftKey: true})
        expect(selectedNames()).toEqual(["b", "c", "d"])
    })
    it("selects from the first entry when nothing was clicked before", () => {
        press(entries[2], {shiftKey: true})
        expect(selectedNames()).toEqual(["a", "b", "c"])
    })
    it("does not throw when the last clicked entry was hidden", () => {
        press(entries[2])
        folder.classList.add("hidden")
        expect(press(entries[4], {shiftKey: true})).toEqual([])
        expect(selectedNames()).toEqual(["c", "e"])
    })
    it("does not throw when the last clicked entry was removed", () => {
        press(entries[2])
        entries[2].remove()
        expect(press(entries[4], {shiftKey: true})).toEqual([])
        expect(selectedNames()).toEqual(["e"])
    })
})
