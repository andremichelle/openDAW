import {describe, expect, it, vi} from "vitest"
import {Exec, Func, Notifier, Terminable, Terminator} from "@opendaw/lib-std"
import {ContextMenu} from "./ContextMenu"
import {MenuItem} from "../menu/MenuItems"

type Opened = { menu: Terminator, watch: Func<Exec, Terminable> }

const openMenu = async (collect: (collector: ContextMenu.Collector) => void): Promise<Opened> => {
    const owner = new EventTarget()
    const {promise, resolve} = Promise.withResolvers<Opened>()
    const installation = ContextMenu.install(owner as unknown as WindowProxy, (_root, _event, watch) =>
        resolve({menu: new Terminator(), watch}))
    const subscription = ContextMenu.subscribe(owner, collect)
    owner.dispatchEvent(new Event("contextmenu"))
    const opened = await promise
    installation.terminate()
    subscription.terminate()
    return opened
}

describe("ContextMenu", () => {
    it("closes the menu when a watched target goes away", async () => {
        const deleted = new Notifier<void>()
        const {menu, watch} = await openMenu(collector => {
            collector.addItems(MenuItem.default({label: "Edit"}))
            collector.closeWhen(close => deleted.subscribe(() => close()))
        })
        const close = vi.fn(() => menu.terminate())
        menu.own(watch(close))
        deleted.notify()
        expect(close).toHaveBeenCalledTimes(1)
    })

    it("stops watching once the menu is closed", async () => {
        const deleted = new Notifier<void>()
        const {menu, watch} = await openMenu(collector => {
            collector.addItems(MenuItem.default({label: "Edit"}))
            collector.closeWhen(close => deleted.subscribe(() => close()))
        })
        const close = vi.fn()
        menu.own(watch(close))
        menu.terminate()
        deleted.notify()
        expect(close).not.toHaveBeenCalled()
    })
})
