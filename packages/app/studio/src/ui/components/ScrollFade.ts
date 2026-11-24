import {Lifecycle} from "@opendaw/lib-std"
import {Events, Html} from "@opendaw/lib-dom"

export namespace ScrollFade {
    export const install = (lifecycle: Lifecycle, scroll: HTMLElement, fadeZone: number = 24): void => {
        const update = () => {
            const below = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop
            scroll.style.setProperty("--fade-top", `${Math.min(1, scroll.scrollTop / fadeZone)}`)
            scroll.style.setProperty("--fade-bottom", `${Math.max(0, Math.min(1, below / fadeZone))}`)
        }
        lifecycle.ownAll(
            Events.subscribe(scroll, "scroll", update, {passive: true}),
            Html.watchResize(scroll, update),
            ...Array.from(scroll.children).map(child => Html.watchResize(child, update))
        )
        update()
    }
}
