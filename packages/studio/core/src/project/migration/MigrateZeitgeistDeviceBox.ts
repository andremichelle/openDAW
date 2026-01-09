import {BoxGraph, Vertex} from "@opendaw/lib-box"
import {BoxIO, ZeitgeistDeviceBox} from "@opendaw/studio-boxes"

export const migrateZeitgeistDeviceBox = (boxGraph: BoxGraph<BoxIO.TypeMap>, box: ZeitgeistDeviceBox, grooveTarget: Vertex): void => {
    if (box.groove.targetAddress.isEmpty()) {
        console.debug("Migrate 'ZeitgeistDeviceBox' to GrooveShuffleBox")
        boxGraph.beginTransaction()
        box.groove.refer(grooveTarget)
        boxGraph.endTransaction()
    }
}
