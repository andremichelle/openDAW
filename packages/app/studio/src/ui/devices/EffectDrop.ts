import {int, isDefined, Option, UUID} from "@opendaw/lib-std"
import {Field, IndexedBox} from "@opendaw/lib-box"
import {EffectPointerType} from "@opendaw/studio-adapters"
import {EffectBox, EffectFactories, Project} from "@opendaw/studio-core"
import {AnyDragData, DragDevice} from "@/ui/AnyDragData"

export namespace EffectDrop {
    export type Data = Extract<DragDevice, { type: "midi-effect" | "audio-effect" }>

    export const asEffect = (dragData: AnyDragData, accepts: "midi" | "audio"): Option<Data> =>
        accepts === "midi"
            ? dragData.type === "midi-effect" ? Option.wrap(dragData) : Option.None
            : dragData.type === "audio-effect" ? Option.wrap(dragData) : Option.None

    export const apply = (project: Project, dragData: Data,
                          field: Field<EffectPointerType>, index: int, copy: boolean): void => {
        const {editing, api, boxGraph} = project
        if (dragData.uuids === null) {
            const factory = EffectFactories.MergedNamed[dragData.device]
            editing.modify(() => api.insertEffect(field, factory, index))
            return
        }
        const boxes = dragData.uuids
            .map(uuid => boxGraph.findBox(UUID.parse(uuid)).unwrapOrNull())
            .filter(isDefined)
            .filter((box): box is EffectBox => box.tags.deviceType === dragData.type)
        if (boxes.length === 0) {return}
        if (copy) {
            editing.modify(() => api.copyEffects(field, boxes, index))
            return
        }
        const sameChain = boxes.every(box => box.host.targetVertex.mapOr(vertex => vertex === field, false))
        if (sameChain) {
            const startIndices = boxes.map(box => box.index.getValue()).toSorted((left, right) => left - right)
            editing.modify(() => IndexedBox.moveIndices(field, startIndices, index))
        } else {
            editing.modify(() => api.moveEffects(field, boxes, index))
        }
    }
}
