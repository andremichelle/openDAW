import {Lifecycle, Notifier, Observer, Option, Provider, Subscription} from "@opendaw/lib-std"
import {TourAnchor} from "./TourAnchor"
import {Rect} from "./TourPlacement"

export type TourTarget = { element: Element, rect: Provider<Rect> }

export namespace TourAnchors {
    const targets = new Map<TourAnchor, TourTarget>()
    const notifier = new Notifier<TourAnchor>()

    export const register = (lifecycle: Lifecycle, element: Element, ...anchors: ReadonlyArray<TourAnchor>): void =>
        registerRect(lifecycle, element, () => element.getBoundingClientRect(), ...anchors)

    export const registerRect = (lifecycle: Lifecycle, element: Element, rect: Provider<Rect>,
                                 ...anchors: ReadonlyArray<TourAnchor>): void =>
        anchors.forEach(anchor => {
            const target = {element, rect}
            targets.set(anchor, target)
            notifier.notify(anchor)
            lifecycle.own({
                terminate: () => {
                    if (targets.get(anchor) !== target) {return}
                    targets.delete(anchor)
                    notifier.notify(anchor)
                }
            })
        })

    export const resolve = (anchor: TourAnchor): Option<TourTarget> => Option.wrap(targets.get(anchor))

    export const subscribe = (anchor: TourAnchor, observer: Observer<Option<TourTarget>>): Subscription =>
        notifier.subscribe(changed => {if (changed === anchor) {observer(resolve(anchor))}})
}
