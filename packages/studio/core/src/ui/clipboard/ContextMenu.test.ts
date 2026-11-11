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

    const labelsOf = async (target: Element): Promise<ReadonlyArray<string>> => {
        const {promise, resolve} = Promise.withResolvers<ReadonlyArray<string>>()
        const installation = ContextMenu.install(window, root => resolve(root.collectChildren()
            .map(item => item.data.type === "default" ? item.data.label : "")))
        target.dispatchEvent(new MouseEvent("contextmenu", {bubbles: true, cancelable: true}))
        const labels = await promise
        installation.terminate()
        return labels
    }

    const nested = () => {
        const parent = document.createElement("div")
        const child = document.createElement("div")
        parent.appendChild(child)
        document.body.appendChild(parent)
        return {parent, child}
    }

    it("collects from the target and every ancestor, innermost first", async () => {
        const {parent, child} = nested()
        const subscriptions = Terminable.many(
            ContextMenu.subscribe(parent, collector => collector.addItems(MenuItem.default({label: "parent"}))),
            ContextMenu.subscribe(child, collector => collector.addItems(MenuItem.default({label: "child"}))))
        expect(await labelsOf(child)).toStrictEqual(["child", "parent"])
        subscriptions.terminate()
        parent.remove()
    })

    it("stopPropagation keeps the ancestors out", async () => {
        const {parent, child} = nested()
        const subscriptions = Terminable.many(
            ContextMenu.subscribe(parent, collector => collector.addItems(MenuItem.default({label: "parent"}))),
            ContextMenu.subscribe(child, collector => {
                collector.addItems(MenuItem.default({label: "child"}))
                collector.stopPropagation()
            }))
        expect(await labelsOf(child)).toStrictEqual(["child"])
        expect(await labelsOf(parent)).toStrictEqual(["parent"])
        subscriptions.terminate()
        parent.remove()
    })
})
