import {Color, Exec, isAbsent, isDefined, Nullable, Terminable, UUID} from "@opendaw/lib-std"
import {Project} from "@opendaw/studio-core"
import {DeviceBoxAdapter, EffectDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {DragDevice} from "@/ui/AnyDragData"
import {GhostCount} from "@/ui/devices/GhostCount"

export namespace DeviceDragging {
    export const install = (project: Project,
                            element: HTMLElement,
                            adapter: DeviceBoxAdapter,
                            color: Color,
                            onDragStart: Exec): Terminable => {
        const {type} = adapter
        if (type === "midi-effect" || type === "audio-effect") {
            const effect = adapter as EffectDeviceBoxAdapter
            return DragAndDrop.installSource(element, () => {
                onDragStart()
                const uuids = collectDragUuids(project, effect)
                const instrument = selectedInstrumentUuidInUnit(project, effect)
                return {type: effect.type, uuids, instrument} satisfies DragDevice
            }, element, () => {
                const uuids = collectDragUuids(project, effect)
                const instrument = selectedInstrumentUuidInUnit(project, effect)
                const count = uuids.length + (isDefined(instrument) ? 1 : 0)
                return GhostCount({count, color})
            })
        }
        if (type === "instrument") {
            return DragAndDrop.installSource(element, () => {
                onDragStart()
                const effects = selectedEffectUuidsInUnit(project, adapter)
                return {
                    type: "instrument",
                    device: null,
                    uuid: UUID.toString(adapter.uuid),
                    effects
                } satisfies DragDevice
            }, element, () => {
                const effects = selectedEffectUuidsInUnit(project, adapter)
                return GhostCount({count: 1 + effects.length, color})
            })
        }
        return Terminable.Empty
    }

    const collectDragUuids = (project: Project, source: EffectDeviceBoxAdapter): ReadonlyArray<UUID.String> => {
        const sourceHost = source.deviceHost()
        const sameChain = project.deviceSelection.selected().filter((selected): selected is EffectDeviceBoxAdapter =>
            (selected.type === "midi-effect" || selected.type === "audio-effect")
            && selected.type === source.type
            && selected.deviceHost() === sourceHost)
        const effects = sameChain.includes(source) ? sameChain : [...sameChain, source]
        return effects
            .toSorted((a, b) => a.indexField.getValue() - b.indexField.getValue())
            .map(effect => UUID.toString(effect.box.address.uuid))
    }

    const selectedInstrumentUuidInUnit = (project: Project, source: DeviceBoxAdapter): Nullable<UUID.String> => {
        const audioUnitBox = source.audioUnitBoxAdapter().box
        const instrumentBox = audioUnitBox.input.pointerHub.incoming().at(0)?.box
        if (isAbsent(instrumentBox)) {return null}
        const hasInstrument = project.deviceSelection.selected().some(entry => entry.box === instrumentBox)
        return hasInstrument ? UUID.toString(instrumentBox.address.uuid) : null
    }

    const selectedEffectUuidsInUnit = (project: Project, source: DeviceBoxAdapter): ReadonlyArray<UUID.String> => {
        const audioUnitBox = source.audioUnitBoxAdapter().box
        return project.deviceSelection.selected()
            .filter((entry): entry is EffectDeviceBoxAdapter =>
                (entry.type === "midi-effect" || entry.type === "audio-effect")
                && entry.audioUnitBoxAdapter().box === audioUnitBox)
            .toSorted((a, b) => a.indexField.getValue() - b.indexField.getValue())
            .map(entry => UUID.toString(entry.box.address.uuid))
    }
}
