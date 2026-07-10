import {ValueEventBoxAdapter, ValueEventCollectionBoxAdapter} from "@opendaw/studio-adapters"
import {Interpolation, ppqn, ValueEvent} from "@opendaw/lib-dsp"
import {asDefined, assert, panic, unitValue} from "@opendaw/lib-std"

export namespace ValueEventEditing {
    // Which member of a same-time pair a placement targets. Two value events may share one time position: index 0 is
    // the INCOMING value (left of the resulting vertical step), index 1 is the OUTGOING value (right). See issue #275.
    export type Side = "incoming" | "outgoing"

    // What a double-click placement does at a (snapped) time that may already hold event(s), given the cursor side.
    type Placement = "create" | "add-incoming" | "add-outgoing" | "overwrite-incoming" | "overwrite-outgoing"

    // Pure placement rule for #275. `hasIncoming` / `hasOutgoing` report whether an index-0 / index-1 event already
    // sits at the target time; `side` is the half of the node the cursor is on (left = incoming, right = outgoing).
    const resolvePlacement = (hasIncoming: boolean, hasOutgoing: boolean, side: Side): Placement => {
        if (hasIncoming && hasOutgoing) {return side === "incoming" ? "overwrite-incoming" : "overwrite-outgoing"}
        if (hasIncoming) {return side === "incoming" ? "add-incoming" : "add-outgoing"}
        if (hasOutgoing) {return "overwrite-outgoing"} // defensive: a lone outgoing (index 1) — just move it
        return "create"
    }

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
    // Issue #275: a double click places or overwrites a value event at `position`. `side` is the half of the node the
    // cursor is on (left = incoming, right = outgoing); it selects which member of a same-time pair the click affects.
    // The decision table is `resolvePlacement`; this executes it against the collection.
    export const createOrMoveEvent = (collection: ValueEventCollectionBoxAdapter,
                                      position: ppqn,
                                      value: unitValue,
                                      interpolation: Interpolation = Interpolation.Linear,
                                      side: Side = "outgoing"): ValueEventBoxAdapter => {
        const events = collection.events
        const first = events.greaterEqual(position)
        const last = events.lowerEqual(position)
        const incoming = first !== null && first.position === position && first.index === 0 ? first : null
        const outgoing = last !== null && last.position === position && last.index === 1 ? last : null
        switch (resolvePlacement(incoming !== null, outgoing !== null, side)) {
            case "create":
                return collection.createEvent({position, index: 0, value, interpolation})
            case "add-outgoing":
                return collection.createEvent({position, index: 1, value, interpolation})
            case "add-incoming": {
                // The existing lone node keeps its value as the OUTGOING (index 1); the click becomes the INCOMING.
                const existing = asDefined(incoming, "incoming")
                collection.createEvent({position, index: 1, value: existing.value, interpolation: existing.interpolation})
                existing.box.value.setValue(value)
                return existing
            }
            case "overwrite-incoming": {
                const target = asDefined(incoming, "incoming")
                target.box.value.setValue(value)
                return target
            }
            case "overwrite-outgoing": {
                const target = asDefined(outgoing, "outgoing")
                target.box.value.setValue(value)
                return target
            }
        }
    }
}