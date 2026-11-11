import {asInstanceOf, Attempt, Attempts, isAbsent, isDefined, isInstanceOf, Option, UUID} from "@opendaw/lib-std"
import {Box, Field, IndexedBox, Vertex} from "@opendaw/lib-box"
import {AudioUnitType, Pointers} from "@opendaw/studio-enums"
import {
    AudioBusBox,
    AudioUnitBox,
    CaptureMidiBox,
    InstrumentCompositeCellBox,
    NoteClipBox,
    NoteEventBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    PlayfieldDeviceBox,
    TrackBox
} from "@opendaw/studio-boxes"
import {AudioUnitFactory, AudioUnitGroups, InstrumentBox, PlayfieldPads, TrackType} from "@opendaw/studio-adapters"
import type {Project} from "./Project"
import type {AudioUnitInsertion} from "./ProjectApi"

// a pad becomes its own instrument unit next to the Playfield and sounds the same there
export namespace PlayfieldPadToUnit {
    export const extract = (project: Project, cell: InstrumentCompositeCellBox,
                            insertion: Option<AudioUnitInsertion> = Option.None): Attempt<AudioUnitBox, string> => {
        if (!PlayfieldPads.isPad(cell)) {return Attempts.err("Not a Playfield pad")}
        const instrument = cell.instrument.pointerHub.incoming().at(0)?.box
        if (isAbsent(instrument)) {return Attempts.err("The pad holds no instrument")}
        const playfield = asInstanceOf(cell.composite.targetVertex.unwrap("composite").box, PlayfieldDeviceBox)
        const source = playfield.host.targetVertex.unwrap("playfield host").box
        if (!isInstanceOf(source, AudioUnitBox)) {return Attempts.err("Only a Playfield on its own track can hand out a pad")}
        const {boxGraph, api} = project
        const placement = insertion.unwrapOrElse(() => api.insertionAfter(Option.wrap(source)))
        const destination = insertion.isEmpty()
            ? source.output.targetVertex.map(({box}) => box).unwrapOrNull()
            : placement.parent.flatMap(uuid => boxGraph.findBox(uuid))
                .flatMap(box => isInstanceOf(box, AudioUnitBox) ? AudioUnitGroups.bus(box) : Option.None).unwrapOrNull()
        const unit = AudioUnitFactory.create(project.skeleton, AudioUnitType.Instrument,
            Option.wrap(CaptureMidiBox.create(boxGraph, UUID.generate())), undefined,
            isInstanceOf(destination, AudioBusBox) ? destination : undefined)
        api.placeAudioUnitsAt([unit], placement)
        unit.volume.setValue(cell.gain.getValue())
        unit.panning.setValue(cell.pan.getValue())
        unit.mute.setValue(cell.mute.getValue())
        unit.solo.setValue(cell.solo.getValue())
        const moved = new Set<Box>([instrument, unit])
        ;(instrument as InstrumentBox).host.refer(unit.input)
        cell.midiEffects.pointerHub.incoming().forEach(pointer => {
            moved.add(pointer.box)
            pointer.refer(unit.midiEffects)
        })
        cell.audioEffects.pointerHub.incoming().forEach(pointer => {
            moved.add(pointer.box)
            pointer.refer(unit.audioEffects)
        })
        const strip: ReadonlyArray<[Field, Vertex]> = [
            [cell.gain, unit.volume], [cell.pan, unit.panning], [cell.mute, unit.mute], [cell.solo, unit.solo]]
        cell.incomingEdges().forEach(pointer => {
            const keys = pointer.targetAddress.unwrap("pointer target").fieldKeys
            if (keys.length === 0) {
                if (pointer.pointerType === Pointers.SideChain) {pointer.refer(unit)}
                return
            }
            Option.wrap(strip.find(([field]) => field.fieldKey === keys[0])).ifSome(([, target]) => pointer.refer(target))
        })
        const tracks = IndexedBox.collectIndexedBoxes(source.tracks)
            .filter((box): box is TrackBox => isInstanceOf(box, TrackBox))
        tracks.filter(track => track.type.getValue() === TrackType.Value)
            .filter(track => track.target.targetVertex.mapOr(({box}) => moved.has(box), false))
            .forEach(track => track.tracks.refer(unit.tracks))
        const noteTrack = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Notes)
            box.tracks.refer(unit.tracks)
            box.target.refer(unit)
        })
        moveNotes(project, tracks.filter(track => track.type.getValue() === TrackType.Notes), noteTrack, cell)
        IndexedBox.collectIndexedBoxes(unit.tracks).forEach((box, index) => box.index.setValue(index))
        IndexedBox.collectIndexedBoxes(source.tracks).forEach((box, index) => box.index.setValue(index))
        cell.delete()
        return Attempts.ok(unit)
    }

    // the pad's notes move to copies of their regions and clips, at the pitch the pad played
    const moveNotes = (project: Project, sources: ReadonlyArray<TrackBox>, target: TrackBox,
                       cell: InstrumentCompositeCellBox): void => {
        const {boxGraph} = project
        const padKey = cell.index.getValue()
        const playKey = cell.key.getValue()
        const collections = new Map<NoteEventCollectionBox, Option<NoteEventCollectionBox>>()
        const moveCollection = (collection: Box): Option<NoteEventCollectionBox> => {
            if (!isInstanceOf(collection, NoteEventCollectionBox)) {return Option.None}
            const known = collections.get(collection)
            if (isDefined(known)) {return known}
            const notes = collection.events.pointerHub.incoming().map(({box}) => box)
                .filter((box): box is NoteEventBox => isInstanceOf(box, NoteEventBox) && box.pitch.getValue() === padKey)
            const result = notes.length === 0 ? Option.None : Option.wrap(NoteEventCollectionBox.create(boxGraph, UUID.generate()))
            result.ifSome(copy => notes.forEach(note => {
                note.events.refer(copy.events)
                note.pitch.setValue(playKey)
            }))
            collections.set(collection, result)
            return result
        }
        sources.forEach(track => {
            track.regions.pointerHub.incoming().forEach(({box}) => {
                if (!isInstanceOf(box, NoteRegionBox)) {return}
                box.events.targetVertex.ifSome(({box: collection}) => moveCollection(collection)
                    .ifSome(copy => NoteRegionBox.create(boxGraph, UUID.generate(), region => {
                        region.regions.refer(target.regions)
                        region.events.refer(copy.owners)
                        region.position.setValue(box.position.getValue())
                        region.duration.setValue(box.duration.getValue())
                        region.loopOffset.setValue(box.loopOffset.getValue())
                        region.loopDuration.setValue(box.loopDuration.getValue())
                        region.eventOffset.setValue(box.eventOffset.getValue())
                        region.mute.setValue(box.mute.getValue())
                        region.label.setValue(box.label.getValue())
                        region.hue.setValue(box.hue.getValue())
                        box.groove.ifVertex(vertex => region.groove.refer(vertex))
                    })))
            })
            track.clips.pointerHub.incoming().forEach(({box}) => {
                if (!isInstanceOf(box, NoteClipBox)) {return}
                box.events.targetVertex.ifSome(({box: collection}) => moveCollection(collection)
                    .ifSome(copy => NoteClipBox.create(boxGraph, UUID.generate(), clip => {
                        clip.clips.refer(target.clips)
                        clip.events.refer(copy.owners)
                        clip.index.setValue(box.index.getValue())
                        clip.duration.setValue(box.duration.getValue())
                        clip.mute.setValue(box.mute.getValue())
                        clip.label.setValue(box.label.getValue())
                        clip.hue.setValue(box.hue.getValue())
                        const {loop, reverse, mute, speed, quantise, trigger} = box.triggerMode
                        clip.triggerMode.loop.setValue(loop.getValue())
                        clip.triggerMode.reverse.setValue(reverse.getValue())
                        clip.triggerMode.mute.setValue(mute.getValue())
                        clip.triggerMode.speed.setValue(speed.getValue())
                        clip.triggerMode.quantise.setValue(quantise.getValue())
                        clip.triggerMode.trigger.setValue(trigger.getValue())
                        box.groove.ifVertex(vertex => clip.groove.refer(vertex))
                    })))
            })
        })
    }
}
