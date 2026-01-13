import {BoxGraph} from "@moises-ai/lib-box"
import {clamp} from "@moises-ai/lib-std"
import {BoxIO, RevampDeviceBox} from "@moises-ai/studio-boxes"

export const migrateRevampDeviceBox = (boxGraph: BoxGraph<BoxIO.TypeMap>, box: RevampDeviceBox): void => {
    boxGraph.beginTransaction()
    box.lowPass.order.setValue(clamp(box.lowPass.order.getValue(), 0, 3))
    box.highPass.order.setValue(clamp(box.highPass.order.getValue(), 0, 3))
    boxGraph.endTransaction()
}
