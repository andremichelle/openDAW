import {UUID} from "@opendaw/lib-std"
import {WerkstattDeviceBox} from "@opendaw/studio-boxes"

const COMPILER_VERSION = 1
const HEADER_PATTERN = /^\/\/ @werkstatt (\w+) (\d+) (\d+)\n/

const parseHeader = (source: string): {userCode: string, update: number} => {
    const match = source.match(HEADER_PATTERN)
    if (match !== null) {
        return {userCode: source.slice(match[0].length), update: parseInt(match[3])}
    }
    return {userCode: source, update: 0}
}

const createHeader = (update: number): string =>
    `// @werkstatt js ${COMPILER_VERSION} ${update}\n`

export namespace WerkstattCompiler {
    export const stripHeader = (source: string): string => parseHeader(source).userCode
    export const compile = async (
        audioContext: BaseAudioContext,
        deviceBox: WerkstattDeviceBox,
        source: string
    ): Promise<void> => {
        const {userCode, update} = parseHeader(source)
        const newUpdate = update + 1
        const uuid = UUID.toString(deviceBox.address.uuid)
        const wrappedCode = `
            if (typeof globalThis.openDAW === "undefined") { globalThis.openDAW = {} }
            if (typeof globalThis.openDAW.werkstattProcessors === "undefined") { globalThis.openDAW.werkstattProcessors = {} }
            globalThis.openDAW.werkstattProcessors["${uuid}"] = {
                update: ${newUpdate},
                create: (function werkstatt() {
                    ${userCode}
                    return Processor
                })()
            }
        `
        const boxGraph = deviceBox.graph
        boxGraph.beginTransaction()
        deviceBox.code.setValue(createHeader(newUpdate) + userCode)
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
