import {panic, Terminable, UUID} from "@opendaw/lib-std"
import {BoxGraph, NewUpdate, PointerUpdate, PrimitiveUpdate, Vertex} from "@opendaw/lib-box"
import {BoxIO, WarpMarkerBox} from "@opendaw/studio-boxes"

// Two warp markers on one play-mode at the same position break its sorted collection, but only on the next sort,
// far from the edit that made them. This fails at the end of that edit instead, so its stack names the cause.
export namespace WarpMarkerGuard {
    export const install = (boxGraph: BoxGraph<BoxIO.TypeMap>): Terminable => {
        const touched = UUID.newSet<UUID.Bytes>(uuid => uuid)
        const updates = boxGraph.subscribeToAllUpdatesImmediate({
            onUpdate: update => {
                if (update instanceof NewUpdate) {
                    if (update.name === WarpMarkerBox.ClassName) {touched.add(update.uuid)}
                } else if (update instanceof PrimitiveUpdate || update instanceof PointerUpdate) {
                    touched.add(update.address.uuid)
                }
            }
        })
        const transactions = boxGraph.subscribeTransaction({
            onBeginTransaction: () => {},
            onEndTransaction: (rolledBack: boolean) => {
                if (touched.isEmpty()) {return}
                const uuids = touched.values().slice()
                touched.clear()
                if (rolledBack) {return}
                const owners = new Map<string, Vertex>()
                uuids.forEach(uuid => boxGraph.findBox(uuid).ifSome(box => {
                    if (!(box instanceof WarpMarkerBox)) {return}
                    box.owner.targetVertex.ifSome(owner => owners.set(owner.address.toString(), owner))
                }))
                owners.forEach(owner => {
                    const positions = new Set<number>()
                    owner.pointerHub.incoming().forEach(({box}) => {
                        if (!(box instanceof WarpMarkerBox)) {return}
                        const position = box.position.getValue()
                        if (positions.has(position)) {
                            panic(`Warp markers at the same position ${position} on ${owner.address.toString()}`)
                        }
                        positions.add(position)
                    })
                })
            }
        })
        return Terminable.many(updates, transactions)
    }
}
