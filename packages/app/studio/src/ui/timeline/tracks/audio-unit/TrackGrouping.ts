import {GlobalShortcuts} from "@/ui/shortcuts/GlobalShortcuts"
import {AudioUnitGroups, Devices} from "@opendaw/studio-adapters"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {ContextMenu, MenuItem, Project} from "@opendaw/studio-core"
import {Browser, Dragging, Events} from "@opendaw/lib-dom"
import {Lifecycle, Option, Procedure, UUID, Terminable} from "@opendaw/lib-std"
import {AnyDragData} from "@/ui/AnyDragData"

export const groupSelectedTracks = (project: Project): void => {
    const selected = project.trackSelection.selected
    const active = project.userEditingManager.audioUnit.get().map(vertex =>
        project.boxAdapters.adapterFor(vertex.box, Devices.isHost).audioUnitBoxAdapter().box).unwrapOrUndefined()
    const units = selected.length > 0 ? selected : !project.trackSelection.hasExplicitSelection && active ? [active] : []
    const group = project.editing.modify(() => project.grouping.create(units)).unwrapOrUndefined()
    if (!group) {return}
    project.trackSelection.set([group])
    project.userEditingManager.audioUnit.edit(group.editing)
}

export const duplicateSelectedTracks = (project: Project): void => {
    const selected = project.trackSelection.selected
    const active = project.userEditingManager.audioUnit.get().map(vertex =>
        project.boxAdapters.adapterFor(vertex.box, Devices.isHost).audioUnitBoxAdapter().box).unwrapOrUndefined()
    const units = selected.length > 0 ? selected : !project.trackSelection.hasExplicitSelection && active ? [active] : []
    const copies = project.editing.modify(() => project.grouping.duplicate(units)).unwrapOrElse([])
    if (copies.length === 0) {return}
    project.trackSelection.set(copies)
    project.userEditingManager.audioUnit.edit(copies[0].editing)
}

export const groupingMenuItems = (project: Project, unit: AudioUnitBox): MenuItem[] => {
    if (!project.trackSelection.has(unit)) {project.trackSelection.set([unit])}
    return [
        MenuItem.default({label: "Group Tracks", shortcut: GlobalShortcuts["group-tracks"].shortcut.format(), selectable: !unit.type.getValue().includes("output")})
            .setTriggerProcedure(() => groupSelectedTracks(project)),
        MenuItem.default({label: "Ungroup (Keep Tracks)", hidden: !unit.isGroup.getValue()})
            .setTriggerProcedure(() => project.editing.modify(() => project.grouping.ungroup(unit))),
        MenuItem.default({label: "Move Out of Group", hidden: !AudioUnitGroups.parent(unit)})
            .setTriggerProcedure(() => project.editing.modify(() => {
                const parent = AudioUnitGroups.parent(unit)
                if (!parent) {return}
                const outer = AudioUnitGroups.parent(parent)
                const siblings = AudioUnitGroups.children(project.rootBox, outer)
                project.grouping.move(project.trackSelection.selected, outer, siblings[siblings.indexOf(parent) + 1])
            }))
    ]
}

export const installTrackSelection = (lifecycle: Lifecycle, project: Project, header: HTMLElement, unit: AudioUnitBox,
                                      populateMenu?: Procedure<MenuItem>): void => {
    let pendingSingle = false, dragged = false
    lifecycle.ownAll(
        Events.subscribe(header, "pointerdown", (event: PointerEvent) => {
            dragged = false
            pendingSingle = false
            if (event.target instanceof Element && event.target.closest("button,input,select,svg.collapse-automation")) {return}
            if (event.button === 2 || Browser.isMacOS() && event.ctrlKey) {
                if (!project.trackSelection.has(unit)) {project.trackSelection.set([unit])}
            } else if (event.button === 0) {
                pendingSingle = !event.shiftKey && !event.metaKey && !event.ctrlKey && project.trackSelection.has(unit)
                if (!pendingSingle) {project.trackSelection.click(unit, event)}
            }
        }),
        Events.subscribe(header, "dragstart", () => dragged = true),
        Events.subscribeAny(header, "--track-drag-start", () => dragged = true),
        Events.subscribe(header, "pointerup", (event: PointerEvent) => {
            if (pendingSingle && !dragged && event.button === 0) {project.trackSelection.click(unit, event)}
            pendingSingle = false
        }),
        ContextMenu.subscribe(header, collector => {
            if (populateMenu) {
                const root = MenuItem.root()
                populateMenu(root)
                collector.addItems(...root.collectChildren())
            } else {
                collector.addItems(...groupingMenuItems(project, unit))
            }
        })
    )
}

export type GroupDrop = {parent?: AudioUnitBox, before?: AudioUnitBox, row: HTMLElement, inside: boolean, after: boolean}

/** Header centre means add to folder; row edges mean insert. Pointer indentation chooses the parent at edges. */
export const resolveGroupDrop = (project: Project, container: HTMLElement, event: {clientX: number, clientY: number}, horizontal = false): GroupDrop | undefined => {
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-unit]"))
        .filter(row => row.getClientRects().length > 0)
        .sort((a, b) => horizontal ? a.getBoundingClientRect().left - b.getBoundingClientRect().left
            : a.getBoundingClientRect().top - b.getBoundingClientRect().top)
    if (rows.length === 0) {return undefined}
    const coord = horizontal ? event.clientX : event.clientY
    const row = rows.find(row => {
        const rect = row.getBoundingClientRect()
        return coord < (horizontal ? rect.right : rect.bottom)
    }) ?? rows[rows.length - 1]
    const unit = project.boxGraph.findBox(UUID.parse(row.dataset.unit!)).unwrapOrUndefined() as AudioUnitBox | undefined
    if (!unit) {return undefined}
    const rect = row.getBoundingClientRect(), start = horizontal ? rect.left : rect.top
    const size = horizontal ? rect.width : Math.min(rect.height, 40)
    const offset = coord - start
    const inside = unit.isGroup.getValue() && offset > size * 0.25 && offset < size * 0.75
    if (inside) {return {parent: unit, row, inside: true, after: false}}
    const after = offset >= size / 2
    let parent = AudioUnitGroups.parent(unit)
    // Moving left across a tree guide lifts the insertion out of that folder.
    if (!horizontal) {
        const indent = Math.max(0, Math.floor((event.clientX - rect.left - 12) / 14))
        while (parent && AudioUnitGroups.depth(parent) >= indent) {parent = AudioUnitGroups.parent(parent)}
    }
    let sibling = unit
    while (AudioUnitGroups.parent(sibling) !== parent) {
        const next = AudioUnitGroups.parent(sibling)
        if (!next) {break}
        sibling = next
    }
    const siblings = AudioUnitGroups.children(project.rootBox, parent)
    const before = after ? siblings[siblings.indexOf(sibling) + 1] : sibling
    return {parent, before, row, inside: false, after}
}

export const draggedUnits = (project: Project, data: AnyDragData): AudioUnitBox[] => {
    if (data.type !== "channelstrip") {return []}
    const box = project.boxGraph.findBox(UUID.parse(data.uuid)).unwrapOrUndefined()
    if (!(box instanceof AudioUnitBox)) {return []}
    return [...(project.trackSelection.has(box) ? project.trackSelection.selected : [box])]
}

export const markGroupDrop = (container: HTMLElement, target?: GroupDrop): void => {
    container.querySelectorAll(".group-drop-inside,.group-drop-before,.group-drop-after").forEach(row =>
        row.classList.remove("group-drop-inside", "group-drop-before", "group-drop-after"))
    if (!target) {return}
    target.row.style.setProperty("--drop-indent", `${target.parent ? 14 * (AudioUnitGroups.depth(target.parent) + 1) : 0}px`)
    target.row.classList.add(target.inside ? "group-drop-inside" : target.after ? "group-drop-after" : "group-drop-before")
}

/** Pointer capture gives track moves the same Escape/cancel behavior as other timeline gestures. */
export const installGroupTrackDrag = (handle: HTMLElement, project: Project, unit: AudioUnitBox): Terminable => {
    handle.draggable = false
    handle.title = "Drag to move track; drop on a group or between tracks. Drag left to move out."
    return Dragging.attach(handle, start => {
        if (start.target instanceof Element && start.target.closest("button,input,select,textarea,a,[contenteditable],.track-resizer,[data-track-controls],svg.collapse-automation")) {return Option.None}
        if (!unit.isAttached() || unit.type.getValue() === "output") {return Option.None}
        const units = project.trackSelection.has(unit) ? [...project.trackSelection.selected] : [unit]
        let moved = false
        let surface: HTMLElement | undefined
        let target: GroupDrop | undefined
        const clear = () => {if (surface) {markGroupDrop(surface)}}
        return Option.wrap({
            update: event => {
                if (!moved && Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < 5) {return}
                if (!moved) {
                    moved = true
                    handle.dispatchEvent(new Event("--track-drag-start", {bubbles: true}))
                }
                clear()
                surface = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-group-surface]") ?? undefined
                target = surface ? resolveGroupDrop(project, surface, event, surface.dataset.groupSurface === "mixer") : undefined
                if (target && !project.grouping.canMove(units, target.parent)) {target = undefined}
                if (surface) {markGroupDrop(surface, target)}
            },
            approve: () => {
                if (moved && target) {project.editing.modify(() => project.grouping.move(units, target!.parent, target!.before))}
            },
            finally: clear
        } satisfies Dragging.Process)
    })
}
