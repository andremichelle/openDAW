import {int, isDefined, Option, tryCatch, unitValue} from "@opendaw/lib-std"
import {Address} from "@opendaw/lib-box"
import {AutomatableParameterFieldAdapter, ParameterOwner} from "@opendaw/studio-adapters"
import type {Project} from "../project"
import {MIDITakeover} from "./MIDITakeover"
import {MIDIEncoding} from "./MIDIEncoding"

export type MIDIMappingPreset = {
    version: 1
    mappings: ReadonlyArray<MIDIMappingPreset.Entry>
}

export namespace MIDIMappingPreset {
    export type Entry = {
        address: string
        unit: string
        owner: string
        parameter: string
        deviceId: string
        filterDeviceId: string
        channel: int
        controlId: int
        min: unitValue
        max: unitValue
        takeover: MIDITakeover
        encoding: MIDIEncoding
    }

    export type ImportResult = {
        imported: int
        replaced: int
        skipped: int
    }

    const StringKeys = ["address", "unit", "owner", "parameter", "deviceId", "filterDeviceId"] as const
    const IntegerRanges: ReadonlyArray<readonly ["channel" | "controlId", int, int]> = [["channel", -1, 15], ["controlId", 0, 127]]
    const UnitKeys = ["min", "max"] as const

    const isEnumValue = (values: ReadonlyArray<unknown>, value: unknown): boolean =>
        typeof value === "number" && values.includes(value)

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
                filterDeviceId: box.filterDeviceId.getValue(),
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

    const isEntry = (value: unknown): value is Entry => {
        if (!isRecord(value)) {return false}
        return StringKeys.every(key => typeof value[key] === "string")
            && IntegerRanges.every(([key, min, max]) => {
                const number = value[key]
                return typeof number === "number" && Number.isInteger(number) && number >= min && number <= max
            })
            && UnitKeys.every(key => {
                const number = value[key]
                return typeof number === "number" && Number.isFinite(number) && number >= 0.0 && number <= 1.0
            })
            && isEnumValue(Object.values(MIDITakeover), value.takeover)
            && isEnumValue(Object.values(MIDIEncoding), value.encoding)
    }

    export const parse = (text: string): Option<MIDIMappingPreset> => {
        const {status, value} = tryCatch((): unknown => JSON.parse(text))
        if (status === "failure" || !isRecord(value)) {return Option.None}
        const {version, mappings} = value
        if (version !== 1 || !Array.isArray(mappings) || !mappings.every(isEntry)) {return Option.None}
        return Option.wrap({version, mappings})
    }

    const resolve = (project: Project, entry: Entry): Option<AutomatableParameterFieldAdapter> => {
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

    export const apply = (project: Project, preset: MIDIMappingPreset): ImportResult => {
        const {midiLearning, editing} = project
        return editing.modify(() => preset.mappings.reduce((result: ImportResult, entry) => resolve(project, entry).match({
            none: () => ({...result, skipped: result.skipped + 1}),
            some: adapter => {
                const replaced = midiLearning.hasMidiConnection(adapter.address)
                midiLearning.createMapping(adapter.field, box => {
                    box.deviceId.setValue(entry.deviceId)
                    box.filterDeviceId.setValue(entry.filterDeviceId)
                    box.deviceChannel.setValue(entry.channel)
                    box.controlId.setValue(entry.controlId)
                    box.min.setValue(entry.min)
                    box.max.setValue(entry.max)
                    box.takeover.setValue(entry.takeover)
                    box.encoding.setValue(entry.encoding)
                })
                return {...result, imported: result.imported + 1, replaced: result.replaced + (replaced ? 1 : 0)}
            }
        }), {imported: 0, replaced: 0, skipped: 0})).unwrap("MIDI mapping import")
    }
}
