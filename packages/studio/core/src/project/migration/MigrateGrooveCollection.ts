import {BoxGraph} from "@opendaw/lib-box"
import {BoxIO, RootBox} from "@opendaw/studio-boxes"
import {Strings, UUID} from "@opendaw/lib-std"
import {GrooveBox, isGrooveBox} from "@opendaw/studio-adapters"

export const GlobalGrooveLabel = "Global Shuffle"

// true for a project made before the groove list existed
export const migrateGrooveCollection = (boxGraph: BoxGraph<BoxIO.TypeMap>, rootBox: RootBox): boolean => {
    const listed = rootBox.grooves.pointerHub.incoming().map(pointer => pointer.box).filter(isGrooveBox)
        .sort((left, right) => left.index.getValue() - right.index.getValue())
    const missing = boxGraph.boxes()
        .filter((box): box is GrooveBox => isGrooveBox(box) && box.collection.targetAddress.isEmpty())
    if (missing.length === 0) {return listed.length === 0}
    console.debug(`Migrate ${missing.length} grooves into the groove list`)
    const global: string = rootBox.groove.targetAddress.mapOr(address => UUID.toString(address.uuid), "")
    const isGlobal = (groove: GrooveBox): boolean => UUID.toString(groove.address.uuid) === global
    const ordered = [...listed, ...missing].sort((left, right) => Number(isGlobal(right)) - Number(isGlobal(left)))
    const taken: Array<string> = [GlobalGrooveLabel, ...listed.map(groove => groove.label.getValue())]
    boxGraph.beginTransaction()
    ordered.forEach((groove, index) => {
        if (groove.index.getValue() !== index) {groove.index.setValue(index)}
        if (!missing.includes(groove)) {return}
        groove.collection.refer(rootBox.grooves)
        if (!isGlobal(groove)) {
            const label = Strings.getUniqueName(taken, groove.label.getValue() || "Shuffle")
            taken.push(label)
            groove.label.setValue(label)
        }
    })
    boxGraph.endTransaction()
    return listed.length === 0
}
