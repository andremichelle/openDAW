import {BoxGraph} from "@opendaw/lib-box"
import {clamp} from "@opendaw/lib-std"
import {BoxIO, DelayDeviceBox} from "@opendaw/studio-boxes"
import {migrateAutomation} from "./MigrateAutomation"

export const migrateDelayDeviceBox = (boxGraph: BoxGraph<BoxIO.TypeMap>, box: DelayDeviceBox): void => {
    if (box.version.getValue() !== 0) {return}
    // Old descending: 1/1, 1/2, 1/3, 1/4, 3/16, 1/6, 1/8, 3/32, 1/12, 1/16, 3/64, 1/24, 1/32, 1/48, 1/64, 1/96, 1/128
    // New ascending: off, 1/128, 1/96, 1/64, 1/48, 1/32, 1/24, 3/64, 1/16, 1/12, 3/32, 1/8, 1/6, 3/16, 1/4, 5/16, 1/3, 3/8, 7/16, 1/2, 1/1
    const oldToNewIndex = [20, 19, 16, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]
    const oldMaxIndex = 16
    const newMaxIndex = 20
    const oldIndex = box.delayMusical.getValue()
    const newIndex = oldToNewIndex[Math.round(clamp(oldIndex, 0, oldMaxIndex))]
    console.debug(`Migrate 'DelayDeviceBox' delay index from ${oldIndex} to ${newIndex}`)
    boxGraph.beginTransaction()
    box.delayMusical.setValue(newIndex)
    box.delayMillis.setValue(0)
    box.preSyncTimeLeft.setValue(0)
    box.preMillisTimeLeft.setValue(0)
    box.preSyncTimeRight.setValue(0)
    box.preMillisTimeRight.setValue(0)
    box.version.setValue(1)
    migrateAutomation(boxGraph, box.delayMusical,
        unit => oldToNewIndex[clamp(Math.round(unit * oldMaxIndex), 0, oldMaxIndex)] / newMaxIndex)
    boxGraph.endTransaction()
}
