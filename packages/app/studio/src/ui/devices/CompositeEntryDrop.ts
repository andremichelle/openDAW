import {asDefined, Subscription} from "@opendaw/lib-std"
import {Field} from "@opendaw/lib-box"
import {EffectPointerType} from "@opendaw/studio-adapters"
import {EffectFactories, Project} from "@opendaw/studio-core"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {AnyDragData} from "@/ui/AnyDragData"

// A composite ENTRY as a drop target: an effect dragged out of the device browser lands straight in that
// entry's chain, without having to enter the entry first. An entry's chain field IS an ordinary effect host,
// so this is the same insert the device panel does, aimed one level in.
export namespace CompositeEntryDrop {
    type Construct = {
        element: HTMLElement
        project: Project
        // The entry's own chain host: `audio-effects` for an audio entry, `midi-effects` for a midi one.
        chainField: Field<EffectPointerType>
        // The kind this entry accepts. A drag of the other kind is refused: its chain could not host it.
        accepts: "audio" | "midi"
    }

    export const install = ({element, project, chainField, accepts}: Construct): Subscription => {
        const {editing} = project
        const dragType = accepts === "audio" ? "audio-effect" : "midi-effect"
        return DragAndDrop.installTarget(element, {
            // Only a NEW effect from the browser (`uuids === null`). MOVING existing devices between chains
            // stays with the device panel's own drag, which reindexes both chains — this must not shadow it.
            drag: (_event: DragEvent, data: AnyDragData): boolean =>
                data.type === dragType && data.uuids === null,
            drop: (event: DragEvent, data: AnyDragData): void => {
                element.classList.remove("drop-target")
                if (data.type !== dragType || data.uuids !== null) {return}
                const factory = asDefined(EffectFactories.MergedNamed[data.device],
                    `Unknown effect: '${data.device}'`)
                // Append to the entry's chain.
                const index = chainField.pointerHub.incoming().length
                editing.modify(() => project.api.insertEffect(chainField, factory, index))
                event.preventDefault()
            },
            enter: () => element.classList.add("drop-target"),
            leave: () => element.classList.remove("drop-target")
        })
    }
}
