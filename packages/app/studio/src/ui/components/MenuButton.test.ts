// @vitest-environment jsdom

import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {Exec, Option} from "@opendaw/lib-std"
import {MenuItem} from "@opendaw/studio-core"

// Live error 1199 (live room): a peer deleted an effect while its device menu was open. The device editor was
// removed, the menu stayed, and "Replace…" ran on the detached effect ("no device-host"). An open menu must close
// once its button has left the document, and a menu closed the normal way must leave nothing behind.

vi.hoisted(() => {
    if (!("AudioWorkletNode" in globalThis)) {Reflect.set(globalThis, "AudioWorkletNode", class {})}
    // jsdom has no onpointer* handler properties, lib-jsx only assigns handlers an element can hold
    for (const type of ["pointerdown", "pointerenter"]) {
        const handlers = new WeakMap<HTMLElement, EventListener>()
        Object.defineProperty(HTMLElement.prototype, `on${type}`, {
            configurable: true,
            get(this: HTMLElement) {return handlers.get(this) ?? null},
            set(this: HTMLElement, handler: EventListener) {
                const previous = handlers.get(this)
                if (previous !== undefined) {this.removeEventListener(type, previous)}
                handlers.set(this, handler)
                this.addEventListener(type, handler)
            }
        })
    }
})
const frames = vi.hoisted(() => new Set<() => void>())
const flyout = vi.hoisted(() => ({element: null as unknown as HTMLElement}))

vi.mock("@opendaw/lib-dom", async importOriginal => {
    const original = await importOriginal<typeof import("@opendaw/lib-dom")>()
    return {
        ...original,
        Html: {...original.Html, adoptStyleSheet: (_css: string, prefix?: string) => prefix ?? "C"},
        AnimationFrame: {
            ...original.AnimationFrame,
            add: (exec: Exec) => {
                frames.add(exec)
                return {terminate: () => frames.delete(exec)}
            }
        }
    }
})
vi.mock("@/ui/surface/Surface.tsx", () => ({Surface: {get: () => ({owner: window})}}))
vi.mock("@/ui/surface/Layers.tsx", () => ({
    Layers: {get: () => ({flyout: flyout.element}), nestedOrigin: () => Option.None}
}))

const runFrame = () => Array.from(frames).forEach(exec => exec())

describe("MenuButton closes its menu when the button leaves the document (live error 1199)", () => {
    let container: HTMLElement
    let triggered: number
    let button: HTMLButtonElement
    const press = () => button.dispatchEvent(new MouseEvent("pointerdown", {bubbles: true}))
    const openMenus = () => flyout.element.childElementCount
    beforeEach(async () => {
        const {MenuButton} = await import("@/ui/components/MenuButton.tsx")
        frames.clear()
        triggered = 0
        container = document.createElement("div")
        flyout.element = document.createElement("div")
        document.body.append(container, flyout.element)
        const root = MenuItem.root()
            .setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                MenuItem.default({label: "Replace…"}).setTriggerProcedure(() => triggered++)))
        button = MenuButton({root}, []) as HTMLButtonElement
        container.append(button)
    })
    afterEach(() => {
        container.remove()
        flyout.element.remove()
    })
    it("keeps the menu open while the button is in the document", () => {
        press()
        expect(openMenus()).toBe(1)
        runFrame()
        expect(openMenus()).toBe(1)
        expect(button.classList.contains("active")).toBe(true)
    })
    it("closes the menu once the button is removed", () => {
        press()
        expect(openMenus()).toBe(1)
        button.remove()
        runFrame()
        expect(openMenus()).toBe(0)
        expect(button.classList.contains("active")).toBe(false)
        expect(triggered).toBe(0)
    })
    it("leaves no frame check behind after a normal close", () => {
        press()
        press()
        expect(openMenus()).toBe(0)
        expect(frames.size).toBe(0)
    })
    it("can open again after the menu was closed by removal", () => {
        press()
        button.remove()
        runFrame()
        container.append(button)
        press()
        expect(openMenus()).toBe(1)
        expect(frames.size).toBe(1)
    })
})
