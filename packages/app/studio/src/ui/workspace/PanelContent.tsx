import {PanelContentFactory} from "@/ui/workspace/PanelContents.tsx"
import {DomElement, JsxValue, replaceChildren} from "@opendaw/lib-jsx"
import {assert, isDefined, Option, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {PanelType} from "@/ui/workspace/PanelType.ts"
import {PanelState} from "@/ui/workspace/PanelState.ts"
import {Surface} from "../surface/Surface"
import {Dialogs} from "@/ui/components/dialogs.tsx"
import {Html} from "@opendaw/lib-dom"
import {TourAnchor} from "@/ui/tour/TourAnchor"
import {TourAnchors} from "@/ui/tour/TourAnchors"

export type PlaceHolder = {
    panelState: PanelState
    container: DomElement
    listener: PanelContentListener
}

export interface PanelContentListener {
    onEmbed(): void
    onPopout(): void
    onMinimized(): void
}

export interface PanelContentHandler extends Terminable {
    togglePopout(): void
    toggleMinimize(): void
    isPopout(): boolean
}

const PanelAnchors: Partial<Record<PanelType, ReadonlyArray<TourAnchor>>> = {
    [PanelType.BrowserPanel]: ["presets", "samples", "soundfonts"],
    [PanelType.DevicePanel]: ["devices"],
    [PanelType.Analysis]: ["analysis"],
    [PanelType.Modulation]: ["modulation"]
}

export class PanelContent {
    readonly #factory: PanelContentFactory
    readonly #panelType: PanelType

    readonly #terminator: Terminator
    readonly #id: string

    #placeholder: Option<PlaceHolder> = Option.None
    #popoutBuilt: boolean = false

    constructor(factory: PanelContentFactory, panelType: PanelType) {
        this.#factory = factory
        this.#panelType = panelType

        this.#terminator = new Terminator()
        this.#id = UUID.toString(UUID.generate())
    }

    bind(panelState: PanelState, container: DomElement, listener: PanelContentListener): PanelContentHandler {
        assert(this.#placeholder.isEmpty(),
            `Cannot have panel open in multiple location (${this.#placeholder.unwrapOrNull()?.panelState})`)
        this.#placeholder = Option.wrap({panelState, container, listener})
        if (this.isPopout) {
            this.#restorePopout()
            listener.onPopout()
        } else if (panelState.isMinimized) {
            listener.onMinimized()
        } else {
            replaceChildren(container, this.#createContent())
            listener.onEmbed()
        }
        return {
            togglePopout: this.togglePopout.bind(this),
            toggleMinimize: this.toggleMinimize.bind(this),
            terminate: this.#onPlaceholderLeaves.bind(this),
            isPopout: (): boolean => this.isPopout
        } satisfies PanelContentHandler
    }

    get isPopout(): boolean {return Surface.getById(this.#id).nonEmpty()}

    releasePopout(): void {
        if (!this.#popoutBuilt) {return}
        this.#terminator.terminate()
        Surface.getById(this.#id).ifSome(surface => Html.empty(surface.ground))
        this.#popoutBuilt = false
    }
    get panelState(): Option<PanelState> {return this.#placeholder.map(placeholder => placeholder.panelState)}
    // True when the panel is popped-out in its own window, or embedded and
    // not minimized.
    get isVisible(): boolean {
        if (this.isPopout) {return true}
        return this.panelState.mapOr(state => !state.isMinimized, false)
    }

    togglePopout(): void {
        if (this.#placeholder.isEmpty()) {
            console.debug("Cannot togglePopout. No Placeholder available.")
            return
        }
        const {panelState, container, listener} = this.#placeholder.unwrap()
        if (!panelState.popoutable) {return}
        if (this.isPopout) {
            this.#closePopout()
        } else {
            Surface.get()
                .new(640, 480, this.#id, panelState.name)
                .match({
                    none: () => {
                        Dialogs.info({message: "Could not open window. Check popup blocker?"}).finally()
                    },
                    some: surface => {
                        this.#terminator.terminate()
                        Html.empty(container)
                        replaceChildren(surface.ground, this.#createContent())
                        this.#popoutBuilt = true
                        listener.onPopout()
                        surface.own({
                            terminate: () => {
                                this.#terminator.terminate()
                                Html.empty(surface.ground)
                                this.#popoutBuilt = false
                                this.#onSurfaceCloses()
                            }
                        })
                    }
                })
        }
    }

    focusPopout(): void {Surface.getById(this.#id).ifSome(surface => surface.owner.focus())}

    toggleMinimize(): void {
        if (this.#placeholder.isEmpty()) {
            console.debug("Cannot toggleMinimize. No Placeholder available.")
            return
        }
        const {panelState, container, listener} = this.#placeholder.unwrap()
        if (!panelState.minimizable) {return}
        if (this.isPopout) {
            this.#closePopout()
        } else if (panelState.isMinimized) {
            replaceChildren(container, this.#createContent())
            panelState.isMinimized = false
            listener.onEmbed()
        } else {
            this.#terminator.terminate()
            Html.empty(container)
            panelState.isMinimized = true
            listener.onMinimized()
        }
    }

    #onPlaceholderLeaves(): void {
        const {container} = this.#placeholder.unwrap("Illegal State Error (no placeholder)")
        this.#placeholder = Option.None
        if (!this.isPopout) {
            this.#terminator.terminate()
            Html.empty(container)
        }
    }

    #onSurfaceCloses(): void {
        if (this.#placeholder.isEmpty()) {
            // No placeholder available, so we do not care
            return
        }
        const {panelState, container, listener} = this.#placeholder.unwrap()
        if (panelState.isMinimized) {
            listener.onMinimized()
        } else {
            replaceChildren(container, this.#createContent())
            panelState.isMinimized = false
            listener.onEmbed()
        }
    }

    #restorePopout(): void {
        if (this.#popoutBuilt) {return}
        Surface.getById(this.#id).ifSome(surface => {
            replaceChildren(surface.ground, this.#createContent())
            this.#popoutBuilt = true
        })
    }

    #closePopout(): void {Surface.getById(this.#id).ifSome(surface => surface.close())}

    #createContent(): JsxValue {
        const content = this.#factory.create(this.#terminator, this.#panelType)
        const anchors = PanelAnchors[this.#panelType]
        if (isDefined(anchors) && content instanceof Element) {TourAnchors.register(this.#terminator, content, ...anchors)}
        return content
    }
}