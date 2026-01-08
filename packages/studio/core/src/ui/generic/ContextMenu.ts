import {Client, Option, Subscription} from "@opendaw/lib-std"
import {Events} from "@opendaw/lib-dom"
import {MenuItem} from "./menu-item"

export namespace ContextMenu {
    export const CONTEXT_MENU_EVENT_TYPE = "--context-menu" as const

    export type MenuFactory = (menuItem: MenuItem, client: Client) => void

    export interface Collector {
        addItems(...items: MenuItem[]): this

        get client(): Client
    }

    class CollectorImpl implements Collector {
        static collecting: Option<CollectorImpl> = Option.None

        readonly root = MenuItem.root()

        #hasItems: boolean = false
        #separatorBefore: boolean = false

        constructor(readonly client: Client) {}

        get hasItems(): boolean {return this.#hasItems}

        readonly addItems = (...items: MenuItem[]): this => {
            items.forEach((item: MenuItem) => {
                if (item.hidden) {return}
                if (this.#separatorBefore) {item.addSeparatorBefore()}
                this.root.addMenuItem(item)
                this.#hasItems = true
                this.#separatorBefore = false
            })
            this.#separatorBefore = true
            return this
        }

        abort(): void {CollectorImpl.collecting = Option.None}
    }

    export const install = (owner: WindowProxy, menuFactory: MenuFactory): Subscription => {
        return Events.subscribe(owner, "contextmenu", async (mouseEvent: MouseEvent) => {
            if (CollectorImpl.collecting.nonEmpty()) {
                console.warn("One context-menu is still populating (abort)")
                return
            }
            mouseEvent.preventDefault()
            const event: Event = new Event(CONTEXT_MENU_EVENT_TYPE, {bubbles: true, composed: true, cancelable: true})
            CollectorImpl.collecting = Option.wrap(new CollectorImpl(mouseEvent))
            mouseEvent.target?.dispatchEvent(event)
            if (CollectorImpl.collecting.nonEmpty()) {
                const collector = CollectorImpl.collecting.unwrap()
                if (collector.hasItems) {
                    menuFactory(collector.root, mouseEvent)
                }
                CollectorImpl.collecting = Option.None
            }
        }, {capture: true})
    }

    export const subscribe = (target: EventTarget, collect: (collector: Collector) => void): Subscription =>
        Events.subscribeAny(target, CONTEXT_MENU_EVENT_TYPE, () =>
            CollectorImpl.collecting.ifSome((collector: CollectorImpl) => collect(collector)), {capture: false})
}
