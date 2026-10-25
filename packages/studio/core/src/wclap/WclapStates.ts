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

    // a save the engine posted before it saw a new url or clapId belongs to the plugin the device no longer names
    export const storeFrom = (project: Project, uuid: string, bytes: ArrayBuffer, url: string, clapId: string): void => {
        project.boxGraph.findBox(UUID.parse(uuid)).ifSome(box => {
            if (!(box instanceof WclapDeviceBox) && !(box instanceof WclapInstrumentBox)) {return}
            if (box.url.getValue() !== url || box.clapId.getValue() !== clapId) {return}
            store(project, uuid, bytes)
        })
    }

    // inside a modify: another build of the same plugin reads the state, another plugin starts without it
    export const select = (box: WclapDeviceBox | WclapInstrumentBox, url: string, clapId: string): void => {
        if (box.clapId.getValue() !== clapId) {
            box.pluginState.setValue(new Int8Array(0))
            box.state.setValue("")
        }
        box.url.setValue(url)
        box.clapId.setValue(clapId)
    }

    const equals =(a: Readonly<Int8Array>, b: Readonly<Int8Array>): boolean =>
        a.length === b.length && a.every((value, index) => value === b[index])
}
