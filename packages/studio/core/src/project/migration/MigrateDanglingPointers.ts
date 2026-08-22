import {EmptyExec, int, RuntimeNotifier} from "@opendaw/lib-std"
import {Box, BoxGraph, PointerField} from "@opendaw/lib-box"

// Yjs converges every peer on the same document but knows nothing of the box graph's referential invariants.
// One peer deleting a box while another concurrently points at it merges cleanly into a document holding an
// edge that names a uuid no box occupies. Detection and repair live here, shared by the collaborative path
// (deterministicReconcile) and this load path, so a graph healed live and one loaded fresh cannot drift.

export const isDanglingPointer = (boxGraph: BoxGraph, pointer: PointerField): boolean =>
    pointer.targetAddress.match({
        none: () => false,
        some: address => boxGraph.findVertex(address).isEmpty()
    })

export const danglingPointersOf = (boxGraph: BoxGraph, box: Box): ReadonlyArray<PointerField> =>
    box.outgoingEdges()
        .map(([pointer]) => pointer)
        .filter(pointer => isDanglingPointer(boxGraph, pointer))

// A mandatory pointer may not dangle, so dropping the edge means dropping its owner; a free pointer only
// loses the edge. Same resolution the exclusive-target rule applies to the equivalent choice.
export const repairDanglingPointer = (pointer: PointerField): void => {
    if (pointer.mandatory) {
        pointer.box.delete()
    } else {
        pointer.defer()
    }
}

const collectDangling = (boxGraph: BoxGraph): ReadonlyArray<PointerField> =>
    boxGraph.boxes().flatMap(box => danglingPointersOf(boxGraph, box))

// Load-path counterpart of the reconcile rule, for projects that never pass through YSync (binary loads,
// imports, dawproject conversion). Runs to a fixpoint: deleting an owner can expose further dangling edges.
// Every pass strictly removes edges or boxes, so it terminates.
export const migrateDanglingPointers = (boxGraph: BoxGraph): int => {
    let repaired = 0 | 0
    let pending = collectDangling(boxGraph)
    while (pending.length > 0) {
        boxGraph.beginTransaction()
        for (const pointer of pending) {
            if (!pointer.box.isAttached()) {continue}
            repairDanglingPointer(pointer)
            repaired++
        }
        boxGraph.endTransaction()
        pending = collectDangling(boxGraph)
    }
    if (repaired > 0) {
        console.debug(`Migrate repaired ${repaired} dangling pointer(s)`)
        RuntimeNotifier.info({
            headline: "Some data is corrupt",
            message: `This project referenced ${repaired} element(s) that no longer exist, most likely from a
            collaborative edit that removed them elsewhere. We cleaned them up as good as possible.`
        }).then(EmptyExec, EmptyExec)
    }
    return repaired
}
