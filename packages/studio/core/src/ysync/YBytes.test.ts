import {describe, expect, it, vi} from "vitest"
import * as Y from "yjs"
import {Maybe, Option, panic, Procedure, safeExecute, UUID} from "@opendaw/lib-std"
import {
    Box,
    BoxConstruct,
    BoxEditing,
    BoxGraph,
    ByteArrayField,
    Int32Field,
    NoPointers,
    UnreferenceableType,
    VertexVisitor
} from "@opendaw/lib-box"
import {YSync} from "./YSync"
import {YBytes} from "./YBytes"

// A box with a bytes field at key 14 and an int field at key 3: a chunk keyed "3" inside the bytes field must never
// be taken for the int field.
type BlobFields = { 3: Int32Field, 14: ByteArrayField }

interface BlobVisitor<RETURN = void> extends VertexVisitor<RETURN> {
    visitBlobBox?(box: BlobBox): RETURN
}

class BlobBox extends Box<UnreferenceableType, BlobFields> {
    static create(graph: BoxGraph, uuid: UUID.Bytes, constructor?: Procedure<BlobBox>): BlobBox {
        return graph.stageBox(new BlobBox({uuid, graph, name: "BlobBox", pointerRules: NoPointers}), constructor)
    }
    private constructor(construct: BoxConstruct<UnreferenceableType>) {super(construct)}
    protected initializeFields(): BlobFields {
        return {
            3: Int32Field.create({parent: this, fieldKey: 3, fieldName: "count", deprecated: false, pointerRules: NoPointers}, "any", "none"),
            14: ByteArrayField.create({parent: this, fieldKey: 14, fieldName: "data", deprecated: false, pointerRules: NoPointers})
        }
    }
    accept<R>(visitor: BlobVisitor<R>): Maybe<R> {return safeExecute(visitor.visitBlobBox, this)}
    get tags(): Readonly<Record<string, string | number | boolean>> {return {}}
    get count(): Int32Field {return this.getField(3)}
    get data(): ByteArrayField {return this.getField(14)}
}

const factory = (name: string, graph: BoxGraph, uuid: UUID.Bytes, constructor: Procedure<Box>): Box =>
    name === "BlobBox" ? BlobBox.create(graph, uuid, constructor as Procedure<BlobBox>) : panic(`Unknown box: ${name}`)

const CHUNK = YBytes.CHUNK
const MB = 1 << 20

const pattern = (length: number, seed: number = 0): Int8Array => Int8Array.from({length}, (_, index) => (index * 7 + seed) & 0x7f)

const same = (a: Readonly<Int8Array>, b: Readonly<Int8Array>): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index])

const changed = (value: Readonly<Int8Array>, at: number, byte: number): Int8Array => {
    const copy = value.slice()
    copy[at] = byte
    return copy
}

const mulberry32 = (seed: number): (() => number) => () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// --- unit: the stored form without YSync ----------------------------------

describe("YBytes stored form", () => {
    const roomWith = (stored: unknown): Y.Map<unknown> => {
        const doc = new Y.Doc()
        const parent = doc.getMap("field")
        parent.set("value", stored)
        return parent
    }

    it("keeps values up to one chunk plain and larger ones chunked, every size reads back byte exact", () => {
        const generator = new YBytes.Generator(1)
        for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK, 3 * CHUNK + 5, MB]) {
            const value = pattern(size, size)
            const parent = roomWith(YBytes.create(value, generator.next()))
            const stored = parent.get("value")
            expect(YBytes.isChunked(stored)).toBe(size > CHUNK)
            const read = YBytes.read(stored)
            expect(read.type).toBe("whole")
            expect(same(YBytes.valueOf(read) ?? new Int8Array(1), value)).toBe(true)
        }
    })

    it("writes only the chunks that differ", () => {
        const generator = new YBytes.Generator(1)
        const value = pattern(10 * CHUNK)
        const parent = roomWith(YBytes.create(value, generator.next()))
        expect(YBytes.write(parent, "value", value, generator.next())).toBe(0)
        const oneChunk = changed(value, 5 * CHUNK + 3, 99)
        expect(YBytes.write(parent, "value", oneChunk, generator.next())).toBe(1)
        const twoChunks = changed(changed(oneChunk, 0, 1), 9 * CHUNK, 1)
        expect(YBytes.write(parent, "value", twoChunks, generator.next())).toBe(2)
        expect(same(YBytes.valueOf(YBytes.read(parent.get("value"))) ?? new Int8Array(0), twoChunks)).toBe(true)
    })

    it("grows and shrinks by chunks and drops the chunks past the end", () => {
        const generator = new YBytes.Generator(1)
        const value = pattern(4 * CHUNK)
        const parent = roomWith(YBytes.create(value, generator.next()))
        const grown = new Int8Array(6 * CHUNK + 10)
        grown.set(value)
        expect(YBytes.write(parent, "value", grown, generator.next())).toBe(3)
        const shrunk = grown.slice(0, 2 * CHUNK + 1)
        YBytes.write(parent, "value", shrunk, generator.next())
        const stored = parent.get("value") as Y.Map<unknown>
        expect(Array.from(stored.keys()).filter(key => key !== "meta").sort()).toStrictEqual(["0", "1", "2"])
        expect(same(YBytes.valueOf(YBytes.read(stored)) ?? new Int8Array(0), shrunk)).toBe(true)
    })

    it("switches between the plain and the chunked form when the size crosses one chunk", () => {
        const generator = new YBytes.Generator(1)
        const parent = roomWith(YBytes.create(pattern(10), generator.next()))
        YBytes.write(parent, "value", pattern(3 * CHUNK), generator.next())
        expect(YBytes.isChunked(parent.get("value"))).toBe(true)
        YBytes.write(parent, "value", pattern(20), generator.next())
        expect(parent.get("value")).toBeInstanceOf(Uint8Array)
        expect(same(YBytes.valueOf(YBytes.read(parent.get("value"))) ?? new Int8Array(0), pattern(20))).toBe(true)
    })

    it("reads a missing chunk, a chunk of a foreign write, a cut chunk and a broken meta as torn", () => {
        const generator = new YBytes.Generator(7)
        const build = () => roomWith(YBytes.create(pattern(3 * CHUNK), generator.next())).get("value") as Y.Map<unknown>
        const missing = build()
        missing.delete("1")
        expect(YBytes.read(missing)).toStrictEqual({type: "torn", owner: 7})
        const foreign = build()
        foreign.set("1", YBytes.read(roomWith(YBytes.create(pattern(3 * CHUNK), {client: 9, counter: 1}))).type === "whole"
            ? (roomWith(YBytes.create(pattern(3 * CHUNK), {client: 9, counter: 1})).get("value") as Y.Map<unknown>).get("1")
            : undefined)
        expect(YBytes.read(foreign).type).toBe("torn")
        const cut = build()
        cut.set("2", (cut.get("2") as Uint8Array).slice(0, 100))
        expect(YBytes.read(cut).type).toBe("torn")
        const broken = build()
        broken.set("meta", new Uint8Array(3))
        expect(YBytes.read(broken)).toStrictEqual({type: "torn", owner: -1})
        expect(YBytes.read(undefined)).toStrictEqual({type: "torn", owner: -1})
        expect(YBytes.read("text")).toStrictEqual({type: "torn", owner: -1})
    })

    it("repairs a torn field from the owner's value", () => {
        const generator = new YBytes.Generator(5)
        const value = pattern(4 * CHUNK)
        const parent = roomWith(YBytes.create(value, generator.next()))
        const stored = parent.get("value") as Y.Map<unknown>
        stored.delete("2")
        stored.set("3", new Uint8Array(20))
        expect(YBytes.ownsRepair(YBytes.read(stored), 5)).toBe(true)
        expect(YBytes.ownsRepair(YBytes.read(stored), 6)).toBe(false)
        expect(YBytes.repair(stored, value)).toBe(2)
        expect(same(YBytes.valueOf(YBytes.read(stored)) ?? new Int8Array(0), value)).toBe(true)
        expect(YBytes.repair(stored, value)).toBe(0)
    })

    it("does not repair from a value of another size", () => {
        const generator = new YBytes.Generator(5)
        const parent = roomWith(YBytes.create(pattern(4 * CHUNK), generator.next()))
        const stored = parent.get("value") as Y.Map<unknown>
        stored.delete("1")
        expect(YBytes.repair(stored, pattern(2 * CHUNK))).toBe(0)
        expect(YBytes.read(stored).type).toBe("torn")
    })
})

// --- collaboration through YSync ------------------------------------------

interface Peer {
    name: string
    doc: Y.Doc
    graph: BoxGraph
    sync: YSync<any>
    seen: Array<Int8Array>
}

const edit = (peer: Peer, procedure: (graph: BoxGraph) => void): void => {
    peer.graph.beginTransaction()
    try {procedure(peer.graph)} finally {peer.graph.endTransaction()}
}

const deliver = (from: Peer, to: Peer): number => {
    const delta = Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc))
    Y.applyUpdate(to.doc, delta, from)
    return delta.length
}

const converge = (...peers: ReadonlyArray<Peer>): void => {
    for (let round = 0; round < 30; round++) {
        for (const from of peers) {for (const to of peers) {if (from !== to) {deliver(from, to)}}}
        const vectors = peers.map(peer => Array.from(Y.encodeStateVector(peer.doc)).join(","))
        if (vectors.every(vector => vector === vectors[0])) {return}
    }
    panic("did not converge")
}

const makePeer = async (name: string, client: number): Promise<Peer> => {
    const doc = new Y.Doc()
    doc.clientID = client
    const graph = new BoxGraph<any>(Option.wrap(factory as any))
    const sync = await YSync.populateRoom<any>({boxGraph: graph, boxes: doc.getMap("boxes")})
    return {name, doc, graph, sync, seen: []}
}

const joinPeer = async (name: string, client: number, from: Peer): Promise<Peer> => {
    const doc = new Y.Doc()
    doc.clientID = client
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(from.doc), from)
    const graph = new BoxGraph<any>(Option.wrap(factory as any))
    const sync = await YSync.joinRoom<any>({boxGraph: graph, boxes: doc.getMap("boxes")})
    return {name, doc, graph, sync, seen: []}
}

const blobOf = (peer: Peer, id: UUID.Bytes): BlobBox => peer.graph.findBox<BlobBox>(id).unwrap()

// every value the peer's graph ever held in the field, to prove no mixed value was ever delivered
const watch = (peer: Peer, id: UUID.Bytes): void => {
    blobOf(peer, id).data.subscribe(owner => peer.seen.push(owner.getValue() as Int8Array))
}

const setup = async (initial: Int8Array, count: number = 2) => {
    const first = await makePeer("A", 1)
    const id = UUID.generate()
    edit(first, graph => {BlobBox.create(graph, id, box => box.data.setValue(initial))})
    const peers: Array<Peer> = [first]
    for (let index = 1; index < count; index++) {
        const peer = await makePeer(String.fromCharCode(65 + index), index + 1)
        peers.push(peer)
    }
    converge(...peers)
    peers.forEach(peer => watch(peer, id))
    return {peers, id}
}

describe("YBytes through YSync", () => {
    it("a one byte edit of a megabyte sends about one chunk", async () => {
        const {peers: [A, B], id} = await setup(pattern(MB))
        edit(A, () => blobOf(A, id).data.setValue(changed(blobOf(A, id).data.getValue(), 600_000, 1)))
        const sent = deliver(A, B)
        expect(sent).toBeLessThan(CHUNK + 2048)
        expect(same(blobOf(B, id).data.getValue(), blobOf(A, id).data.getValue())).toBe(true)
    })

    it("a range edit with setBytes sends about one chunk too", async () => {
        const {peers: [A, B], id} = await setup(pattern(MB))
        edit(A, () => blobOf(A, id).data.setBytes(100, new Int8Array([5, 5, 5])))
        expect(deliver(A, B)).toBeLessThan(CHUNK + 2048)
        expect(same(blobOf(B, id).data.getValue(), blobOf(A, id).data.getValue())).toBe(true)
    })

    it("a late joiner reads the whole current value", async () => {
        const {peers: [A], id} = await setup(pattern(MB))
        edit(A, () => blobOf(A, id).data.setByte(5, 9))
        edit(A, () => blobOf(A, id).data.setLength(MB + 100))
        const late = await joinPeer("L", 9, A)
        expect(same(blobOf(late, id).data.getValue(), blobOf(A, id).data.getValue())).toBe(true)
    })

    it("the room keeps the current chunks, not every edit", async () => {
        const {peers: [A], id} = await setup(pattern(MB))
        for (let round = 0; round < 20; round++) {
            edit(A, () => blobOf(A, id).data.setByte((round * 50_021) % MB, round))
        }
        expect(Y.encodeStateAsUpdate(A.doc).length).toBeLessThan(MB + 64 * 1024)
    })

    it("an old room holding a large field as plain bytes is read, and the first write chunks it", async () => {
        const A = await makePeer("A", 1)
        const id = UUID.generate()
        edit(A, graph => {BlobBox.create(graph, id, box => box.data.setValue(pattern(10)))})
        // the room as an older client left it: the whole megabyte as one Uint8Array
        const fields = (A.doc.getMap("boxes").get(UUID.toString(id)) as Y.Map<unknown>).get("fields") as Y.Map<unknown>
        A.doc.transact(() => fields.set("14", new Uint8Array(pattern(MB).buffer)), "[history] old client")
        const B = await joinPeer("B", 2, A)
        expect(same(blobOf(B, id).data.getValue(), pattern(MB))).toBe(true)
        edit(B, () => blobOf(B, id).data.setByte(7, 1))
        expect(YBytes.isChunked(fields.get("14"))).toBe(false)
        deliver(B, A)
        expect(YBytes.isChunked(fields.get("14"))).toBe(true)
        expect(same(blobOf(A, id).data.getValue(), blobOf(B, id).data.getValue())).toBe(true)
    })

    it("a chunk keyed like a sibling field never touches that field", async () => {
        const {peers: [A, B], id} = await setup(pattern(MB))
        edit(A, () => blobOf(A, id).count.setValue(42))
        converge(A, B)
        edit(A, () => blobOf(A, id).data.setByte(3 * CHUNK + 1, 9))
        converge(A, B)
        expect(blobOf(B, id).count.getValue()).toBe(42)
        expect(blobOf(B, id).data.getValue()[3 * CHUNK + 1]).toBe(9)
    })

    it("a box with a large field created on one peer arrives whole, and its deletion too", async () => {
        const A = await makePeer("A", 1)
        const B = await makePeer("B", 2)
        const id = UUID.generate()
        edit(A, graph => {BlobBox.create(graph, id, box => box.data.setValue(pattern(3 * CHUNK + 3)))})
        converge(A, B)
        expect(same(blobOf(B, id).data.getValue(), pattern(3 * CHUNK + 3))).toBe(true)
        edit(B, graph => graph.findBox(id).unwrap().delete())
        converge(A, B)
        expect(A.graph.findBox(id).isEmpty()).toBe(true)
    })

    it("an undo travels as a range as well", async () => {
        const {peers: [A, B], id} = await setup(pattern(MB))
        const editing = new BoxEditing(A.graph)
        editing.modify(() => blobOf(A, id).data.setByte(1000, 3))
        converge(A, B)
        editing.undo()
        expect(deliver(A, B)).toBeLessThan(CHUNK + 2048)
        expect(same(blobOf(B, id).data.getValue(), pattern(MB))).toBe(true)
    })

    it("two peers editing different chunks at once end with one whole value, never a mix", async () => {
        const original = pattern(8 * CHUNK)
        const {peers: [A, B], id} = await setup(original)
        const valueA = changed(original, 10, 1)
        const valueB = changed(original, 6 * CHUNK, 2)
        const repair = vi.spyOn(YBytes, "repair")
        edit(A, () => blobOf(A, id).data.setValue(valueA))
        edit(B, () => blobOf(B, id).data.setValue(valueB))
        converge(A, B)
        expect(repair).toHaveBeenCalledTimes(1)
        expect(repair.mock.results[0].value).toBeGreaterThan(0)
        repair.mockRestore()
        const finalA = blobOf(A, id).data.getValue()
        expect(same(finalA, blobOf(B, id).data.getValue())).toBe(true)
        expect(same(finalA, valueA) || same(finalA, valueB)).toBe(true)
        for (const peer of [A, B]) {
            expect(peer.seen.every(value => same(value, original) || same(value, valueA) || same(value, valueB))).toBe(true)
        }
    })

    it("two peers editing the same chunk at once end with one of them", async () => {
        const original = pattern(4 * CHUNK)
        const {peers: [A, B], id} = await setup(original)
        const valueA = changed(original, 2 * CHUNK + 1, 1)
        const valueB = changed(original, 2 * CHUNK + 2, 2)
        edit(A, () => blobOf(A, id).data.setValue(valueA))
        edit(B, () => blobOf(B, id).data.setValue(valueB))
        converge(A, B)
        const final = blobOf(A, id).data.getValue()
        expect(same(final, blobOf(B, id).data.getValue())).toBe(true)
        expect(same(final, valueA) || same(final, valueB)).toBe(true)
    })

    it("one peer growing while another edits a chunk ends with one whole value", async () => {
        const original = pattern(4 * CHUNK)
        const {peers: [A, B], id} = await setup(original)
        const grown = new Int8Array(7 * CHUNK)
        grown.set(original)
        grown.fill(3, 5 * CHUNK)
        const valueB = changed(original, CHUNK, 4)
        edit(A, () => blobOf(A, id).data.setValue(grown))
        edit(B, () => blobOf(B, id).data.setValue(valueB))
        converge(A, B)
        const final = blobOf(A, id).data.getValue()
        expect(same(final, blobOf(B, id).data.getValue())).toBe(true)
        expect(same(final, grown) || same(final, valueB)).toBe(true)
    })

    it("three peers editing different chunks at once end with one whole value, never a mix", async () => {
        const original = pattern(9 * CHUNK)
        const {peers, id} = await setup(original, 3)
        const values = peers.map((_, index) => changed(original, index * 3 * CHUNK + 5, index + 1))
        peers.forEach((peer, index) => edit(peer, () => blobOf(peer, id).data.setValue(values[index])))
        converge(...peers)
        const final = blobOf(peers[0], id).data.getValue()
        peers.forEach(peer => expect(same(blobOf(peer, id).data.getValue(), final)).toBe(true))
        expect(values.some(value => same(value, final))).toBe(true)
        for (const peer of peers) {
            expect(peer.seen.every(value => same(value, original) || values.some(candidate => same(value, candidate)))).toBe(true)
        }
    })

    it("a peer that sees a torn field while its owner is away keeps its value, the next write heals it", async () => {
        const original = pattern(6 * CHUNK)
        const {peers: [A, B, C], id} = await setup(original, 3)
        edit(A, () => blobOf(A, id).data.setValue(changed(original, 1, 1)))
        edit(B, () => blobOf(B, id).data.setValue(changed(original, 5 * CHUNK, 2)))
        // only C hears both, A and B never hear each other, so nobody who owns the winning write repairs
        deliver(A, C)
        deliver(B, C)
        expect(same(blobOf(C, id).data.getValue(), original) || C.seen.length > 0).toBe(true)
        expect(C.seen.every(value => same(value, original) || same(value, changed(original, 1, 1))
            || same(value, changed(original, 5 * CHUNK, 2)))).toBe(true)
        const healed = pattern(6 * CHUNK, 3)
        edit(C, () => blobOf(C, id).data.setValue(healed))
        converge(A, B, C)
        for (const peer of [A, B, C]) {expect(same(blobOf(peer, id).data.getValue(), healed)).toBe(true)}
    })

    it("two peers editing at random, delivering in random order, always agree on one whole value", async () => {
        const next = mulberry32(2026)
        const original = pattern(5 * CHUNK)
        const {peers: [A, B], id} = await setup(original)
        const written: Array<Int8Array> = [original]
        for (let round = 0; round < 40; round++) {
            for (const peer of [A, B]) {
                if (next() < 0.6) {
                    const current = blobOf(peer, id).data.getValue()
                    const value = next() < 0.2
                        ? pattern(Math.floor(next() * 7 * CHUNK), round)
                        : changed(current.length === 0 ? new Int8Array(1) : current,
                            Math.floor(next() * Math.max(1, current.length)), Math.floor(next() * 100))
                    written.push(value)
                    edit(peer, () => blobOf(peer, id).data.setValue(value))
                }
            }
            if (next() < 0.5) {deliver(A, B)} else {deliver(B, A)}
            if (next() < 0.3) {converge(A, B)}
        }
        converge(A, B)
        expect(same(blobOf(A, id).data.getValue(), blobOf(B, id).data.getValue())).toBe(true)
        for (const peer of [A, B]) {
            expect(peer.seen.every(value => written.some(candidate => same(value, candidate)))).toBe(true)
        }
    })
})
