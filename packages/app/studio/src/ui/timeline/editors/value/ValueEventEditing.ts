import {ValueEventBoxAdapter, ValueEventCollectionBoxAdapter} from "@opendaw/studio-adapters"
import {Interpolation, ppqn, ValueEvent} from "@opendaw/lib-dsp"
import {assert, panic, unitValue} from "@opendaw/lib-std"

export namespace ValueEventEditing {
    export const deleteEvent = (collection: ValueEventCollectionBoxAdapter, event: ValueEventBoxAdapter) => {
        if (event.index > 1) {return panic(`Invalid index > 1 (${event.index})`)}
        // Find successor BEFORE deleting, but promote AFTER to avoid temporary duplicate index
        const successorToPromote = event.index === 0
            ? (() => {
                const successor = ValueEvent.nextEvent(collection.events, event)
                return successor !== null && successor.position === event.position ? successor : null
            })()
            : null
        // Remove from EventCollection synchronously before box.delete() because pointerHub
        // notifications are deferred until after modify() completes. This prevents duplicate
        // events at the same (position, index) when the successor is promoted.
        collection.events.remove(event)
        event.box.delete()
        if (successorToPromote !== null) {
            assert(successorToPromote.index === 1, `Invalid index !== 1 (${successorToPromote.index})`)
            successorToPromote.box.index.setValue(0)
        }
    }
    export const createOrMoveEvent = (collection: ValueEventCollectionBoxAdapter,
                                      position: ppqn,
                                      value: unitValue,
                                      interpolation: Interpolation = Interpolation.Linear): ValueEventBoxAdapter => {
        const le = collection.events.lowerEqual(position)
        const ge = collection.events.greaterEqual(position)
        if (null === le || null === ge) {
            return collection.createEvent({position, index: 0, value, interpolation})
        } else if (le === ge) {
            if (le.index === 0) {
                return collection.createEvent({position, index: 1, value, interpolation})
            } else {
                le.box.value.setValue(value)
                return le
            }
        } else if (le.position === ge.position) {
            le.box.value.setValue(value)
            return le
        } else {
            return collection.createEvent({position, index: 0, value, interpolation})
        }
    }
}