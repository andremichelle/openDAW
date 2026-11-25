import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {UnitOrder} from "./UnitOrder"

const unit = (index: number, uuid: UUID.Bytes = UUID.generate()) => ({uuid, indexField: {getValue: () => index}})

// In a live room two units can share an index until the room settles it, both must keep their own row.
describe("UnitOrder", () => {
    it("gives every unit its own row in index order", () => {
        const [first, second, third] = [unit(0), unit(1), unit(2)]
        expect(UnitOrder.rows([third, first, second])).toEqual([first, second, third])
    })

    it("gives two units on one index two rows", () => {
        const [low, high] = [UUID.parse("00000000-0000-4000-8000-000000000000"), UUID.parse("ffffffff-ffff-4fff-bfff-ffffffffffff")]
        const [before, shared, sharedToo, after] = [unit(0), unit(1, high), unit(1, low), unit(2)]
        expect(UnitOrder.rows([after, shared, before, sharedToo])).toEqual([before, sharedToo, shared, after])
    })

    it("orders the tie the same on every client", () => {
        const units = [unit(3), unit(3), unit(3)]
        expect(UnitOrder.rows(units)).toEqual(UnitOrder.rows(units.toReversed()))
    })
})
