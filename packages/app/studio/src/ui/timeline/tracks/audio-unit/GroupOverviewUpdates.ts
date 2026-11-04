import {Observer, Terminable, Terminator} from "@opendaw/lib-std"
import {AudioUnitBoxAdapter, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import type {Project} from "@opendaw/studio-core"

export const subscribeGroupOverview = (project: Project, unit: AudioUnitBox, redraw: Observer<void>): Terminable => {
    const lifecycle = new Terminator()
    const descendants = lifecycle.own(new Terminator())
    let members: ReadonlyArray<AudioUnitBox> = []
    const refresh = (): void => {
        const next = unit.groupCollapsed.getValue()
            ? project.audioUnitLayout.snapshot.rows.filter(row => row.ancestors.includes(unit)).map(row => row.unit) : []
        if (members.length === next.length && members.every((member, index) => member === next[index])) {return}
        members = next
        descendants.terminate()
        members.forEach(member => {
            const tracks = project.boxAdapters.adapterFor(member, AudioUnitBoxAdapter).tracks
            const subscriptions = new Map<TrackBoxAdapter, Terminable>()
            descendants.ownAll(
                {terminate: () => subscriptions.forEach(subscription => subscription.terminate())},
                tracks.catchupAndSubscribe({
                    onAdd: track => {
                        if (track.type !== TrackType.Notes && track.type !== TrackType.Audio) {return}
                        subscriptions.set(track, Terminable.many(track.regions.subscribeChanges(redraw), track.enabled.subscribe(() => redraw())))
                        redraw()
                    },
                    onRemove: track => {
                        subscriptions.get(track)?.terminate()
                        subscriptions.delete(track)
                        redraw()
                    },
                    onReorder: () => redraw()
                })
            )
        })
        redraw()
    }
    lifecycle.own(project.audioUnitLayout.value.subscribe(refresh))
    refresh()
    return lifecycle
}
