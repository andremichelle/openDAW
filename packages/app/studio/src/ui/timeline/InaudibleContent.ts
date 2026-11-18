import {Arrays, isDefined, isInstanceOf} from "@opendaw/lib-std"
import {ppqn} from "@opendaw/lib-dsp"
import {
    AnyRegionBoxAdapter,
    NoteEventBoxAdapter,
    NoteRegionBoxAdapter,
    ValueEventBoxAdapter,
    ValueRegionBoxAdapter
} from "@opendaw/studio-adapters"

export namespace InaudibleContent {
    export type Event = NoteEventBoxAdapter | ValueEventBoxAdapter

    type Window = Readonly<{ start: ppqn, end: ppqn }>

    export type Geometry = Readonly<{ loopOffset: ppqn, loopDuration: ppqn, duration: ppqn }>

    export const windowsOf = ({loopOffset, loopDuration, duration}: Geometry): ReadonlyArray<Window> => {
        if (loopDuration <= 0) {return Arrays.empty()}
        if (duration >= loopDuration) {return [{start: 0, end: loopDuration}]}
        const start = ((loopOffset % loopDuration) + loopDuration) % loopDuration
        const end = start + duration
        return end <= loopDuration
            ? [{start, end}]
            : [{start, end: loopDuration}, {start: 0, end: end - loopDuration}]
    }

    const inside = (windows: ReadonlyArray<Window>, position: ppqn): boolean =>
        windows.some(({start, end}) => start <= position && position < end)

    const notesOutside = (notes: ReadonlyArray<NoteEventBoxAdapter>, geometry: Geometry): ReadonlyArray<Event> => {
        const windows = windowsOf(geometry)
        return notes.filter(note => !inside(windows, note.position))
    }

    const pointsOutside = (events: ReadonlyArray<ValueEventBoxAdapter>, geometry: Geometry): ReadonlyArray<Event> => {
        const keep = new Set<ValueEventBoxAdapter>()
        windowsOf(geometry).forEach(({start, end}) => {
            const before = events.filter(event => event.position < start).at(-1)
            const after = events.find(event => event.position >= end)
            if (isDefined(before)) {keep.add(before)}
            if (isDefined(after)) {keep.add(after)}
            events.filter(event => start <= event.position && event.position < end).forEach(event => keep.add(event))
        })
        return events.filter(event => !keep.has(event))
    }

    const outside = (region: AnyRegionBoxAdapter, geometry: Geometry): ReadonlyArray<Event> => {
        if (isInstanceOf(region, NoteRegionBoxAdapter)) {
            return region.optCollection.mapOr(({events}) => notesOutside(events.asArray(), geometry), Arrays.empty())
        }
        if (isInstanceOf(region, ValueRegionBoxAdapter)) {
            return region.optCollection.mapOr(({events}) => pointsOutside(events.asArray(), geometry), Arrays.empty())
        }
        return Arrays.empty()
    }

    export const count = (regions: ReadonlyArray<AnyRegionBoxAdapter>, cuts: ReadonlyArray<ppqn>,
                          removed: (start: ppqn, end: ppqn) => boolean): number => regions.reduce((sum, region) => {
        const edges = cuts.filter(cut => region.position < cut && cut < region.complete)
        if (edges.length === 0) {return sum}
        const bounds = [region.position, ...edges, region.complete]
        return bounds.slice(0, -1).reduce((pieces, start, index) => {
            const end = bounds[index + 1]
            if (removed(start, end) || (index === 0 && region.isMirrowed)) {return pieces}
            const {loopOffset, loopDuration} = region
            return pieces + outside(region, {loopOffset: loopOffset + start - region.position, loopDuration, duration: end - start}).length
        }, sum)
    }, 0)

    export const collect = (regions: ReadonlyArray<AnyRegionBoxAdapter>): ReadonlyArray<Event> => regions
        .filter(region => region.box.isAttached())
        .filter(region => !region.isMirrowed)
        .flatMap(region => outside(region, region))
}
