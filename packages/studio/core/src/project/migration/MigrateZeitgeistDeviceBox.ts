import {BoxGraph, Vertex} from "@opendaw/lib-box"
import {BoxIO, ZeitgeistDeviceBox} from "@opendaw/studio-boxes"

// Only projects made before the groove list had a Zeitgeist without a groove by accident, since then it means None
export const migrateZeitgeistDeviceBox = (boxGraph: BoxGraph<BoxIO.TypeMap>,
                                          box: ZeitgeistDeviceBox,
                                          grooveTarget: Vertex,
                                          beforeGrooveList: boolean): void => {
    if (beforeGrooveList && box.groove.targetAddress.isEmpty()) {
        console.debug("Migrate 'ZeitgeistDeviceBox' to GrooveShuffleBox")
        boxGraph.beginTransaction()
        box.groove.refer(grooveTarget)
        boxGraph.endTransaction()
    }
}
