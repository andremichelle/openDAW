import css from "./CompositeEntryList.sass?inline"
import {Exec, Func, Lifecycle, Option, Subscription, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
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
    // `data-composite-drop`: a drop over this list is handled by a branch (into its chain / as a new branch),
    // NOT by the parent device chain — the device panel's drag reads this and suppresses its insert marker here.
    const element: HTMLElement = <div className={className} data-composite-drop=""/>
    // The rows scroll within a capped height so the footer stays pinned below; our own overlay scrollbars.
    const scroll: HTMLElement = <div className="scroll" onConnect={host => lifecycle.own(installScrollbars(host))}/>
    // Everything a row owns (knobs, checkbox binds, tooltips, drop target) dies when the rows are rebuilt.
    const rowLifecycle = lifecycle.own(new Terminator())
    const update = () => {
        rowLifecycle.terminate()
        Html.empty(scroll)
        const current = rows(rowLifecycle)
        if (current.length === 0) {
            scroll.appendChild(<div className="empty">No entries — drop an effect to add one</div>)
        }
        for (const row of current) {scroll.appendChild(row)}
    }
    update()
    element.appendChild(scroll)
    footer.ifSome(node => element.appendChild(node))
    lifecycle.own(watch(update))
    return element
}
