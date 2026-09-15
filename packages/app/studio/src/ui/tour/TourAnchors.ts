import {Lifecycle, Notifier, Observer, Option, Subscription} from "@opendaw/lib-std"
import {TourAnchor} from "./TourAnchor"

export namespace TourAnchors {
    const elements = new Map<TourAnchor, Element>()
    const notifier = new Notifier<TourAnchor>()

    export const register = (lifecycle: Lifecycle, element: Element, ...anchors: ReadonlyArray<TourAnchor>): void =>
        anchors.forEach(anchor => {
            elements.set(anchor, element)
            notifier.notify(anchor)
            lifecycle.own({
                terminate: () => {
                    if (elements.get(anchor) !== element) {return}
                    elements.delete(anchor)
                    notifier.notify(anchor)
                }
            })
        })

    export const resolve = (anchor: TourAnchor): Option<Element> => Option.wrap(elements.get(anchor))

    export const subscribe = (anchor: TourAnchor, observer: Observer<Option<Element>>): Subscription =>
        notifier.subscribe(changed => {if (changed === anchor) {observer(resolve(anchor))}})
}
