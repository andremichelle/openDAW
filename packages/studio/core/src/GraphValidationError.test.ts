import {describe, expect, it} from "vitest"
import {Option, tryCatch, UUID} from "@opendaw/lib-std"
import {BoxGraph, GraphValidationError} from "@opendaw/lib-box"
import {AudioRegionBox, BoxIO} from "@opendaw/studio-boxes"

// Riffle: a host must tell damaged project data from a storage failure without matching message text
describe("GraphValidationError", () => {
    it("is what a transaction leaving a mandatory pointer empty throws", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        graph.beginTransaction()
        AudioRegionBox.create(graph, UUID.generate())
        const result = tryCatch(() => graph.endTransaction())
        expect(result.status).toBe("failure")
        const error = result.status === "failure" ? result.error : null
        expect(error).toBeInstanceOf(GraphValidationError)
        expect((error as Error).name).toBe("GraphValidationError")
        expect((error as Error).message).toMatch(/requires an edge\.$/)
    })
    it("is an Error, so existing handlers keep working", () => {
        expect(new GraphValidationError("x")).toBeInstanceOf(Error)
    })
    it("is not thrown for an empty graph", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        expect(() => graph.verifyPointers()).not.toThrow()
    })
})
