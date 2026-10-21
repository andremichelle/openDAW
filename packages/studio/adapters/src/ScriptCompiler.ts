import {asInstanceOf, Editing, isDefined, UUID} from "@opendaw/lib-std"
import {BoxGraph, Field, StringField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {WerkstattParameterBox, WerkstattSampleBox, WerkstattSidechainBox} from "@opendaw/studio-boxes"
import {ParamDeclaration, SampleDeclaration, ScriptDeclaration, SidechainDeclaration} from "./ScriptDeclaration"
import {ScriptTopLevel} from "./ScriptTopLevel"
import {DeviceBox} from "./DeviceBox"
import {Promises} from "@opendaw/lib-runtime"

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

const reconcileSidechains = (hub: Field<Pointers.ScriptSideChain>, declared: ReadonlyArray<SidechainDeclaration>): void => {
    const existingByLabel = new Map<string, WerkstattSidechainBox>()
    for (const pointer of hub.pointerHub.filter()) {
        const sidechainBox = asInstanceOf(pointer.box, WerkstattSidechainBox)
        existingByLabel.set(sidechainBox.label.getValue(), sidechainBox)
    }
    const declaredLabels = new Set(declared.map(({label}) => label))
    for (const [label, sidechainBox] of existingByLabel) {
        if (!declaredLabels.has(label)) {sidechainBox.delete()}
    }
    declared.forEach(({label}, index) => {
        const existing = existingByLabel.get(label)
        if (isDefined(existing)) {
            if (existing.index.getValue() !== index) {existing.index.setValue(index)}
        } else {
            WerkstattSidechainBox.create(hub.box.graph, UUID.generate(), sidechainBox => {
                sidechainBox.owner.refer(hub)
                sidechainBox.label.setValue(label)
                sidechainBox.index.setValue(index)
            })
        }
    })
}

// Wrap the user script for registration into `globalThis.openDAW.<registry>[uuid]`. Beyond `{update, create}`
// (consumed by the TS core-processors engine), the entry also carries the `@no-pass` verdict (`pass`, read by
// the Spielwerk bridge) plus the PARSED `@param` / `@sample`
// declarations (with their declaration index, matching the `WerkstattParameterBox.index` the engine keys by):
// the WASM script bridge needs them to map a param's raw automation value through the right `ValueMapping` and
// to label each param / sample, since the worklet has no box graph to read those from. The TS engine ignores
// the extra fields (it resolves mappings + labels from the box adapter), so this stays a pure superset.
// A script with a view runs in two realms, so its top level must not hold state (ScriptTopLevel): it is strict,
// the shared globals are shadowed and every top-level value is frozen. Violations refuse a compile, never a load.
const wrapProcessor = (config: ScriptCompiler.Config, userCode: string, enforce: boolean): string => {
    if (!ScriptTopLevel.applies(userCode)) {
        return `(function ${config.functionName}() {
            ${userCode}
            return Processor
        })()`
    }
    const {declarations, violations} = ScriptTopLevel.check(userCode)
    if (enforce && violations.length > 0) {throw new Error(ScriptTopLevel.format(violations))}
    return `(function ${config.functionName}(globalThis, self, openDAW) {
            "use strict"
            ${userCode}
            ${ScriptTopLevel.freezeSource(declarations)}
            return Processor
        })()`
}

const wrapScript = (config: ScriptCompiler.Config, uuid: string, update: number, userCode: string,
                    enforce: boolean = false): string => {
    const order = ScriptDeclaration.parseDeclarationOrder(userCode)
    const params = ScriptDeclaration.parseParams(userCode).map(declaration => ({
        label: declaration.label, index: order.get(declaration.label) ?? 0, mapping: declaration.mapping,
        min: declaration.min, max: declaration.max, unit: declaration.unit
    }))
    const samples = ScriptDeclaration.parseSamples(userCode).map(declaration => ({
        label: declaration.label, index: order.get(declaration.label) ?? 0
    }))
    const sidechains = ScriptDeclaration.parseSidechains(userCode).map(({label}, index) => ({label, index}))
    return `
    if (typeof globalThis.openDAW === "undefined") { globalThis.openDAW = {} }
    if (typeof globalThis.openDAW.${config.registryName} === "undefined") { globalThis.openDAW.${config.registryName} = {} }
    globalThis.openDAW.${config.registryName}["${uuid}"] = {
        update: ${update},
        create: ${wrapProcessor(config, userCode, enforce)},
        params: ${JSON.stringify(params)},
        samples: ${JSON.stringify(samples)},
        sidechains: ${JSON.stringify(sidechains)},
        readsSidechains: ${/\bthis\.sidechains\b/.test(userCode)},
        latency: ${ScriptDeclaration.parseLatency(userCode)},
        pass: ${ScriptDeclaration.parsePassThrough(userCode)}
    }
`
}

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

// the script version each device has registered in a context's worklet scope, so a reload of the same version is skipped
const registeredUpdates = new WeakMap<BaseAudioContext, WeakMap<ScriptCompiler.ScriptDeviceBox, number>>()

const claimRegistration = (audioContext: BaseAudioContext, deviceBox: ScriptCompiler.ScriptDeviceBox,
                           update: number): boolean => {
    const updates = registeredUpdates.get(audioContext) ?? new WeakMap<ScriptCompiler.ScriptDeviceBox, number>()
    registeredUpdates.set(audioContext, updates)
    if (updates.get(deviceBox) === update) {return false}
    updates.set(deviceBox, update)
    return true
}

const registerClaimed = async (audioContext: BaseAudioContext, deviceBox: ScriptCompiler.ScriptDeviceBox,
                               update: number, wrappedCode: string): Promise<void> => {
    const result = await Promises.tryCatch(registerWorklet(audioContext, wrappedCode))
    if (result.status === "rejected") {
        const updates = registeredUpdates.get(audioContext)
        if (updates?.get(deviceBox) === update) {updates.delete(deviceBox)}
        throw result.error
    }
}

export namespace ScriptCompiler {
    export interface ScriptDeviceBox extends DeviceBox {
        readonly graph: BoxGraph
        readonly code: StringField
        readonly parameters: Field<Pointers.Parameter>
        readonly samples: Field<Pointers.Sample>
        readonly sideChains?: Field<Pointers.ScriptSideChain>
    }

    export type Config = {
        readonly headerTag: string
        readonly registryName: string
        readonly functionName: string
    }

    // The wrapped, registry-populating source for a script (`{update, create, params, samples}`), exposed so the
    // WASM script bridge + its parity tests + the offline renderer can seed `globalThis.openDAW` identically to
    // the live app (which goes through `compile` / `load`). The single source of truth for the registry shape.
    export const wrap = wrapScript

    export const reconcileSidechainBoxes = reconcileSidechains

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
                const wrappedCode = wrapScript(config, uuid, update, userCode)
                validateCode(wrappedCode)
                if (!claimRegistration(audioContext, deviceBox, update)) {return}
                return registerClaimed(audioContext, deviceBox, update, wrappedCode)
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
                const sidechains = ScriptDeclaration.parseSidechains(userCode)
                const wrappedCode = wrapScript(config, uuid, newUpdate, userCode, true)
                validateCode(wrappedCode)
                const label = ScriptDeclaration.parseLabel(userCode)
                claimRegistration(audioContext, deviceBox, newUpdate)
                const modifier = () => {
                    deviceBox.code.setValue(createHeader(newUpdate) + userCode)
                    label.ifSome(name => deviceBox.label.setValue(name))
                    reconcileParameters(deviceBox, params, order)
                    reconcileSamples(deviceBox, samples, order)
                    if (isDefined(deviceBox.sideChains)) {reconcileSidechains(deviceBox.sideChains, sidechains)}
                }
                if (append) {
                    editing.append(modifier)
                } else {
                    editing.modify(modifier)
                }
                return registerClaimed(audioContext, deviceBox, newUpdate, wrappedCode)
            }
        }
    }
}
