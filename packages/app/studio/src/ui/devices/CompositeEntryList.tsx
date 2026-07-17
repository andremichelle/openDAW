import css from "./CompositeEntryList.sass?inline"
import {Exec, Func, Lifecycle, Subscription, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "CompositeEntryList")

type Construct = {
    lifecycle: Lifecycle
    // Rebuilt on every collection change: each entry becomes its own row element (an AudioCompositeEntry). The
    // list hands over the rebuild lifecycle so a row's controls die when the list is rebuilt.
    rows: Func<Lifecycle, ReadonlyArray<Element>>
    // Subscribe to the entry collection; the list rebuilds on each change.
    watch: Func<Exec, Subscription>
    // A SPLIT owns its entries (the engine maps them BY INDEX), so it offers no add.
    fixed: boolean
    addEntry: Exec
}

// The composite's entry list: it lays the rows out, shows an empty hint when there are none, and offers the
// add. It is pure layout — a row's look and behaviour lives in the AudioCompositeEntry the owner builds.
export const CompositeEntryList = ({lifecycle, rows, watch, fixed, addEntry}: Construct) => {
    const element: HTMLElement = <div className={className}/>
    // Everything a row owns (knobs, checkbox binds, tooltips, drop target) dies when the rows are rebuilt.
    const rowLifecycle = lifecycle.own(new Terminator())
    const update = () => {
        rowLifecycle.terminate()
        Html.empty(element)
        const current = rows(rowLifecycle)
        if (current.length === 0) {
            element.appendChild(<div className="empty">No entries — the signal passes through</div>)
        }
        for (const row of current) {element.appendChild(row)}
        if (!fixed) {
            const add: HTMLElement = <div className="add">+ Add Entry</div>
            element.appendChild(add)
            rowLifecycle.own(Events.subscribe(add, "click", () => addEntry()))
        }
    }
    update()
    lifecycle.own(watch(update))
    return element
}
