import {BoxGraph, Update} from "@opendaw/lib-box"
import {AudioRegionBox, AudioUnitBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"

export const affectsGroupOverview = (graph: BoxGraph, update: Update): boolean => {
    if (update.type === "new" || update.type === "delete") {
        return [AudioUnitBox.ClassName, TrackBox.ClassName, NoteRegionBox.ClassName, AudioRegionBox.ClassName].includes(update.name)
    }
    const box = graph.findBox(update.address.uuid).unwrapOrUndefined()
    if (box instanceof AudioUnitBox) {
        return [box.groupParent.address, box.index.address, box.isGroup.address]
            .some(address => address.equals(update.address))
    }
    if (box instanceof TrackBox) {
        return box.enabled.address.equals(update.address) || box.tracks.address.equals(update.address)
            || box.index.address.equals(update.address)
    }
    return box instanceof NoteRegionBox || box instanceof AudioRegionBox
}
