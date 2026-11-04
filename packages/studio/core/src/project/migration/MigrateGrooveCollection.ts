import {BoxGraph} from "@opendaw/lib-box"
import {BoxIO, RootBox} from "@opendaw/studio-boxes"
import {Strings, UUID} from "@opendaw/lib-std"
import {GrooveBox, isGrooveBox} from "@opendaw/studio-adapters"

export const GlobalGrooveLabel = "Global Shuffle"

// Every groove joins the project's groove list, the global one first. Returns true for a project made before
// the list existed, so later passes can tell an old empty groove pointer from a deliberate None.
export const migrateGrooveCollection = (boxGraph: BoxGraph<BoxIO.TypeMap>, rootBox: RootBox): boolean => {
    const members = rootBox.grooves.pointerHub.incoming().length
    const missing = boxGraph.boxes()
        .filter((box): box is GrooveBox => isGrooveBox(box) && box.collection.targetAddress.isEmpty())
    if (missing.length === 0) {return members === 0}
    console.debug(`Migrate ${missing.length} grooves into the groove list`)
    const global: string = rootBox.groove.targetAddress.mapOr(address => UUID.toString(address.uuid), "")
    const ordered = missing.slice().sort((a, b) =>
        Number(UUID.toString(b.address.uuid) === global) - Number(UUID.toString(a.address.uuid) === global))
    const taken: Array<string> = [GlobalGrooveLabel]
    boxGraph.beginTransaction()
    ordered.forEach((groove, offset) => {
        groove.collection.refer(rootBox.grooves)
        groove.index.setValue(members + offset)
        if (UUID.toString(groove.address.uuid) !== global) {
            const label = Strings.getUniqueName(taken, groove.label.getValue() || "Shuffle")
            taken.push(label)
            groove.label.setValue(label)
        }
    })
    boxGraph.endTransaction()
    return members === 0
}
