import {describe, expect, it} from "vitest"
import {Address, BoxGraph} from "@opendaw/lib-box"
import {Option, UUID} from "@opendaw/lib-std"
import {BoxIO, SelectionBox} from "@opendaw/studio-boxes"
import {migrateSelectionBox} from "./MigrateSelectionBox"

// The pass detects an unresolvable selectable/selection gracefully, then removes the box through
// Box.delete — which used to panic on that very pointer while walking the box's outgoing edges, so the
// cleanup could never run. Regression for that self-defeating repair.
describe("migrateSelectionBox", () => {
    const create = (boxGraph: BoxGraph<BoxIO.TypeMap>, target: Option<Address>): SelectionBox => {
        boxGraph.beginTransaction()
        const box = SelectionBox.create(boxGraph, UUID.generate())
        box.selectable.targetAddress = target
        box.selection.targetAddress = target
        boxGraph.endTransaction()
        return box
    }

    it("removes a SelectionBox whose pointers dangle, without throwing", () => {
        const boxGraph = new BoxGraph<BoxIO.TypeMap>()
        const box = create(boxGraph, Option.wrap(Address.compose(UUID.generate())))

        expect(() => migrateSelectionBox(boxGraph, box)).not.toThrow()
        expect(boxGraph.findBox(box.address.uuid).isEmpty()).toBe(true)
    })

    it("removes a SelectionBox whose pointers were never set", () => {
        const boxGraph = new BoxGraph<BoxIO.TypeMap>()
        const box = create(boxGraph, Option.None)

        expect(() => migrateSelectionBox(boxGraph, box)).not.toThrow()
        expect(boxGraph.findBox(box.address.uuid).isEmpty()).toBe(true)
    })
})
