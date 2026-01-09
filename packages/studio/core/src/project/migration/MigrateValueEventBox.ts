import {BoxGraph} from "@opendaw/lib-box"
import {UUID} from "@opendaw/lib-std"
import {BoxIO, ValueEventBox, ValueEventCurveBox} from "@opendaw/studio-boxes"

export const migrateValueEventBox = (boxGraph: BoxGraph<BoxIO.TypeMap>, eventBox: ValueEventBox): void => {
    const slope = eventBox.slope.getValue()
    if (isNaN(slope)) {return}
    if (slope === 0.0) {
        console.debug("Migrate 'ValueEventBox'")
        boxGraph.beginTransaction()
        eventBox.slope.setValue(NaN)
        boxGraph.endTransaction()
    } else if (eventBox.interpolation.getValue() === 1) {
        if (slope === 0.5) {
            console.debug("Migrate 'ValueEventBox' to linear")
            boxGraph.beginTransaction()
            eventBox.slope.setValue(NaN)
            boxGraph.endTransaction()
        } else {
            console.debug("Migrate 'ValueEventBox' to new ValueEventCurveBox")
            boxGraph.beginTransaction()
            ValueEventCurveBox.create(boxGraph, UUID.generate(), box => {
                box.event.refer(eventBox.interpolation)
                box.slope.setValue(slope)
            })
            eventBox.slope.setValue(NaN)
            boxGraph.endTransaction()
        }
    }
}
