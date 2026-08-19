import {Box, StringField, Vertex} from "@opendaw/lib-box"
import {Option} from "@opendaw/lib-std"
import {Pointers} from "@opendaw/studio-enums"
import {AudioUnitBox, ModulationBox} from "@opendaw/studio-boxes"
import {BoxAdaptersContext} from "./BoxAdaptersContext"
import {AudioUnitBoxAdapter} from "./audio-unit/AudioUnitBoxAdapter"
import {ModulationBoxAdapter} from "./modulation/ModulationBoxAdapter"
import {Devices} from "./DeviceAdapter"

export namespace ParameterOwner {
    /// A scriptable device's dynamic parameter lives in its own child box, so the walk falls back to the
    /// device that owns it.
    export const nameOf = (context: BoxAdaptersContext, vertex: Vertex): Option<string> => {
        const box = vertex.box
        if (box instanceof AudioUnitBox) {
            return context.boxAdapters.adapterFor(box, AudioUnitBoxAdapter).input.label
        }
        if (box instanceof ModulationBox) {
            const adapter = context.boxAdapters.adapterFor(box, ModulationBoxAdapter)
            return Option.wrap(`${adapter.source.label} \u2192 ${adapter.targetOwner.unwrapOrElse("")} ${
                adapter.target.mapOr(parameter => parameter.name, "")}`.trim())
        }
        const own = labelOf(context, box)
        if (own.nonEmpty()) {return own}
        const owner = resolveOwnerDeviceBox(box).flatMap(owner => labelOf(context, owner))
        return owner.nonEmpty() ? owner : Option.wrap(box.name)
    }

    export const audioUnitOf = (context: BoxAdaptersContext, vertex: Vertex): Option<AudioUnitBoxAdapter> => {
        const box = vertex.box
        if (box instanceof AudioUnitBox) {
            return Option.wrap(context.boxAdapters.adapterFor(box, AudioUnitBoxAdapter))
        }
        const own = unitOf(context, box)
        if (own.nonEmpty()) {return own}
        return resolveOwnerDeviceBox(box).flatMap(owner => unitOf(context, owner))
    }

    const unitOf = (context: BoxAdaptersContext, box: Box): Option<AudioUnitBoxAdapter> =>
        context.boxAdapters.optAdapter(box)
            .flatMap(adapter => Devices.isAny(adapter)
                ? Option.wrap(adapter.audioUnitBoxAdapter())
                : Option.None)

    const labelOf = (context: BoxAdaptersContext, box: Box): Option<string> =>
        context.boxAdapters.optAdapter(box).flatMap(adapter =>
            "labelField" in adapter && adapter.labelField instanceof StringField
                ? Option.wrap(adapter.labelField.getValue())
                : Option.None)

    const resolveOwnerDeviceBox = (box: Box): Option<Box> => {
        for (const [pointer] of box.outgoingEdges()) {
            if (pointer.pointerType === Pointers.Parameter) {
                return pointer.targetVertex.map(vertex => vertex.box)
            }
        }
        return Option.None
    }
}
