import css from "./CompositeEntryList.sass?inline"
import {Exec, Func, Lifecycle, Option, Subscription, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {installScrollbars} from "@/ui/components/Scrollbars"

const className = Html.adoptStyleSheet(css, "CompositeEntryList")

type Construct = {
    lifecycle: Lifecycle
    // Rebuilt on every collection change: each entry becomes its own row element (an AudioCompositeEntry). The
    // list hands over the rebuild lifecycle so a row's controls die when the list is rebuilt.
    rows: Func<Lifecycle, ReadonlyArray<Element>>
    // Subscribe to the entry collection; the list rebuilds on each change.
    watch: Func<Exec, Subscription>
    // The Add Effect footer, built by the owner (a menu button that also accepts a dropped effect). None for a
    // fixed split, which cannot gain branches. A stable element: it survives the row rebuilds.
    footer: Option<HTMLElement>
}

// The composite's entry list: it lays the rows out, shows an empty hint when there are none, and pins the Add
// Effect footer at the bottom. It is pure layout — a row's look and behaviour lives in the AudioCompositeEntry
// the owner builds.
export const CompositeEntryList = ({lifecycle, rows, watch, footer}: Construct) => {
    // The device panel's drag reads `data-composite-drop` to suppress its own insert marker over this list.
    const element: HTMLElement = <div className={className} data-composite-drop=""/>
    const scroll: HTMLElement = <div className="scroll" onConnect={host => lifecycle.own(installScrollbars(host))}/>
    // Keep a scrollable list's wheel to itself so the panel's own deltaX handler does not drift it sideways.
    lifecycle.own(Events.subscribe(scroll, "wheel", (event: WheelEvent) => {
        if (scroll.scrollHeight > scroll.clientHeight) {event.stopPropagation()}
    }, {passive: true}))
    // `--fade-bottom` (0..1) scales the bottom fade by how much remains scrollable, so it vanishes at the end.
    let fadeZone = 24
    const updateFade = () => {
        const below = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop
        scroll.style.setProperty("--fade-bottom", `${fadeZone <= 0 ? 0 : Math.max(0, Math.min(1, below / fadeZone))}`)
    }
    lifecycle.ownAll(
        Events.subscribe(scroll, "scroll", updateFade, {passive: true}),
        Html.watchResize(scroll, () => {
            fadeZone = 1.5 * parseFloat(getComputedStyle(scroll).fontSize || "16")
            updateFade()
        })
    )
    const rowLifecycle = lifecycle.own(new Terminator())
    const update = () => {
        rowLifecycle.terminate()
        Html.empty(scroll)
        const current = rows(rowLifecycle)
        element.classList.toggle("empty", current.length === 0)
        for (const row of current) {scroll.appendChild(row)}
        updateFade()
    }
    update()
    element.appendChild(scroll)
    footer.ifSome(node => element.appendChild(node))
    lifecycle.own(watch(update))
    return element
}
