import {asDefined, isDefined, Lifecycle, Option, Optional, Procedure, UUID, Terminable} from "@opendaw/lib-std"
import {Browser, Dragging, Events} from "@opendaw/lib-dom"
import {AudioUnitGroups} from "@opendaw/studio-adapters"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {ContextMenu, MenuItem, Project} from "@opendaw/studio-core"
import {AudioUnitType} from "@opendaw/studio-enums"
import {GroupDropLayout} from "./GroupDropLayout"
import {GlobalShortcuts} from "@/ui/shortcuts/GlobalShortcuts"

export const groupSelectedTracks = (project: Project): void => {
    const group = project.editing.modify(() => project.grouping.create(project.trackSelection.commandTargets)).unwrapOrElse(Option.None)
    if (group.isEmpty()) {return}
    const unit = group.unwrap()
    project.trackSelection.set([unit])
    project.userEditingManager.audioUnit.edit(unit.editing)
}

export const ungroupSelectedTracks = (project: Project): void => {
    const groups = project.trackSelection.commandTargets.filter(unit => unit.isGroup.getValue())
        .toSorted((left, right) => AudioUnitGroups.depth(right) - AudioUnitGroups.depth(left))
    if (groups.length === 0) {return}
    const members = new Set(groups.flatMap(group => AudioUnitGroups.children(project.rootBox, group)))
    const promoted = project.audioUnitLayout.snapshot.rows
        .filter(row => members.has(row.unit) && !groups.includes(row.unit)).map(row => row.unit)
    project.editing.modify(() => {
        groups.forEach(group => project.grouping.ungroup(group))
        if (promoted.length > 0) {project.userEditingManager.audioUnit.edit(promoted[0].editing)}
    })
    project.trackSelection.set(promoted)
}

export const duplicateSelectedTracks = (project: Project): void => {
    const copies = project.editing.modify(() => project.grouping.duplicate(project.trackSelection.commandTargets)).unwrapOrElse([])
    if (copies.length === 0) {return}
    project.trackSelection.set(copies)
    project.userEditingManager.audioUnit.edit(copies[0].editing)
}

export const groupingMenuItems = (project: Project, unit: AudioUnitBox): MenuItem[] => {
    return [
        MenuItem.default({label: "Group Tracks", shortcut: GlobalShortcuts["group-tracks"].shortcut.format(), selectable: unit.type.getValue() !== AudioUnitType.Output})
            .setTriggerProcedure(() => {
                if (!project.trackSelection.has(unit)) {project.trackSelection.set([unit])}
                groupSelectedTracks(project)
            }),
        MenuItem.default({label: "Ungroup (Keep Tracks)", shortcut: GlobalShortcuts["ungroup-tracks"].shortcut.format(), hidden: !unit.isGroup.getValue()})
            .setTriggerProcedure(() => {
                if (!project.trackSelection.has(unit)) {project.trackSelection.set([unit])}
                ungroupSelectedTracks(project)
            }),
        MenuItem.default({label: "Move Out of Group", hidden: !isDefined(AudioUnitGroups.parent(unit).unwrapOrUndefined())})
            .setTriggerProcedure(() => project.editing.modify(() => project.grouping.moveOutOfGroup(unit,
                project.trackSelection.has(unit) ? project.trackSelection.selected : [unit])))
    ]
}

export const installTrackSelection = (lifecycle: Lifecycle, project: Project, header: HTMLElement, unit: AudioUnitBox,
                                      populateMenu?: Procedure<MenuItem>): void => {
    let pendingSingle = false
    let dragged = false
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
            if (isDefined(populateMenu)) {
                const root = MenuItem.root()
                populateMenu(root)
                collector.addItems(...root.collectChildren())
            } else {
                collector.addItems(...groupingMenuItems(project, unit))
            }
        })
    )
}

export type GroupDrop = {parent?: AudioUnitBox, before?: AudioUnitBox, row: HTMLElement, inside: boolean, after: boolean, indent: number, headerHeight: number}

/** Header centre means add to folder; row edges mean insert. Pointer indentation chooses the parent at edges. */
export const resolveGroupDrop = (project: Project, container: HTMLElement, event: {clientX: number, clientY: number}, horizontal = false): Option<GroupDrop> => {
    const elements = new Map(Array.from(container.querySelectorAll<HTMLElement>("[data-unit]"))
        .map(row => [row.dataset.unit, row]))
    const headers = new Map(Array.from(container.querySelectorAll<HTMLElement>("[data-group-header]"))
        .map(header => [header.dataset.groupHeader, header]))
    const layout = project.audioUnitLayout.snapshot
    const rows = layout.visibleRows.flatMap(row => {
        const uuid = UUID.toString(row.unit.address.uuid)
        const element = elements.get(uuid)
        if (!isDefined(element) || element.getClientRects().length === 0) {return []}
        return [{unit: row.unit, bounds: element.getBoundingClientRect(),
            header: (headers.get(uuid) ?? element).getBoundingClientRect()}]
    })
    return GroupDropLayout.resolve(layout, rows, event, horizontal).map(target => ({
        parent: target.parent, before: target.before,
        row: asDefined(elements.get(UUID.toString(target.row.unit.address.uuid))),
        inside: target.inside, after: target.after, indent: target.indent, headerHeight: target.row.header.height
    }))
}

export const markGroupDrop = (container: HTMLElement, target?: GroupDrop): void => {
    container.querySelectorAll(".group-drop-inside,.group-drop-before,.group-drop-after").forEach(row =>
        row.classList.remove("group-drop-inside", "group-drop-before", "group-drop-after"))
    if (!isDefined(target)) {return}
    target.row.style.setProperty("--drop-indent", `${target.indent}px`)
    target.row.style.setProperty("--drop-header-height", `${target.headerHeight}px`)
    target.row.classList.add(target.inside ? "group-drop-inside" : target.after ? "group-drop-after" : "group-drop-before")
}

/** Pointer capture gives track moves the same Escape/cancel behavior as other timeline gestures. */
export const installGroupTrackDrag = (handle: HTMLElement, project: Project, unit: AudioUnitBox): Terminable => {
    handle.dataset.groupHeader = UUID.toString(unit.address.uuid)
    handle.draggable = false
    handle.title = "Drag to move track; drop on a group or between tracks. Drag left to move out."
    const dragging = Dragging.attach(handle, start => {
        if (start.target instanceof Element && start.target.closest("button,input,select,textarea,a,[contenteditable],.track-resizer,[data-track-controls],svg.collapse-automation")) {return Option.None}
        if (!unit.isAttached() || unit.type.getValue() === AudioUnitType.Output) {return Option.None}
        const units = project.trackSelection.has(unit) ? [...project.trackSelection.selected] : [unit]
        let moved = false
        let surface: Optional<HTMLElement>
        let target: Optional<GroupDrop>
        const clear = () => {if (isDefined(surface)) {markGroupDrop(surface)}}
        return Option.wrap({
            update: event => {
                if (!moved && Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < 5) {return}
                if (!moved) {
                    moved = true
                    handle.dispatchEvent(new Event("--track-drag-start", {bubbles: true}))
                }
                clear()
                surface = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-group-surface]") ?? undefined
                target = isDefined(surface) ? resolveGroupDrop(project, surface, event, surface.dataset.groupSurface === "mixer").unwrapOrUndefined() : undefined
                if (isDefined(target) && !(target.inside
                    ? project.grouping.canMove(units, target.parent)
                    : project.grouping.canDrop(units, target.parent, target.before))) {target = undefined}
                if (isDefined(surface)) {markGroupDrop(surface, target)}
            },
            approve: () => {
                if (moved && isDefined(target)) {
                    const {parent, before} = target
                    project.editing.modify(() => project.grouping.move(units, parent, before))
                }
            },
            finally: clear
        } satisfies Dragging.Process)
    })
    return Terminable.many(dragging, {terminate: () => handle.removeAttribute("data-group-header")})
}
