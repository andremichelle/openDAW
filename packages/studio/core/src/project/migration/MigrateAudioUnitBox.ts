import {BoxGraph} from "@opendaw/lib-box"
import {panic} from "@opendaw/lib-std"
import {AudioUnitBox, BoxIO} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {AudioUnitCapture} from "../AudioUnitCapture"

export const migrateAudioUnitBox = (boxGraph: BoxGraph<BoxIO.TypeMap>, box: AudioUnitBox): void => {
    if (box.type.getValue() !== AudioUnitType.Instrument || box.capture.nonEmpty()) {return}
    boxGraph.beginTransaction()
    if (!AudioUnitCapture.restore(boxGraph, box)) {return panic(`${box} has neither capture nor instrument.`)}
    boxGraph.endTransaction()
}
