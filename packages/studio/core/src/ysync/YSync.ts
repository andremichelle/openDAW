import {
    asDefined,
    asInstanceOf,
    assert,
    EmptyExec,
    isUndefined,
    JSONValue,
    Option,
    panic,
    Provider,
    Subscription,
    Terminable,
    Terminator,
    tryCatch,
    UUID
} from "@moises-ai/lib-std"
import {ArrayField, BoxGraph, Field, ObjectField, PointerField, PrimitiveField, Update} from "@moises-ai/lib-box"
import {YMapper} from "./YMapper"
import * as Y from "yjs"

type EventHandler = (events: Array<Y.YEvent<any>>, transaction: Y.Transaction) => void

export type Construct<T> = {
    boxGraph: BoxGraph<T>,
    boxes: Y.Map<unknown>
    conflict?: Provider<boolean>
}

export class YSync<T> implements Terminable {
    static debugging: boolean = false

    /** @internal */
    static isEmpty(doc: Y.Doc): boolean {
        return doc.getMap("boxes").size === 0
    }

    static async populateRoom<T>({boxGraph, boxes}: Construct<T>): Promise<YSync<T>> {
        console.debug("populate")
        assert(boxes.size === 0, "boxes must be empty")
        const sync = new YSync<T>({boxGraph, boxes})
        asDefined(boxes.doc, "Y.Map is not connect to Y.Doc")
            .transact(() => boxGraph.boxes()
                .forEach(box => {
                    const key = UUID.toString(box.address.uuid)
                    const map = YMapper.createBoxMap(box)
                    boxes.set(key, map)
                }), "[openDAW] populate")
        return sync
    }

    static async joinRoom<T>({boxGraph, boxes}: Construct<T>): Promise<YSync<T>> {
        console.debug("join")
        assert(boxGraph.boxes().length === 0, "BoxGraph must be empty")
        const sync = new YSync<T>({boxGraph, boxes})
        boxGraph.beginTransaction()
        boxes.forEach((value, key) => {
            const boxMap = value as Y.Map<unknown>
            const uuid = UUID.parse(key)
            const name = boxMap.get("name") as keyof T
            const fields = boxMap.get("fields") as Y.Map<unknown>
            boxGraph.createBox(name, uuid, box => YMapper.applyFromBoxMap(box, fields))
        })
        boxGraph.endTransaction()
        return sync
    }

    static #computePathPrefix(boxes: Y.Map<unknown>): ReadonlyArray<string | number> {
        const prefix: Array<string | number> = []
        let item = (boxes as unknown as { _item: unknown })._item as
            { parentSub: string | number, parent: { _item: unknown } } | null
        while (item !== null) {
            prefix.unshift(item.parentSub)
            const parent = item.parent as unknown as { _item: unknown }
            item = parent._item as typeof item
        }
        return prefix
    }

    readonly #terminator = new Terminator()
    readonly #boxGraph: BoxGraph<T>
    readonly #conflict: Option<Provider<boolean>>
    readonly #boxes: Y.Map<unknown>
    readonly #updates: Array<Update>
    readonly #pathPrefix: ReadonlyArray<string | number>

    #ignoreUpdates: boolean = false

    constructor({boxGraph, boxes, conflict}: Construct<T>) {
        this.#boxGraph = boxGraph
        this.#conflict = Option.wrap(conflict)
        this.#boxes = boxes
        this.#updates = []
        this.#pathPrefix = YSync.#computePathPrefix(boxes)
        this.#terminator.ownAll(this.#setupYjs(), this.#setupOpenDAW())
    }

    terminate(): void {this.#terminator.terminate()}

    #setupYjs(): Subscription {
        const eventHandler: EventHandler = (events, {origin, local}) => {
            const originLabel = typeof origin === "string" ? origin : "Unkown Origin"
            const isOwnOrigin = typeof origin === "string" && origin.startsWith("[openDAW]")
            const isHistoryReplay = typeof origin === "string" && origin.startsWith("[history]")
            console.debug(`got ${events.length} ${local ? "local" : "external"} updates from '${originLabel}', isHistoryReplay: ${isHistoryReplay}, isOwnOrigin: ${isOwnOrigin}`)
            if (isOwnOrigin || (local && !isHistoryReplay)) {return}
            this.#boxGraph.beginTransaction()
            const result = tryCatch(() => {
                for (const event of events) {
                    const path = this.#normalizePath(event.path)
                    const keys = event.changes.keys
                    for (const [key, change] of keys.entries()) {
                        if (YSync.debugging) {
                            console.debug(`${change.action} on ${path}:${key}`)
                        }
                        if (change.action === "add") {
                            assert(path.length === 0, "'Add' cannot have a path")
                            this.#createBox(key)
                        } else if (change.action === "update") {
                            if (path.length === 0) {continue}
                            assert(path.length >= 2, "Invalid path: must have at least 2 elements (uuid, 'fields').")
                            this.#updateValue(path, key)
                        } else if (change.action === "delete") {
                            assert(path.length === 0, "'Delete' cannot have a path")
                            this.#deleteBox(key)
                        }
                    }
                }
                this.#ignoreUpdates = true
                this.#boxGraph.endTransaction()
                this.#ignoreUpdates = false
            })
            if (result.status === "failure") {
                this.#ignoreUpdates = false
                if (this.#boxGraph.inTransaction()) {
                    this.#boxGraph.abortTransaction()
                }
                console.warn(`[YSync] Transaction rejected, rolling back:`, result.error)
                this.#rollbackTransaction(events)
                return
            }
            const highLevelConflict = this.#conflict.mapOr(check => check(), false)
            if (highLevelConflict) {
                this.#rollbackTransaction(events)
            }
        }
        this.#boxes.observeDeep(eventHandler)
        return {terminate: () => {this.#boxes.unobserveDeep(eventHandler)}}
    }

    #createBox(key: string): void {
        const map = this.#boxes.get(key) as Y.Map<unknown>
        const name = map.get("name") as keyof T
        const fields = map.get("fields") as Y.Map<unknown>
        const uuid = UUID.parse(key)
        const optBox = this.#boxGraph.findBox(UUID.parse(key))
        if (optBox.isEmpty()) {
            this.#boxGraph.createBox(name, uuid, box => YMapper.applyFromBoxMap(box, fields))
        } else {
            console.debug(`Box '${key}' has already been created. Performing 'Upsert'.`)
            YMapper.applyFromBoxMap(optBox.unwrap(), fields)
        }
    }

    #normalizePath(path: ReadonlyArray<string | number>): ReadonlyArray<string | number> {
        const prefix = this.#pathPrefix
        if (prefix.length === 0 || path.length < prefix.length) {return path}
        for (let i = 0; i < prefix.length; i++) {
            if (path[i] !== prefix[i]) {return path}
        }
        return path.slice(prefix.length)
    }

    #updateValue(path: ReadonlyArray<string | number>, key: string): void {
        const address = YMapper.pathToAddress(path, key)
        const vertex = this.#boxGraph.findVertex(address)
            .unwrap(`Vertex at '${address.toString()}' does not exist.`)
        const [uuidAsString, fieldsKey, ...fieldKeys] = path
        const targetMap = YMapper.findMap((this.#boxes
            .get(String(uuidAsString)) as Y.Map<unknown>)
            .get(String(fieldsKey)) as Y.Map<unknown>, fieldKeys)
        assert(vertex.isField(), "Vertex must be either Primitive or Pointer")
        vertex.accept({
            visitField: (_: Field) => panic("Vertex must be either Primitive or Pointer"),
            visitArrayField: (_: ArrayField) => panic("Vertex must be either Primitive or Pointer"),
            visitObjectField: (_: ObjectField<any>) => panic("Vertex must be either Primitive or Pointer"),
            visitPointerField: (field: PointerField) => field.fromJSON(targetMap.get(key) as JSONValue),
            visitPrimitiveField: (field: PrimitiveField) => field.fromJSON(targetMap.get(key) as JSONValue)
        })
    }

    #deleteBox(key: string): void {
        const box = this.#boxGraph.findBox(UUID.parse(key))
            .unwrap(`Box '${key}' does not exist.`)
        box.outgoingEdges().forEach(([pointer]) => pointer.defer())
        box.incomingEdges().forEach(pointer => pointer.defer())
        this.#boxGraph.unstageBox(box)
    }

    #rollbackTransaction(events: ReadonlyArray<Y.YEvent<any>>): void {
        console.debug(`rollback ${events.length} events...`)
        this.#getDoc()
            .transact(() => {
                for (let i = events.length - 1; i >= 0; i--) {
                    const event = events[i]
                    const target = asInstanceOf(event.target, Y.Map)
                    Array.from(event.changes.keys.entries())
                        .toReversed()
                        .forEach(([key, change]) => {
                            if (change.action === "add") {
                                target.delete(key)
                            } else if (change.action === "update") {
                                if (isUndefined(change.oldValue)) {
                                    console.warn(`oldValue of ${change} is undefined`)
                                    target.delete(key)
                                } else {
                                    target.set(key, change.oldValue)
                                }
                            } else if (change.action === "delete") {
                                target.set(key, change.oldValue)
                            }
                        })
                }
            }, "[openDAW] rollback")
    }

    #setupOpenDAW(): Terminable {
        return Terminable.many(
            this.#boxGraph.subscribeTransaction({
                onBeginTransaction: EmptyExec,
                onEndTransaction: (rolledBack) => {
                    if (this.#ignoreUpdates || rolledBack) {
                        this.#updates.length = 0
                        return
                    }
                    this.#getDoc().transact(() => this.#updates.forEach(update => {
                        /**
                         * TRANSFER CHANGES FROM OPENDAW TO YJS
                         */
                        if (update.type === "new") {
                            const uuid = update.uuid
                            const key = UUID.toString(uuid)
                            const box = this.#boxGraph.findBox(uuid).unwrap()
                            this.#boxes.set(key, YMapper.createBoxMap(box))
                        } else if (update.type === "primitive") {
                            const key = UUID.toString(update.address.uuid)
                            const boxObject = asDefined(this.#boxes.get(key),
                                "Could not find box") as Y.Map<unknown>
                            const {address: {fieldKeys}, newValue} = update
                            let field = boxObject.get("fields") as Y.Map<unknown>
                            for (let i = 0; i < fieldKeys.length - 1; i++) {
                                field = asDefined(field.get(String(fieldKeys[i])),
                                    `No field at '${fieldKeys[i]}'`) as Y.Map<unknown>
                            }
                            field.set(String(fieldKeys[fieldKeys.length - 1]), newValue)
                        } else if (update.type === "pointer") {
                            const key = UUID.toString(update.address.uuid)
                            const boxObject = asDefined(this.#boxes.get(key),
                                "Could not find box") as Y.Map<unknown>
                            const {address: {fieldKeys}, newAddress} = update
                            let field = boxObject.get("fields") as Y.Map<unknown>
                            for (let i = 0; i < fieldKeys.length - 1; i++) {
                                field = asDefined(field.get(String(fieldKeys[i])),
                                    `No field at '${fieldKeys[i]}'`) as Y.Map<unknown>
                            }
                            field.set(String(fieldKeys[fieldKeys.length - 1]),
                                newAddress.mapOr(address => address.toString(), null))
                        } else if (update.type === "delete") {
                            this.#boxes.delete(UUID.toString(update.uuid))
                        }
                    }), "[openDAW] updates")
                    this.#updates.length = 0
                }
            }),
            this.#boxGraph.subscribeToAllUpdatesImmediate({
                onUpdate: (update: Update): unknown => this.#updates.push(update)
            })
        )
    }

    #getDoc(): Y.Doc {
        return asDefined(this.#boxes.doc, "Y.Map is not connect to Y.Doc")
    }
}