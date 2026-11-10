import {int} from "@opendaw/lib-std"
import {AnyClipBoxAdapter, AudioUnitBoxAdapter, AudioUnitGroups, TrackBoxAdapter} from "@opendaw/studio-adapters"
import type {Project} from "@opendaw/studio-core"
import {GroupClipAppearance} from "./GroupClipAppearance"

export namespace GroupClipColumnMoves {
    export type Move = {clip: AnyClipBoxAdapter, index: int, track: TrackBoxAdapter}
    export const prepare = (project: Project, moves: ReadonlyArray<Move>, copy: boolean): (() => void) => {
        const moved = new Map(moves.map(move => [move.clip.box, move]))
        const changes = project.audioUnitLayout.snapshot.rows.filter(row => AudioUnitGroups.isGroup(row.unit)).flatMap(({unit}) => {
            const tracks = AudioUnitGroups.subtree(project.rootBox, unit)
                .flatMap(child => project.boxAdapters.adapterFor(child, AudioUnitBoxAdapter).tracks.values())
            const indices = new Set(moves.map(({clip}) => clip.indexField.getValue()))
            return [...indices].flatMap(index => {
                const label = GroupClipAppearance.read(unit, index).label
                if (label === "") {return []}
                const clips = tracks.flatMap(track => track.clips.collection.getAdapterByIndex(index).mapOr(clip => [clip], []))
                const targets = clips.map(clip => moved.get(clip.box))
                const destination = targets[0]?.index
                if (destination === undefined || destination === index || !targets.every(move => move !== undefined
                    && move.index === destination && move.track.optAudioUnit.mapOr(target => target === unit
                        || AudioUnitGroups.ancestors(target).includes(unit), false))) {return []}
                return [{unit, index, destination, label}]
            })
        })
        return () => {
            if (!copy) {changes.forEach(({unit, index}) => GroupClipAppearance.clear(unit, index))}
            changes.forEach(({unit, destination, label}) => GroupClipAppearance.store(unit, destination, {label}))
        }
    }
}
