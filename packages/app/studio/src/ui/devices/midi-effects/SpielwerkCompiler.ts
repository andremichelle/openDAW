import {asInstanceOf, Editing, isDefined, Nullable, UUID} from "@opendaw/lib-std"
import {SpielwerkDeviceBox, WerkstattParameterBox} from "@opendaw/studio-boxes"

const COMPILER_VERSION = 1
const HEADER_PATTERN = /^\/\/ @spielwerk (\w+) (\d+) (\d+)\n/

interface ParamDeclaration {
    label: string
    defaultValue: number
}

const parseHeader = (source: string): { userCode: string, update: number } => {
    const match = source.match(HEADER_PATTERN)
    return match !== null ? {
        userCode: source.slice(match[0].length),
        update: parseInt(match[3])
    } : {
        userCode: source,
        update: 0
    }
}

const createHeader = (update: number): string => `// @spielwerk js ${COMPILER_VERSION} ${update}\n`

const PARAM_LINE = /^\/\/ @param .+$/gm

const parseParams = (code: string): ReadonlyArray<ParamDeclaration> => {
    const params: Array<ParamDeclaration> = []
    let match: Nullable<RegExpExecArray>
    PARAM_LINE.lastIndex = 0
    while ((match = PARAM_LINE.exec(code)) !== null) {
        const valid = match[0].match(/^\/\/ @param (\w+)(?: ([.\d]+))?$/)
        if (valid === null) {
            throw new Error(`Malformed @param: '${match[0]}' — expected: // @param <name> [defaultValue]`)
        }
        params.push({
            label: valid[1],
            defaultValue: isDefined(valid[2]) ? parseFloat(valid[2]) : 0.0
        })
    }
    return params
}

const reconcileParameters = (deviceBox: SpielwerkDeviceBox, declared: ReadonlyArray<ParamDeclaration>): void => {
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

const wrapCode = (uuid: string, update: number, userCode: string): string => `
    if (typeof globalThis.openDAW === "undefined") { globalThis.openDAW = {} }
    if (typeof globalThis.openDAW.spielwerkProcessors === "undefined") { globalThis.openDAW.spielwerkProcessors = {} }
    globalThis.openDAW.spielwerkProcessors["${uuid}"] = {
        update: ${update},
        create: (function spielwerk() {
            ${userCode}
            return Processor
        })()
    }
`

const validateCode = (wrappedCode: string): void => {new Function(wrappedCode)}

const registerWorklet = async (audioContext: BaseAudioContext,
                               wrappedCode: string): Promise<void> => {
    const blob = new Blob([wrappedCode], {type: "application/javascript"})
    const blobUrl = URL.createObjectURL(blob)
    try {
        await audioContext.audioWorklet.addModule(blobUrl)
    } finally {
        URL.revokeObjectURL(blobUrl)
    }
}

export namespace SpielwerkCompiler {
    export const stripHeader = (source: string): string => parseHeader(source).userCode
    export const load = async (audioContext: BaseAudioContext, deviceBox: SpielwerkDeviceBox): Promise<void> => {
        const {userCode, update} = parseHeader(deviceBox.code.getValue())
        if (update === 0) {return}
        const uuid = UUID.toString(deviceBox.address.uuid)
        const wrappedCode = wrapCode(uuid, update, userCode)
        validateCode(wrappedCode)
        return registerWorklet(audioContext, wrappedCode)
    }
    export const compile = async (audioContext: BaseAudioContext,
                                  editing: Editing,
                                  deviceBox: SpielwerkDeviceBox,
                                  source: string,
                                  append: boolean = false): Promise<void> => {
        const userCode = parseHeader(source).userCode
        const currentUpdate = parseHeader(deviceBox.code.getValue()).update
        const newUpdate = currentUpdate + 1
        const uuid = UUID.toString(deviceBox.address.uuid)
        const params = parseParams(userCode)
        const wrappedCode = wrapCode(uuid, newUpdate, userCode)
        validateCode(wrappedCode)
        const modifier = () => {
            deviceBox.code.setValue(createHeader(newUpdate) + userCode)
            reconcileParameters(deviceBox, params)
        }
        if (append) {
            editing.append(modifier)
        } else {
            editing.modify(modifier)
        }
        return registerWorklet(audioContext, wrappedCode)
    }
}
