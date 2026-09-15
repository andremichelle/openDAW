import {createElement, RouteLocation} from "@opendaw/lib-jsx"
import {DefaultObservableValue, EmptyExec, isDefined, Option, Terminable, Terminator} from "@opendaw/lib-std"
import {AnimationFrame, Events, Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"
import {openManual} from "@/ui/manuals"
import {StudioPreferences} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {Dialogs} from "@/ui/components/dialogs"
import {Checkbox} from "@/ui/components/Checkbox"
import {Surface} from "@/ui/surface/Surface"
import {TourAnchors} from "./TourAnchors"
import {TourStep, TourSteps} from "./TourSteps"
import {TourAnchor} from "./TourAnchor"
import {TourCard} from "./TourCard"
import {centerCard, frameRect, placeCard} from "./TourPlacement"

export namespace Tour {
    // Offered once per arrival from the dashboard or a shared bundle link, never when switching between projects.
    export const install = (service: StudioService): Terminable => {
        const idle = {value: true}
        return service.projectProfileService.catchupAndSubscribe(optProfile => {
            const wasIdle = idle.value
            idle.value = optProfile.isEmpty()
            if (optProfile.isEmpty() || !wasIdle) {return}
            if (!StudioPreferences.settings.visibility["offer-studio-tour"]) {return}
            if (RouteLocation.get().path.startsWith("/join")) {return}
            AnimationFrame.once(() => {
                if (service.layout.screen.getValue() !== "default") {return}
                offer(service)
            })
        })
    }

    export const offer = (service: StudioService): void => {
        const lifecycle = new Terminator()
        const never = lifecycle.own(new DefaultObservableValue(false))
        Dialogs.show({
            headline: "Welcome to openDAW",
            okText: "Start tour",
            buttons: [{text: "Not now", onClick: handler => handler.close()}],
            content: <p style={{margin: "0"}}>Take a quick tour of the studio?</p>,
            leading: (
                <Checkbox lifecycle={lifecycle} model={never}
                          style={{marginLeft: "-0.25em"}}
                          appearance={{color: Colors.shadow, activeColor: Colors.green, cursor: "pointer"}}>
                    <span>Never show this again</span>
                    <Icon symbol={IconSymbol.Checkbox}/>
                </Checkbox>
            )
        }).then(() => start(service), EmptyExec).finally(() => {
            if (never.getValue()) {StudioPreferences.settings.visibility["offer-studio-tour"] = false}
            lifecycle.terminate()
        })
    }

    export const start = (service: StudioService): void => {
        if (!service.hasProfile) {return}
        state.run.ifSome(run => run.finish())
        state.run = Option.wrap(new Run(service))
    }

    const state: {run: Option<Run>} = {run: Option.None}
    const Steps: ReadonlyArray<[TourAnchor, TourStep]> = Object.entries(TourSteps) as Array<[TourAnchor, TourStep]>

    class Run {
        readonly #service: StudioService
        readonly #terminator: Terminator
        readonly #stepLifecycle: Terminator
        readonly #restore: Terminator

        #index: number = 0
        #card: Option<{card: TourCard, owner: Window}> = Option.None
        #userFocusedInput: boolean = false

        constructor(service: StudioService) {
            this.#service = service
            this.#terminator = new Terminator()
            this.#stepLifecycle = this.#terminator.own(new Terminator())
            this.#restore = new Terminator()
            const browseScope = service.layout.browseScope.getValue()
            const clipsVisible = service.timeline.clips.visible.getValue()
            this.#restore.ownAll(
                {terminate: () => service.layout.browseScope.setValue(browseScope)},
                {terminate: () => service.timeline.clips.visible.setValue(clipsVisible)}
            )
            this.#terminator.ownAll(
                this.#subscribeKeys(window),
                service.projectProfileService.catchupAndSubscribe(optProfile => {
                    if (optProfile.isEmpty()) {this.finish()}
                })
            )
            this.#show(0)
        }

        next(): void {
            if (this.#index + 1 >= Steps.length) {
                this.finish()
                StudioPreferences.settings.visibility["offer-studio-tour"] = false
                Dialogs.approve({
                    headline: "That was the tour",
                    message: "Want to read on? The manuals cover every part in depth.",
                    approveText: "Open manuals",
                    cancelText: "Close",
                    reverse: true
                }).then(open => {if (open) {openManual("/manuals/")}})
            } else {
                this.#show(this.#index + 1)
            }
        }

        back(): void {if (this.#index > 0) {this.#show(this.#index - 1)}}

        finish(): void {
            if (!state.run.contains(this)) {return}
            state.run = Option.None
            this.#terminator.terminate()
            this.#card.ifSome(({card}) => {
                card.element.remove()
                card.ring.remove()
            })
            this.#card = Option.None
            this.#restore.terminate()
            if (this.#service.hasProfile && this.#service.layout.screen.getValue() !== "default") {
                this.#service.switchScreen("default")
            }
        }

        #show(index: number): void {
            this.#index = index
            this.#stepLifecycle.terminate()
            const [anchor, step] = Steps[index]
            if (this.#service.layout.screen.getValue() !== step.screen) {this.#service.switchScreen(step.screen)}
            step.prepare?.(this.#service)
            AnimationFrame.once(() => {
                if (!state.run.contains(this) || this.#index !== index) {return}
                this.#present(anchor, step)
            })
        }

        #present(anchor: TourAnchor, step: TourStep): void {
            this.#stepLifecycle.terminate()
            this.#userFocusedInput = false
            const optAnchor = TourAnchors.resolve(anchor)
            const surface = optAnchor.match({none: () => Surface.get(), some: element => Surface.get(element)})
            const card = this.#cardFor(surface)
            card.update({headline: step.headline, text: step.text, index: this.#index, count: Steps.length})
            const layout = () => {
                const size = card.measure()
                const viewport = {width: surface.width, height: surface.height}
                optAnchor.match({
                    none: () => card.layout(centerCard(size, viewport), undefined),
                    some: element => {
                        const {x, y, width, height} = element.getBoundingClientRect()
                        const rect = {x, y, width, height}
                        card.layout(placeCard(rect, size, viewport, step.placement),
                            isDefined(step.frame) ? frameRect(rect, step.frame, viewport) : undefined)
                    }
                })
            }
            layout()
            this.#stepLifecycle.ownAll(
                Events.subscribe(surface.owner, "resize", layout),
                Events.subscribe(surface.owner, "pointerdown", ({target}) => {
                    if (Events.isTextInput(target)) {this.#userFocusedInput = true}
                }, {capture: true})
            )
            if (surface.owner !== window) {this.#stepLifecycle.own(this.#subscribeKeys(surface.owner))}
            this.#stepLifecycle.own(TourAnchors.subscribe(anchor, () => this.#present(anchor, step)))
            optAnchor.ifSome(element => this.#stepLifecycle.own(Html.watchResize(element, layout)))
        }

        #cardFor(surface: Surface): TourCard {
            const existing = this.#card.unwrapOrNull()
            if (existing !== null && existing.owner === surface.owner) {return existing.card}
            this.#card.ifSome(({card}) => {
                card.element.remove()
                card.ring.remove()
            })
            const card = new TourCard({onClose: () => this.finish(), onNext: () => this.next()})
            surface.floating.appendChild(card.ring)
            surface.floating.appendChild(card.element)
            this.#card = Option.wrap({card, owner: surface.owner})
            return card
        }

        #subscribeKeys(owner: Window): Terminable {
            return Events.subscribe(owner, "keydown", event => {
                if (this.#userFocusedInput && Events.isTextInput(event.target)) {return}
                switch (event.code) {
                    case "Escape":
                        this.finish()
                        break
                    case "ArrowRight":
                    case "Enter":
                        this.next()
                        break
                    case "ArrowLeft":
                        this.back()
                        break
                    default:
                        return
                }
                event.preventDefault()
                event.stopPropagation()
            }, {capture: true})
        }
    }
}
