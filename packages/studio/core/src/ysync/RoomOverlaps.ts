import {asDefined, isInstanceOf, Option, RuntimeNotifier, SortedSet, Terminable, tryCatch, UUID} from "@opendaw/lib-std"
import {Address, Box, BoxGraph, Update} from "@opendaw/lib-box"
import {TrackBox} from "@opendaw/studio-boxes"
import {AnyRegionBox, RegionOverlap, UnionBoxTypes} from "@opendaw/studio-adapters"
import type {YSync} from "./YSync"

// Two participants can place or move regions onto one spot at the same time, each valid on its own client.
// Overlaps are never allowed, so one of the two changes is taken back as a whole: by the client that made it,
// because only it knows what it changed. Of two concurrent changes the client with the higher id gives way.
export namespace RoomOverlaps {
    // one local transaction that touched a region, taken back as a whole like an undo
    type Change = {
        readonly updates: ReadonlyArray<Update>
        readonly regions: ReadonlyArray<UUID.Bytes>
        readonly known: Map<number, number>
    }

    const RegionNames: ReadonlySet<string> = new Set(["NoteRegionBox", "AudioRegionBox", "ValueRegionBox"])

    const regionOf = (graph: BoxGraph, update: Update): Option<UUID.Bytes> => {
        if (update.type === "new" || update.type === "delete") {
            return RegionNames.has(update.name) ? Option.wrap(update.uuid) : Option.None
        }
        return graph.findBox(update.address.uuid)
            .flatMap(box => UnionBoxTypes.isRegionBox(box) ? Option.wrap(box.address.uuid) : Option.None)
    }

    const overlaps = (before: AnyRegionBox, after: AnyRegionBox): boolean => {
        if (RegionOverlap.endsAtSuccessor(before)) {return false}
        const position = after.position.getValue()
        return before.position.getValue() + before.duration.getValue() > position + RegionOverlap.boundaryTolerance(position)
    }

    export const watch = (graph: BoxGraph, sync: YSync<unknown>): Terminable => {
        const latest: SortedSet<UUID.Bytes, {uuid: UUID.Bytes, change: Change}> = UUID.newSet(({uuid}) => uuid)
        const pending: Array<Update> = []
        const touchedRegions: SortedSet<UUID.Bytes, UUID.Bytes> = UUID.newSet(uuid => uuid)
        let known: Option<Map<number, number>> = Option.None
        let recording = false
        let reverting = false
        const writers = (region: AnyRegionBox) => [region.address, region.position.address, region.duration.address, region.regions.address]
            .flatMap(address => sync.writerOf(address).mapOr(id => [id], []))
        const begin = (): void => {
            recording = !sync.applyingRemote && !reverting
            pending.length = 0
            touchedRegions.clear()
            known = Option.None
        }
        const record = (update: Update): void => {
            if (!recording) {return}
            pending.push(update)
            regionOf(graph, update).ifSome(uuid => {
                if (known.isEmpty()) {known = Option.wrap(sync.knownClocks())}
                touchedRegions.add(uuid)
            })
        }
        const end = (rolledBack: boolean): void => {
            if (recording && !rolledBack && touchedRegions.size() > 0) {
                const change: Change = {updates: pending.slice(), regions: touchedRegions.values(), known: known.unwrap()}
                change.regions.forEach(uuid => {
                    latest.removeByKeyIfExist(uuid)
                    latest.add({uuid, change})
                })
            }
            recording = false
            pending.length = 0
            touchedRegions.clear()
        }
        const givesWay = (mine: AnyRegionBox, other: AnyRegionBox): boolean => latest.opt(mine.address.uuid).mapOr(({change}) => {
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
            const changes = new Set<Change>()
            losers.forEach(region => changes.add(latest.get(region.address.uuid).change))
            changes.forEach(change => change.regions.forEach(uuid => {
                if (latest.opt(uuid).mapOr(entry => entry.change === change, false)) {latest.removeByKey(uuid)}
            }))
            reverting = true
            graph.beginTransaction()
            const result = tryCatch(() => {
                changes.forEach(change => takeBack(change))
                graph.endTransaction()
            })
            if (result.status === "failure") {
                console.warn("[RoomOverlaps] could not take back the whole change, removing the region instead:", result.error)
                if (graph.inTransaction()) {graph.abortTransaction()}
                graph.beginTransaction()
                losers.forEach(region => {if (region.isAttached()) {region.delete()}})
                graph.endTransaction()
            }
            reverting = false
            RuntimeNotifier.notify({
                message: "Another participant used the same spot at the same time. Your change was taken back.",
                icon: "Info"
            })
        }
        const mine = (address: Address): boolean => sync.writerOf(address).mapOr(({client}) => client === sync.clientID, false)
        // like an undo, but what a peer wrote since stays, and so does a new box a peer already points at
        const takeBack = (change: Change): void => {
            const created: SortedSet<UUID.Bytes, UUID.Bytes> = UUID.newSet(uuid => uuid)
            change.updates.forEach(update => {if (update.type === "new") {created.add(update.uuid)}})
            const kept: SortedSet<UUID.Bytes, UUID.Bytes> = UUID.newSet(uuid => uuid)
            const keep: Array<Box> = []
            created.forEach(uuid => graph.findBox(uuid).ifSome(box => {
                // a pointer this client wrote is part of the change, only a peer's pointer is a dependency
                if (box.incomingEdges().some(pointer => !created.hasKey(pointer.box.address.uuid) && !mine(pointer.address))) {keep.push(box)}
            }))
            // what a kept box is connected to within the change stays with it
            while (keep.length > 0) {
                const box = asDefined(keep.pop())
                if (!kept.add(box.address.uuid)) {continue}
                box.outgoingEdges().forEach(([, target]) => graph.findBox(target.uuid).ifSome(other => {
                    if (created.hasKey(other.address.uuid)) {keep.push(other)}
                }))
                box.incomingEdges().forEach(({box: other}) => {if (created.hasKey(other.address.uuid)) {keep.push(other)}})
            }
            change.updates.toReversed().forEach(update => {
                if (update.type === "new") {
                    if (kept.hasKey(update.uuid)) {return}
                    graph.findBox(update.uuid).ifSome(box => {if (mine(box.address)) {update.inverse(graph)}})
                } else if (update.type === "delete") {
                    if (graph.findBox(update.uuid).isEmpty()) {update.inverse(graph)}
                } else if (!kept.hasKey(update.address.uuid) && graph.findVertex(update.address).nonEmpty() && mine(update.address)) {
                    update.inverse(graph)
                }
            })
        }
        const terminables = [
            graph.subscribeToAllUpdates({onUpdate: record}),
            graph.subscribeTransaction({onBeginTransaction: begin, onEndTransaction: end}),
            sync.subscribeRemote(resolve)
        ]
        return Terminable.many(...terminables)
    }
}
