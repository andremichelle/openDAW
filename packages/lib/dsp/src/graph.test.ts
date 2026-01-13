import {describe, expect, it} from "vitest"
import {int} from "@moises-ai/lib-std"
import {Graph, TopologicalSort} from "./graph"

describe("graph", () => {
    it("topology", () => {
        const graph = new Graph<int>()
        const sort = new TopologicalSort<int>(graph)
        graph.addVertex(0)
        graph.addVertex(1)
        graph.addVertex(2)
        sort.update()
        expect(sort.sorted()).toStrictEqual([0, 1, 2])
        graph.addEdge([0, 1])
        graph.addEdge([1, 2])
        sort.update()
        expect(sort.sorted()).toStrictEqual([0, 1, 2])
        graph.removeEdge([0, 1])
        graph.removeEdge([1, 2])
        sort.update()
        expect(sort.sorted()).toStrictEqual([0, 1, 2])
        graph.addEdge([2, 1])
        graph.addEdge([1, 0])
        sort.update()
        expect(sort.sorted()).toStrictEqual([2, 1, 0])
    })
})