import {describe, expect, it, vi} from "vitest"
import {Optional} from "@opendaw/lib-std"
import {BoxStateRow, StdbSync, StdbSyncConnection} from "./StdbSync"

type MockBox = {
    address: {uuid: Uint8Array}
    name: string
    toJSON(): unknown
    fromJSON(data: unknown): void
    outgoingEdges(): Array<[{defer(): void}, unknown]>
    incomingEdges(): Array<{defer(): void}>
}

type UpdateListener = {onUpdate(update: unknown): void}
type TransactionListener = {onBeginTransaction(): void, onEndTransaction(): void}

const uuidBytes = (str: string): Uint8Array => {
    const hex = str.replace(/-/g, "")
    const bytes = new Uint8Array(16)
    for (let i = 0; i < 16; i++) {
        bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
    }
    return bytes
}

const UUID_A = "00000000-0000-0000-0000-000000000001"
const UUID_B = "00000000-0000-0000-0000-000000000002"
const BYTES_A = uuidBytes(UUID_A)
const BYTES_B = uuidBytes(UUID_B)

const createMockBox = (uuid: Uint8Array, name: string, json: unknown = {field: "value"}): MockBox => ({
    address: {uuid},
    name,
    toJSON: () => json,
    fromJSON: vi.fn(),
    outgoingEdges: () => [],
    incomingEdges: () => [],
})

const createMockConn = (): StdbSyncConnection & {
    _onInsert: Array<(ctx: unknown, row: BoxStateRow) => void>
    _onUpdate: Array<(ctx: unknown, old: BoxStateRow, row: BoxStateRow) => void>
    _onDelete: Array<(ctx: unknown, row: BoxStateRow) => void>
} => {
    const insertCbs: Array<(ctx: unknown, row: BoxStateRow) => void> = []
    const updateCbs: Array<(ctx: unknown, old: BoxStateRow, row: BoxStateRow) => void> = []
    const deleteCbs: Array<(ctx: unknown, row: BoxStateRow) => void> = []
    return {
        _onInsert: insertCbs,
        _onUpdate: updateCbs,
        _onDelete: deleteCbs,
        db: {
            box_state: {
                onInsert: (cb) => insertCbs.push(cb),
                onUpdate: (cb) => updateCbs.push(cb),
                onDelete: (cb) => deleteCbs.push(cb),
            },
        },
        reducers: {
            boxCreate: vi.fn(),
            boxUpdate: vi.fn(),
            boxDelete: vi.fn(),
        },
    }
}

const createMockGraph = (boxes: Array<MockBox> = []) => {
    let transactionListener: Optional<TransactionListener> = undefined
    let immediateListener: Optional<UpdateListener> = undefined
    const pendingUpdates: Array<unknown> = []
    return {
        _boxes: boxes,
        _transactionListener: () => transactionListener,
        _immediateListener: () => immediateListener,
        _simulateLocalTransaction(updates: Array<unknown>): void {
            transactionListener?.onBeginTransaction()
            for (const update of updates) {
                immediateListener?.onUpdate(update)
            }
            transactionListener?.onEndTransaction()
        },
        boxes: () => boxes,
        findBox: (uuid: Uint8Array) => {
            const found = boxes.find(box =>
                box.address.uuid.every((byte, idx) => byte === uuid[idx]))
            return {
                isEmpty: () => found === undefined,
                unwrap: () => found,
            }
        },
        beginTransaction: vi.fn(),
        endTransaction: vi.fn(),
        createBox: vi.fn((_name: string, _uuid: Uint8Array, constructor?: (box: MockBox) => void) => {
            const box = createMockBox(_uuid, _name)
            boxes.push(box)
            if (constructor) {constructor(box)}
            return box
        }),
        unstageBox: vi.fn((box: MockBox) => {
            const idx = boxes.indexOf(box)
            if (idx >= 0) {boxes.splice(idx, 1)}
        }),
        subscribeTransaction: (listener: TransactionListener) => {
            transactionListener = listener
            return {terminate: () => {transactionListener = undefined}}
        },
        subscribeToAllUpdatesImmediate: (listener: UpdateListener) => {
            immediateListener = listener
            return {terminate: () => {immediateListener = undefined}}
        },
    }
}

describe("StdbSync", () => {
    describe("populateRoom", () => {
        it("sends boxCreate for each existing box", () => {
            const boxA = createMockBox(BYTES_A, "Track", {name: "Track 1"})
            const boxB = createMockBox(BYTES_B, "Region", {name: "Region 1"})
            const graph = createMockGraph([boxA, boxB])
            const conn = createMockConn()
            StdbSync.populateRoom(graph as any, conn, "room-1")
            expect(conn.reducers.boxCreate).toHaveBeenCalledTimes(2)
            expect(conn.reducers.boxCreate).toHaveBeenCalledWith({
                roomId: "room-1",
                boxUuid: UUID_A,
                boxName: "Track",
                data: JSON.stringify({name: "Track 1"}),
            })
            expect(conn.reducers.boxCreate).toHaveBeenCalledWith({
                roomId: "room-1",
                boxUuid: UUID_B,
                boxName: "Region",
                data: JSON.stringify({name: "Region 1"}),
            })
        })
    })

    describe("joinRoom", () => {
        it("creates boxes from initial rows", () => {
            const graph = createMockGraph()
            const conn = createMockConn()
            const rows: Array<BoxStateRow> = [
                {roomId: "room-1", boxUuid: UUID_A, boxName: "Track", data: '{"name":"Track 1"}'},
                {roomId: "room-1", boxUuid: UUID_B, boxName: "Region", data: '{"name":"Region 1"}'},
            ]
            StdbSync.joinRoom(graph as any, conn, "room-1", rows)
            expect(graph.beginTransaction).toHaveBeenCalledTimes(1)
            expect(graph.endTransaction).toHaveBeenCalledTimes(1)
            expect(graph.createBox).toHaveBeenCalledTimes(2)
        })
        it("filters rows by roomId", () => {
            const graph = createMockGraph()
            const conn = createMockConn()
            const rows: Array<BoxStateRow> = [
                {roomId: "room-1", boxUuid: UUID_A, boxName: "Track", data: '{"name":"Track 1"}'},
                {roomId: "room-other", boxUuid: UUID_B, boxName: "Region", data: '{"name":"Region 1"}'},
            ]
            StdbSync.joinRoom(graph as any, conn, "room-1", rows)
            expect(graph.createBox).toHaveBeenCalledTimes(1)
        })
        it("clears existing boxes before creating from host data", () => {
            const existingBox = createMockBox(uuidBytes("00000000-0000-0000-0000-000000000099"), "OldTrack")
            const graph = createMockGraph([existingBox])
            const conn = createMockConn()
            const rows: Array<BoxStateRow> = [
                {roomId: "room-1", boxUuid: UUID_A, boxName: "Track", data: '{"name":"Track 1"}'},
            ]
            StdbSync.joinRoom(graph as any, conn, "room-1", rows)
            expect(graph.unstageBox).toHaveBeenCalledWith(existingBox)
            expect(graph.createBox).toHaveBeenCalledTimes(1)
        })
    })

    describe("local → remote", () => {
        it("new box triggers boxCreate reducer", () => {
            const graph = createMockGraph()
            const conn = createMockConn()
            const sync = new StdbSync(graph as any, conn, "room-1")
            const box = createMockBox(BYTES_A, "Track", {name: "New"})
            graph._boxes.push(box)
            graph._simulateLocalTransaction([
                {type: "new", uuid: BYTES_A, name: "Track", settings: new ArrayBuffer(0)},
            ])
            expect(conn.reducers.boxCreate).toHaveBeenCalledWith({
                roomId: "room-1",
                boxUuid: UUID_A,
                boxName: "Track",
                data: JSON.stringify({name: "New"}),
            })
        })
        it("primitive update triggers boxUpdate reducer", () => {
            const boxA = createMockBox(BYTES_A, "Track", {volume: 0.8})
            const graph = createMockGraph([boxA])
            const conn = createMockConn()
            const sync = new StdbSync(graph as any, conn, "room-1")
            graph._simulateLocalTransaction([
                {type: "primitive", address: {uuid: BYTES_A, fieldKeys: [0]}},
            ])
            expect(conn.reducers.boxUpdate).toHaveBeenCalledWith({
                roomId: "room-1",
                boxUuid: UUID_A,
                data: JSON.stringify({volume: 0.8}),
            })
        })
        it("delete triggers boxDelete reducer", () => {
            const graph = createMockGraph()
            const conn = createMockConn()
            const sync = new StdbSync(graph as any, conn, "room-1")
            graph._simulateLocalTransaction([
                {type: "delete", uuid: BYTES_A, name: "Track", settings: new ArrayBuffer(0)},
            ])
            expect(conn.reducers.boxDelete).toHaveBeenCalledWith({
                roomId: "room-1",
                boxUuid: UUID_A,
            })
        })
        it("create+delete in same transaction cancels out", () => {
            const graph = createMockGraph()
            const conn = createMockConn()
            const sync = new StdbSync(graph as any, conn, "room-1")
            graph._simulateLocalTransaction([
                {type: "new", uuid: BYTES_A, name: "Track", settings: new ArrayBuffer(0)},
                {type: "delete", uuid: BYTES_A, name: "Track", settings: new ArrayBuffer(0)},
            ])
            expect(conn.reducers.boxCreate).not.toHaveBeenCalled()
            expect(conn.reducers.boxDelete).not.toHaveBeenCalled()
        })
        it("deduplicates multiple field updates to same box", () => {
            const boxA = createMockBox(BYTES_A, "Track", {volume: 1.0})
            const graph = createMockGraph([boxA])
            const conn = createMockConn()
            const sync = new StdbSync(graph as any, conn, "room-1")
            graph._simulateLocalTransaction([
                {type: "primitive", address: {uuid: BYTES_A, fieldKeys: [0]}},
                {type: "primitive", address: {uuid: BYTES_A, fieldKeys: [1]}},
            ])
            expect(conn.reducers.boxUpdate).toHaveBeenCalledTimes(1)
        })
    })

    describe("remote → local", () => {
        it("onInsert creates box in graph", () => {
            const graph = createMockGraph()
            const conn = createMockConn()
            const sync = new StdbSync(graph as any, conn, "room-1")
            const row: BoxStateRow = {roomId: "room-1", boxUuid: UUID_A, boxName: "Track", data: '{"name":"Remote"}'}
            conn._onInsert.forEach(cb => cb(null, row))
            expect(graph.createBox).toHaveBeenCalledTimes(1)
            expect(graph.beginTransaction).toHaveBeenCalled()
            expect(graph.endTransaction).toHaveBeenCalled()
        })
        it("onInsert ignores different roomId", () => {
            const graph = createMockGraph()
            const conn = createMockConn()
            const sync = new StdbSync(graph as any, conn, "room-1")
            const row: BoxStateRow = {roomId: "room-other", boxUuid: UUID_A, boxName: "Track", data: '{}'}
            conn._onInsert.forEach(cb => cb(null, row))
            expect(graph.createBox).not.toHaveBeenCalled()
        })
        it("onInsert skips existing box (upsert guard)", () => {
            const boxA = createMockBox(BYTES_A, "Track")
            const graph = createMockGraph([boxA])
            const conn = createMockConn()
            const sync = new StdbSync(graph as any, conn, "room-1")
            const row: BoxStateRow = {roomId: "room-1", boxUuid: UUID_A, boxName: "Track", data: '{}'}
            conn._onInsert.forEach(cb => cb(null, row))
            expect(graph.createBox).not.toHaveBeenCalled()
        })
        it("onUpdate applies fromJSON to existing box", () => {
            const boxA = createMockBox(BYTES_A, "Track")
            const graph = createMockGraph([boxA])
            const conn = createMockConn()
            const sync = new StdbSync(graph as any, conn, "room-1")
            const oldRow: BoxStateRow = {roomId: "room-1", boxUuid: UUID_A, boxName: "Track", data: '{}'}
            const newRow: BoxStateRow = {roomId: "room-1", boxUuid: UUID_A, boxName: "Track", data: '{"volume":0.5}'}
            conn._onUpdate.forEach(cb => cb(null, oldRow, newRow))
            expect(boxA.fromJSON).toHaveBeenCalledWith({volume: 0.5})
        })
        it("onDelete unstages box from graph", () => {
            const boxA = createMockBox(BYTES_A, "Track")
            const graph = createMockGraph([boxA])
            const conn = createMockConn()
            const sync = new StdbSync(graph as any, conn, "room-1")
            const row: BoxStateRow = {roomId: "room-1", boxUuid: UUID_A, boxName: "Track", data: '{}'}
            conn._onDelete.forEach(cb => cb(null, row))
            expect(graph.unstageBox).toHaveBeenCalledWith(boxA)
        })
    })

    describe("ignoreUpdates prevents echo", () => {
        it("remote insert does not trigger boxCreate reducer", () => {
            const graph = createMockGraph()
            const conn = createMockConn()
            const sync = new StdbSync(graph as any, conn, "room-1")
            const row: BoxStateRow = {roomId: "room-1", boxUuid: UUID_A, boxName: "Track", data: '{"name":"Remote"}'}
            conn._onInsert.forEach(cb => cb(null, row))
            expect(conn.reducers.boxCreate).not.toHaveBeenCalled()
        })
    })

    describe("terminate", () => {
        it("cleans up subscriptions so local changes no longer trigger reducers", () => {
            const graph = createMockGraph()
            const conn = createMockConn()
            const sync = new StdbSync(graph as any, conn, "room-1")
            sync.terminate()
            const box = createMockBox(BYTES_A, "Track")
            graph._boxes.push(box)
            graph._simulateLocalTransaction([
                {type: "new", uuid: BYTES_A, name: "Track", settings: new ArrayBuffer(0)},
            ])
            expect(conn.reducers.boxCreate).not.toHaveBeenCalled()
        })
    })
})
