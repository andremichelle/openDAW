import {describe, expect, it} from "vitest"
import {Maybe, Option, Procedure, safeExecute, UUID} from "@opendaw/lib-std"
import {Box, BoxConstruct} from "./box"
import {BoxGraph} from "./graph"
import {ByteArrayField, StringField} from "./primitive"
import {NoPointers, VertexVisitor} from "./vertex"
import {UnreferenceableType} from "./pointer"
import {BoxEditing} from "./editing"
import {BytesSplice} from "./bytes-splice"
import {UpdateTasks} from "./sync-source"
import {applyUpdateTasks} from "./sync-target"
import {UpdateTask} from "./sync"
import {Update} from "./updates"

type BytesBoxFields = { 1: ByteArrayField, 2: StringField }

interface BytesVisitor<RETURN = void> extends VertexVisitor<RETURN> {
    visitBytesBox?(box: BytesBox): RETURN
}

class BytesBox extends Box<UnreferenceableType, BytesBoxFields> {
    static create(graph: BoxGraph, uuid: UUID.Bytes, constructor?: Procedure<BytesBox>): BytesBox {
        return graph.stageBox(new BytesBox({uuid, graph, name: "BytesBox", pointerRules: NoPointers}), constructor)
    }

    private constructor(construct: BoxConstruct<UnreferenceableType>) {super(construct)}

    protected initializeFields(): BytesBoxFields {
        return {
            1: ByteArrayField.create({parent: this, fieldKey: 1, fieldName: "data", deprecated: false, pointerRules: NoPointers}),
            2: StringField.create({parent: this, fieldKey: 2, fieldName: "label", deprecated: false, pointerRules: NoPointers})
        }
    }

    accept<R>(visitor: BytesVisitor<R>): Maybe<R> {return safeExecute(visitor.visitBytesBox, this)}

    get tags(): Readonly<Record<string, string | number | boolean>> {return {}}
    get data(): ByteArrayField {return this.getField(1)}
    get label(): StringField {return this.getField(2)}
}

type TypeMap = { BytesBox: BytesBox }

const createGraph = (): BoxGraph<TypeMap> =>
    new BoxGraph<TypeMap>(Option.wrap(<K extends keyof TypeMap>(name: K, graph: BoxGraph<TypeMap>, uuid: UUID.Bytes,
                                                                constructor: Procedure<TypeMap[K]>): TypeMap[K] =>
        BytesBox.create(graph, uuid, constructor as Procedure<BytesBox>)))

const bytes = (...values: ReadonlyArray<number>): Int8Array => new Int8Array(values)

// a deterministic generator, so a failing fuzz case can be replayed
const random = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 0x100000000
}

const randomBytes = (next: () => number, length: number): Int8Array =>
    Int8Array.from({length}, () => Math.floor(next() * 4) - 2)

const same = (a: Readonly<Int8Array>, b: Readonly<Int8Array>): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index])

// an edit like an editor makes: overwrite, insert or remove a run somewhere, or append, removing once it got long
const randomEdit = (next: () => number, from: Int8Array): Int8Array => {
    const at = Math.floor(next() * (from.length + 1))
    const run = Math.floor(next() * 40)
    switch (from.length > 600 ? 2 : Math.floor(next() * 4)) {
        case 0: {
            const to = from.slice()
            to.set(randomBytes(next, Math.min(run, from.length - at)), at)
            return to
        }
        case 1:
            return BytesSplice.apply(from, {offset: at, deleteCount: 0, insert: randomBytes(next, run)})
        case 2:
            return BytesSplice.apply(from, {offset: at, deleteCount: Math.min(run, from.length - at), insert: new Int8Array(0)})
        default:
            return BytesSplice.apply(from, {offset: from.length, deleteCount: 0, insert: randomBytes(next, run)})
    }
}

describe("BytesSplice.of", () => {
    const splice = (from: Int8Array, to: Int8Array) => BytesSplice.of(from, to).unwrap()

    it("finds nothing between equal values, also between two empty ones", () => {
        expect(BytesSplice.of(bytes(1, 2, 3), bytes(1, 2, 3)).isEmpty()).toBe(true)
        expect(BytesSplice.of(bytes(), bytes()).isEmpty()).toBe(true)
    })

    it("finds one changed byte in the middle, at the start and at the end", () => {
        expect(splice(bytes(1, 2, 3), bytes(1, 9, 3))).toStrictEqual({offset: 1, deleteCount: 1, insert: bytes(9)})
        expect(splice(bytes(1, 2, 3), bytes(9, 2, 3))).toStrictEqual({offset: 0, deleteCount: 1, insert: bytes(9)})
        expect(splice(bytes(1, 2, 3), bytes(1, 2, 9))).toStrictEqual({offset: 2, deleteCount: 1, insert: bytes(9)})
    })

    it("finds growth and shrinking at the end", () => {
        expect(splice(bytes(1, 2), bytes(1, 2, 3, 4))).toStrictEqual({offset: 2, deleteCount: 0, insert: bytes(3, 4)})
        expect(splice(bytes(1, 2, 3, 4), bytes(1, 2))).toStrictEqual({offset: 2, deleteCount: 2, insert: bytes()})
    })

    it("finds an insert and a removal in the middle", () => {
        expect(splice(bytes(1, 2, 5, 6), bytes(1, 2, 3, 4, 5, 6))).toStrictEqual({offset: 2, deleteCount: 0, insert: bytes(3, 4)})
        expect(splice(bytes(1, 2, 3, 4, 5, 6), bytes(1, 2, 5, 6))).toStrictEqual({offset: 2, deleteCount: 2, insert: bytes()})
    })

    it("goes from empty to a value and back", () => {
        expect(splice(bytes(), bytes(1, 2))).toStrictEqual({offset: 0, deleteCount: 0, insert: bytes(1, 2)})
        expect(splice(bytes(1, 2), bytes())).toStrictEqual({offset: 0, deleteCount: 2, insert: bytes()})
    })

    it("never lets prefix and suffix overlap where the bytes repeat", () => {
        expect(splice(bytes(1, 1), bytes(1, 1, 1))).toStrictEqual({offset: 2, deleteCount: 0, insert: bytes(1)})
        expect(splice(bytes(1, 1, 1), bytes(1, 1))).toStrictEqual({offset: 2, deleteCount: 1, insert: bytes()})
        expect(splice(bytes(7, 7, 7, 7), bytes(7))).toStrictEqual({offset: 1, deleteCount: 3, insert: bytes()})
    })

    it("replaces everything when nothing is shared", () => {
        expect(splice(bytes(1, 2, 3), bytes(4, 5))).toStrictEqual({offset: 0, deleteCount: 3, insert: bytes(4, 5)})
    })

    it("hands out a copy, never a view into the new value", () => {
        const to = bytes(1, 9, 3)
        const {insert} = splice(bytes(1, 2, 3), to)
        to[1] = 0
        expect(insert[0]).toBe(9)
    })

    it("rebuilds the new value from any old one, 5000 random edits", () => {
        const next = random(17)
        let value = randomBytes(next, 64)
        for (let round = 0; round < 5000; round++) {
            const edited = randomEdit(next, value)
            const found = BytesSplice.of(value, edited)
            if (found.isEmpty()) {
                expect(same(edited, value)).toBe(true)
            } else {
                const {offset, deleteCount, insert} = found.unwrap()
                expect(offset + deleteCount).toBeLessThanOrEqual(value.length)
                expect(insert.length).toBeLessThanOrEqual(edited.length)
                expect(same(BytesSplice.apply(value, found.unwrap()), edited)).toBe(true)
            }
            value = edited
        }
    })
})

describe("BytesSplice.apply", () => {
    it("refuses a splice outside the value", () => {
        expect(() => BytesSplice.apply(bytes(1, 2), {offset: 3, deleteCount: 0, insert: bytes()})).toThrow(RangeError)
        expect(() => BytesSplice.apply(bytes(1, 2), {offset: 1, deleteCount: 2, insert: bytes()})).toThrow(RangeError)
        expect(() => BytesSplice.apply(bytes(1, 2), {offset: -1, deleteCount: 0, insert: bytes()})).toThrow(RangeError)
        expect(() => BytesSplice.apply(bytes(1, 2), {offset: 0, deleteCount: -1, insert: bytes()})).toThrow(RangeError)
    })

    it("leaves the value it splices untouched", () => {
        const value = bytes(1, 2, 3)
        BytesSplice.apply(value, {offset: 1, deleteCount: 1, insert: bytes(9, 9)})
        expect(value).toStrictEqual(bytes(1, 2, 3))
    })
})

describe("ByteArrayField range edits", () => {
    const setup = (initial: Int8Array) => {
        const graph = createGraph()
        const updates: Array<Update> = []
        graph.beginTransaction()
        const box = BytesBox.create(graph, UUID.generate(), box => box.data.setValue(initial))
        graph.endTransaction()
        graph.subscribeToAllUpdatesImmediate({onUpdate: update => updates.push(update)})
        const edit = (procedure: () => void) => {
            graph.beginTransaction()
            procedure()
            graph.endTransaction()
        }
        return {graph, box, updates, edit}
    }

    it("writes inside the value into a copy, the old value stays as it was", () => {
        const {box, updates, edit} = setup(bytes(1, 2, 3, 4))
        const before = box.data.getValue()
        edit(() => box.data.setBytes(1, bytes(8, 9)))
        expect(box.data.getValue()).toStrictEqual(bytes(1, 8, 9, 4))
        expect(before).toStrictEqual(bytes(1, 2, 3, 4))
        expect(updates).toHaveLength(1)
    })

    it("makes no update when the bytes are already there", () => {
        const {box, updates, edit} = setup(bytes(1, 2, 3))
        const before = box.data.getValue()
        edit(() => box.data.setBytes(1, bytes(2, 3)))
        edit(() => box.data.setByte(0, 1))
        edit(() => box.data.setLength(3))
        expect(updates).toHaveLength(0)
        expect(box.data.getValue()).toBe(before)
    })

    it("grows at the end and zero fills a gap past it", () => {
        const {box, edit} = setup(bytes(1, 2))
        edit(() => box.data.setBytes(2, bytes(3)))
        expect(box.data.getValue()).toStrictEqual(bytes(1, 2, 3))
        edit(() => box.data.setBytes(5, bytes(6)))
        expect(box.data.getValue()).toStrictEqual(bytes(1, 2, 3, 0, 0, 6))
    })

    it("refuses negative and fractional offsets and lengths", () => {
        const {box, edit} = setup(bytes(1, 2))
        expect(() => edit(() => box.data.setBytes(-1, bytes(1)))).toThrow()
        expect(() => edit(() => box.data.setBytes(0.5, bytes(1)))).toThrow()
        expect(() => edit(() => box.data.setLength(-1))).toThrow()
        expect(() => edit(() => box.data.setLength(1.5))).toThrow()
    })

    it("writes one byte, wrapping it into a signed byte", () => {
        const {box, edit} = setup(bytes(0, 0))
        edit(() => box.data.setByte(1, 255))
        expect(box.data.getValue()).toStrictEqual(bytes(0, -1))
    })

    it("cuts and zero extends the length", () => {
        const {box, edit} = setup(bytes(1, 2, 3))
        edit(() => box.data.setLength(1))
        expect(box.data.getValue()).toStrictEqual(bytes(1))
        edit(() => box.data.setLength(3))
        expect(box.data.getValue()).toStrictEqual(bytes(1, 0, 0))
        edit(() => box.data.setLength(0))
        expect(box.data.getValue()).toStrictEqual(bytes())
    })

    it("undoes and redoes range edits byte exact", () => {
        const {graph, box} = setup(bytes(1, 2, 3, 4))
        const editing = new BoxEditing(graph)
        editing.modify(() => box.data.setBytes(1, bytes(9)))
        editing.modify(() => box.data.setLength(6))
        editing.modify(() => box.data.setBytes(0, bytes(5, 5)))
        expect(box.data.getValue()).toStrictEqual(bytes(5, 5, 3, 4, 0, 0))
        editing.undo()
        expect(box.data.getValue()).toStrictEqual(bytes(1, 9, 3, 4, 0, 0))
        editing.undo()
        expect(box.data.getValue()).toStrictEqual(bytes(1, 9, 3, 4))
        editing.undo()
        expect(box.data.getValue()).toStrictEqual(bytes(1, 2, 3, 4))
        editing.redo()
        editing.redo()
        editing.redo()
        expect(box.data.getValue()).toStrictEqual(bytes(5, 5, 3, 4, 0, 0))
    })
})

describe("UpdateTasks for bytes", () => {
    const tasksOf = (initial: Int8Array, procedure: (box: BytesBox) => void) => {
        const graph = createGraph()
        graph.beginTransaction()
        const box = BytesBox.create(graph, UUID.generate(), box => box.data.setValue(initial))
        graph.endTransaction()
        const tasks: Array<UpdateTask<TypeMap>> = []
        graph.subscribeToAllUpdatesImmediate({onUpdate: update => tasks.push(UpdateTasks.of<TypeMap>(update))})
        graph.beginTransaction()
        procedure(box)
        graph.endTransaction()
        return {graph, box, tasks}
    }

    it("sends one changed byte of a megabyte as a range", () => {
        const {tasks} = tasksOf(new Int8Array(1 << 20), box => box.data.setByte(500_000, 7))
        expect(tasks).toHaveLength(1)
        const [task] = tasks
        if (task.type !== "update-bytes") {throw new Error(`expected update-bytes, got ${task.type}`)}
        expect(task.offset).toBe(500_000)
        expect(task.deleteCount).toBe(1)
        expect(task.bytes).toStrictEqual(bytes(7))
    })

    it("sends a whole value when the range would not be smaller", () => {
        const {tasks} = tasksOf(bytes(1, 2, 3, 4), box => box.data.setValue(bytes(5, 6, 7, 8)))
        expect(tasks.map(task => task.type)).toStrictEqual(["update-primitive"])
    })

    it("sends a whole value for a tiny field even if one byte changed", () => {
        const {tasks} = tasksOf(bytes(1, 2), box => box.data.setByte(0, 9))
        expect(tasks.map(task => task.type)).toStrictEqual(["update-primitive"])
    })

    it("leaves other primitive fields alone", () => {
        const {tasks} = tasksOf(bytes(), box => box.label.setValue("x"))
        expect(tasks.map(task => task.type)).toStrictEqual(["update-primitive"])
    })

    it("replays several range edits of one field in one transaction in order", () => {
        const source = new Int8Array(4096).map((_, index) => index & 0x7f)
        const {graph, box, tasks} = tasksOf(source, box => {
            box.data.setBytes(10, bytes(1, 1, 1))
            box.data.setLength(4000)
            box.data.setBytes(3999, bytes(9, 9))
            box.data.setBytes(0, bytes(-5))
        })
        expect(tasks.every(task => task.type === "update-bytes")).toBe(true)
        const mirror = createGraph()
        mirror.beginTransaction()
        BytesBox.create(mirror, box.address.uuid, mirrored => mirrored.data.setValue(source))
        mirror.endTransaction()
        mirror.beginTransaction()
        applyUpdateTasks(mirror, tasks)
        mirror.endTransaction()
        expect(mirror.findBox<BytesBox>(box.address.uuid).unwrap().data.getValue()).toStrictEqual(box.data.getValue())
        expect(Array.from(mirror.checksum())).toStrictEqual(Array.from(graph.checksum()))
    })

    it("applies a range edit to a box created in the same batch", () => {
        const graph = createGraph()
        const tasks: Array<UpdateTask<TypeMap>> = []
        graph.subscribeToAllUpdatesImmediate({onUpdate: update => tasks.push(UpdateTasks.of<TypeMap>(update))})
        graph.beginTransaction()
        const box = BytesBox.create(graph, UUID.generate(), box => box.data.setValue(new Int8Array(100)))
        box.data.setByte(50, 3)
        graph.endTransaction()
        const mirror = createGraph()
        mirror.beginTransaction()
        applyUpdateTasks(mirror, tasks)
        mirror.endTransaction()
        expect(Array.from(mirror.checksum())).toStrictEqual(Array.from(graph.checksum()))
    })

    it("refuses a range edit that does not fit the field it lands on", () => {
        const graph = createGraph()
        graph.beginTransaction()
        const box = BytesBox.create(graph, UUID.generate(), box => box.data.setValue(bytes(1, 2)))
        graph.endTransaction()
        const at = box.data.address.decompose()
        graph.beginTransaction()
        expect(() => applyUpdateTasks(graph, [{type: "update-bytes", address: at, offset: 1, deleteCount: 5, bytes: bytes()}]))
            .toThrow(RangeError)
        graph.abortTransaction()
        graph.beginTransaction()
        expect(() => applyUpdateTasks(graph, [{
            type: "update-bytes", address: box.label.address.decompose(), offset: 0, deleteCount: 0, bytes: bytes()
        }])).toThrow()
        graph.abortTransaction()
        expect(box.data.getValue()).toStrictEqual(bytes(1, 2))
    })

    it("keeps a mirror equal through 300 random transactions with undo and redo", () => {
        const next = random(99)
        const graph = createGraph()
        const editing = new BoxEditing(graph)
        const box = editing.modify(() => BytesBox.create(graph, UUID.generate(), box => box.data.setValue(randomBytes(next, 2000)))).unwrap()
        const mirror = createGraph()
        mirror.beginTransaction()
        BytesBox.create(mirror, box.address.uuid, mirrored => mirrored.data.setValue(box.data.getValue()))
        mirror.endTransaction()
        const tasks: Array<UpdateTask<TypeMap>> = []
        graph.subscribeToAllUpdatesImmediate({onUpdate: update => tasks.push(UpdateTasks.of<TypeMap>(update))})
        const ranges = {count: 0}
        for (let round = 0; round < 300; round++) {
            const action = next()
            if (action < 0.15) {
                editing.undo()
            } else if (action < 0.25) {
                editing.redo()
            } else {
                editing.modify(() => box.data.setValue(randomEdit(next, box.data.getValue() as Int8Array)))
            }
            ranges.count += tasks.filter(task => task.type === "update-bytes").length
            mirror.beginTransaction()
            applyUpdateTasks(mirror, tasks.splice(0))
            mirror.endTransaction()
            expect(same(mirror.findBox<BytesBox>(box.address.uuid).unwrap().data.getValue(), box.data.getValue())).toBe(true)
        }
        expect(ranges.count).toBeGreaterThan(200)
    })
})
