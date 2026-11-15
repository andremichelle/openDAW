import {Option} from "@opendaw/lib-std"
import {ppqn} from "@opendaw/lib-dsp"
import {AnyRegionBoxAdapter, RegionOverlap, TrackBoxAdapter} from "@opendaw/studio-adapters"
import type {Project} from "@opendaw/studio-core"

export namespace RegionDuplication {
    export const duplicateSelected = (project: Project): boolean => {
        const {editing, regionSelection, trackFocus} = project
        const selected = regionSelection.selected()
            .filter(region => region.trackBoxAdapter.nonEmpty())
            .toSorted((left, right) => right.position - left.position)
        if (selected.length === 0) {return false}
        const offset = Math.ceil(Math.max(...selected.map(region => region.complete))
            - Math.min(...selected.map(region => region.position)))
        const groups = new Map<TrackBoxAdapter, Array<AnyRegionBoxAdapter>>()
        selected.forEach(region => {
            const track = region.trackBoxAdapter.unwrap()
            const group = groups.get(track) ?? []
            group.push(region)
            groups.set(track, group)
        })
        editing.modify(() => {
            const copies = Array.from(groups)
                .flatMap(([track, regions]) => duplicateOnTrack(project, track, regions, offset))
            regionSelection.deselectAll()
            regionSelection.select(...copies)
            Option.wrap(copies.at(0))
                .flatMap(copy => copy.trackBoxAdapter)
                .ifSome(track => trackFocus.focus(track))
        })
        return true
    }

    // all copies of one track land on one track, even if only one of them finds its place occupied
    const duplicateOnTrack = (project: Project,
                              track: TrackBoxAdapter,
                              regions: ReadonlyArray<AnyRegionBoxAdapter>,
                              offset: ppqn): ReadonlyArray<AnyRegionBoxAdapter> => {
        const {api, boxAdapters, overlapResolver} = project
        const occupied = regions.some(region => !RegionOverlap.hasSpace(
            boxAdapters, track.box, region.position + offset, region.position + offset + region.duration))
        const target = occupied
            ? overlapResolver.resolveTargetTrack(track,
                Math.min(...regions.map(region => region.position + offset)),
                Math.max(...regions.map(region => region.position + offset + region.duration)))
            : track
        return regions.flatMap(region => {
            const position = region.position + offset
            if (target === track) {return api.duplicateRegion(region, {position}).mapOr(copy => [copy], [])}
            return [region.copyTo({position, target: target.box.regions, consolidate: true})]
        })
    }
}
