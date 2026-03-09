import {UUID} from "@opendaw/lib-std"
import {WerkstattDeviceBox} from "@opendaw/studio-boxes"

export namespace WerkstattCompiler {
    export const compile = async (
        audioContext: BaseAudioContext,
        deviceBox: WerkstattDeviceBox
    ): Promise<void> => {
        const code = deviceBox.code.getValue()
        const uuid = UUID.toString(deviceBox.address.uuid)
        const version = deviceBox.version.getValue() + 1
        const wrappedCode = `
            if (typeof globalThis.openDAW === "undefined") { globalThis.openDAW = {} }
            if (typeof globalThis.openDAW.werkstattProcessors === "undefined") { globalThis.openDAW.werkstattProcessors = {} }
            globalThis.openDAW.werkstattProcessors["${uuid}"] = {
                version: ${version},
                create: (function werkstatt() {
                    ${code}
                    return Processor
                })()
            }
        `
        const boxGraph = deviceBox.graph
        boxGraph.beginTransaction()
        deviceBox.version.setValue(version)
        boxGraph.endTransaction()
        const blob = new Blob([wrappedCode], {type: "application/javascript"})
        const blobUrl = URL.createObjectURL(blob)
        try {
            await audioContext.audioWorklet.addModule(blobUrl)
        } finally {
            URL.revokeObjectURL(blobUrl)
        }
    }
}
