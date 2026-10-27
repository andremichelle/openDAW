import {describe, expect, it} from "vitest"
import {WclapGuis} from "./WclapGuis"

const bytes = (...values: Array<number>): ArrayBuffer => new Uint8Array(values).buffer

describe("WclapGuis", () => {
    it("delivers every plugin message to every open page of the device", () => {
        const uuid = "device-a"
        const panel: Array<ArrayBuffer> = []
        const window: Array<ArrayBuffer> = []
        const panelGui = WclapGuis.register(uuid, message => panel.push(message))
        const windowGui = WclapGuis.register(uuid, message => window.push(message))
        WclapGuis.deliver(uuid, bytes(1))
        expect(panel.length).toBe(1)
        expect(window.length).toBe(1)
        windowGui.terminate()
        WclapGuis.deliver(uuid, bytes(2))
        expect(panel.length).toBe(2)
        expect(window.length).toBe(1)
        panelGui.terminate()
        WclapGuis.deliver(uuid, bytes(3))
        expect(panel.length).toBe(2)
    })

    it("keeps other devices apart", () => {
        const received: Array<string> = []
        const a = WclapGuis.register("device-b", () => received.push("b"))
        const c = WclapGuis.register("device-c", () => received.push("c"))
        WclapGuis.deliver("device-b", bytes(1))
        expect(received).toEqual(["b"])
        a.terminate()
        c.terminate()
    })

    it("keeps the hovered parameter until the last page of the device closes", () => {
        const uuid = "device-d"
        const first = WclapGuis.register(uuid, () => {})
        const second = WclapGuis.register(uuid, () => {})
        WclapGuis.hover(uuid, 7)
        first.terminate()
        expect(WclapGuis.hoveredParam(uuid)).toBe(7)
        second.terminate()
        expect(WclapGuis.hoveredParam(uuid)).toBe(-1)
    })

    it("ignores a second terminate of the same page", () => {
        const uuid = "device-e"
        const received: Array<number> = []
        const first = WclapGuis.register(uuid, () => received.push(1))
        first.terminate()
        const second = WclapGuis.register(uuid, () => received.push(2))
        first.terminate()
        WclapGuis.deliver(uuid, bytes(1))
        expect(received).toEqual([2])
        second.terminate()
    })

    it("tells only the requested device that its plugin asks to show or hide its window", () => {
        const shown: Array<boolean> = []
        const subscription = WclapGuis.subscribeShow("device-f", visible => shown.push(visible))
        WclapGuis.show("device-f", true)
        WclapGuis.show("device-g", true)
        WclapGuis.show("device-f", false)
        subscription.terminate()
        WclapGuis.show("device-f", true)
        expect(shown).toEqual([true, false])
    })
})
