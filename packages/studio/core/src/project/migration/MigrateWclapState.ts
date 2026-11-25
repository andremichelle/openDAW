import {BoxGraph} from "@opendaw/lib-box"
import {tryCatch} from "@opendaw/lib-std"
import {BoxIO, WclapDeviceBox, WclapInstrumentBox} from "@opendaw/studio-boxes"

export const migrateWclapState = (boxGraph: BoxGraph<BoxIO.TypeMap>, box: WclapDeviceBox | WclapInstrumentBox): void => {
    const base64 = box.state.getValue()
    if (base64.length === 0 || box.pluginState.getValue().length > 0) {return}
    const decoded = tryCatch(() => Uint8Array.from(atob(base64), char => char.charCodeAt(0)))
    if (decoded.status === "failure") {
        console.warn(`Migrate '${box.name}' kept its state, it is no valid base64`, box.address.toString())
        return
    }
    console.debug(`Migrate '${box.name}' state into plugin-state`)
    boxGraph.beginTransaction()
    box.pluginState.setValue(new Int8Array(decoded.value.buffer))
    box.state.setValue("")
    boxGraph.endTransaction()
}
