import {BoxGraph, PointerField} from "@opendaw/lib-box"
import {clamp, isDefined} from "@opendaw/lib-std"
import {
    BoxIO,
    BoxVisitor,
    KorpusDeviceBox,
    TrackBox,
    ValueClipBox,
    ValueEventBox,
    ValueEventCollectionBox,
    ValueRegionBox
} from "@opendaw/studio-boxes"

const automatedEvents = (pointers: ReadonlyArray<PointerField>): Set<ValueEventBox> => {
    const events = new Set<ValueEventBox>()
    const collect = (collection: PointerField) => collection.targetVertex.ifSome(vertex =>
        vertex.box.accept<BoxVisitor>({
            visitValueEventCollectionBox: (collectionBox: ValueEventCollectionBox) =>
                collectionBox.events.pointerHub.incoming().forEach(({box: eventOwner}) =>
                    eventOwner.accept<BoxVisitor>({visitValueEventBox: (event: ValueEventBox) => events.add(event)}))
        }))
    pointers.forEach(({box: owner}) => owner.accept<BoxVisitor>({
        visitTrackBox: (track: TrackBox) =>
            [...track.regions.pointerHub.incoming(), ...track.clips.pointerHub.incoming()]
                .forEach(({box: lane}) => lane.accept<BoxVisitor>({
                    visitValueRegionBox: (region: ValueRegionBox) => collect(region.events),
                    visitValueClipBox: (clip: ValueClipBox) => collect(clip.events)
                }))
    }))
    return events
}

const isTrackPointer = (pointer: PointerField): boolean =>
    isDefined(pointer.box.accept<BoxVisitor<boolean>>({visitTrackBox: () => true}))

export const migrateKorpusDeviceBox = (boxGraph: BoxGraph<BoxIO.TypeMap>, box: KorpusDeviceBox): void => {
    const semitones = box.deprecatedTuneB.getValue()
    const cents = box.deprecatedDetuneB.getValue()
    const pointers = box.deprecatedTuneB.pointerHub.incoming()
    const detunePointers = box.deprecatedDetuneB.pointerHub.incoming()
    if (semitones === 0 && cents === 0.0 && pointers.length === 0 && detunePointers.length === 0) {return}
    console.debug("Migrate 'KorpusDeviceBox' tune and detune B into one tune")
    const detuneTracks = detunePointers.filter(isTrackPointer)
    const detuneOthers = detunePointers.filter(pointer => !isTrackPointer(pointer))
    boxGraph.beginTransaction()
    // A MIDI mapping or modulation spanning ±25 ct would span ±24 st on the new knob.
    detuneOthers.forEach(({box: owner}) => owner.delete())
    if (pointers.some(isTrackPointer) || detuneTracks.length === 0) {
        // Two lanes on different event grids cannot merge; the semitone lane wins.
        detuneTracks.forEach(({box: owner}) => owner.delete())
    } else {
        // The only tuning lane: ±25 ct maps affinely onto ±24 st, with the static semitones folded in.
        automatedEvents(detuneTracks).forEach(event => event.value.setValue(
            clamp((semitones + (-25.0 + 50.0 * event.value.getValue()) / 100.0 + 24.0) / 48.0, 0.0, 1.0)))
        detuneTracks.forEach(pointer => pointer.refer(box.tuneB))
    }
    automatedEvents(pointers).forEach(event =>
        event.value.setValue(clamp(event.value.getValue() + cents / 100.0 / 48.0, 0.0, 1.0)))
    pointers.forEach(pointer => pointer.refer(box.tuneB))
    box.tuneB.setValue(clamp(semitones + cents / 100.0, -24.0, 24.0))
    box.deprecatedTuneB.setValue(0)
    box.deprecatedDetuneB.setValue(0.0)
    boxGraph.endTransaction()
}
