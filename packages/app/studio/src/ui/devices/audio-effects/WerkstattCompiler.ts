import {asInstanceOf, Editing, isDefined, UUID} from "@opendaw/lib-std"
import {WerkstattDeviceBox, WerkstattParameterBox} from "@opendaw/studio-boxes"

const COMPILER_VERSION = 1
const HEADER_PATTERN = /^\/\/ @werkstatt (\w+) (\d+) (\d+)\n/
const PARAM_PATTERN = /^\/\/ @param (\w+)(?: ([.\d]+))?$/gm

interface ParamDeclaration {
    label: string
    defaultValue: number
}

const parseHeader = (source: string): { userCode: string, update: number } => {
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
    const seen = new Set<string>()
    for (const {label} of declared) {seen.add(label)}
    for (const [label, paramBox] of existingByLabel) {
        if (!seen.has(label)) {
            paramBox.delete()
        }
    }
    seen.clear()
    for (let index = 0; index < declared.length; index++) {
        const {label, defaultValue} = declared[index]
        if (seen.has(label)) {continue}
        seen.add(label)
        const existing = existingByLabel.get(label)
        if (isDefined(existing)) {
            existing.index.setValue(index)
            if (existing.defaultValue.getValue() !== defaultValue) {
                existing.defaultValue.setValue(defaultValue)
                existing.value.setValue(defaultValue)
            }
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
        editing: Editing,
        deviceBox: WerkstattDeviceBox,
        source: string
    ): Promise<void> => {
        const userCode = parseHeader(source).userCode
        const currentUpdate = parseHeader(deviceBox.code.getValue()).update
        const newUpdate = currentUpdate + 1
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
        new Function(wrappedCode)
        editing.append(() => {
            deviceBox.code.setValue(createHeader(newUpdate) + userCode)
            reconcileParameters(deviceBox, params)
        })
        const blob = new Blob([wrappedCode], {type: "application/javascript"})
        const blobUrl = URL.createObjectURL(blob)
        try {
            await audioContext.audioWorklet.addModule(blobUrl)
        } finally {
            URL.revokeObjectURL(blobUrl)
        }
    }
}