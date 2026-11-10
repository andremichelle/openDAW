import {asDefined, Client, Exec, isDefined, Lifecycle, Notifier, Nullable, Option, Optional, Procedure, Subscription, UUID, Terminable} from "@opendaw/lib-std"
import {AnimationFrame, Browser, Dragging, Events, Keyboard} from "@opendaw/lib-dom"
import {AudioUnitGroups, Devices, UnionBoxTypes} from "@opendaw/studio-adapters"
import {AudioUnitBox, TrackBox} from "@opendaw/studio-boxes"
import {ContextMenu, MenuItem, Project} from "@opendaw/studio-core"
import {AudioUnitType} from "@opendaw/studio-enums"
import {GroupDropLayout} from "./GroupDropLayout"
import {GlobalShortcuts} from "@/ui/shortcuts/GlobalShortcuts"

export namespace TrackGrouping {
    const isSelectable = (unit: AudioUnitBox): boolean => unit.isAttached() && unit.type.getValue() !== AudioUnitType.Output

    export const selectTracks = (project: Project, units: ReadonlyArray<AudioUnitBox>): void => {
        const {audioUnitSelection} = project
        const next = units.filter(isSelectable)
        audioUnitSelection.deselect(...audioUnitSelection.selected().filter(unit => !next.includes(unit)))
        audioUnitSelection.select(...next)
    }

    const editedTrack = (project: Project): Option<AudioUnitBox> => project.userEditingManager.audioUnit.get()
        .map(vertex => project.boxAdapters.adapterFor(vertex.box, Devices.isHost).audioUnitBoxAdapter().box)

    export const deselectHiddenTracks = (project: Project): Terminable => {
        let alive = true
        const subscription = project.audioUnitLayout.value.subscribe(() => queueMicrotask(() => {
            if (!alive || project.editing.canRedo()) {return}
            const layout = project.audioUnitLayout.snapshot
            const isHidden = (unit: AudioUnitBox): boolean => layout.row(unit).mapOr(row => row.visibleIndex === -1, false)
            const hidden = project.audioUnitSelection.selected().filter(isHidden)
            const hiddenContent = project.selection.selected().filter(vertex => {
                const {box} = vertex
                const pointer = UnionBoxTypes.isRegionBox(box) ? box.regions : UnionBoxTypes.isClipBox(box) ? box.clips : null
                const track = pointer?.targetVertex.unwrapOrNull()?.box
                const unit = track instanceof TrackBox ? track.tracks.targetVertex.unwrapOrNull()?.box : undefined
                return unit instanceof AudioUnitBox && isHidden(unit)
            })
            if (hidden.length > 0 || hiddenContent.length > 0) {
                project.editing.append(() => {
                    project.audioUnitSelection.deselect(...hidden)
                    project.selection.deselect(...hiddenContent)
                })
            }
        }))
        return Terminable.many(subscription, {terminate: () => alive = false})
    }

    export const isTrackEdited = (project: Project, unit: AudioUnitBox): boolean =>
        editedTrack(project).mapOr(edited => edited === unit, false)

    export const isTrackLineActive = (project: Project, unit: AudioUnitBox): boolean =>
        editedTrack(project).mapOr(edited => edited === unit
            || project.audioUnitLayout.snapshot.row(edited).mapOr(row => row.ancestors.includes(unit), false), false)

    const groupRenameRequests = new Notifier<AudioUnitBox>()

    export const subscribeGroupRename = (unit: AudioUnitBox, procedure: Exec): Subscription =>
        groupRenameRequests.subscribe(requested => {if (requested === unit) {procedure()}})

    export const groupSelectedTracks = (project: Project): void => {
        const created = project.editing.modify(() => {
            const group = project.grouping.create(project.audioUnitSelection.selected()).unwrapOrUndefined()
            if (isDefined(group)) {
                project.userEditingManager.audioUnit.edit(group.editing)
                selectTracks(project, [group])
            }
            return group
        }).unwrapOrUndefined()
        if (isDefined(created)) {AnimationFrame.once(() => groupRenameRequests.notify(created))}
    }

    export const ungroupSelectedTracks = (project: Project): void => {
        const groups = project.audioUnitSelection.selected().filter(unit => AudioUnitGroups.isGroup(unit))
            .toSorted((left, right) => AudioUnitGroups.depth(right) - AudioUnitGroups.depth(left))
        if (groups.length === 0) {return}
        const members = new Set(groups.flatMap(group => AudioUnitGroups.children(project.rootBox, group)))
        const promoted = project.audioUnitLayout.snapshot.rows
            .filter(row => members.has(row.unit) && !groups.includes(row.unit)).map(row => row.unit)
        project.editing.modify(() => {
            groups.forEach(group => project.grouping.ungroup(group))
            if (promoted.length > 0) {project.userEditingManager.audioUnit.edit(promoted[0].editing)}
            selectTracks(project, promoted)
        })
    }

    export const duplicateSelectedTracks = (project: Project): void => {
        project.editing.modify(() => {
            const copies = project.grouping.duplicate(project.audioUnitSelection.selected())
            if (copies.length === 0) {return}
            project.userEditingManager.audioUnit.edit(copies[0].editing)
            selectTracks(project, copies)
        })
    }

    export const deleteSelectedTracks = (project: Project, pressed: AudioUnitBox): boolean => {
        const {audioUnitSelection} = project
        if (audioUnitSelection.count() < 2 || !audioUnitSelection.isSelected(pressed)) {return false}
        const roots = AudioUnitGroups.roots(audioUnitSelection.selected())
        project.editing.modify(() => roots.forEach(unit => project.api.deleteAudioUnit(unit)))
        return true
    }

    export const groupingMenuItems = (project: Project, unit: AudioUnitBox): MenuItem[] => {
        const {audioUnitSelection} = project
        return [
            MenuItem.default({label: "Create Group Bus", shortcut: GlobalShortcuts["group-tracks"].shortcut.format(),
                selectable: audioUnitSelection.nonEmpty()})
                .setTriggerProcedure(() => groupSelectedTracks(project)),
            MenuItem.default({label: "Remove Group Bus (Keep Tracks)", shortcut: GlobalShortcuts["ungroup-tracks"].shortcut.format(),
                hidden: !AudioUnitGroups.isGroup(unit), selectable: audioUnitSelection.nonEmpty()})
                .setTriggerProcedure(() => ungroupSelectedTracks(project)),
            MenuItem.default({label: "Move Out of Group Bus", hidden: !isDefined(AudioUnitGroups.parent(unit).unwrapOrUndefined())})
                .setTriggerProcedure(() => project.editing.modify(() => project.grouping.moveOutOfGroup(unit,
                    audioUnitSelection.isSelected(unit) ? audioUnitSelection.selected() : [unit])))
        ]
    }

    export type TrackPress = "replace" | "range" | "toggle"

    export const trackPressOf = (event: PointerEvent): TrackPress =>
        event.shiftKey ? "range" : Keyboard.isControlKey(event) ? "toggle" : "replace"

    export const editsOnPress = (project: Project, unit: AudioUnitBox, event: PointerEvent): boolean => {
        const press = trackPressOf(event)
        return press === "replace"
            || press === "toggle" && project.audioUnitSelection.isSelected(unit)
            || press === "range" && editedTrack(project).isEmpty()
    }

    export const placePasted = (project: Project, unit: AudioUnitBox): void => {
        project.api.placeAudioUnitsAt([unit], project.api.insertionAfterSelection())
        selectTracks(project, [unit])
    }

    export const selectForMenu = (project: Project, unit: AudioUnitBox): void => {
        if (!project.audioUnitSelection.isSelected(unit)) {selectTracks(project, [unit])}
    }

    const visibleRange = (project: Project, from: AudioUnitBox, to: AudioUnitBox): ReadonlyArray<AudioUnitBox> => {
        const rows = project.audioUnitLayout.snapshot.visibleRows
        const start = rows.findIndex(row => row.unit === from)
        const end = rows.findIndex(row => row.unit === to)
        if (start === -1 || end === -1) {return [to]}
        return rows.slice(Math.min(start, end), Math.max(start, end) + 1).map(row => row.unit)
    }

    export const pressTrack = (project: Project, unit: AudioUnitBox, press: TrackPress): Nullable<Exec> => {
        const {audioUnitSelection} = project
        const selected = audioUnitSelection.isSelected(unit)
        if (press === "range") {
            selectTracks(project, editedTrack(project).mapOr(anchor => visibleRange(project, anchor, unit), [unit]))
        } else if (press === "toggle") {
            if (selected) {audioUnitSelection.deselect(unit)}
            else {selectTracks(project, [...audioUnitSelection.selected(), unit])}
        } else if (!selected) {
            selectTracks(project, [unit])
        } else if (audioUnitSelection.count() > 1) {
            return () => selectTracks(project, [unit])
        }
        return null
    }

    export const installTrackSelection = (lifecycle: Lifecycle, project: Project, header: HTMLElement, unit: AudioUnitBox,
                                          populateMenu?: Procedure<MenuItem>): void => {
        let onRelease: Nullable<Exec> = null
        let dragged = false
        lifecycle.ownAll(
            Events.subscribe(header, "pointerdown", (event: PointerEvent) => {
                dragged = false
                onRelease = null
                if (event.target instanceof Element && event.target.closest("button,input,select,svg.collapse-automation")) {return}
                if (event.button === 2 || Browser.isMacOS() && event.ctrlKey) {
                    selectForMenu(project, unit)
                } else if (event.button === 0) {
                    onRelease = pressTrack(project, unit, trackPressOf(event))
                }
            }),
            Events.subscribe(header, "dragstart", (event: DragEvent) => {if (!event.defaultPrevented) {dragged = true}}),
            Events.subscribeAny(header, "--track-drag-start", () => dragged = true),
            Events.subscribe(header, "pointerup", (event: PointerEvent) => {
                if (isDefined(onRelease) && !dragged && event.button === 0) {onRelease()}
                onRelease = null
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

    export const resolveGroupDrop = (project: Project, container: HTMLElement, event: Client, horizontal = false, originX?: number): Option<GroupDrop> => {
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
        return GroupDropLayout.resolve(layout, rows, event, horizontal, originX).map(target => ({
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

    export const installGroupTrackDrag = (handle: HTMLElement, project: Project, unit: AudioUnitBox,
                                          laneDrag: (target: Nullable<EventTarget>) => boolean = () => false): Terminable => {
        handle.dataset.groupHeader = UUID.toString(unit.address.uuid)
        handle.draggable = false
        handle.title = "Drag to move track; drop on a group bus or between tracks. Drag left to move out."
        const dragging = Dragging.attach(handle, start => {
            if (laneDrag(start.target)) {return Option.None}
            if (start.target instanceof Element && start.target.closest("button,input,select,textarea,a,[contenteditable],.track-resizer,[data-track-controls],svg.collapse-automation")) {return Option.None}
            if (!unit.isAttached() || unit.type.getValue() === AudioUnitType.Output) {return Option.None}
            const units = project.audioUnitSelection.isSelected(unit) ? [...project.audioUnitSelection.selected()] : [unit]
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
                    target = isDefined(surface) ? resolveGroupDrop(project, surface, event, surface.dataset.groupSurface === "mixer", start.clientX).unwrapOrUndefined() : undefined
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
}
