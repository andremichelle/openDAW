import {int, isDefined, Subscription, UUID} from "@opendaw/lib-std"
import {EffectFactories, EffectFactory, Project} from "@opendaw/studio-core"
import {AudioCompositeAdapter, AudioEffectCompositeCellBoxAdapter} from "@opendaw/studio-adapters"
import {AudioEffectCompositeCellBox} from "@opendaw/studio-boxes"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {AnyDragData} from "@/ui/AnyDragData"

// All drag & drop of an AudioComposite's entries in one place:
//   - REORDER: drag a branch by its label handle onto another to move it (order is the user's arrangement; the
//     branches sum in parallel, so it does not change the sound).
//   - NEW EFFECT: drop an audio effect from the browser. Onto the MIDDLE of a branch adds it to that branch's
//     serial chain; onto a branch's top / bottom edge (or the Add Effect footer) creates a NEW branch holding
//     just that effect.
// A row is both a reorder target and a new-effect target — only one drag type is ever active, so they share the
// insertion-line / highlight marks.
export namespace AudioCompositeEntryDnD {
    type HandleConstruct = {
        handle: HTMLElement
        classReceiver: HTMLElement
        composite: AudioCompositeAdapter
        uuid: UUID.Bytes
        getIndex: () => int
    }

    // The reorder DRAG SOURCE (the branch label): a handle, so the row's knobs keep their own pointer dragging.
    export const installHandle = ({handle, classReceiver, composite, uuid, getIndex}: HandleConstruct): Subscription =>
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
        entry: AudioEffectCompositeCellBoxAdapter
        getIndex: () => int
        // A SPLIT owns its branches (mapped BY INDEX), so it allows neither reorder nor new branches: an effect
        // dropped on any of its rows always goes INTO that branch's chain.
        branchable: boolean
    }

    // A branch row as a drop target for BOTH a reorder and a new effect (see the namespace note).
    export const installTarget = ({element, project, composite, entry, getIndex, branchable}: TargetConstruct): Subscription =>
        DragAndDrop.installTarget(element, {
            drag: (event: DragEvent, data: AnyDragData): boolean => {
                if (data.type === "composite-entry") {
                    if (!branchable || data.composite !== UUID.toString(composite.uuid) || data.index === getIndex()) {
                        return false
                    }
                    // A downward move lands AFTER the target, an upward move BEFORE it.
                    mark(element, data.index < getIndex() ? "insert-after" : "insert-before")
                    return true
                }
                if (isNewAudioEffect(data)) {
                    const zone = branchable ? zoneOf(event, element) : "onto"
                    mark(element, zone === "before" ? "insert-before" : zone === "after" ? "insert-after" : "drop-target")
                    return true
                }
                return false
            },
            drop: (event: DragEvent, data: AnyDragData): void => {
                mark(element, null)
                if (data.type === "composite-entry") {
                    if (!branchable) {return}
                    event.preventDefault()
                    reorder(project, composite, data.index, getIndex())
                } else if (isNewAudioEffect(data)) {
                    event.preventDefault()
                    const factory = EffectFactories.MergedNamed[data.device]
                    if (!isDefined(factory)) {return}
                    const zone = branchable ? zoneOf(event, element) : "onto"
                    if (zone === "onto") {
                        // Append to THIS branch's serial chain, as the device panel appends to a chain.
                        project.editing.modify(() => project.api.insertEffect(entry.box.audioEffects, factory,
                            entry.box.audioEffects.pointerHub.incoming().length))
                    } else {
                        insertBranch(project, composite, zone === "before" ? getIndex() : getIndex() + 1, factory)
                    }
                }
            },
            enter: () => {},
            leave: () => mark(element, null)
        })

    type AppendConstruct = { element: HTMLElement, project: Project, composite: AudioCompositeAdapter }

    // The Add Effect footer as a drop target: a new effect dropped on it appends a branch (the empty-list case
    // and the plain "add at the end").
    export const installAppendTarget = ({element, project, composite}: AppendConstruct): Subscription =>
        DragAndDrop.installTarget(element, {
            drag: (_event: DragEvent, data: AnyDragData): boolean => isNewAudioEffect(data),
            drop: (event: DragEvent, data: AnyDragData): void => {
                element.classList.remove("drop-target")
                if (!isNewAudioEffect(data)) {return}
                const factory = EffectFactories.MergedNamed[data.device]
                if (!isDefined(factory)) {return}
                event.preventDefault()
                insertBranch(project, composite, composite.entries.adapters().length, factory)
            },
            enter: (allowDrop: boolean) => element.classList.toggle("drop-target", allowDrop),
            leave: () => element.classList.remove("drop-target")
        })

    // Create a new branch at `atIndex` holding just `factory`, shifting the branches at or after it down by one.
    export const insertBranch = (project: Project, composite: AudioCompositeAdapter,
                                 atIndex: int, factory: EffectFactory): void => {
        project.editing.modify(() => {
            composite.entries.adapters()
                .filter(other => other.indexField.getValue() >= atIndex)
                .forEach(other => other.indexField.setValue(other.indexField.getValue() + 1))
            const cell = AudioEffectCompositeCellBox.create(project.boxGraph, UUID.generate(), box => {
                box.composite.refer(composite.box.entries)
                box.index.setValue(atIndex)
            })
            project.api.insertEffect(cell.audioEffects, factory, 0)
        })
    }

    const isNewAudioEffect = (data: AnyDragData): data is Extract<AnyDragData, { type: "audio-effect" }> & { uuids: null } =>
        data.type === "audio-effect" && data.uuids === null

    const zoneOf = (event: DragEvent, element: HTMLElement): "before" | "onto" | "after" => {
        const rect = element.getBoundingClientRect()
        const fraction = (event.clientY - rect.top) / rect.height
        return fraction < 0.25 ? "before" : fraction > 0.75 ? "after" : "onto"
    }

    const mark = (element: HTMLElement,
                  cls: "insert-before" | "insert-after" | "drop-target" | null): void => {
        element.classList.toggle("insert-before", cls === "insert-before")
        element.classList.toggle("insert-after", cls === "insert-after")
        element.classList.toggle("drop-target", cls === "drop-target")
    }

    const reorder = (project: Project, composite: AudioCompositeAdapter, fromIndex: int, toIndex: int): void => {
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
