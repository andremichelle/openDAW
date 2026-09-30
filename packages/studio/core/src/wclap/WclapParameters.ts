import {asInstanceOf, isDefined, Optional, UUID} from "@opendaw/lib-std"
import {Field} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {WclapDeviceBox, WclapInstrumentBox, WclapParameterBox} from "@opendaw/studio-boxes"
import {WclapParamGesture, WclapParamInfo} from "@opendaw/studio-adapters"
import {Project} from "../project"

// The device's `WclapParameterBox` children mirror the loaded plugin's automatable parameters, keyed by clap id.
// An existing box keeps its value (the host is the source of truth, the bridge pushes it into the plugin) and
// keeps its automation, modulation and MIDI links when the plugin's range changed.
export namespace WclapParameters {
    export const reconcile = (project: Project, uuid: string, params: ReadonlyArray<WclapParamInfo>): void => {
        const hub = parametersOf(project, uuid)
        if (!isDefined(hub)) {return}
        const wanted = new Map(params.filter(isAutomatable).map(param => [param.id, param]))
        project.editing.modify(() => {
            const existing = new Map<number, WclapParameterBox>()
            for (const {box} of hub.pointerHub.incoming()) {
                const paramBox = asInstanceOf(box, WclapParameterBox)
                const id = paramBox.clapId.getValue() >>> 0
                const info = wanted.get(id)
                if (!isDefined(info)) {
                    paramBox.delete()
                    continue
                }
                existing.set(id, paramBox)
                paramBox.label.setValue(info.name)
                paramBox.module.setValue(info.module)
                paramBox.flags.setValue(info.flags)
                paramBox.min.setValue(info.min)
                paramBox.max.setValue(info.max)
                paramBox.defaultValue.setValue(info.defaultValue)
            }
            for (const info of wanted.values()) {
                if (existing.has(info.id)) {continue}
                WclapParameterBox.create(project.boxGraph, UUID.generate(), paramBox => {
                    paramBox.owner.refer(hub)
                    paramBox.label.setValue(info.name)
                    paramBox.module.setValue(info.module)
                    paramBox.clapId.setValue(info.id | 0)
                    paramBox.min.setValue(info.min)
                    paramBox.max.setValue(info.max)
                    paramBox.flags.setValue(info.flags)
                    paramBox.defaultValue.setValue(info.defaultValue)
                    paramBox.value.setValue(info.value)
                })
            }
        }, false)
    }

    export const apply = (project: Project, uuid: string, paramId: number, value: number, gesture: WclapParamGesture): void => {
        if (gesture !== 0) {return}
        const hub = parametersOf(project, uuid)
        if (!isDefined(hub)) {return}
        const paramBox = hub.pointerHub.incoming()
            .map(({box}) => asInstanceOf(box, WclapParameterBox))
            .find(paramBox => (paramBox.clapId.getValue() >>> 0) === paramId)
        if (!isDefined(paramBox) || paramBox.value.getValue() === Math.fround(value)) {return}
        project.editing.modify(() => paramBox.value.setValue(value), false)
    }

    const IS_HIDDEN = 1 << 2
    const IS_READONLY = 1 << 3
    const isAutomatable = ({flags}: WclapParamInfo): boolean => (flags & (IS_HIDDEN | IS_READONLY)) === 0

    const parametersOf = (project: Project, uuid: string): Optional<Field<Pointers.Parameter>> => {
        const box = project.boxGraph.findBox(UUID.parse(uuid)).unwrapOrNull()
        if (box instanceof WclapDeviceBox || box instanceof WclapInstrumentBox) {return box.parameters}
        return undefined
    }
}
