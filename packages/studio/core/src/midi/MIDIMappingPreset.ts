import {int, isDefined, Option, tryCatch} from "@opendaw/lib-std"
import {Address} from "@opendaw/lib-box"
import {AutomatableParameterFieldAdapter, ParameterOwner} from "@opendaw/studio-adapters"
import type {Project} from "../project"
import {MIDIMappableField} from "./MIDILearning"

export type MIDIMappingPresetEntry = {
    address: string
    unit: string
    owner: string
    parameter: string
    deviceId: string
    channel: int
    controlId: int
    min: number
    max: number
    takeover: int
    encoding: int
}

export type MIDIMappingPreset = {
    version: 1
    mappings: ReadonlyArray<MIDIMappingPresetEntry>
}

export type MIDIMappingImportResult = {
    imported: int
    replaced: int
    skipped: int
}

export namespace MIDIMappingPreset {
    const StringKeys = ["address", "unit", "owner", "parameter", "deviceId"] as const
    const NumberRanges: ReadonlyArray<readonly [keyof MIDIMappingPresetEntry, number, number]> = [
        ["channel", -1, 15], ["controlId", 0, 127], ["min", 0, 1], ["max", 0, 1], ["takeover", 0, 2], ["encoding", 0, 3]
    ]

    const unitName = (project: Project, adapter: AutomatableParameterFieldAdapter): string =>
        ParameterOwner.audioUnitOf(project, adapter.field).mapOr(unit => unit.label, "")

    const ownerName = (project: Project, adapter: AutomatableParameterFieldAdapter): string =>
        ParameterOwner.nameOf(project, adapter.field).unwrapOrElse("")

    export const create = (project: Project): MIDIMappingPreset => ({
        version: 1,
        mappings: project.midiLearning.controllerBoxes().flatMap(box => box.parameter.targetAddress
            .flatMap(address => project.parameterFieldAdapters.opt(address))
            .mapOr(adapter => [{
                address: adapter.address.toString(),
                unit: unitName(project, adapter),
                owner: ownerName(project, adapter),
                parameter: adapter.name,
                deviceId: box.deviceId.getValue(),
                channel: box.deviceChannel.getValue(),
                controlId: box.controlId.getValue(),
                min: box.min.getValue(),
                max: box.max.getValue(),
                takeover: box.takeover.getValue(),
                encoding: box.encoding.getValue()
            }], []))
    })

    const isRecord = (value: unknown): value is Record<string, unknown> =>
        typeof value === "object" && isDefined(value) && !Array.isArray(value)

    const isEntry = (value: unknown): value is MIDIMappingPresetEntry => {
        if (!isRecord(value)) {return false}
        return StringKeys.every(key => typeof value[key] === "string")
            && NumberRanges.every(([key, min, max]) => {
                const number = value[key]
                return typeof number === "number" && Number.isFinite(number) && number >= min && number <= max
            })
    }

    export const parse = (text: string): Option<MIDIMappingPreset> => {
        const {status, value} = tryCatch((): unknown => JSON.parse(text))
        if (status === "failure" || !isRecord(value)) {return Option.None}
        const {version, mappings} = value
        if (version !== 1 || !Array.isArray(mappings) || !mappings.every(isEntry)) {return Option.None}
        return Option.wrap({version, mappings})
    }

    const resolve = (project: Project, entry: MIDIMappingPresetEntry): Option<AutomatableParameterFieldAdapter> => {
        const byAddress = tryCatch(() => Address.decode(entry.address))
        if (byAddress.status === "success") {
            const adapter = project.parameterFieldAdapters.opt(byAddress.value)
            if (adapter.nonEmpty()) {return adapter}
        }
        const candidates = project.parameterFieldAdapters.adapters().filter(adapter =>
            adapter.name === entry.parameter
            && unitName(project, adapter) === entry.unit
            && ownerName(project, adapter) === entry.owner)
        return candidates.length === 1 ? Option.wrap(candidates[0]) : Option.None
    }

    export const apply = (project: Project, preset: MIDIMappingPreset): MIDIMappingImportResult => {
        const {midiLearning} = project
        return preset.mappings.reduce((result: MIDIMappingImportResult, entry) => resolve(project, entry).match({
            none: () => ({...result, skipped: result.skipped + 1}),
            some: adapter => {
                const replaced = midiLearning.hasMidiConnection(adapter.address)
                midiLearning.createMapping(adapter.field as unknown as MIDIMappableField, box => {
                    box.deviceId.setValue(entry.deviceId)
                    box.deviceChannel.setValue(entry.channel)
                    box.controlId.setValue(entry.controlId)
                    box.min.setValue(entry.min)
                    box.max.setValue(entry.max)
                    box.takeover.setValue(entry.takeover)
                    box.encoding.setValue(entry.encoding)
                })
                return {...result, imported: result.imported + 1, replaced: result.replaced + (replaced ? 1 : 0)}
            }
        }), {imported: 0, replaced: 0, skipped: 0})
    }
}
