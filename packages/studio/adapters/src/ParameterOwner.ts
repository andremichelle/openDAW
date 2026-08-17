import {Box, StringField, Vertex} from "@opendaw/lib-box"
import {Option} from "@opendaw/lib-std"
import {Pointers} from "@opendaw/studio-enums"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {BoxAdaptersContext} from "./BoxAdaptersContext"
import {AudioUnitBoxAdapter} from "./audio-unit/AudioUnitBoxAdapter"

export namespace ParameterOwner {
    /// A scriptable device's dynamic parameter lives in its own child box, so the walk falls back to the
    /// device that owns it.
    export const nameOf = (context: BoxAdaptersContext, vertex: Vertex): Option<string> => {
        const box = vertex.box
        if (box instanceof AudioUnitBox) {
            return context.boxAdapters.adapterFor(box, AudioUnitBoxAdapter).input.label
        }
        const own = labelOf(context, box)
        if (own.nonEmpty()) {return own}
        const owner = resolveOwnerDeviceBox(box).flatMap(owner => labelOf(context, owner))
        return owner.nonEmpty() ? owner : Option.wrap(box.name)
    }

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
