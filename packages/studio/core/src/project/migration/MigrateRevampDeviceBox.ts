import {BoxGraph} from "@opendaw/lib-box"
import {clamp} from "@opendaw/lib-std"
import {BoxIO, RevampDeviceBox} from "@opendaw/studio-boxes"

export const migrateRevampDeviceBox = (boxGraph: BoxGraph<BoxIO.TypeMap>, box: RevampDeviceBox): void => {
    boxGraph.beginTransaction()
    box.lowPass.order.setValue(clamp(box.lowPass.order.getValue(), 0, 3))
    box.highPass.order.setValue(clamp(box.highPass.order.getValue(), 0, 3))
    boxGraph.endTransaction()
}
