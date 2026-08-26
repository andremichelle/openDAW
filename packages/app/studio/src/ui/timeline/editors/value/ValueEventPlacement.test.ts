import {describe, expect, it} from "vitest"
import {ValueEventPlacement} from "./ValueEventPlacement"

describe("ValueEventPlacement.resolve (#275 automation-node placement)", () => {
    it("an empty time creates a lone node, regardless of side", () => {
        expect(ValueEventPlacement.resolve(false, false, "incoming")).toBe("create")
        expect(ValueEventPlacement.resolve(false, false, "outgoing")).toBe("create")
    })
    it("a lone node: click right adds the outgoing, click left adds the incoming (old value -> outgoing)", () => {
        expect(ValueEventPlacement.resolve(true, false, "outgoing")).toBe("add-outgoing")
        expect(ValueEventPlacement.resolve(true, false, "incoming")).toBe("add-incoming")
    })
    it("a full pair overwrites the member on the cursor's side", () => {
        expect(ValueEventPlacement.resolve(true, true, "incoming")).toBe("overwrite-incoming")
        expect(ValueEventPlacement.resolve(true, true, "outgoing")).toBe("overwrite-outgoing")
    })
    it("defensive: a lone outgoing (index 1 without index 0) is just moved", () => {
        expect(ValueEventPlacement.resolve(false, true, "incoming")).toBe("overwrite-outgoing")
        expect(ValueEventPlacement.resolve(false, true, "outgoing")).toBe("overwrite-outgoing")
    })
})
