import {EmptyExec, int, RuntimeNotifier} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"

// A box whose mandatory pointer has no target cannot exist: an effect with no chain, a region with no track,
// a selection with nothing selected. Deserialization already cleared every pointer whose target was missing,
// and every migration above has had its chance to rebuild one it knows about, so what is left here is
// genuinely unsatisfiable. Deleting an owner can leave another box unsatisfied, hence the fixpoint.
export const migrateUnsatisfiedMandatory = (boxGraph: BoxGraph): int => {
    let deleted = 0 | 0
    let pending = boxGraph.edges().unsatisfiedMandatoryPointers()
    while (pending.length > 0) {
        boxGraph.beginTransaction()
        for (const pointer of pending) {
            if (!pointer.box.isAttached()) {continue}
            pointer.box.delete()
            deleted++
        }
        boxGraph.endTransaction()
        pending = boxGraph.edges().unsatisfiedMandatoryPointers()
    }
    if (deleted > 0) {
        console.debug(`Migrate removed ${deleted} box(es) with an unsatisfied mandatory pointer`)
        RuntimeNotifier.info({
            headline: "Some data is corrupt",
            message: `This project referenced ${deleted} element(s) that no longer exist. We removed them as
            good as possible.`
        }).then(EmptyExec, EmptyExec)
    }
    return deleted
}
