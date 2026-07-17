import css from "./CompositeEntryList.sass?inline"
import {
    DefaultObservableValue,
    Exec,
    Func,
    int,
    isDefined,
    Lifecycle,
    MutableObservableValue,
    Provider,
    Subscription,
    Terminable,
    Terminator
} from "@opendaw/lib-std"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {AutomatableParameterFieldAdapter} from "@opendaw/studio-adapters"
import {Icon} from "@/ui/components/Icon"
import {Checkbox} from "@/ui/components/Checkbox"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "CompositeEntryList")

// One row's worth of an entry, whichever composite kind it belongs to. An AUDIO entry has a gain knob and a
// MIDI entry does not, so the OWNING editor builds `knob` with its own adapter — that keeps this list free of
// the audio/midi split while still going through the normal `ControlBuilder` (automation, midi-learn, menus).
export type CompositeEntryRow = {
    readonly label: string
    readonly knob: JsxValue      // the entry's gain knob (audio only)
    readonly panKnob: JsxValue   // the entry's pan knob (audio only)
    readonly mute: AutomatableParameterFieldAdapter<boolean>
    readonly solo: AutomatableParameterFieldAdapter<boolean>
    readonly chainLength: int
    // Fired by clicking the ROW itself: opening the branch is the primary action, so it needs no button.
    readonly enter: Exec
    readonly remove: Exec
    // Install this row as a DROP TARGET for an effect / preset dragged onto it (see CompositeEntryDrop).
    readonly installDrop: Func<HTMLElement, Subscription>
}

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    // Re-evaluated on every collection change: an entry add / remove / reorder rebuilds the rows.
    rows: Provider<ReadonlyArray<CompositeEntryRow>>
    // Subscribe to the entry collection; the list rebuilds on each change.
    watch: Func<Exec, Subscription>
    // A SPLIT owns its entries (the engine maps them BY INDEX), so it offers no add.
    fixed: boolean
    addEntry: Exec
}

// The composite's entry list: one row per parallel branch with its mute / solo (and gain, for audio), a way to
// ENTER the branch (the panel then shows that entry's own chain, as entering a Playfield slot does), and a drop
// target so an effect can be dragged straight into a branch.
export const CompositeEntryList = ({lifecycle, service, rows, watch, fixed, addEntry}: Construct) => {
    const {editing} = service.project
    const element: HTMLElement = <div className={className}/>
    // Everything a row owns (knob, checkbox binds, tooltips, drop target) dies when the rows are rebuilt.
    const rowLifecycle = lifecycle.own(new Terminator())
    const update = () => {
        rowLifecycle.terminate()
        Html.empty(element)
        const current = rows()
        if (current.length === 0) {
            element.appendChild(<div className="empty">No entries — the signal passes through</div>)
        }
        for (const row of current) {
            const muteValue = new DefaultObservableValue(false)
            const soloValue = new DefaultObservableValue(false)
            // A SPLIT owns its entries (the engine maps them BY INDEX), so they cannot be removed.
            const remove: HTMLElement = fixed
                ? <div/>
                : <Icon symbol={IconSymbol.Delete} className="remove"/>
            const entryElement: HTMLElement = (
                <div className="entry">
                    <div className="label">{row.label}</div>
                    <div className="knob" data-swallow-click="">{row.knob}</div>
                    <div className="knob" data-swallow-click="">{row.panKnob}</div>
                    <div className="checkboxes" data-swallow-click="">
                        <Checkbox lifecycle={rowLifecycle}
                                  model={muteValue}
                                  appearance={{activeColor: Colors.red, framed: true, tooltip: "Mute entry"}}>
                            <Icon symbol={IconSymbol.Mute}/>
                        </Checkbox>
                        <Checkbox lifecycle={rowLifecycle}
                                  model={soloValue}
                                  appearance={{activeColor: Colors.yellow, framed: true, tooltip: "Solo entry"}}>
                            <Icon symbol={IconSymbol.Solo}/>
                        </Checkbox>
                    </div>
                    {remove}
                </div>
            )
            if (row.chainLength > 0) {entryElement.classList.add("has-effects")}
            element.appendChild(entryElement)
            // The knob and the checkboxes live INSIDE the row: swallow their clicks so adjusting a control
            // does not also open the chain.
            rowLifecycle.own(Events.subscribe(entryElement, "click", (event: Event) => {
                const target = event.target
                if (target instanceof Element && isDefined(target.closest("[data-swallow-click]"))) {
                    event.stopPropagation()
                }
            }, {capture: true}))
            rowLifecycle.ownAll(
                connectBoolean(muteValue, EditWrapper.forAutomatableParameter(editing, row.mute)),
                connectBoolean(soloValue, EditWrapper.forAutomatableParameter(editing, row.solo)),
                TextTooltip.default(entryElement, () => "Edit entry chain"),
                // Clicking the ROW opens its chain. The controls inside it (knob, mute / solo, delete) stop
                // their own clicks, so hitting a control never also navigates away.
                Events.subscribe(entryElement, "click", () => row.enter()),
                row.installDrop(entryElement)
            )
            if (!fixed) {
                rowLifecycle.ownAll(
                    TextTooltip.default(remove, () => "Delete entry"),
                    Events.subscribe(remove, "click", (event: Event) => {
                        event.stopPropagation() // deleting must not also enter the row being deleted
                        row.remove()
                    })
                )
            }
        }
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

// Two-way bind a checkbox model to its parameter wrapper (mirrors the Playfield slot's own helper).
const connectBoolean = (value: MutableObservableValue<boolean>,
                        wrapper: MutableObservableValue<boolean>): Terminable => {
    value.setValue(wrapper.getValue())
    return Terminable.many(
        value.subscribe(owner => wrapper.setValue(owner.getValue())),
        wrapper.subscribe(owner => value.setValue(owner.getValue()))
    )
}
