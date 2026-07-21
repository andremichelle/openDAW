import {int, isDefined, Nullable, Optional, Provider, Subscription, UUID} from "@opendaw/lib-std"
import {Box, Field} from "@opendaw/lib-box"
import {EffectBox, EffectFactories, EffectFactory, Project} from "@opendaw/studio-core"
import {AudioCompositeAdapter, AudioEffectCompositeCellBoxAdapter, EffectPointerType} from "@opendaw/studio-adapters"
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
                if (isExistingAudioEffect(data) && acceptsExistingEffect(project, composite, data)) {
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
                } else if (isExistingAudioEffect(data) && acceptsExistingEffect(project, composite, data)) {
                    event.preventDefault()
                    const boxes = resolveAudioEffectBoxes(project, data.uuids)
                    const zone = branchable ? zoneOf(event, element) : "onto"
                    if (zone === "onto") {
                        // MOVE the dragged effects into THIS branch's serial chain (re-homing them out of their source).
                        const insertIndex = entry.box.audioEffects.pointerHub.incoming().length
                        project.editing.modify(() => project.api.moveEffects(entry.box.audioEffects, boxes, insertIndex))
                    } else {
                        moveToNewBranch(project, composite, zone === "before" ? getIndex() : getIndex() + 1, boxes)
                    }
                }
            },
            enter: () => {},
            leave: () => mark(element, null)
        })

    type AppendConstruct = {
        element: HTMLElement
        project: Project
        composite: AudioCompositeAdapter
        // Gate the whole target (e.g. the entry-list body only accepts when the list is EMPTY, so it never
        // fights the per-row targets). Defaults to always-on for the Add-Effect footer button.
        active?: Provider<boolean>
    }

    // A drop target that APPENDS a branch: a new effect creates one holding it, an existing effect is moved into
    // one. Used by the Add Effect footer button and by the entry list's empty body.
    export const installAppendTarget = ({element, project, composite, active}: AppendConstruct): Subscription =>
        DragAndDrop.installTarget(element, {
            drag: (_event: DragEvent, data: AnyDragData): boolean =>
                (active?.() ?? true)
                && (isNewAudioEffect(data) || acceptsExistingEffect(project, composite, data)),
            drop: (event: DragEvent, data: AnyDragData): void => {
                element.classList.remove("drop-target")
                if (active?.() === false) {return}
                const atIndex = composite.entries.adapters().length
                if (isNewAudioEffect(data)) {
                    const factory = EffectFactories.MergedNamed[data.device]
                    if (!isDefined(factory)) {return}
                    event.preventDefault()
                    insertBranch(project, composite, atIndex, factory)
                } else if (isExistingAudioEffect(data) && acceptsExistingEffect(project, composite, data)) {
                    event.preventDefault()
                    moveToNewBranch(project, composite, atIndex, resolveAudioEffectBoxes(project, data.uuids))
                }
            },
            enter: (allowDrop: boolean) => element.classList.toggle("drop-target", allowDrop),
            leave: () => element.classList.remove("drop-target")
        })

    // A drop target that MOVES existing effects OUT into `targetField` (e.g. the branch editor's back-to-parent
    // pill: drop an effect on it to lift it from the branch onto the parent chain). Appends to the target.
    export const installMoveOutTarget = ({element, project, targetField}: {
        element: HTMLElement, project: Project, targetField: Field<EffectPointerType>
    }): Subscription =>
        DragAndDrop.installTarget(element, {
            drag: (_event: DragEvent, data: AnyDragData): boolean =>
                isExistingAudioEffect(data) && resolveAudioEffectBoxes(project, data.uuids).length > 0,
            drop: (event: DragEvent, data: AnyDragData): void => {
                element.classList.remove("drop-target")
                if (!isExistingAudioEffect(data)) {return}
                const boxes = resolveAudioEffectBoxes(project, data.uuids)
                if (boxes.length === 0) {return}
                event.preventDefault()
                const insertIndex = targetField.pointerHub.incoming().length
                project.editing.modify(() => project.api.moveEffects(targetField, boxes, insertIndex))
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

    // An EXISTING audio effect (or several) being dragged out of a chain to be MOVED, as opposed to a new one
    // created from the browser (`uuids === null`).
    type ExistingAudioEffectDrag = { type: "audio-effect", uuids: ReadonlyArray<UUID.String>, instrument: Nullable<UUID.String> }
    const isExistingAudioEffect = (data: AnyDragData): data is ExistingAudioEffectDrag =>
        data.type === "audio-effect" && data.uuids !== null

    const resolveAudioEffectBoxes = (project: Project, uuids: ReadonlyArray<UUID.String>): ReadonlyArray<EffectBox> =>
        uuids.map(uuid => project.boxGraph.findBox(UUID.parse(uuid)).unwrapOrNull())
            .filter(isDefined)
            .filter((box): box is EffectBox => box.tags.deviceType === "audio-effect")

    // Walk up from a box through its host chain (an effect's `host`, a composite entry's `composite`) to its
    // owner. Stops at the audio unit (which has no such pointer).
    const ancestorOf = (box: Box): Optional<Box> => {
        if (box instanceof AudioEffectCompositeCellBox) {
            return box.composite.targetVertex.unwrapOrNull()?.box
        }
        if (box.tags.deviceType === "audio-effect" || box.tags.deviceType === "midi-effect") {
            return (box as EffectBox).host.targetVertex.unwrapOrNull()?.box
        }
        return undefined
    }

    // Dropping a box into a branch of a composite that lives inside that box's OWN subtree would be a cycle
    // (e.g. dragging a composite into one of its own branches). Reject it by walking the target composite's
    // ancestry and looking for any dragged box.
    const wouldCycle = (draggedUuids: ReadonlySet<UUID.String>, composite: AudioCompositeAdapter): boolean => {
        let current: Optional<Box> = composite.box
        while (isDefined(current)) {
            if (draggedUuids.has(UUID.toString(current.address.uuid))) {return true}
            current = ancestorOf(current)
        }
        return false
    }

    const acceptsExistingEffect = (project: Project, composite: AudioCompositeAdapter, data: AnyDragData): boolean =>
        isExistingAudioEffect(data)
        && resolveAudioEffectBoxes(project, data.uuids).length > 0
        && !wouldCycle(new Set(data.uuids), composite)

    // Move existing effect boxes into a NEW branch created at `atIndex`, shifting the branches at or after it down.
    const moveToNewBranch = (project: Project, composite: AudioCompositeAdapter,
                             atIndex: int, boxes: ReadonlyArray<EffectBox>): void => {
        project.editing.modify(() => {
            composite.entries.adapters()
                .filter(other => other.indexField.getValue() >= atIndex)
                .forEach(other => other.indexField.setValue(other.indexField.getValue() + 1))
            const cell = AudioEffectCompositeCellBox.create(project.boxGraph, UUID.generate(), box => {
                box.composite.refer(composite.box.entries)
                box.index.setValue(atIndex)
            })
            project.api.moveEffects(cell.audioEffects, boxes, 0)
        })
    }

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
