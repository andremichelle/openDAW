import {Client, Option, Subscription} from "@opendaw/lib-std"
import {Events} from "@opendaw/lib-dom"
import {MenuItem, MenuRootData} from "./MenuItems"

export namespace ContextMenu {
    export const CONTEXT_MENU_EVENT_TYPE = "--context-menu" as const

    export type MenuFactory = (menuItem: MenuItem, client: Client) => void

    export interface Collector {
        addItems(...items: MenuItem[]): this

        get client(): Client
    }

    class CollectorImpl implements Collector {
        static collecting: Option<CollectorImpl> = Option.None

        readonly #root = MenuItem.root()

        #chain: Promise<void> = Promise.resolve()

        #hasItems: boolean = false
        #separatorBefore: boolean = false

        constructor(readonly client: Client) {}

        get root(): MenuItem<MenuRootData> {return this.#root}
        get hasItems(): boolean {return this.#hasItems}

        readonly addItems = (...items: MenuItem[]): this => {
            items.forEach((item: MenuItem) => {
                if (item.hidden) {return}
                if (this.#separatorBefore) {item.addSeparatorBefore()}
                this.#root.addMenuItem(item)
                this.#hasItems = true
                this.#separatorBefore = false
            })
            this.#separatorBefore = true
            return this
        }

        readonly appendToChain = (fn: () => unknown): void => {
            this.#chain = this.#chain.then(async () => {await fn()})
        }
        readonly waitForChain = (): Promise<void> => this.#chain

        abort(): void {CollectorImpl.collecting = Option.None}
    }

    export const install = (owner: WindowProxy, menuFactory: MenuFactory): Subscription =>
        Events.subscribe(owner, "contextmenu", async (mouseEvent: MouseEvent) => {
            if (CollectorImpl.collecting.nonEmpty()) {
                console.warn("One context-menu is still populating (abort)")
                return
            }
            mouseEvent.preventDefault()
            const event: Event = new Event(CONTEXT_MENU_EVENT_TYPE, {bubbles: true, composed: true, cancelable: true})
            const collector = new CollectorImpl(mouseEvent)
            CollectorImpl.collecting = Option.wrap(collector)
            mouseEvent.target?.dispatchEvent(event)
            await collector.waitForChain()
            if (CollectorImpl.collecting.nonEmpty()) {
                if (collector.hasItems) {
                    menuFactory(collector.root, mouseEvent)
                }
                CollectorImpl.collecting = Option.None
            }
        }, {capture: true})

    export const subscribe = (target: EventTarget, collect: (collector: Collector) => unknown): Subscription =>
        Events.subscribeAny(target, CONTEXT_MENU_EVENT_TYPE, () =>
            CollectorImpl.collecting.ifSome((collector: CollectorImpl) => {
                collector.appendToChain(() => collect(collector))
            }), {capture: false})
}