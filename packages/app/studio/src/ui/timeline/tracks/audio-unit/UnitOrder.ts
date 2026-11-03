import {int, UUID} from "@opendaw/lib-std"
import {IndexComparator} from "@opendaw/studio-adapters"

type Unit = {readonly uuid: UUID.Bytes, readonly indexField: {getValue(): int}}

export namespace UnitOrder {
    // a live room can hold two units on one index for a while, the uuid keeps them apart in the same order everywhere
    export const compare = (a: Unit, b: Unit): int =>
        IndexComparator(a.indexField.getValue(), b.indexField.getValue()) || UUID.Comparator(a.uuid, b.uuid)

    export const rows = <U extends Unit>(units: ReadonlyArray<U>): ReadonlyArray<U> => units.toSorted(compare)
}
