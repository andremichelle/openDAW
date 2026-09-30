import {UUID} from "@opendaw/lib-std"
import {WclapDeviceBox, WclapInstrumentBox} from "@opendaw/studio-boxes"
import {Project} from "../project"

// The plugin's own state blob, pushed by the bridge after it changed, kept on the device box as base64
export namespace WclapStates {
    export const store = (project: Project, uuid: string, bytes: ArrayBuffer): void => {
        const box = project.boxGraph.findBox(UUID.parse(uuid))
        console.debug(`[wclap] state for ${uuid}: ${bytes.byteLength} bytes, box ${box.mapOr(box => box.name, "NOT FOUND")}`)
        box.ifSome(box => {
            if (!(box instanceof WclapDeviceBox) && !(box instanceof WclapInstrumentBox)) {return}
            const base64 = encode(new Uint8Array(bytes))
            if (box.state.getValue() === base64) {return}
            project.editing.modify(() => box.state.setValue(base64), false)
            console.debug(`[wclap] state stored on ${box.name}, unsaved changes: ${project.editing.hasUnsavedChanges()}`)
        })
    }

    const encode = (bytes: Uint8Array): string => {
        const chunks: Array<string> = []
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)))
        }
        return btoa(chunks.join(""))
    }
}
