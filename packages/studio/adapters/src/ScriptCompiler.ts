import {asInstanceOf, Editing, isDefined, tryCatch, UUID} from "@opendaw/lib-std"
import {BoxGraph, Field, StringField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {
    ScriptRecordBox,
    ScriptValueBox,
    WerkstattParameterBox,
    WerkstattSampleBox,
    WerkstattSidechainBox
} from "@opendaw/studio-boxes"
import {
    CollectionDeclaration,
    ParamDeclaration,
    SampleDeclaration,
    ScriptDeclaration,
    SidechainDeclaration
} from "./ScriptDeclaration"
import {ScriptTopLevel} from "./ScriptTopLevel"
import {ScriptRecords} from "./ScriptRecords"
import {ScriptBuffers} from "./ScriptBuffers"
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

const recordValues = (record: ScriptRecordBox): Map<string, ScriptValueBox> => new Map(record.values.pointerHub.filter()
    .map(({box}) => asInstanceOf(box, ScriptValueBox)).map(valueBox => [valueBox.field.getValue(), valueBox]))

// A changed declaration reshapes a collection (grow / shrink at the end, surviving records keep their values), an
// unchanged one leaves the records the view inserted or removed alone. A changed seed is written only into
// values that still hold the old seed.
const reconcileRecords = (hub: Field<Pointers.ScriptRecord>, declared: ReadonlyArray<CollectionDeclaration>,
                          previous: ReadonlyArray<CollectionDeclaration>): void => {
    const byCollection = new Map<string, Array<ScriptRecordBox>>()
    for (const {box} of hub.pointerHub.filter()) {
        const record = asInstanceOf(box, ScriptRecordBox)
        const records = byCollection.get(record.collection.getValue()) ?? []
        records.push(record)
        byCollection.set(record.collection.getValue(), records)
    }
    for (const [name, records] of byCollection) {
        if (!declared.some(collection => collection.name === name)) {records.forEach(record => record.delete())}
    }
    for (const collection of declared) {
        const records = (byCollection.get(collection.name) ?? [])
            .sort((left, right) => left.order.getValue() - right.order.getValue())
        const before = previous.find(candidate => candidate.name === collection.name)
        const target = collection.records.length
        const reshape = isDefined(before) ? before.records.length !== target : records.length === 0
        if (reshape) {
            while (records.length > target) {records.pop()?.delete()}
        }
        records.forEach((record, order) => {
            if (record.order.getValue() !== order) {record.order.setValue(order)}
            if (record.collectionIndex.getValue() !== collection.index) {record.collectionIndex.setValue(collection.index)}
            const values = recordValues(record)
            for (const [label, valueBox] of values) {
                if (!collection.fields.some(field => field.label === label)) {valueBox.delete()}
            }
            collection.fields.forEach((field, fieldIndex) => {
                const seed = collection.records[order]?.[fieldIndex] ?? field.defaultValue
                const valueBox = values.get(field.label)
                if (!isDefined(valueBox)) {
                    ScriptValueBox.create(hub.box.graph, UUID.generate(), box => {
                        box.owner.refer(record.values)
                        box.field.setValue(field.label)
                        box.fieldIndex.setValue(fieldIndex)
                        box.value.setValue(seed)
                    })
                    return
                }
                if (valueBox.fieldIndex.getValue() !== fieldIndex) {valueBox.fieldIndex.setValue(fieldIndex)}
                const beforeIndex = before?.fields.findIndex(candidate => candidate.label === field.label) ?? -1
                const oldSeed = beforeIndex === -1 ? null
                    : before?.records[order]?.[beforeIndex] ?? before?.fields[beforeIndex].defaultValue ?? null
                if (isDefined(oldSeed) && oldSeed !== seed && valueBox.value.getValue() === Math.fround(oldSeed)) {
                    valueBox.value.setValue(seed)
                }
                const value = valueBox.value.getValue()
                const clamped = Math.min(field.max, Math.max(field.min, value))
                if (clamped !== value) {valueBox.value.setValue(clamped)}
            })
        })
        if (reshape) {
            for (let order = records.length; order < target; order++) {ScriptRecords.create(hub, collection, order, collection.records[order])}
        }
    }
}

const previousCollections = (code: string, headerPattern: RegExp): ReadonlyArray<CollectionDeclaration> => {
    const result = tryCatch(() => ScriptDeclaration.parseCollections(parseHeader(code, headerPattern).userCode))
    return result.status === "success" ? result.value : []
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

// a saved project must always load: on load a malformed data directive declares nothing instead of throwing
const parseOnLoad = <T>(enforce: boolean, parse: () => ReadonlyArray<T>): ReadonlyArray<T> => {
    if (enforce) {return parse()}
    const result = tryCatch(parse)
    if (result.status === "success") {return result.value}
    console.warn("[ScriptCompiler] ignoring a malformed data directive on load", result.error)
    return []
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
    const collections = parseOnLoad(enforce, () => ScriptDeclaration.parseCollections(userCode)).map(({name, index, fields}) => ({
        name, index, fields: fields.map(({label, defaultValue}, fieldIndex) => ({label, index: fieldIndex, defaultValue}))
    }))
    return `
    if (typeof globalThis.openDAW === "undefined") { globalThis.openDAW = {} }
    if (typeof globalThis.openDAW.${config.registryName} === "undefined") { globalThis.openDAW.${config.registryName} = {} }
    globalThis.openDAW.${config.registryName}["${uuid}"] = {
        update: ${update},
        create: ${wrapProcessor(config, userCode, enforce)},
        params: ${JSON.stringify(params)},
        samples: ${JSON.stringify(samples)},
        sidechains: ${JSON.stringify(sidechains)},
        collections: ${JSON.stringify(collections)},
        streams: ${JSON.stringify(parseOnLoad(enforce, () => ScriptDeclaration.parseStreams(userCode)))},
        buffers: ${JSON.stringify(parseOnLoad(enforce, () => ScriptDeclaration.parseBuffers(userCode)))},
        readsSidechains: ${/\bthis\.sidechains\b/.test(userCode)},
        latency: ${ScriptDeclaration.parseLatency(userCode)},
        pass: ${ScriptDeclaration.parsePassThrough(userCode)}
    }
`
}

// The view realm's copy of the script: strict and frozen like the processor's, then it hands every class a
// `@view` or `@window` line names to the iframe runtime (`__openDAWViews`).
const wrapViewScript = (userCode: string): string => {
    const classNames = Array.from(new Set([...ScriptDeclaration.parseViews(userCode), ...ScriptDeclaration.parseWindows(userCode)]
        .map(({className}) => className)))
    const registry = classNames
        .map(name => `${JSON.stringify(name)}: typeof ${name} === "undefined" ? undefined : ${name}`).join(", ")
    const {declarations} = ScriptTopLevel.check(userCode)
    return `(function () {
    "use strict"
    ${userCode}
    ${ScriptTopLevel.freezeSource(declarations)}
    __openDAWViews({${registry}})
})()`
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
        readonly records?: Field<Pointers.ScriptRecord>
        readonly buffers?: Field<Pointers.ScriptBuffer>
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

    export const wrapView = wrapViewScript

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
                const collections = ScriptDeclaration.parseCollections(userCode)
                const buffers = ScriptDeclaration.parseBuffers(userCode)
                const previous = previousCollections(deviceBox.code.getValue(), headerPattern)
                const wrappedCode = wrapScript(config, uuid, newUpdate, userCode, true)
                validateCode(wrappedCode)
                if (ScriptTopLevel.applies(userCode)) {validateCode(wrapViewScript(userCode))}
                const label = ScriptDeclaration.parseLabel(userCode)
                claimRegistration(audioContext, deviceBox, newUpdate)
                const modifier = () => {
                    deviceBox.code.setValue(createHeader(newUpdate) + userCode)
                    label.ifSome(name => deviceBox.label.setValue(name))
                    reconcileParameters(deviceBox, params, order)
                    reconcileSamples(deviceBox, samples, order)
                    if (isDefined(deviceBox.sideChains)) {reconcileSidechains(deviceBox.sideChains, sidechains)}
                    if (isDefined(deviceBox.records)) {reconcileRecords(deviceBox.records, collections, previous)}
                    if (isDefined(deviceBox.buffers)) {ScriptBuffers.reconcile(deviceBox.buffers, buffers)}
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
