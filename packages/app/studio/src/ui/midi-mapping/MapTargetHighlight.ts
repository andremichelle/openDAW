import css from "./MapTargetHighlight.sass?inline"
import {isDefined, Terminable, Terminator} from "@opendaw/lib-std"
import {AnimationFrame, Events, Html} from "@opendaw/lib-dom"
import {MIDILearning, MIDIMappableField} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "MapTarget")

const StateClasses = [className, "midi-map-assignable", "midi-map-mapped", "midi-map-target"]

// wrappers with display: contents have no box, the frame goes on the first descendant that has one
const boxedElementOf = (element: Element): Element => {
    let current = element
    while (getComputedStyle(current).display === "contents" && isDefined(current.firstElementChild)) {
        current = current.firstElementChild
    }
    return current
}

export const installMapTarget = (midiLearning: MIDILearning,
                                 field: MIDIMappableField,
                                 element: Element): Terminable => {
    const terminator = new Terminator()
    let highlighted: Element = element
    let alive = true
    const update = () => {
        if (!alive) {return}
        const active = midiLearning.mapMode.getValue()
        const next = active ? boxedElementOf(element) : highlighted
        if (next !== highlighted) {
            highlighted.classList.remove(...StateClasses)
            highlighted = next
        }
        highlighted.classList.toggle(className, active)
        highlighted.classList.toggle("midi-map-assignable", active)
        highlighted.classList.toggle("midi-map-mapped", active && midiLearning.hasMidiConnection(field.address))
        highlighted.classList.toggle("midi-map-target", active && midiLearning.mapTarget
            .mapOr(target => target.address.equals(field.address), false))
    }
    terminator.ownAll(
        midiLearning.mapMode.subscribe(update),
        midiLearning.mapTarget.subscribe(update),
        midiLearning.subscribeChanges(update),
        Events.subscribe(element, "pointerdown", (event: PointerEvent) => {
            if (!midiLearning.mapMode.getValue() || event.button !== 0) {return}
            event.preventDefault()
            event.stopImmediatePropagation()
            midiLearning.mapTarget.wrap(field)
        }, {capture: true}),
        {
            terminate: () => {
                alive = false
                highlighted.classList.remove(...StateClasses)
            }
        }
    )
    // controls mount while map mode is already on (screen switch), so resolve the box once attached
    const updateWhenAttached = () => {
        if (!alive) {return}
        if (element.isConnected) {update()} else {AnimationFrame.once(updateWhenAttached)}
    }
    update()
    updateWhenAttached()
    return terminator
}
