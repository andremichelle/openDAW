import {asInstanceOf, Editing, isDefined, UUID} from "@moises-ai/lib-std"
import {BoxGraph, Field, StringField} from "@moises-ai/lib-box"
import {Pointers} from "@moises-ai/studio-enums"
import {WerkstattParameterBox} from "@moises-ai/studio-boxes"
import {parseParams} from "@moises-ai/studio-adapters"
import type {ParamDeclaration} from "@moises-ai/studio-adapters"

export interface ScriptDeviceBox {
    readonly graph: BoxGraph
    readonly address: {readonly uuid: UUID.Bytes}
    readonly code: StringField
    readonly parameters: Field<Pointers.Parameter>
}

export type ScriptCompilerConfig = {
    readonly headerTag: string
    readonly registryName: string
    readonly functionName: string
}

const COMPILER_VERSION = 1
const FLOAT_TOLERANCE = 1e-6

const createHeaderPattern = (tag: string): RegExp => new RegExp(`^// @${tag} (\\w+) (\\d+) (\\d+)\n`)

const parseHeader = (source: string, pattern: RegExp): {userCode: string, update: number} => {
    const match = source.match(pattern)
    return match !== null ? {
        userCode: source.slice(match[0].length),
        update: parseInt(match[3])
    } : {
        userCode: source,
        update: 0
    }
}

const reconcileParameters = (deviceBox: ScriptDeviceBox, declared: ReadonlyArray<ParamDeclaration>): void => {
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
        const declaration = declared[index]
        if (seen.has(declaration.label)) {continue}
        seen.add(declaration.label)
        const existing = existingByLabel.get(declaration.label)
        const mappedDefault = declaration.defaultValue
        if (isDefined(existing)) {
            existing.index.setValue(index)
            if (Math.abs(existing.defaultValue.getValue() - mappedDefault) > FLOAT_TOLERANCE) {
                existing.defaultValue.setValue(mappedDefault)
                existing.value.setValue(mappedDefault)
            }
        } else {
            WerkstattParameterBox.create(boxGraph, UUID.generate(), paramBox => {
                paramBox.owner.refer(deviceBox.parameters)
                paramBox.label.setValue(declaration.label)
                paramBox.index.setValue(index)
                paramBox.value.setValue(mappedDefault)
                paramBox.defaultValue.setValue(mappedDefault)
            })
        }
    }
}

const wrapCode = (config: ScriptCompilerConfig, uuid: string, update: number, userCode: string): string => `
    if (typeof globalThis.openDAW === "undefined") { globalThis.openDAW = {} }
    if (typeof globalThis.openDAW.${config.registryName} === "undefined") { globalThis.openDAW.${config.registryName} = {} }
    globalThis.openDAW.${config.registryName}["${uuid}"] = {
        update: ${update},
        create: (function ${config.functionName}() {
            ${userCode}
            return Processor
        })()
    }
`

const validateCode = (wrappedCode: string): void => {new Function(wrappedCode)}

const registerWorklet = async (audioContext: BaseAudioContext, wrappedCode: string): Promise<void> => {
    const blob = new Blob([wrappedCode], {type: "application/javascript"})
    const blobUrl = URL.createObjectURL(blob)
    try {
        await audioContext.audioWorklet.addModule(blobUrl)
    } finally {
        URL.revokeObjectURL(blobUrl)
    }
}

export const createScriptCompiler = (config: ScriptCompilerConfig) => {
    const headerPattern = createHeaderPattern(config.headerTag)
    const createHeader = (update: number): string =>
        `// @${config.headerTag} js ${COMPILER_VERSION} ${update}\n`
    return {
        stripHeader: (source: string): string => parseHeader(source, headerPattern).userCode,
        load: async (audioContext: BaseAudioContext, deviceBox: ScriptDeviceBox): Promise<void> => {
            const {userCode, update} = parseHeader(deviceBox.code.getValue(), headerPattern)
            if (update === 0) {return}
            const uuid = UUID.toString(deviceBox.address.uuid)
            const wrappedCode = wrapCode(config, uuid, update, userCode)
            validateCode(wrappedCode)
            return registerWorklet(audioContext, wrappedCode)
        },
        compile: async (audioContext: BaseAudioContext,
                        editing: Editing,
                        deviceBox: ScriptDeviceBox,
                        source: string,
                        append: boolean = false): Promise<void> => {
            const userCode = parseHeader(source, headerPattern).userCode
            const currentUpdate = parseHeader(deviceBox.code.getValue(), headerPattern).update
            const newUpdate = currentUpdate + 1
            const uuid = UUID.toString(deviceBox.address.uuid)
            const params = parseParams(userCode)
            const wrappedCode = wrapCode(config, uuid, newUpdate, userCode)
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
}
