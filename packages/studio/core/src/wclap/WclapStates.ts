import {UUID} from "@opendaw/lib-std"
import {WclapDeviceBox, WclapInstrumentBox} from "@opendaw/studio-boxes"
import {Project} from "../project"

// The plugin's own state blob, pushed by the bridge after it changed, kept on the device box as base64
export namespace WclapStates {
    export const store = (project: Project, uuid: string, bytes: ArrayBuffer): void => {
        project.boxGraph.findBox(UUID.parse(uuid)).ifSome(box => {
            if (!(box instanceof WclapDeviceBox) && !(box instanceof WclapInstrumentBox)) {return}
            const base64 = encode(new Uint8Array(bytes))
            if (box.state.getValue() === base64) {return}
            project.editing.modify(() => box.state.setValue(base64), false)
        })
    }

    const encode = (bytes: Uint8Array): string => {
        const chunks = Array.from({length: Math.ceil(bytes.length / 0x8000)},
            (_, index) => String.fromCharCode(...bytes.subarray(index * 0x8000, (index + 1) * 0x8000)))
        return btoa(chunks.join(""))
    }
}
