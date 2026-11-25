import {BoxGraph} from "@opendaw/lib-box"
import {BoxIO, EuclidLaneBox} from "@opendaw/studio-boxes"
import {Euclid} from "@opendaw/studio-adapters"

export const migrateEuclidLaneBox = (boxGraph: BoxGraph<BoxIO.TypeMap>, box: EuclidLaneBox): void => {
    const mute = box.mute.getValue()
    const solo = box.solo.getValue()
    if (!mute && !solo) {return}
    boxGraph.beginTransaction()
    for (let pattern = 0; pattern < Euclid.Patterns; pattern++) {
        const rhythm = Euclid.rhythmOf(box, pattern)
        if (mute) {rhythm.mute.setValue(true)}
        if (solo) {rhythm.solo.setValue(true)}
    }
    box.mute.writeDeprecated(false)
    box.solo.writeDeprecated(false)
    boxGraph.endTransaction()
}
