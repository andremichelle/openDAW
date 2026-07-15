import {BoxGraph, PointerField} from "@opendaw/lib-box"
import {UUID} from "@opendaw/lib-std"
import {ValueEventBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"

// Deterministic, constraint-aware reconciliation of a box graph.
//
// Yjs converges every client on the SAME document but has no notion of the box graph's referential
// invariants (a pointer must resolve, an exclusive target accepts at most one incoming pointer, ...). So a
// merged document can encode a state that is illegal for the graph. Applied naively, endTransaction throws
// and YSync reverts locally — and because each client reverts to a DIFFERENT local state, the peers fork.
//
// The cure is not to teach Yjs the rules but to repair the illegal state with a function that is PURE in the
// converged document: every client, seeing the same document, runs the same repair and lands on the same
// graph. The only inputs allowed are data present on every client — box uuids and field addresses — never
// wall-clock time or message arrival order. Repairs run to a fixpoint (one repair can expose another).
//
// PROTOTYPE SCOPE: exclusive-target overflow (the case the collab tests show diverging). Dangling pointers
// and mandatory-missing are cheap to add on the same skeleton; each just needs its own deterministic rule.

const byUuid = (a: {address: {uuid: UUID.Bytes}}, b: {address: {uuid: UUID.Bytes}}): number =>
    UUID.toString(a.address.uuid).localeCompare(UUID.toString(b.address.uuid))

const byAddress = (a: PointerField, b: PointerField): number =>
    a.address.toString().localeCompare(b.address.toString())

// Collapse a value-event collection onto its (position, index) uniqueness invariant: per position keep the
// earliest event at index 0 and the latest at index 1, deleting any in between. Two clients concurrently adding
// an event at the same position each pick index 0, so the merged document holds two events at (position, 0) —
// which the SortedSet comparator (ValueEventBoxAdapter.Comparator) rejects, but only lazily in asArray, so the
// merge commits and crashes later on selection. Sorting breaks an exact (position, index) tie by uuid so every
// client computes the identical repair; the semantic mirrors the load-time migrateValueEventCollection, so a
// collection healed here and one loaded fresh converge.
const reconcileValueEventCollection = (collectionBox: ValueEventCollectionBox): boolean => {
    const events = collectionBox.events.pointerHub.incoming()
        .map(pointer => pointer.box)
        .filter((box): box is ValueEventBox => box instanceof ValueEventBox)
        .sort((a, b) => {
            const positionDiff = a.position.getValue() - b.position.getValue()
            if (positionDiff !== 0) {return positionDiff}
            const indexDiff = a.index.getValue() - b.index.getValue()
            return indexDiff !== 0 ? indexDiff : byUuid(a, b)
        })
    let changed = false
    let groupStart = 0
    for (let cursor = 1; cursor <= events.length; cursor++) {
        if (cursor < events.length
            && events[cursor].position.getValue() === events[groupStart].position.getValue()) {continue}
        const group = events.slice(groupStart, cursor)
        const first = group[0]
        if (first.index.getValue() !== 0) {first.index.setValue(0); changed = true}
        if (group.length >= 2) {
            const last = group[group.length - 1]
            if (last.index.getValue() !== 1) {last.index.setValue(1); changed = true}
            for (let middle = 1; middle < group.length - 1; middle++) {group[middle].delete(); changed = true}
        }
        groupStart = cursor
    }
    return changed
}

/**
 * Repair every constraint violation reachable in `boxGraph`, in-place, deterministically. MUST be called
 * inside an open transaction (its edits become part of that transaction). Returns whether anything changed.
 */
export const deterministicReconcile = (boxGraph: BoxGraph): boolean => {
    let repairedAny = false
    let changed = true
    while (changed) {
        changed = false
        // Stable, client-independent iteration order.
        const boxes = boxGraph.boxes().slice().sort(byUuid)
        for (const box of boxes) {
            if (!box.isAttached()) {continue}
            // --- Exclusive target overflow: keep the lowest-addressed incoming pointer, drop the rest. ---
            if (box.pointerRules.exclusive) {
                const incoming = box.incomingEdges().slice().sort(byAddress)
                if (incoming.length > 1) {
                    for (let index = 1; index < incoming.length; index++) {
                        const pointer: PointerField = incoming[index]
                        // A mandatory pointer may not dangle, so dropping the edge means dropping its owner.
                        if (pointer.mandatory) {
                            pointer.box.delete()
                        } else {
                            pointer.defer()
                        }
                    }
                    changed = true
                    repairedAny = true
                    break // graph mutated: restart the scan from a fresh, ordered snapshot
                }
            }
            // --- Duplicate value events: collapse the collection onto (position, index) uniqueness. ---
            if (box instanceof ValueEventCollectionBox) {
                if (reconcileValueEventCollection(box)) {
                    changed = true
                    repairedAny = true
                    break // graph mutated: restart the scan from a fresh, ordered snapshot
                }
            }
        }
    }
    return repairedAny
}
