import {BoxGraph} from "@opendaw/lib-box"
import {isDefined} from "@opendaw/lib-std"
import {BoxIO, BoxVisitor, ValueEventBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"

export const migrateValueEventCollection = (boxGraph: BoxGraph<BoxIO.TypeMap>, collectionBox: ValueEventCollectionBox): void => {
    const events = collectionBox.events.pointerHub.incoming()
        .map(pointer => pointer.box.accept<BoxVisitor<ValueEventBox>>({
            visitValueEventBox: (eventBox) => eventBox
        }))
        .filter(isDefined)
        .sort((a, b) => {
            const positionDiff = a.position.getValue() - b.position.getValue()
            return positionDiff !== 0 ? positionDiff : a.index.getValue() - b.index.getValue()
        })
    if (events.length === 0) {return}
    const toDelete: Array<ValueEventBox> = []
    const toFix: Array<{event: ValueEventBox, index: number}> = []
    let first: ValueEventBox = events[0]
    let last: ValueEventBox = events[0]
    let count = 1
    const flush = () => {
        if (count === 1) {
            if (first.index.getValue() !== 0) {toFix.push({event: first, index: 0})}
        } else {
            if (first.index.getValue() !== 0) {toFix.push({event: first, index: 0})}
            if (last.index.getValue() !== 1) {toFix.push({event: last, index: 1})}
        }
    }
    for (let i = 1; i < events.length; i++) {
        const event = events[i]
        if (event.position.getValue() === first.position.getValue()) {
            if (count >= 2) {toDelete.push(last)}
            last = event
            count++
        } else {
            flush()
            first = event
            last = event
            count = 1
        }
    }
    flush()
    if (toDelete.length > 0 || toFix.length > 0) {
        console.debug(`Migrate ValueEventCollection: deleting ${toDelete.length}, fixing ${toFix.length}`)
        boxGraph.beginTransaction()
        toFix.forEach(({event, index}) => event.index.setValue(index))
        toDelete.forEach(event => event.delete())
        boxGraph.endTransaction()
    }
}
