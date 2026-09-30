import {BoxGraph, PointerField} from "@opendaw/lib-box"
import {clamp} from "@opendaw/lib-std"
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

export const migrateKorpusDeviceBox = (boxGraph: BoxGraph<BoxIO.TypeMap>, box: KorpusDeviceBox): void => {
    const semitones = box.deprecatedTuneB.getValue()
    const cents = box.deprecatedDetuneB.getValue()
    const pointers = box.deprecatedTuneB.pointerHub.incoming()
    const detunePointers = box.deprecatedDetuneB.pointerHub.incoming()
    if (semitones === 0 && cents === 0.0 && pointers.length === 0 && detunePointers.length === 0) {return}
    console.debug("Migrate 'KorpusDeviceBox' tune and detune B into one tune")
    boxGraph.beginTransaction()
    // Cents automation, MIDI mappings and modulation have no equivalent on the ±24 st knob.
    detunePointers.forEach(({box: owner}) => owner.delete())
    automatedEvents(pointers).forEach(event =>
        event.value.setValue(clamp(event.value.getValue() + cents / 100.0 / 48.0, 0.0, 1.0)))
    pointers.forEach(pointer => pointer.refer(box.tuneB))
    box.tuneB.setValue(clamp(semitones + cents / 100.0, -24.0, 24.0))
    box.deprecatedTuneB.setValue(0)
    box.deprecatedDetuneB.setValue(0.0)
    boxGraph.endTransaction()
}
