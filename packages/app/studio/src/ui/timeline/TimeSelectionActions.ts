import {isInstanceOf, UUID} from "@opendaw/lib-std"
import {AudioUnitBoxAdapter, TrackBoxAdapter} from "@opendaw/studio-adapters"
import {TrackBox} from "@opendaw/studio-boxes"
import {MenuItem, Project} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {TimeSelection} from "@/ui/timeline/TimeSelection"
import {TimeEditing} from "@/ui/timeline/TimeEditing"
import {RegionsShortcuts} from "@/ui/shortcuts/RegionsShortcuts"
import {Dialogs} from "@/ui/components/dialogs"

export namespace TimeSelectionActions {
    export type Action = "delete" | "insert"

    export const allTracks = ({boxGraph, boxAdapters}: Project): ReadonlyArray<TrackBoxAdapter> => boxGraph.boxes()
        .filter(box => isInstanceOf(box, TrackBox))
        .map(box => boxAdapters.adapterFor(box, TrackBoxAdapter))

    export const apply = async ({project}: StudioService, selection: TimeSelection,
                                tracks: ReadonlyArray<TrackBoxAdapter>, action: Action): Promise<void> => {
        const {editing, audioUnitFreeze, boxGraph, boxAdapters, timelineBoxAdapter} = project
        const units = UUID.newSet<AudioUnitBoxAdapter>(unit => unit.uuid)
        tracks.forEach(track => units.add(boxAdapters.adapterFor(track.audioUnit, AudioUnitBoxAdapter)))
        const frozen = units.values().filter(unit => audioUnitFreeze.isFrozen(unit))
        if (frozen.length > 0) {
            const approved = await Dialogs.approve({
                headline: "Frozen Tracks",
                message: `${frozen.length === 1 ? "A frozen track is" : `${frozen.length} frozen tracks are`} part of the time selection. Unfreeze and edit?`,
                approveText: "Unfreeze"
            })
            if (!approved) {return}
            frozen.forEach(unit => audioUnitFreeze.unfreeze(unit))
        }
        const {position, complete, global} = selection
        const globals: ReadonlyArray<TimeEditing.Global> = global ? [{timeline: timelineBoxAdapter, boxGraph}] : []
        editing.modify(() => action === "delete"
            ? TimeEditing.deleteTime(tracks, globals, position, complete)
            : TimeEditing.insertTime(tracks, globals, position, complete - position))
    }

    export const menuItems = (run: (action: Action) => void): ReadonlyArray<MenuItem> => [
        MenuItem.default({label: "Delete Time", shortcut: RegionsShortcuts["delete-time"].shortcut.format()})
            .setTriggerProcedure(() => run("delete")),
        MenuItem.default({label: "Insert Time", shortcut: RegionsShortcuts["insert-time"].shortcut.format()})
            .setTriggerProcedure(() => run("insert"))
    ]
}
