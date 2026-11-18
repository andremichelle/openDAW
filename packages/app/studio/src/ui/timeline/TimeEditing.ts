import {ppqn, PPQN} from "@opendaw/lib-dsp"
import {Option, UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {
    AnyRegionBoxAdapter,
    KeyEventBoxAdapter,
    MarkerBoxAdapter,
    RegionEditing,
    SignatureTrackAdapter,
    TimelineBoxAdapter,
    TrackBoxAdapter,
    ValueEventBoxAdapter
} from "@opendaw/studio-adapters"
import {ChordEventBox} from "@opendaw/studio-boxes"

export namespace TimeEditing {
    export type Global = Readonly<{timeline: TimelineBoxAdapter, boxGraph: BoxGraph}>

    type PointEvent = MarkerBoxAdapter | KeyEventBoxAdapter | ValueEventBoxAdapter

    const cutAll = (regions: Array<AnyRegionBoxAdapter>, position: ppqn): void => regions.slice()
        .filter(region => region.position < position && position < region.complete)
        .forEach(region => RegionEditing.cut(region, position, true).ifSome(right => regions.push(right)))

    const mapStates = (positions: ReadonlyArray<ppqn>, position: ppqn, complete: ppqn): ReadonlyArray<Option<ppqn>> => {
        const length = complete - position
        const targets = positions.map(at => at < position ? at : at < complete ? position : at - length)
        return targets.map((target, index) => positions[index] >= position && positions[index] < complete
        && index + 1 < targets.length && targets[index + 1] === position ? Option.None : Option.wrap(target))
    }

    const applyPoints = (events: ReadonlyArray<PointEvent>, targets: ReadonlyArray<Option<ppqn>>): void =>
        events.forEach((event, index) => targets[index].match({
            none: () => event.box.delete(),
            some: target => {if (target !== event.position) {event.box.position.setValue(target)}}
        }))

    const rebuildSignature = (signatureTrack: SignatureTrackAdapter,
                              map: (events: ReadonlyArray<ppqn>) => ReadonlyArray<Option<ppqn>>): void => {
        const [storage, ...events] = Array.from(signatureTrack.iterateAll())
        if (events.length === 0) {return}
        const targets = map(events.map(event => event.accumulatedPpqn))
        let accumulated: ppqn = 0
        let barLength: ppqn = PPQN.fromSignature(storage.nominator, storage.denominator)
        let index = 0
        events.forEach((event, eventIndex) => {
            const adapter = signatureTrack.adapterAt(event.index).unwrap("signature event")
            targets[eventIndex].match({
                none: () => adapter.box.delete(),
                some: target => {
                    const relative = Math.max(1, Math.round((target - accumulated) / barLength))
                    adapter.box.index.setValue(index++)
                    adapter.box.relativePosition.setValue(relative)
                    accumulated += relative * barLength
                    barLength = PPQN.fromSignature(event.nominator, event.denominator)
                }
            })
        })
    }

    export const deleteTime = (tracks: ReadonlyArray<TrackBoxAdapter>, global: ReadonlyArray<Global>,
                               position: ppqn, complete: ppqn): void => {
        if (complete <= position) {return}
        const length = complete - position
        tracks.forEach(track => {
            const regions = track.regions.collection.asArray().slice()
            cutAll(regions, position)
            cutAll(regions, complete)
            regions.forEach(region => {
                if (region.position >= complete) {
                    region.position = region.position - length
                } else if (region.position >= position) {
                    region.box.delete()
                }
            })
        })
        global.forEach(({timeline}) => {
            const markers = timeline.markerTrack.events.asArray().slice()
            applyPoints(markers, markers.map(({position: at}) =>
                at < position ? Option.wrap(at) : at < complete ? Option.None : Option.wrap(at - length)))
            timeline.tempoTrackEvents.ifSome(({events}) => {
                const points = events.asArray().slice()
                applyPoints(points, mapStates(points.map(point => point.position), position, complete))
            })
            const keys = timeline.keyTrack.events.asArray().slice()
            applyPoints(keys, mapStates(keys.map(key => key.position), position, complete))
            const map = (value: ppqn): ppqn => value < position ? value : value < complete ? position : value - length
            timeline.chordTrack.events.asArray().slice().forEach(chord => {
                const start = map(chord.position)
                const end = map(chord.complete)
                if (end <= start) {
                    chord.box.delete()
                } else {
                    chord.box.position.setValue(start)
                    chord.box.duration.setValue(end - start)
                }
            })
            rebuildSignature(timeline.signatureTrack, events => mapStates(events, position, complete))
        })
    }

    export const insertTime = (tracks: ReadonlyArray<TrackBoxAdapter>, global: ReadonlyArray<Global>,
                               position: ppqn, length: ppqn): void => {
        if (length <= 0) {return}
        const push = (at: ppqn): Option<ppqn> => Option.wrap(at >= position ? at + length : at)
        tracks.forEach(track => {
            const regions = track.regions.collection.asArray().slice()
            cutAll(regions, position)
            regions.filter(region => region.position >= position)
                .forEach(region => region.position = region.position + length)
        })
        global.forEach(({timeline, boxGraph}) => {
            const markers = timeline.markerTrack.events.asArray().slice()
            applyPoints(markers, markers.map(({position: at}) => push(at)))
            timeline.tempoTrackEvents.ifSome(({events}) => {
                const points = events.asArray().slice()
                applyPoints(points, points.map(({position: at}) => push(at)))
            })
            const keys = timeline.keyTrack.events.asArray().slice()
            applyPoints(keys, keys.map(({position: at}) => push(at)))
            timeline.chordTrack.events.asArray().slice().forEach(chord => {
                if (chord.position >= position) {
                    chord.box.position.setValue(chord.position + length)
                } else if (chord.complete > position) {
                    const {complete, box: source} = chord
                    source.duration.setValue(position - chord.position)
                    ChordEventBox.create(boxGraph, UUID.generate(), box => {
                        box.position.setValue(position + length)
                        box.duration.setValue(complete - position)
                        box.degree.setValue(source.degree.getValue())
                        box.shift.setValue(source.shift.getValue())
                        box.shape.setValue(source.shape.getValue())
                        box.notes.setValue(source.notes.getValue())
                        box.inversion.setValue(source.inversion.getValue())
                        box.track.refer(timeline.chordTrack.object.events)
                    })
                }
            })
            rebuildSignature(timeline.signatureTrack, events => events.map(push))
        })
    }
}
