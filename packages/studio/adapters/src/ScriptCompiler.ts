import {asInstanceOf, Editing, isDefined, UUID} from "@opendaw/lib-std"
import {BoxGraph, Field, StringField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {WerkstattParameterBox, WerkstattSampleBox} from "@opendaw/studio-boxes"
import {ParamDeclaration, SampleDeclaration, ScriptDeclaration} from "./ScriptDeclaration"
import {DeviceBox} from "./DeviceBox"

const COMPILER_VERSION = 1

const createHeaderPattern = (tag: string): RegExp => new RegExp(`^// @${tag} (\\w+) (\\d+) (\\d+)\n`)

const parseHeader = (source: string, pattern: RegExp): { userCode: string, update: number } => {
    const match = source.match(pattern)
    return match !== null ? {
        userCode: source.slice(match[0].length),
        update: parseInt(match[3])
    } : {
        userCode: source,
        update: 0
    }
}

const cachedParamDeclarations = new WeakMap<ScriptCompiler.ScriptDeviceBox, Map<string, ParamDeclaration>>()

const reconcileParameters = (deviceBox: ScriptCompiler.ScriptDeviceBox, declared: ReadonlyArray<ParamDeclaration>, order: Map<string, number>): void => {
    const boxGraph = deviceBox.graph
    const previousDeclarations = cachedParamDeclarations.get(deviceBox) ?? new Map<string, ParamDeclaration>()
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
    const newDeclarations = new Map<string, ParamDeclaration>()
    for (const declaration of declared) {
        if (seen.has(declaration.label)) {continue}
        seen.add(declaration.label)
        const unifiedIndex = order.get(declaration.label) ?? 0
        const existing = existingByLabel.get(declaration.label)
        const previous = previousDeclarations.get(declaration.label)
        const declarationChanged = !isDefined(previous) || !ScriptDeclaration.isEqual(previous, declaration)
        if (isDefined(existing) && declarationChanged) {
            existing.delete()
            existingByLabel.delete(declaration.label)
        }
        const current = existingByLabel.get(declaration.label)
        if (isDefined(current)) {
            if (current.index.getValue() !== unifiedIndex) {
                current.index.setValue(unifiedIndex)
            }
        } else {
            WerkstattParameterBox.create(boxGraph, UUID.generate(), paramBox => {
                paramBox.owner.refer(deviceBox.parameters)
                paramBox.label.setValue(declaration.label)
                paramBox.index.setValue(unifiedIndex)
                paramBox.value.setValue(declaration.defaultValue)
                paramBox.defaultValue.setValue(declaration.defaultValue)
            })
        }
        newDeclarations.set(declaration.label, declaration)
    }
    cachedParamDeclarations.set(deviceBox, newDeclarations)
}

const reconcileSamples = (deviceBox: ScriptCompiler.ScriptDeviceBox, declared: ReadonlyArray<SampleDeclaration>, order: Map<string, number>): void => {
    const boxGraph = deviceBox.graph
    const existingPointers = deviceBox.samples.pointerHub.filter()
    const existingByLabel = new Map<string, WerkstattSampleBox>()
    for (const pointer of existingPointers) {
        const sampleBox = asInstanceOf(pointer.box, WerkstattSampleBox)
        existingByLabel.set(sampleBox.label.getValue(), sampleBox)
    }
    const seen = new Set<string>()
    for (const {label} of declared) {seen.add(label)}
    for (const [label, sampleBox] of existingByLabel) {
        if (!seen.has(label)) {
            sampleBox.file.targetVertex.ifSome(({box: fileBox}) => {
                const mustDelete = fileBox.pointerHub.size() === 1
                sampleBox.file.defer()
                if (mustDelete) {fileBox.delete()}
            })
            sampleBox.delete()
        }
    }
    seen.clear()
    for (const declaration of declared) {
        if (seen.has(declaration.label)) {continue}
        seen.add(declaration.label)
        const unifiedIndex = order.get(declaration.label) ?? 0
        const existing = existingByLabel.get(declaration.label)
        if (isDefined(existing)) {
            if (existing.index.getValue() !== unifiedIndex) {
                existing.index.setValue(unifiedIndex)
            }
        } else {
            WerkstattSampleBox.create(boxGraph, UUID.generate(), sampleBox => {
                sampleBox.owner.refer(deviceBox.samples)
                sampleBox.label.setValue(declaration.label)
                sampleBox.index.setValue(unifiedIndex)
            })
        }
    }
}

const wrapCode = (config: ScriptCompiler.Config, uuid: string, update: number, userCode: string): string => `
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

export namespace ScriptCompiler {
    export interface ScriptDeviceBox extends DeviceBox {
        readonly graph: BoxGraph
        readonly code: StringField
        readonly parameters: Field<Pointers.Parameter>
        readonly samples: Field<Pointers.Sample>
    }

    export type Config = {
        readonly headerTag: string
        readonly registryName: string
        readonly functionName: string
    }

    export const create = (config: Config) => {
        const headerPattern = createHeaderPattern(config.headerTag)
        const createHeader = (update: number): string =>
            `// @${config.headerTag} js ${COMPILER_VERSION} ${update}\n`
        let maxUpdate = 0
        return {
            stripHeader: (source: string): string => parseHeader(source, headerPattern).userCode,
            load: async (audioContext: BaseAudioContext, deviceBox: ScriptDeviceBox): Promise<void> => {
                const {userCode, update} = parseHeader(deviceBox.code.getValue(), headerPattern)
                if (update === 0) {return}
                const params = ScriptDeclaration.parseParams(userCode)
                const declMap = new Map<string, ParamDeclaration>()
                for (const declaration of params) {declMap.set(declaration.label, declaration)}
                cachedParamDeclarations.set(deviceBox, declMap)
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
                maxUpdate = Math.max(maxUpdate, currentUpdate)
                const newUpdate = maxUpdate + 1
                maxUpdate = newUpdate
                const uuid = UUID.toString(deviceBox.address.uuid)
                const params = ScriptDeclaration.parseParams(userCode)
                const samples = ScriptDeclaration.parseSamples(userCode)
                const order = ScriptDeclaration.parseDeclarationOrder(userCode)
                const wrappedCode = wrapCode(config, uuid, newUpdate, userCode)
                validateCode(wrappedCode)
                const label = ScriptDeclaration.parseLabel(userCode)
                const modifier = () => {
                    deviceBox.code.setValue(createHeader(newUpdate) + userCode)
                    label.ifSome(name => deviceBox.label.setValue(name))
                    reconcileParameters(deviceBox, params, order)
                    reconcileSamples(deviceBox, samples, order)
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
}
