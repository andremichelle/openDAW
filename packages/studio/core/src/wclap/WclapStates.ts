import {UUID} from "@opendaw/lib-std"
import {WclapDeviceBox, WclapInstrumentBox} from "@opendaw/studio-boxes"
import {Project} from "../project"

// The plugin's own state blob, pushed by the bridge after it changed, kept on the device box as bytes
export namespace WclapStates {
    export const store = (project: Project, uuid: string, bytes: ArrayBuffer): void => {
        project.boxGraph.findBox(UUID.parse(uuid)).ifSome(box => {
            if (!(box instanceof WclapDeviceBox) && !(box instanceof WclapInstrumentBox)) {return}
            const next = new Int8Array(bytes.slice(0))
            if (equals(box.pluginState.getValue(), next) && box.state.getValue() === "") {return}
            project.editing.modify(() => {
                box.pluginState.setValue(next)
                box.state.setValue("")
            }, false)
        })
    }

    const equals = (a: Readonly<Int8Array>, b: Readonly<Int8Array>): boolean =>
        a.length === b.length && a.every((value, index) => value === b[index])
}
