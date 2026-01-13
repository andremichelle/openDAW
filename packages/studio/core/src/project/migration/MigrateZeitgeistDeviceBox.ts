import {BoxGraph, Vertex} from "@moises-ai/lib-box"
import {BoxIO, ZeitgeistDeviceBox} from "@moises-ai/studio-boxes"

export const migrateZeitgeistDeviceBox = (boxGraph: BoxGraph<BoxIO.TypeMap>, box: ZeitgeistDeviceBox, grooveTarget: Vertex): void => {
    if (box.groove.targetAddress.isEmpty()) {
        console.debug("Migrate 'ZeitgeistDeviceBox' to GrooveShuffleBox")
        boxGraph.beginTransaction()
        box.groove.refer(grooveTarget)
        boxGraph.endTransaction()
    }
}
