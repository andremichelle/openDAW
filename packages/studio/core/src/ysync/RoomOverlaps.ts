import {int, isInstanceOf, Option, RuntimeNotifier, SortedSet, Terminable, UUID} from "@opendaw/lib-std"
import {Address, Box, BoxGraph, PrimitiveField, PrimitiveValues, Update} from "@opendaw/lib-box"
import {TrackBox} from "@opendaw/studio-boxes"
import {AnyRegionBox, RegionOverlap, UnionBoxTypes} from "@opendaw/studio-adapters"
import type {YSync} from "./YSync"

// Two participants can place or move regions onto one spot at the same time, each valid on its own client.
// Overlaps are never allowed, so one of the two changes is taken back: by the client that made it, because only
// it knows where the region was. Of two concurrent changes the client with the higher id gives way.
export namespace RoomOverlaps {
    type Change = {
        readonly uuid: UUID.Bytes
        readonly created: boolean
        readonly values: Array<[PrimitiveField, PrimitiveValues]>
        track: Option<Address>
        readonly known: Map<number, number>
    }

    const fieldsOf = (region: AnyRegionBox): ReadonlyArray<PrimitiveField> =>
        [region.position, region.duration, region.loopOffset, region.loopDuration]

    const regionOf = (graph: BoxGraph, uuid: UUID.Bytes): Option<AnyRegionBox> =>
        graph.findBox(uuid).flatMap(box => UnionBoxTypes.isRegionBox(box) ? Option.wrap(box) : Option.None)

    const overlaps = (before: AnyRegionBox, after: AnyRegionBox): boolean => {
        if (RegionOverlap.endsAtSuccessor(before)) {return false}
        const position = after.position.getValue()
        return before.position.getValue() + before.duration.getValue() > position + RegionOverlap.boundaryTolerance(position)
    }

    export const watch = (graph: BoxGraph, sync: YSync<unknown>): Terminable => {
        const changes: SortedSet<UUID.Bytes, Change> = UUID.newSet(change => change.uuid)
        const patched = new Set<string>()
        let reverting = false
        const writers = (region: AnyRegionBox) => [region.address, region.position.address, region.duration.address, region.regions.address]
            .flatMap(address => sync.writerOf(address).mapOr(id => [id], []))
        const record = (update: Update): void => {
            if (sync.applyingRemote || reverting) {return}
            if (update.type === "delete") {
                changes.removeByKeyIfExist(update.uuid)
                return
            }
            if (update.type === "new") {
                regionOf(graph, update.uuid).ifSome(region => {
                    changes.removeByKeyIfExist(region.address.uuid)
                    changes.add({uuid: region.address.uuid, created: true, values: [], track: Option.None, known: sync.knownClocks()})
                    patched.add(UUID.toString(region.address.uuid))
                })
                return
            }
            regionOf(graph, update.address.uuid).ifSome(region => {
                const key = UUID.toString(region.address.uuid)
                if (!patched.has(key)) {
                    patched.add(key)
                    changes.removeByKeyIfExist(region.address.uuid)
                    changes.add({
                        uuid: region.address.uuid, created: false, known: sync.knownClocks(),
                        values: fieldsOf(region).map(field => [field, field.getValue()]), track: region.regions.targetAddress
                    })
                }
                const fieldKey = update.address.toString()
                if (patched.has(fieldKey)) {return}
                patched.add(fieldKey)
                const change = changes.get(region.address.uuid)
                if (update.type === "pointer") {
                    if (update.address.equals(region.regions.address)) {change.track = update.oldAddress}
                } else if (update.type === "primitive") {
                    const entry = change.values.find(([field]) => field.address.equals(update.address))
                    if (entry !== undefined) {entry[1] = update.oldValue}
                }
            })
        }
        const givesWay = (mine: AnyRegionBox, other: AnyRegionBox): boolean => changes.opt(mine.address.uuid).mapOr(change => {
            const me = sync.clientID
            if (!writers(mine).some(({client}) => client === me)) {return false}
            return writers(other).some(({client, clock}) => client !== me && client < me && clock >= (change.known.get(client) ?? 0))
        }, false)
        const resolve = (touched: ReadonlyArray<Box>): void => {
            const tracks = new Set<TrackBox>()
            touched.forEach(box => {
                if (isInstanceOf(box, TrackBox)) {tracks.add(box)}
                if (UnionBoxTypes.isRegionBox(box)) {
                    box.regions.targetVertex.ifSome(vertex => {if (isInstanceOf(vertex.box, TrackBox)) {tracks.add(vertex.box)}})
                }
            })
            const losers = new Map<string, AnyRegionBox>()
            tracks.forEach(track => {
                if (!track.isAttached()) {return}
                const regions = RegionOverlap.sortedRegions(track).filter(region => !sync.isLocal(region.address.uuid))
                regions.forEach((before, index) => regions.slice(index + 1).forEach(after => {
                    if (!overlaps(before, after)) {return}
                    if (givesWay(before, after)) {losers.set(UUID.toString(before.address.uuid), before)}
                    if (givesWay(after, before)) {losers.set(UUID.toString(after.address.uuid), after)}
                }))
            })
            if (losers.size === 0) {return}
            reverting = true
            let removed: int = 0
            graph.beginTransaction()
            losers.forEach(region => {
                const change = changes.removeByKey(region.address.uuid)
                const track = change.track.flatMap(address => graph.findVertex(address))
                if (change.created || track.isEmpty()) {
                    region.delete()
                    removed++
                    return
                }
                change.values.forEach(([field, value]) => field.setValue(value))
                region.regions.refer(track.unwrap())
            })
            graph.endTransaction()
            reverting = false
            RuntimeNotifier.notify({
                message: removed > 0
                    ? "Another participant placed a region on the same spot at the same time. Yours was removed."
                    : "Another participant used the same spot at the same time. Your region went back.",
                icon: "Info"
            })
        }
        const terminables = [
            graph.subscribeToAllUpdates({onUpdate: record}),
            graph.subscribeTransaction({onBeginTransaction: () => patched.clear(), onEndTransaction: () => patched.clear()}),
            sync.subscribeRemote(resolve)
        ]
        return Terminable.many(...terminables)
    }
}
