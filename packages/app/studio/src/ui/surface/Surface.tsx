import css from "./Surface.sass?inline"
import {
    ArrayMultimap,
    asDefined,
    assert,
    Client,
    int,
    isDefined,
    Nullable,
    Option,
    panic,
    Point,
    Procedure,
    Subscription,
    Terminable,
    TerminableOwner,
    Terminator,
    tryCatch
} from "@moises-ai/lib-std"
import {createElement, DomElement} from "@moises-ai/lib-jsx"
import {IconLibrary} from "@/ui/IconLibrary.tsx"
import {ErrorHandler} from "@/errors/ErrorHandler.ts"
import {ValueTooltip} from "@/ui/surface/ValueTooltip.tsx"
import {TextTooltip} from "./TextTooltip"
import {FloatingTextInput} from "@/ui/components/FloatingTextInput.tsx"
import {AnimationFrame, CssUtils, Events, Html, Keyboard} from "@moises-ai/lib-dom"
import {initializeColors} from "@moises-ai/studio-enums"

const className = Html.adoptStyleSheet(css, "Surface")

export interface SurfaceConfigurator {
    config(surface: Surface): void
}

export type KeyEventType = "keydown" | "keypress" | "keyup"

export class Surface implements TerminableOwner {
    static main(configurator: SurfaceConfigurator, errorHandler: ErrorHandler): Surface {
        assert(!isDefined(this.#configurator), "Main must only be called once")
        this.#configurator = configurator
        const surface = this.create(window, "main", null)
        errorHandler.install(window, "main")
        return surface
    }

    static readonly #keyListeners = new ArrayMultimap<KeyEventType, {
        priority: int,
        procedure: Procedure<WindowEventMap[KeyEventType]>
    }>(undefined, ({priority: a}, {priority: b}) => b - a)

    static dispatchGlobalKey(type: KeyEventType, event: KeyboardEvent): void {
        if (Keyboard.isControlKey(event) && event.code === "KeyA") {
            if (!Events.isTextInput(event.target)) {
                event.preventDefault()
            }
        } else if (event.code === "Escape") {
            if (document.activeElement instanceof HTMLElement) {
                document.activeElement.blur()
            }
        }
        for (const {procedure} of this.#keyListeners.get(type)) {
            procedure(event)
            if (event.defaultPrevented) {
                return
            }
        }
    }

    static subscribeKeyboard<K extends KeyEventType>(type: K, procedure: (ev: WindowEventMap[K]) => void, priority: int = 0): Subscription {
        const value = {priority, procedure}
        this.#keyListeners.add(type, value)
        return {terminate: () => this.#keyListeners.remove(type, value)}
    }

    static readonly isAvailable = (): boolean => isDefined(this.#configurator)

    static create(owner: WindowProxy, name: string, parent: Nullable<Surface>): Surface {
        const surface = new Surface(owner, name, parent)
        asDefined(this.#configurator, "main not been called").config(surface)
        assert(!this.#surfacesByWindow.has(owner), `${owner.name} already has a surface`)
        this.#surfacesByWindow.set(owner, surface)
        surface.own({terminate: () => this.#surfacesByWindow.delete(owner)})
        return surface
    }

    static forEach(procedure: Procedure<Surface>): void {this.#surfacesByWindow.forEach(procedure)}

    static get(proxyOrElement?: WindowProxy | Element): Surface {
        const key = this.#findWindowProxy(proxyOrElement)
        return asDefined(this.#surfacesByWindow.get(key) || this.#surfacesByWindow.get(window), "No surfaces defined")
    }

    static #findWindowProxy(element?: WindowProxy | Element): Window {
        if (element instanceof Element) {
            const defaultView = element.ownerDocument.defaultView
            if (defaultView !== null) {
                return defaultView
            }
        }
        if (element !== undefined && "self" in element && element.self === element) {
            return element as Window
        }
        return window
    }

    static getById(id: string): Option<Surface> {return Option.wrap(this.#surfaceById.get(id))}

    static #configurator: Nullable<SurfaceConfigurator> = null

    static readonly #surfaceById = new Map<string, Surface>()
    static readonly #surfacesByWindow = new Map<WindowProxy, Surface>()

    readonly #owner: WindowProxy
    readonly #name: string
    readonly #parent: Nullable<Surface>

    readonly #terminator: Terminator
    readonly #ground: DomElement
    readonly #flyout: DomElement
    readonly #floating: DomElement
    readonly #textTooltip: TextTooltip
    readonly #valueTooltip: ValueTooltip
    readonly #pointer: Point

    private constructor(owner: WindowProxy, name: string, parent: Nullable<Surface>) {
        this.#owner = owner
        this.#name = name
        this.#parent = parent

        this.#terminator = parent?.spawn() ?? new Terminator()
        this.#terminator.own({terminate: () => owner.close()})

        this.#ground = <div className="ground"/>
        this.#flyout = <div className="flyout"/>
        this.#floating = <div className="flyout"/>
        this.#textTooltip = new TextTooltip(this)
        this.#valueTooltip = new ValueTooltip(this)
        this.#pointer = Point.zero()

        owner.document.body.appendChild(
            <div className={className}>
                <IconLibrary/>
                {this.#ground}
                {this.#flyout}
                {this.#floating}
            </div>
        )

        this.#listen()
    }

    own<T extends Terminable>(terminable: T): T {return this.#terminator.own(terminable)}
    ownAll<T extends Terminable>(...terminables: T[]): void {this.#terminator.ownAll(...terminables)}
    spawn(): Terminator {return this.#terminator.spawn()}

    get name(): string {return this.#name}
    get pointer(): Readonly<Point> {return this.#pointer}
    get ground(): DomElement {return this.#ground}
    get flyout(): DomElement {
        const toRemove = Array.from(this.#flyout.children)
        /**
         * We need to postpone this due to an unexpected browser behavior.
         * For some unknown reason <code>Html.empty(this.#flyout)</code> will lead to:
         *
         * NotFoundError: Failed to execute 'remove' on 'Element':
         * The node to be removed is no longer a child of this node. Perhaps it was moved in a 'blur' event handler?
         *
         * If anybody can explain why this code thrown an error, I owe you a beer.
         * The intention of this code is to allow only one flyout.
         */
        AnimationFrame.once(() => toRemove.forEach(element => {
            const {status, error} = tryCatch(() => {if (element.isConnected) {element.remove()}})
            if (status === "failure") {console.warn(error)}
        }))
        return this.#flyout
    }
    get floating(): DomElement {return this.#floating}
    get hasFlyout(): boolean {return this.#flyout.firstChild !== null}
    get owner(): Window {return this.#owner}
    get width(): number {return this.#owner.innerWidth}
    get height(): number {return this.#owner.innerHeight}
    get textTooltip(): TextTooltip {return this.#textTooltip}
    get valueTooltip(): ValueTooltip {return this.#valueTooltip}
    get body(): HTMLElement {return this.#owner.document.body}

    close(): void {
        if (this.root() === this) {
            return panic("You cannot close the main window.")
        } else {
            this.#owner.close()
        }
    }

    new(width: int, height: int, id: string, name: string = "untitled"): Option<Surface> {
        const existing = Surface.#surfaceById.get(id)
        if (isDefined(existing)) {return panic(`${id} is already open`)}
        width = Math.min(this.#owner.innerWidth, width)
        height = Math.min(this.#owner.innerHeight, height)
        const x = (this.#owner.innerWidth - width) >> 1
        const y = (this.#owner.innerHeight - height) >> 1
        const features: WindowFeatures = {
            left: x, top: y, width, height,
            toolbar: 0, location: 0, directories: 0, status: 0,
            menubar: 0, titlebar: 0, scrollbars: 0, resizable: 1
        }
        const owner = this.#owner.open(undefined, id, stringifyFeatures(features))
        if (owner === null) {return Option.None}
        owner.name = name
        owner.document.title = name
        this.#copyHeadElements(owner)
        const surface = Surface.create(owner, name, this)
        Surface.#surfaceById.set(id, surface)
        return Option.wrap(surface)
    }

    root(): Surface {
        let surface: Surface = this
        do {
            if (surface.#parent === null) {return surface}
            surface = surface.#parent
        } while (true)
    }

    async requestFloatingTextInput(client: Client, value?: string): Promise<string> {
        const resolvers = Promise.withResolvers<string>()
        this.flyout.appendChild(FloatingTextInput({
            position: {x: client.clientX, y: client.clientY},
            value: value ?? "Type new value...",
            resolvers
        }))
        return resolvers.promise.catch(() => value ?? "")
    }

    toString(): string {
        return `Surface name: ${this.#name}`
    }

    #copyHeadElements(proxy: Window): void {
        const source = this.root().#owner.document
        const target = proxy.document
        const elements = Array.from(source.head.children).filter(child => child.tagName.toLowerCase() !== "script")
        for (const element of elements) {target.head.append(element.cloneNode(true))}
        for (const sheet of source.adoptedStyleSheets) {
            const styleElement = target.createElement("style")
            styleElement.textContent = Array.from(sheet.cssRules).map(rule => rule.cssText).join("\n")
            target.head.appendChild(styleElement)
        }
        initializeColors(target.documentElement)
    }

    #listen(): void {
        // Workaround for not receiving outside pointer-up events
        // If you click inside the browser window, move outside, add another (mouse) button
        // and release both, no pointerup is fired.
        // TODO I see that way too often on Windows machines in error reports.
        //  There is still something off.
        let pointerDown: Option<EventTarget> = Option.None
        const document = this.#owner.document
        this.#terminator.ownAll(
            Events.subscribe(this.#owner, "pointerdown", (event: PointerEvent) => {
                if (pointerDown.nonEmpty()) {
                    // TODO There is a strange behavior on some machines, where it appears
                    //  that the pointerdown event is sent twice immediately (related to to-do above)
                    console.debug("simulate pointerup onpointerdown", Date.now())
                    pointerDown.unwrap().dispatchEvent(new PointerEvent("pointerup", event))
                    pointerDown = Option.None
                }
                this.#pointer.x = event.clientX
                this.#pointer.y = event.clientY
                pointerDown = Option.wrap(event.target)
            }, {capture: true}),
            Events.subscribe(this.#owner, "pointermove", (event: PointerEvent) => {
                if (pointerDown.nonEmpty() && event.buttons === 0) {
                    console.debug("simulate pointerup pointermove")
                    pointerDown.unwrap().dispatchEvent(new PointerEvent("pointerup", event))
                    pointerDown = Option.None
                }
                this.#pointer.x = event.clientX
                this.#pointer.y = event.clientY
            }, {capture: true}),
            Events.subscribe(this.#owner, "pointerup", (_event: PointerEvent) => {
                pointerDown = Option.None
            }, {capture: true}),
            Events.subscribe(this.#owner, "dragover", (event: DragEvent) => {
                this.#pointer.x = event.clientX
                this.#pointer.y = event.clientY
            }, {capture: true}),
            Events.subscribe(this.#owner, "dragend", (_event: DragEvent) => {
                pointerDown = Option.None
            }, {capture: true}),
            Events.subscribe(this.#owner, "beforeunload", () => {
                if (this.#owner === self) {return} // We are leaving the main window. Nothing to do.
                console.debug(`Before-unload surface: '${this.#owner.name}'`)
                for (const [id, surface] of Surface.#surfaceById.entries()) {
                    if (surface === this) {
                        Surface.#surfaceById.delete(id)
                        break
                    }
                }
                Surface.#surfacesByWindow.delete(this.#owner)
                this.#terminator.terminate()
                this.#adoptAnimationFrame()
            }, {capture: true, once: true}),
            Events.subscribe(this.#owner, "keydown", (event: KeyboardEvent) =>
                Surface.dispatchGlobalKey("keydown", event)),
            Events.subscribe(this.#owner, "keypress", (event: KeyboardEvent) =>
                Surface.dispatchGlobalKey("keypress", event)),
            Events.subscribe(this.#owner, "keyup", (event: KeyboardEvent) =>
                Surface.dispatchGlobalKey("keyup", event)),
            // Seems to reset the custom cursor faithfully when leaving and re-entering the studio (blur did not)
            Events.subscribe(this.#owner, "focus", () => AnimationFrame.once(() => CssUtils.setCursor("auto"))),
            // Ctrl + scroll on Linux can affect web UI elements because it typically triggers zoom in most browsers.
            Events.subscribe(this.#owner, "wheel", (event) => {
                if (event.ctrlKey) {event.preventDefault()}
            }, {passive: false}),
            Events.subscribe(this.#owner, "contextmenu", (event) => {
                event.preventDefault()
                event.stopPropagation()
                AnimationFrame.once(() => CssUtils.setCursor("auto"))
            }, {capture: true}),
            Events.subscribe(document.body, "touchmove", Events.PreventDefault, {capture: true}),
            Events.subscribeAny(document, "visibilitychange", () => this.#adoptAnimationFrame(), {capture: true})
        )
    }

    #adoptAnimationFrame(): void {
        for (const owner of Surface.#surfacesByWindow.keys()) {
            if (!owner.document.hidden) {
                AnimationFrame.start(owner)
                return
            }
        }
    }
}

type WindowFeatures = {
    top: number
    left: number
    width: number
    height: number
    toolbar: number
    menubar: number
    titlebar: number
    scrollbars: number
    resizable: number
    directories: number
    location: number
    status: number
}

const stringifyFeatures = (features: WindowFeatures): string =>
    Object.entries(features).map(([key, value]: [string, number]) => `${key}=${value}`).join(",")