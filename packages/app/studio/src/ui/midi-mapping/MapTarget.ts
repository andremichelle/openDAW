import {Terminable, Terminator} from "@opendaw/lib-std"
import {Events} from "@opendaw/lib-dom"
import {MIDILearning, MIDIMappableField} from "@opendaw/studio-core"

export namespace MapTarget {
    const StateClasses = ["midi-map", "midi-map-mapped", "midi-map-target"]

    export const select = (midiLearning: MIDILearning, field: MIDIMappableField, element: Element): Terminable =>
        Events.subscribe(element, "pointerdown", (event: PointerEvent) => {
            if (!midiLearning.mapMode.getValue() || !Events.isPrimaryButton(event)) {return}
            event.preventDefault()
            event.stopImmediatePropagation()
            midiLearning.mapTarget.wrap(field)
        }, {capture: true})

    export const frame = (midiLearning: MIDILearning, field: MIDIMappableField, element: Element): Terminable => {
        const terminator = new Terminator()
        const update = () => {
            const active = midiLearning.mapMode.getValue()
            element.classList.toggle("midi-map", active)
            element.classList.toggle("midi-map-mapped", active && midiLearning.hasMidiConnection(field.address))
            element.classList.toggle("midi-map-target", active && midiLearning.mapTarget
                .mapOr(target => target.address.equals(field.address), false))
        }
        terminator.ownAll(
            midiLearning.mapMode.subscribe(update),
            midiLearning.mapTarget.subscribe(update),
            midiLearning.subscribeChanges(update),
            Terminable.create(() => element.classList.remove(...StateClasses))
        )
        update()
        return terminator
    }
}
