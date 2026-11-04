import {Box, BoxGraph, Field} from "@opendaw/lib-box"
import {isDefined, Maybe, UUID} from "@opendaw/lib-std"
import {Pointers} from "@opendaw/studio-enums"
import {
    BoxIO,
    BoxVisitor,
    TrackBox,
    ValueClipBox,
    ValueEventBox,
    ValueEventCollectionBox,
    ValueEventCurveBox,
    ValueRegionBox
} from "@opendaw/studio-boxes"

type Owner = ValueRegionBox | ValueClipBox

const asTrack = (box: Box): Maybe<TrackBox> => box.accept<BoxVisitor<TrackBox>>({visitTrackBox: track => track})
const asOwner = (box: Box): Maybe<Owner> => box.accept<BoxVisitor<Owner>>({
    visitValueRegionBox: region => region,
    visitValueClipBox: clip => clip
})
const asCollection = (box: Box): Maybe<ValueEventCollectionBox> =>
    box.accept<BoxVisitor<ValueEventCollectionBox>>({visitValueEventCollectionBox: collection => collection})
const asEvent = (box: Box): Maybe<ValueEventBox> => box.accept<BoxVisitor<ValueEventBox>>({visitValueEventBox: event => event})
const asCurve = (box: Box): Maybe<ValueEventCurveBox> =>
    box.accept<BoxVisitor<ValueEventCurveBox>>({visitValueEventCurveBox: curve => curve})

const eventsOf = (collection: ValueEventCollectionBox): ReadonlyArray<ValueEventBox> =>
    collection.events.pointerHub.incoming().map(pointer => asEvent(pointer.box)).filter(isDefined)

const copyCollection = (boxGraph: BoxGraph<BoxIO.TypeMap>, source: ValueEventCollectionBox): ValueEventCollectionBox => {
    const copy = ValueEventCollectionBox.create(boxGraph, UUID.generate())
    eventsOf(source).forEach(sourceEvent => {
        const event = ValueEventBox.create(boxGraph, UUID.generate(), box => {
            box.events.refer(copy.events)
            box.position.setValue(sourceEvent.position.getValue())
            box.index.setValue(sourceEvent.index.getValue())
            box.interpolation.setValue(sourceEvent.interpolation.getValue())
            box.value.setValue(sourceEvent.value.getValue())
            box.slope.setValue(sourceEvent.slope.getValue())
        })
        sourceEvent.interpolation.pointerHub.incoming().forEach(pointer => {
            const curve = asCurve(pointer.box)
            if (isDefined(curve)) {
                ValueEventCurveBox.create(boxGraph, UUID.generate(), box => {
                    box.event.refer(event.interpolation)
                    box.slope.setValue(curve.slope.getValue())
                })
            }
        })
    })
    return copy
}

// Must run inside a transaction. Collections shared with other targets are copied before rewriting.
export const migrateAutomation = <P extends Pointers>(boxGraph: BoxGraph<BoxIO.TypeMap>, target: Field<P>,
                                                     map: (unit: number) => number): void => {
    const owners: Array<Owner> = target.pointerHub.incoming()
        .map(pointer => asTrack(pointer.box))
        .filter(isDefined)
        .flatMap(track => [...track.regions.pointerHub.incoming(), ...track.clips.pointerHub.incoming()])
        .map(pointer => asOwner(pointer.box))
        .filter(isDefined)
    const done = new Set<ValueEventCollectionBox>()
    for (const owner of owners) {
        const collection = owner.events.targetVertex.mapOr(vertex => asCollection(vertex.box), undefined)
        if (!isDefined(collection) || done.has(collection)) {continue}
        done.add(collection)
        const users = collection.owners.pointerHub.incoming()
        const shared = users.some(pointer => {
            const user = asOwner(pointer.box)
            return !isDefined(user) || !owners.includes(user)
        })
        const migrated = shared ? copyCollection(boxGraph, collection) : collection
        done.add(migrated)
        if (shared) {
            users.map(pointer => asOwner(pointer.box))
                .filter(isDefined)
                .filter(user => owners.includes(user))
                .forEach(user => user.events.refer(migrated.owners))
        }
        eventsOf(migrated).forEach(event => event.value.setValue(map(event.value.getValue())))
    }
}
