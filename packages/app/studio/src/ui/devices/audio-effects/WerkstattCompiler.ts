import {asInstanceOf, isDefined, UUID} from "@opendaw/lib-std"
import {WerkstattDeviceBox, WerkstattParameterBox} from "@opendaw/studio-boxes"

const COMPILER_VERSION = 1
const HEADER_PATTERN = /^\/\/ @werkstatt (\w+) (\d+) (\d+)\n/
const PARAM_PATTERN = /^\/\/ @param (\w+)(?: ([.\d]+))?$/gm

interface ParamDeclaration {
    label: string
    defaultValue: number
}

const parseHeader = (source: string): {userCode: string, update: number} => {
    const match = source.match(HEADER_PATTERN)
    if (match !== null) {
        return {userCode: source.slice(match[0].length), update: parseInt(match[3])}
    }
    return {userCode: source, update: 0}
}

const createHeader = (update: number): string =>
    `// @werkstatt js ${COMPILER_VERSION} ${update}\n`

const parseParams = (code: string): ReadonlyArray<ParamDeclaration> => {
    const params: Array<ParamDeclaration> = []
    let match: RegExpExecArray | null
    PARAM_PATTERN.lastIndex = 0
    while ((match = PARAM_PATTERN.exec(code)) !== null) {
        params.push({
            label: match[1],
            defaultValue: isDefined(match[2]) ? parseFloat(match[2]) : 0.0
        })
    }
    return params
}

const reconcileParameters = (deviceBox: WerkstattDeviceBox, declared: ReadonlyArray<ParamDeclaration>): void => {
    const boxGraph = deviceBox.graph
    const existingPointers = deviceBox.parameters.pointerHub.filter()
    const existingByLabel = new Map<string, WerkstattParameterBox>()
    for (const pointer of existingPointers) {
        const paramBox = asInstanceOf(pointer.box, WerkstattParameterBox)
        existingByLabel.set(paramBox.label.getValue(), paramBox)
    }
    const declaredLabels = new Set(declared.map(declaration => declaration.label))
    for (const [label, paramBox] of existingByLabel) {
        if (!declaredLabels.has(label)) {
            paramBox.delete()
        }
    }
    for (let index = 0; index < declared.length; index++) {
        const {label, defaultValue} = declared[index]
        const existing = existingByLabel.get(label)
        if (isDefined(existing)) {
            existing.index.setValue(index)
            existing.defaultValue.setValue(defaultValue)
        } else {
            WerkstattParameterBox.create(boxGraph, UUID.generate(), paramBox => {
                paramBox.owner.refer(deviceBox.parameters)
                paramBox.label.setValue(label)
                paramBox.index.setValue(index)
                paramBox.value.setValue(defaultValue)
                paramBox.defaultValue.setValue(defaultValue)
            })
        }
    }
}

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
        const params = parseParams(userCode)
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
        reconcileParameters(deviceBox, params)
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
