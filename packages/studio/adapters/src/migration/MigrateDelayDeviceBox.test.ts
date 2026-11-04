import {describe, expect, it} from "vitest"
import {BoxGraph, Field} from "@opendaw/lib-box"
import {UUID} from "@opendaw/lib-std"
import {Pointers} from "@opendaw/studio-enums"
import {BoxIO, DelayDeviceBox, TrackBox, ValueEventBox, ValueEventCollectionBox, ValueRegionBox} from "@opendaw/studio-boxes"
import {migrateDelayDeviceBox} from "./MigrateDelayDeviceBox"

// Old descending rate list (17 entries) mapped onto the new ascending one (21 entries, 0 = off).
const OLD_TO_NEW = [20, 19, 16, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]

const createDelay = (boxGraph: BoxGraph<BoxIO.TypeMap>, musical: number): DelayDeviceBox => {
    boxGraph.beginTransaction()
    const box = DelayDeviceBox.create(boxGraph, UUID.generate(), box => {
        box.delayMusical.setValue(musical)
        box.version.setValue(0)
    })
    boxGraph.endTransaction()
    return box
}

const automate = (boxGraph: BoxGraph<BoxIO.TypeMap>, target: Field<Pointers.Automation>, values: ReadonlyArray<number>) => {
    boxGraph.beginTransaction()
    const track = TrackBox.create(boxGraph, UUID.generate(), box => box.target.refer(target))
    const collection = ValueEventCollectionBox.create(boxGraph, UUID.generate())
    ValueRegionBox.create(boxGraph, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(collection.owners)
        box.duration.setValue(3840)
    })
    values.forEach((value, index) => ValueEventBox.create(boxGraph, UUID.generate(), box => {
        box.events.refer(collection.events)
        box.position.setValue(index * 960)
        box.value.setValue(value)
    }))
    boxGraph.endTransaction()
    return collection
}

const eventValues = (collection: ValueEventCollectionBox): Array<number> => collection.events.pointerHub.incoming()
    .map(pointer => pointer.box as ValueEventBox)
    .sort((left, right) => left.position.getValue() - right.position.getValue())
    .map(event => event.value.getValue())

describe("migrateDelayDeviceBox", () => {
    it("maps the static delay index and bumps the version", () => {
        const boxGraph = new BoxGraph<BoxIO.TypeMap>()
        const delay = createDelay(boxGraph, 9)
        migrateDelayDeviceBox(boxGraph, delay)
        expect(delay.delayMusical.getValue()).toBe(OLD_TO_NEW[9])
        expect(delay.version.getValue()).toBe(1)
    })
    it("rewrites the automation of delay-musical (old unit -> old index -> new unit)", () => {
        const boxGraph = new BoxGraph<BoxIO.TypeMap>()
        const delay = createDelay(boxGraph, 9)
        const oldUnits = [0, 3 / 16, 9 / 16, 1]
        const collection = automate(boxGraph, delay.delayMusical, oldUnits)
        migrateDelayDeviceBox(boxGraph, delay)
        const expected = oldUnits.map(unit => OLD_TO_NEW[Math.round(unit * 16)] / 20)
        eventValues(collection).forEach((value, index) => expect(value).toBeCloseTo(expected[index], 6))
    })
    it("leaves a version 1 box and its automation alone", () => {
        const boxGraph = new BoxGraph<BoxIO.TypeMap>()
        const delay = createDelay(boxGraph, 9)
        boxGraph.beginTransaction()
        delay.version.setValue(1)
        boxGraph.endTransaction()
        const collection = automate(boxGraph, delay.delayMusical, [0.25])
        migrateDelayDeviceBox(boxGraph, delay)
        expect(delay.delayMusical.getValue()).toBe(9)
        expect(eventValues(collection)[0]).toBeCloseTo(0.25, 6)
    })
})
