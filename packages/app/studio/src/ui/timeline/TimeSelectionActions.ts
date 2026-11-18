import {Arrays, isInstanceOf, UUID} from "@opendaw/lib-std"
import {AnyRegionBoxAdapter, AudioUnitBoxAdapter, TrackBoxAdapter} from "@opendaw/studio-adapters"
import {TrackBox} from "@opendaw/studio-boxes"
import {MenuItem, Project} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {TimeSelection} from "@/ui/timeline/TimeSelection"
import {TimeEditing} from "@/ui/timeline/TimeEditing"
import {InaudibleContent} from "@/ui/timeline/InaudibleContent"
import {TimeSelectionShortcuts} from "@/ui/shortcuts/TimeSelectionShortcuts"
import {Dialogs} from "@/ui/components/dialogs"

export namespace TimeSelectionActions {
    export type Action = "delete" | "insert"

    export const allTracks = ({boxGraph, boxAdapters}: Project): ReadonlyArray<TrackBoxAdapter> => boxGraph.boxes()
        .filter(box => isInstanceOf(box, TrackBox))
        .map(box => boxAdapters.adapterFor(box, TrackBoxAdapter))

    export const apply = ({project}: StudioService, selection: TimeSelection,
                          tracks: ReadonlyArray<TrackBoxAdapter>, action: Action): void => {
        const {editing, audioUnitFreeze, boxGraph, boxAdapters, timelineBoxAdapter} = project
        const units = UUID.newSet<AudioUnitBoxAdapter>(unit => unit.uuid)
        tracks.forEach(track => track.optAudioUnit.ifSome(box => units.add(boxAdapters.adapterFor(box, AudioUnitBoxAdapter))))
        const frozen = units.values().filter(unit => audioUnitFreeze.isFrozen(unit))
        const {position, complete, global} = selection
        const globals: ReadonlyArray<TimeEditing.Global> = global ? [{timeline: timelineBoxAdapter, boxGraph}] : []
        const edit = (mark: boolean): ReadonlyArray<AnyRegionBoxAdapter> => editing.modify(() => action === "delete"
            ? TimeEditing.deleteTime(tracks, globals, position, complete)
            : TimeEditing.insertTime(tracks, globals, position, complete - position), mark).unwrapOrElse(Arrays.empty())
        const run = (): void => {
            const inaudible = InaudibleContent.count(tracks.flatMap(track => track.regions.collection.asArray()),
                action === "delete" ? [position, complete] : [position],
                (start, end) => action === "delete" && start >= position && end <= complete)
            if (inaudible === 0) {
                edit(true)
                return
            }
            Dialogs.approve({
                headline: "Cleanup Inaudible Content",
                message: `The cut leaves ${inaudible === 1 ? "a note or point" : `${inaudible} notes and points`} in the regions that can no longer be heard. Remove ${inaudible === 1 ? "it" : "them"} as well?`,
                approveText: "Remove",
                cancelText: "Ignore"
            }).then(remove => {
                if (!remove) {
                    edit(true)
                    return
                }
                const touched = edit(false)
                editing.modify(() => InaudibleContent.collect(touched).forEach(event => event.box.delete()))
            })
        }
        if (frozen.length === 0) {
            run()
            return
        }
        Dialogs.approve({
            headline: "Frozen Tracks",
            message: `${frozen.length === 1 ? "A frozen track is" : `${frozen.length} frozen tracks are`} part of the time selection. Unfreeze and edit?`,
            approveText: "Unfreeze"
        }).then(approved => {
            if (!approved) {return}
            frozen.forEach(unit => audioUnitFreeze.unfreeze(unit))
            run()
        })
    }

    export const menuItems = (run: (action: Action) => void): ReadonlyArray<MenuItem> => [
        MenuItem.default({label: "Delete Time", shortcut: TimeSelectionShortcuts["delete-time"].shortcut.format()})
            .setTriggerProcedure(() => run("delete")),
        MenuItem.default({label: "Insert Time", shortcut: TimeSelectionShortcuts["insert-time"].shortcut.format()})
            .setTriggerProcedure(() => run("insert"))
    ]
}
