import {EmptyExec, JSONValue, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {BoxGraph, Update} from "@opendaw/lib-box"

export type BoxStateRow = {
    readonly roomId: string
    readonly boxUuid: string
    readonly boxName: string
    readonly data: string
}

export type StdbSyncConnection = {
    db: {
        box_state: {
            onInsert(cb: (ctx: unknown, row: BoxStateRow) => void): void
            onUpdate(cb: (ctx: unknown, oldRow: BoxStateRow, newRow: BoxStateRow) => void): void
            onDelete(cb: (ctx: unknown, row: BoxStateRow) => void): void
        }
    }
    reducers: {
        boxCreate(params: {roomId: string, boxUuid: string, boxName: string, data: string}): void
        boxUpdate(params: {roomId: string, boxUuid: string, data: string}): void
        boxDelete(params: {roomId: string, boxUuid: string}): void
    }
}

export class StdbSync<T> implements Terminable {
    static populateRoom<T>(boxGraph: BoxGraph<T>, conn: StdbSyncConnection, roomId: string): StdbSync<T> {
        for (const box of boxGraph.boxes()) {
            try {
                const boxUuid = UUID.toString(box.address.uuid)
                conn.reducers.boxCreate({
                    roomId,
                    boxUuid,
                    boxName: box.name as string,
                    data: JSON.stringify(box.toJSON()),
                })
            } catch (error: unknown) {
                console.error("[StdbSync] populateRoom boxCreate error:", error)
            }
        }
        return new StdbSync(boxGraph, conn, roomId)
    }

    static joinRoom<T>(boxGraph: BoxGraph<T>, conn: StdbSyncConnection, roomId: string, rows: Iterable<BoxStateRow>): StdbSync<T> {
        boxGraph.beginTransaction()
        try {
            for (const box of [...boxGraph.boxes()]) {
                box.outgoingEdges().forEach(([pointer]) => { pointer.defer() })
                box.incomingEdges().forEach(pointer => { pointer.defer() })
                boxGraph.unstageBox(box)
            }
            for (const row of rows) {
                if (row.roomId !== roomId) {continue}
                try {
                    const uuid = UUID.parse(row.boxUuid)
                    const name = row.boxName as keyof T
                    boxGraph.createBox(name, uuid, box => box.fromJSON(JSON.parse(row.data)))
                } catch (error: unknown) {
                    console.error("[StdbSync] joinRoom row error:", error)
                }
            }
        } finally {
            boxGraph.endTransaction()
        }
        return new StdbSync(boxGraph, conn, roomId)
    }

    readonly #terminator = new Terminator()
    readonly #boxGraph: BoxGraph<T>
    readonly #conn: StdbSyncConnection
    readonly #roomId: string
    readonly #updates: Array<Update> = []
    #ignoreUpdates = false
    #terminated = false

    constructor(boxGraph: BoxGraph<T>, conn: StdbSyncConnection, roomId: string) {
        this.#boxGraph = boxGraph
        this.#conn = conn
        this.#roomId = roomId
        this.#setupRemoteListeners()
        this.#terminator.ownAll(
            this.#boxGraph.subscribeTransaction({
                onBeginTransaction: EmptyExec,
                onEndTransaction: () => {
                    if (this.#ignoreUpdates) {
                        this.#updates.length = 0
                        return
                    }
                    this.#flushUpdates()
                },
            }),
            this.#boxGraph.subscribeToAllUpdatesImmediate({
                onUpdate: (update: Update) => this.#updates.push(update),
            }),
        )
    }

    terminate(): void {
        this.#terminated = true
        this.#terminator.terminate()
    }

    #flushUpdates(): void {
        const created = new Set<string>()
        const deleted = new Set<string>()
        const updated = new Set<string>()
        for (const update of this.#updates) {
            const key = update.type === "primitive" || update.type === "pointer"
                ? UUID.toString(update.address.uuid)
                : UUID.toString(update.uuid)
            if (update.type === "new") {
                created.add(key)
            } else if (update.type === "delete") {
                deleted.add(key)
            } else {
                updated.add(key)
            }
        }
        this.#updates.length = 0
        for (const boxUuid of created) {
            if (deleted.has(boxUuid)) {continue}
            const optBox = this.#boxGraph.findBox(UUID.parse(boxUuid))
            if (optBox.isEmpty()) {continue}
            const box = optBox.unwrap()
            this.#conn.reducers.boxCreate({
                roomId: this.#roomId,
                boxUuid,
                boxName: box.name as string,
                data: JSON.stringify(box.toJSON()),
            })
        }
        for (const boxUuid of deleted) {
            if (created.has(boxUuid)) {continue}
            this.#conn.reducers.boxDelete({roomId: this.#roomId, boxUuid})
        }
        for (const boxUuid of updated) {
            if (created.has(boxUuid) || deleted.has(boxUuid)) {continue}
            const optBox = this.#boxGraph.findBox(UUID.parse(boxUuid))
            if (optBox.isEmpty()) {continue}
            this.#conn.reducers.boxUpdate({
                roomId: this.#roomId,
                boxUuid,
                data: JSON.stringify(optBox.unwrap().toJSON()),
            })
        }
    }

    #setupRemoteListeners(): void {
        this.#conn.db.box_state.onInsert((_ctx: unknown, row: BoxStateRow) => {
            if (this.#terminated) {return}
            if (row.roomId !== this.#roomId) {return}
            const uuid = UUID.parse(row.boxUuid)
            if (!this.#boxGraph.findBox(uuid).isEmpty()) {return}
            let parsed: JSONValue
            try {
                parsed = JSON.parse(row.data) as JSONValue
            } catch (error: unknown) {
                console.error("[StdbSync] onInsert JSON.parse error:", error)
                return
            }
            this.#ignoreUpdates = true
            this.#boxGraph.beginTransaction()
            try {
                const name = row.boxName as keyof T
                this.#boxGraph.createBox(name, uuid, box => box.fromJSON(parsed))
            } finally {
                this.#boxGraph.endTransaction()
                this.#ignoreUpdates = false
            }
        })
        this.#conn.db.box_state.onUpdate((_ctx: unknown, _oldRow: BoxStateRow, newRow: BoxStateRow) => {
            if (this.#terminated) {return}
            if (newRow.roomId !== this.#roomId) {return}
            const uuid = UUID.parse(newRow.boxUuid)
            const optBox = this.#boxGraph.findBox(uuid)
            if (optBox.isEmpty()) {return}
            let parsed: JSONValue
            try {
                parsed = JSON.parse(newRow.data) as JSONValue
            } catch (error: unknown) {
                console.error("[StdbSync] onUpdate JSON.parse error:", error)
                return
            }
            this.#ignoreUpdates = true
            this.#boxGraph.beginTransaction()
            try {
                optBox.unwrap().fromJSON(parsed)
            } finally {
                this.#boxGraph.endTransaction()
                this.#ignoreUpdates = false
            }
        })
        this.#conn.db.box_state.onDelete((_ctx: unknown, row: BoxStateRow) => {
            if (this.#terminated) {return}
            if (row.roomId !== this.#roomId) {return}
            const uuid = UUID.parse(row.boxUuid)
            const optBox = this.#boxGraph.findBox(uuid)
            if (optBox.isEmpty()) {return}
            const box = optBox.unwrap()
            this.#ignoreUpdates = true
            this.#boxGraph.beginTransaction()
            try {
                box.outgoingEdges().forEach(([pointer]) => { pointer.defer() })
                box.incomingEdges().forEach(pointer => { pointer.defer() })
                this.#boxGraph.unstageBox(box)
            } finally {
                this.#boxGraph.endTransaction()
                this.#ignoreUpdates = false
            }
        })
    }
}
