import {Arrays, asDefined, assert} from "@opendaw/lib-std"

export type Edge<V> = [V, V]

export class Graph<V> {
    readonly #vertices: Array<V>
    readonly #predecessors: Map<V, Array<V>>

    constructor() {
        this.#vertices = []
        this.#predecessors = new Map<V, Array<V>>()
    }

    addVertex(vertex: V): void {
        assert(!this.#vertices.includes(vertex), "Vertex already exists")
        this.#vertices.push(vertex)
        assert(!this.#predecessors.has(vertex), "Predecessor already exists")
        this.#predecessors.set(vertex, [])
    }

    removeVertex(vertex: V): void {
        Arrays.remove(this.#vertices, vertex)
        const found = this.#predecessors.delete(vertex)
        assert(found, "Predecessor does not exists")
    }

    getPredecessors(vertex: V): ReadonlyArray<V> {return this.#predecessors.get(vertex) ?? Arrays.empty()}
    predecessors(): Map<V, V[]> {return this.#predecessors}
    vertices(): ReadonlyArray<V> {return this.#vertices}

    addEdge([source, target]: Edge<V>): void {
        const vertexPredecessors = asDefined(this.#predecessors.get(target),
            `[add] Edge has unannounced vertex. (${target})`)
        vertexPredecessors.push(source)
    }

    removeEdge([source, target]: Edge<V>): void {
        const vertexPredecessors = asDefined(this.#predecessors.get(target),
            `[remove] Edge has unannounced vertex. (${target})`)
        assert(vertexPredecessors.includes(source), `${source} is not marked.`)
        Arrays.remove(vertexPredecessors, source)
    }

    isEmpty(): boolean {return this.#vertices.length === 0}
}

export class TopologicalSort<V> {
    readonly #graph: Graph<V>
    readonly #sorted: Array<V>
    readonly #visited: Set<V>
    readonly #withLoops: Set<V>
    readonly #successors: Map<V, Set<V>>

    constructor(graph: Graph<V>) {
        this.#graph = graph

        this.#sorted = []
        this.#visited = new Set<V>()
        this.#withLoops = new Set<V>()
        this.#successors = new Map<V, Set<V>>()
    }

    update(): void {
        this.#prepare()
        this.#graph.vertices().forEach(vertex => this.#visit(vertex))
    }

    sorted(): ReadonlyArray<V> {return this.#sorted}
    hasLoops(): boolean {return this.#withLoops.size !== 0}

    #prepare(): void {
        this.#clear()
        const addTo = new Map<V, Set<V>>()
        for (const vert of this.#graph.vertices()) {
            this.#successors.set(vert, new Set<V>())
            addTo.set(vert, new Set<V>())
        }
        for (const vert2 of this.#graph.vertices()) {
            for (const vert1 of this.#graph.getPredecessors(vert2)) {
                asDefined(this.#successors.get(vert1), `Could not find Successor for ${vert1}`).add(vert2)
            }
        }
        let change: boolean
        do {
            change = false
            for (const vert of this.#graph.vertices()) {
                asDefined(addTo.get(vert)).clear()
                for (const vert1 of asDefined(this.#successors.get(vert))) {
                    for (const vert2 of asDefined(this.#successors.get(vert1))) {
                        if (!this.#successors.get(vert)?.has(vert2)) {
                            change = true
                            asDefined(addTo.get(vert)).add(vert2)
                        }
                    }
                }
            }
            for (const vert of this.#graph.vertices()) {
                const vs = asDefined(this.#successors.get(vert))
                asDefined(addTo.get(vert)).forEach(n1 => vs.add(n1))
            }
        }
        while (change)
    }

    #visit(vert: V): void {
        if (this.#visited.has(vert)) {return}
        this.#visited.add(vert)
        for (const n1 of this.#graph.getPredecessors(vert)) {
            if (asDefined(this.#successors.get(vert)).has(n1)) {
                this.#withLoops.add(vert)
                this.#withLoops.add(n1)
                continue
            }
            this.#visit(n1)
        }
        this.#sorted.push(vert)
    }

    #clear(): void {
        Arrays.clear(this.#sorted)
        this.#visited.clear()
        this.#withLoops.clear()
        this.#successors.clear()
    }
}