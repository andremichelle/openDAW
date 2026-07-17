import {int, Subscription, UUID} from "@opendaw/lib-std"
import {Project} from "@opendaw/studio-core"
import {AudioCompositeAdapter} from "@opendaw/studio-adapters"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {AnyDragData} from "@/ui/AnyDragData"

// Drag an AudioComposite entry to reorder it among its siblings. The order among parallel branches is the
// user's own arrangement (the branches sum in parallel, so it does not change the sound) — dragging one onto
// another MOVES it there, shifting the rest, and the entry indices are rewritten 0..n-1 to match. A drag
// handle is the SOURCE (so the row's knobs keep their own pointer dragging), the whole row is the TARGET.
export namespace AudioCompositeEntryReorder {
    type SourceConstruct = {
        handle: HTMLElement
        classReceiver: HTMLElement
        composite: AudioCompositeAdapter
        uuid: UUID.Bytes
        getIndex: () => int
    }

    export const installSource = ({handle, classReceiver, composite, uuid, getIndex}: SourceConstruct): Subscription =>
        DragAndDrop.installSource(handle, () => ({
            type: "composite-entry",
            uuid: UUID.toString(uuid),
            index: getIndex(),
            composite: UUID.toString(composite.uuid)
        } satisfies AnyDragData), classReceiver)

    type TargetConstruct = {
        element: HTMLElement
        project: Project
        composite: AudioCompositeAdapter
        getIndex: () => int
    }

    export const installTarget = ({element, project, composite, getIndex}: TargetConstruct): Subscription =>
        DragAndDrop.installTarget(element, {
            drag: (_event: DragEvent, data: AnyDragData): boolean => {
                if (data.type !== "composite-entry"
                    || data.composite !== UUID.toString(composite.uuid)
                    || data.index === getIndex()) {return false}
                // A downward move lands AFTER the target, an upward move BEFORE it (standard list reorder), so
                // the insertion line hints where the entry will land.
                element.classList.toggle("insert-after", data.index < getIndex())
                element.classList.toggle("insert-before", data.index > getIndex())
                return true
            },
            drop: (event: DragEvent, data: AnyDragData): void => {
                clearMarks(element)
                if (data.type !== "composite-entry") {return}
                event.preventDefault()
                move(project, composite, data.index, getIndex())
            },
            enter: (allowDrop: boolean) => {if (!allowDrop) {clearMarks(element)}},
            leave: () => clearMarks(element)
        })

    const clearMarks = (element: HTMLElement): void =>
        element.classList.remove("insert-before", "insert-after")

    const move = (project: Project, composite: AudioCompositeAdapter, fromIndex: int, toIndex: int): void => {
        const ordered = composite.entries.adapters()
            .toSorted((left, right) => left.indexField.getValue() - right.indexField.getValue())
        const from = ordered.findIndex(entry => entry.indexField.getValue() === fromIndex)
        const to = ordered.findIndex(entry => entry.indexField.getValue() === toIndex)
        if (from < 0 || to < 0 || from === to) {return}
        const moved = ordered[from]
        ordered.splice(from, 1)
        ordered.splice(to, 0, moved)
        project.editing.modify(() => ordered.forEach((entry, index) => entry.indexField.setValue(index)))
    }
}
