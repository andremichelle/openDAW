import {
    asDefined,
    asInstanceOf,
    assert,
    EmptyExec,
    int,
    isDefined,
    isInstanceOf,
    isUndefined,
    JSONValue,
    Notifier,
    Observer,
    Option,
    panic,
    Provider,
    SortedSet,
    Subscription,
    Terminable,
    Terminator,
    tryCatch,
    UUID
} from "@opendaw/lib-std"
import {
    Address,
    ArrayField,
    Box,
    BoxGraph,
    ByteArrayField,
    Field,
    ObjectField,
    optimizeUpdates,
    PointerField,
    PrimitiveField,
    Update
} from "@opendaw/lib-box"
import {YMapper} from "./YMapper"
import {YBytes} from "./YBytes"
import {deterministicReconcile, isInstrumentWithoutCapture} from "./Reconcile"
import * as Y from "yjs"

type EventHandler = (events: Array<Y.YEvent<any>>, transaction: Y.Transaction) => void

export type Construct<T> = {
    boxGraph: BoxGraph<T>,
    boxes: Y.Map<unknown>
    conflict?: Provider<boolean>
}

// edits that stay on this client until published: a preview is reverted when the room breaks it, a take survives
export type LocalLayerKind = "preview" | "take"

export interface LocalLayer extends Terminable {
    get hasChanges(): boolean
    run<R>(procedure: Provider<R>): R
    revert(): void
    publish(): void
    boxes(): ReadonlyArray<Box>
    owns(uuid: UUID.Bytes): boolean
    subscribeInvalid(observer: Observer<void>): Subscription
}

type LayerState = {
    readonly kind: LocalLayerKind
    readonly boxes: SortedSet<UUID.Bytes, UUID.Bytes>
    readonly hidden: SortedSet<UUID.Bytes, UUID.Bytes>
    readonly fields: SortedSet<Address, Address>
    readonly invalid: Notifier<void>
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
        const generation = sync.#generator.next()
        asDefined(boxes.doc, "Y.Map is not connect to Y.Doc")
            .transact(() => boxGraph.boxes()
                .forEach(box => {
                    const key = UUID.toString(box.address.uuid)
                    const map = YMapper.createBoxMap(box, generation)
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
        // A room document can encode a state that violates a box-graph invariant. Repair deterministically
        // before validating, so a fresh joiner lands on the same graph every peer already holds instead of
        // rejecting the whole snapshot. The rebuild above only mirrors the document and must NOT be written
        // back (that would republish every box map over the live room), but the repair must be, exactly as on
        // the live path in #setupYjs.
        sync.#publishFrom = Option.wrap(sync.#updates.length)
        deterministicReconcile(boxGraph)
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
    readonly #generator: YBytes.Generator
    readonly #touchedBytes: Array<ByteArrayField> = []
    readonly #cutPointers: Array<PointerField> = []

    readonly #layers: Array<LayerState> = []
    readonly #remote: Notifier<ReadonlyArray<Box>> = new Notifier<ReadonlyArray<Box>>()

    #applyingRemote: boolean = false
    #ignoreUpdates: boolean = false
    #publishFrom: Option<int> = Option.None
    #activeLayer: Option<LayerState> = Option.None

    constructor({boxGraph, boxes, conflict}: Construct<T>) {
        this.#boxGraph = boxGraph
        this.#conflict = Option.wrap(conflict)
        this.#boxes = boxes
        this.#updates = []
        this.#pathPrefix = YSync.#computePathPrefix(boxes)
        this.#generator = new YBytes.Generator(asDefined(boxes.doc, "Y.Map is not connect to Y.Doc").clientID)
        this.#terminator.ownAll(this.#setupYjs(), this.#setupOpenDAW())
    }

    isLocal(uuid: UUID.Bytes): boolean {return this.#layers.some(layer => layer.boxes.hasKey(uuid))}

    // the kind of local layer the current edit runs in
    get activeLayerKind(): Option<LocalLayerKind> {return this.#activeLayer.map(({kind}) => kind)}

    get clientID(): int {return this.#getDoc().clientID}
    // true while a peer's batch is written into the graph, the edits seen then are not this client's
    get applyingRemote(): boolean {return this.#applyingRemote}
    // what this client has received from every other client so far
    knownClocks(): Map<number, number> {return Y.decodeStateVector(Y.encodeStateVector(this.#getDoc()))}

    // who wrote the box (no field keys) or the field the document holds now
    writerOf(address: Address): Option<Y.ID> {
        const key = UUID.toString(address.uuid)
        if (address.fieldKeys.length === 0) {return Option.wrap(this.#boxes._map.get(key)?.id)}
        const boxObject = this.#boxes.get(key)
        if (!isInstanceOf(boxObject, Y.Map)) {return Option.None}
        const parent = this.#resolveFieldMap(boxObject, key, address.fieldKeys)
        return Option.wrap(parent?._map.get(String(address.fieldKeys[address.fieldKeys.length - 1]))?.id)
    }

    // a peer's batch arrived and stands, with the boxes it touched
    subscribeRemote(observer: Observer<ReadonlyArray<Box>>): Subscription {return this.#remote.subscribe(observer)}

    createLayer(kind: LocalLayerKind): LocalLayer {
        const layer: LayerState = {
            kind, boxes: UUID.newSet(uuid => uuid), hidden: UUID.newSet(uuid => uuid),
            fields: Address.newSet(address => address), invalid: new Notifier<void>()
        }
        this.#layers.push(layer)
        return {
            get hasChanges(): boolean {return YSync.#hasChanges(layer)},
            run: <R>(procedure: Provider<R>): R => this.#runInLayer(layer, procedure),
            revert: () => this.#revertLayers([layer]),
            publish: () => this.#publishLayer(layer),
            boxes: () => layer.boxes.values().flatMap(uuid => this.#boxGraph.findBox(uuid).mapOr(box => [box], [])),
            owns: (uuid: UUID.Bytes) => layer.boxes.hasKey(uuid),
            subscribeInvalid: (observer: Observer<void>) => layer.invalid.subscribe(observer),
            terminate: () => {
                const index = this.#layers.indexOf(layer)
                if (index >= 0) {this.#layers.splice(index, 1)}
            }
        }
    }

    terminate(): void {
        this.#layers.length = 0
        this.#terminator.terminate()
    }

    static #hasChanges({boxes, hidden, fields}: LayerState): boolean {
        return !boxes.isEmpty() || !hidden.isEmpty() || !fields.isEmpty()
    }

    get #previews(): ReadonlyArray<LayerState> {
        return this.#layers.filter(layer => layer.kind === "preview" && YSync.#hasChanges(layer))
    }

    #runInLayer<R>(layer: LayerState, procedure: Provider<R>): R {
        const outer = this.#activeLayer
        this.#activeLayer = Option.wrap(layer)
        const result = tryCatch(procedure)
        this.#activeLayer = outer
        if (result.status === "failure") {throw result.error}
        return result.value
    }

    // the graph returns to what the document holds now, not to what it held before the local edits
    #revertLayers(layers: ReadonlyArray<LayerState>): void {
        if (!layers.some(YSync.#hasChanges)) {return}
        assert(!this.#boxGraph.inTransaction(), "Cannot revert local edits inside a transaction")
        const result = tryCatch(() => {
            this.#boxGraph.beginTransaction()
            layers.forEach(layer => this.#revertInTransaction(layer))
            // a restored pointer can name what a peer deleted meanwhile, that repair belongs to the room
            this.#publishFrom = Option.wrap(this.#updates.length)
            this.#boxGraph.clearUnresolvablePointers()
            this.#boxGraph.endTransaction()
        })
        if (result.status === "failure") {
            this.#publishFrom = Option.None
            if (this.#boxGraph.inTransaction()) {this.#boxGraph.abortTransaction()}
            this.#boxGraph.beginTransaction()
            layers.forEach(layer => this.#revertInTransaction(layer))
            this.#publishFrom = Option.wrap(this.#updates.length)
            deterministicReconcile(this.#boxGraph)
            this.#boxGraph.endTransaction()
        }
        layers.forEach(YSync.#clearLayer)
    }

    #publishLayer(layer: LayerState): void {
        if (!YSync.#hasChanges(layer)) {return}
        assert(!this.#boxGraph.inTransaction(), "Cannot publish local edits inside a transaction")
        this.#getDoc().transact(() => {
            layer.boxes.values().forEach(uuid => {
                const key = UUID.toString(uuid)
                if (this.#boxes.has(key)) {return}
                this.#boxGraph.findBox(uuid).ifSome(box => this.#boxes.set(key, YMapper.createBoxMap(box, this.#generator.next())))
            })
            layer.hidden.values().forEach(uuid => this.#boxes.delete(UUID.toString(uuid)))
            layer.fields.values().forEach(address => this.#writeField(address))
        }, "[openDAW] updates")
        YSync.#clearLayer(layer)
    }

    #writeField(address: Address): void {
        const key = UUID.toString(address.uuid)
        const boxObject = this.#boxes.get(key)
        if (!isInstanceOf(boxObject, Y.Map)) {return}
        const parent = this.#resolveFieldMap(boxObject, key, address.fieldKeys)
        if (parent === undefined) {return}
        const fieldKey = String(address.fieldKeys[address.fieldKeys.length - 1])
        this.#boxGraph.findVertex(address).ifSome(vertex => vertex.accept({
            visitPointerField: (field: PointerField) =>
                parent.set(fieldKey, field.targetAddress.mapOr(target => target.toString(), null)),
            visitPrimitiveField: (field: PrimitiveField) => {
                const value = field.getValue()
                if (value instanceof Int8Array) {
                    YBytes.write(parent, fieldKey, value, this.#generator.next())
                } else {
                    parent.set(fieldKey, YMapper.toY(value))
                }
            }
        }))
    }

    static #clearLayer({boxes, hidden, fields}: LayerState): void {
        boxes.clear()
        hidden.clear()
        fields.clear()
    }

    #setupYjs(): Subscription {
        const eventHandler: EventHandler = (events, {origin, local}) => {
            const originLabel = typeof origin === "string" ? origin : "Unkown Origin"
            const isOwnOrigin = typeof origin === "string" && origin.startsWith("[openDAW]")
            const isHistoryReplay = typeof origin === "string" && origin.startsWith("[history]")
            console.debug(`got ${events.length} ${local ? "local" : "external"} updates from '${originLabel}', isHistoryReplay: ${isHistoryReplay}, isOwnOrigin: ${isOwnOrigin}`)
            if (isOwnOrigin || (local && !isHistoryReplay)) {return}
            this.#applyingRemote = true
            const applied = tryCatch(() => this.#applyRemote(events))
            this.#applyingRemote = false
            if (applied.status === "failure") {throw applied.error}
            applied.value.ifSome(touched => this.#remote.notify(touched))
        }
        this.#boxes.observeDeep(eventHandler)
        return {terminate: () => {this.#boxes.unobserveDeep(eventHandler)}}
    }

    #applyRemote(events: Array<Y.YEvent<any>>): Option<ReadonlyArray<Box>> {
        const previews = this.#previews
        // First attempt: apply the remote batch verbatim.
        this.#boxGraph.beginTransaction()
        const touched: Array<Box> = []
        const result = tryCatch(() => {
            touched.push(...this.#applyEvents(events))
            this.#assertResolvable(touched)
            // an optional pointer cut by a delete passes validation, the box left behind may still be unusable
            const broken = this.#cutPointers.find(({box}) => box.isAttached() && isInstrumentWithoutCapture(box))
            if (isDefined(broken)) {return panic(`${broken.box} lost its capture.`)}
            this.#ignoreUpdates = true
            this.#boxGraph.endTransaction()
            this.#ignoreUpdates = false
        })
        if (result.status === "failure") {
            this.#ignoreUpdates = false
            if (this.#boxGraph.inTransaction()) {
                this.#boxGraph.abortTransaction()
            }
            // The merged document is legal for Yjs but violates a box-graph invariant (e.g. two clients
            // concurrently attached pointers to an exclusive target). Rather than revert locally — which
            // forks the room, because each client reverts to its own different state — RE-APPLY the batch
            // and repair the violation with a function that is deterministic in the converged document
            // (see deterministicReconcile). Every client computes the same repair, so the graphs converge.
            //
            // The repair itself MUST be written back to the document (everything before `#publishFrom`
            // mirrors the incoming batch and stays suppressed). Kept local-only, it silently breaks the
            // 'graph equals document' invariant: the graph never re-derives an edge it dropped, so once the
            // document's violation clears by other means (a later write wins the field by LWW) the healed
            // peers hold a state no peer that never saw the violation, and no late joiner, can reproduce.
            const reconciled = tryCatch(() => {
                this.#boxGraph.beginTransaction()
                previews.forEach(layer => this.#revertInTransaction(layer))
                touched.splice(0, touched.length, ...this.#applyEvents(events))
                this.#publishFrom = Option.wrap(this.#updates.length)
                deterministicReconcile(this.#boxGraph)
                this.#boxGraph.endTransaction()
            })
            if (reconciled.status === "failure") {
                this.#publishFrom = Option.None
                this.#ignoreUpdates = false
                if (this.#boxGraph.inTransaction()) {
                    const aborted = tryCatch(() => this.#boxGraph.abortTransaction())
                    if (aborted.status === "failure") {console.warn("[YSync] Abort failed:", aborted.error)}
                }
                // Still illegal after reconciliation: revert locally (last resort). No inverse ops are
                // written back to Yjs (that would race the in-flight remote update into a retry loop).
                console.warn(`[YSync] Transaction rejected even after reconcile, reverted locally:`,
                    result.error, reconciled.error)
                const reverted = tryCatch(() => this.#revertLayers(previews))
                if (reverted.status === "failure") {console.warn("[YSync] Could not revert local edits:", reverted.error)}
                YSync.#invalidate(previews)
                return Option.None
            }
            console.debug(`[YSync] Transaction reconciled deterministically after:`, result.error)
            this.#repairTorn()
            YSync.#invalidate(previews)
            return Option.wrap(touched)
        }
        const hasConflict = (): boolean => this.#conflict.mapOr(check => check(), false)
        if (hasConflict() && previews.length > 0) {
            this.#revertLayers(previews)
            YSync.#invalidate(previews)
        }
        if (hasConflict()) {
            this.#rollbackTransaction(events)
            return Option.None
        }
        this.#repairTorn()
        return Option.wrap(touched)
    }

    // Replay one remote Yjs event batch into the (already open) box-graph transaction. Idempotent enough to
    // run twice: the first attempt applies verbatim; on a constraint failure the reconcile path aborts and
    // replays through here before repairing.
    #applyEvents(events: Array<Y.YEvent<any>>): ReadonlyArray<Box> {
        const touched: Array<Box> = []
        this.#touchedBytes.length = 0
        this.#cutPointers.length = 0
        for (const event of events) {
            const path = this.#normalizePath(event.path)
            // an event inside a chunked bytes field: its keys are chunks, not fields, the field is read whole
            const chunked = this.#bytesFieldAt(path)
            if (chunked !== null) {
                YMapper.fromY(chunked, this.#storedAt(path))
                this.#touchedBytes.push(chunked)
                touched.push(chunked.box)
                continue
            }
            const keys = event.changes.keys
            for (const [key, change] of keys.entries()) {
                if (YSync.debugging) {
                    console.debug(`${change.action} on ${path}:${key}`)
                }
                // concurrent writes to one field arrive as any action, the document holds the winner
                if (path.length > 0) {
                    assert(path.length >= 2, "Invalid path: must have at least 2 elements (uuid, 'fields').")
                    const uuid = String(path[0])
                    if (this.#boxGraph.findBox(UUID.parse(uuid)).isEmpty()) {
                        const hiding = this.#layers.find(layer => layer.hidden.hasKey(UUID.parse(uuid)))
                        if (hiding?.kind === "preview") {return panic(`A peer edited ${uuid}, which a preview replaced.`)}
                        // a repair dropped this box while a peer kept writing to it: the document decides
                        if (hiding === undefined && this.#boxes.has(uuid)) {touched.push(this.#createBox(uuid))}
                    } else if (change.action !== "delete") {
                        touched.push(this.#updateValue(path, key))
                    }
                } else if (change.action === "add" || change.action === "update") {
                    // an update here is a box recreated under its key: the map and all its values are new
                    touched.push(this.#createBox(key))
                } else if (change.action === "delete") {
                    this.#deleteBox(key)
                }
            }
        }
        return touched
    }

    // A batch can leave an edge naming a uuid no box occupies: the box map came back carrying its original
    // pointer values (an undo replay in the host app does exactly this), or a peer deleted the target
    // concurrently. Nothing downstream catches it, because endTransaction validates address PRESENCE, not
    // resolvability, so it commits here and surfaces much later as a panic in dependenciesOf. Throw instead,
    // which drops us into the reconcile path below and repairs it deterministically. Checked after the whole
    // batch: a box created early may legitimately point at one created later in the same batch.
    #assertResolvable(touched: ReadonlyArray<Box>): void {
        for (const box of touched) {
            if (!box.isAttached()) {continue}
            for (const [pointer, targetAddress] of box.outgoingEdges()) {
                if (this.#boxGraph.findVertex(targetAddress).isEmpty()) {
                    return panic(`Pointer ${pointer.toString()} targets ${targetAddress.toString()} (no such vertex).`)
                }
            }
        }
    }

    #createBox(key: string): Box {
        const map = this.#boxes.get(key) as Y.Map<unknown>
        const name = map.get("name") as keyof T
        const fields = map.get("fields") as Y.Map<unknown>
        const uuid = UUID.parse(key)
        const optBox = this.#boxGraph.findBox(UUID.parse(key))
        if (optBox.isEmpty()) {
            return this.#boxGraph.createBox(name, uuid, box => YMapper.applyFromBoxMap(box, fields))
        } else {
            console.debug(`Box '${key}' has already been created. Performing 'Upsert'.`)
            const box = optBox.unwrap()
            YMapper.applyFromBoxMap(box, fields)
            return box
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

    // the bytes field a Y.Map at `path` stores, if it is one
    #bytesFieldAt(path: ReadonlyArray<string | number>): ByteArrayField | null {
        if (path.length < 3) {return null}
        const vertex = this.#boxGraph.findVertex(YMapper.pathToAddress(path.slice(0, -1), String(path[path.length - 1]))).unwrapOrNull()
        return vertex instanceof ByteArrayField ? vertex : null
    }

    #storedAt(path: ReadonlyArray<string | number>): unknown {
        const [uuidAsString, fieldsKey, ...fieldKeys] = path
        const parent = YMapper.findMap((this.#boxes.get(String(uuidAsString)) as Y.Map<unknown>)
            .get(String(fieldsKey)) as Y.Map<unknown>, fieldKeys.slice(0, -1))
        return parent.get(String(fieldKeys[fieldKeys.length - 1]))
    }

    // a remote batch that left a chunked field torn: the client that owns the winning write puts its value back
    #repairTorn(): void {
        const fields = this.#touchedBytes.splice(0)
        if (fields.length === 0) {return}
        const client = this.#getDoc().clientID
        const repairs = fields.flatMap(field => {
            const stored = this.#storedField(field)
            if (!YBytes.isChunked(stored) || !YBytes.ownsRepair(YBytes.read(stored), client)) {return []}
            return [{stored, value: field.getValue()}]
        })
        if (repairs.length === 0) {return}
        this.#getDoc().transact(() => repairs.forEach(({stored, value}) => YBytes.repair(stored, value)), "[openDAW] repair")
    }

    #storedField(field: ByteArrayField): unknown {
        const key = UUID.toString(field.address.uuid)
        const boxObject = this.#boxes.get(key)
        if (!isInstanceOf(boxObject, Y.Map)) {return undefined}
        const parent = this.#resolveFieldMap(boxObject, key, field.address.fieldKeys)
        return parent?.get(String(field.address.fieldKeys[field.address.fieldKeys.length - 1]))
    }

    #updateValue(path: ReadonlyArray<string | number>, key: string): Box {
        const address = YMapper.pathToAddress(path, key)
        const vertex = this.#boxGraph.findVertex(address)
            .unwrap(`Vertex at '${address.toString()}' does not exist.`)
        const [uuidAsString, fieldsKey, ...fieldKeys] = path
        const targetMap = YMapper.findMap((this.#boxes
            .get(String(uuidAsString)) as Y.Map<unknown>)
            .get(String(fieldsKey)) as Y.Map<unknown>, fieldKeys)
        assert(vertex.isField(), "Vertex must be either Primitive or Pointer")
        const bytes = this.#bytesFieldAt([...path, key])
        if (bytes !== null) {this.#touchedBytes.push(bytes)}
        vertex.accept({
            visitField: (_: Field) => panic("Vertex must be either Primitive or Pointer"),
            visitArrayField: (_: ArrayField) => panic("Vertex must be either Primitive or Pointer"),
            visitObjectField: (_: ObjectField<any>) => panic("Vertex must be either Primitive or Pointer"),
            visitPointerField: (field: PointerField) => field.fromJSON(targetMap.get(key) as JSONValue),
            visitPrimitiveField: (field: PrimitiveField) => YMapper.fromY(field, targetMap.get(key))
        })
        return vertex.box
    }

    #deleteBox(key: string): void {
        const optBox = this.#boxGraph.findBox(UUID.parse(key))
        if (optBox.isEmpty()) {
            // Two peers can publish the same repair (a mandatory owner losing an exclusive target).
            console.debug(`Box '${key}' has already been deleted.`)
            return
        }
        const box = optBox.unwrap()
        box.outgoingEdges().forEach(([pointer]) => pointer.defer())
        box.incomingEdges().forEach(pointer => {
            this.#cutPointers.push(pointer)
            pointer.defer()
        })
        this.#boxGraph.unstageBox(box)
    }

    #revertInTransaction({boxes, hidden, fields}: LayerState): void {
        boxes.values().forEach(uuid => {
            const key = UUID.toString(uuid)
            const boxMap = this.#boxes.get(key)
            if (isInstanceOf(boxMap, Y.Map)) {
                this.#boxGraph.findBox(uuid).ifSome(box => YMapper.applyFromBoxMap(box, boxMap.get("fields") as Y.Map<unknown>))
            } else {
                this.#deleteBox(key)
            }
        })
        hidden.values().forEach(uuid => {
            const key = UUID.toString(uuid)
            if (this.#boxes.has(key) && this.#boxGraph.findBox(uuid).isEmpty()) {this.#createBox(key)}
        })
        fields.values().forEach(address => this.#restoreField(address))
    }

    #restoreField(address: Address): void {
        const key = UUID.toString(address.uuid)
        const boxObject = this.#boxes.get(key)
        if (!isInstanceOf(boxObject, Y.Map)) {return}
        const parent = this.#resolveFieldMap(boxObject, key, address.fieldKeys)
        const value = parent?.get(String(address.fieldKeys[address.fieldKeys.length - 1]))
        if (isUndefined(value)) {return}
        this.#boxGraph.findVertex(address).ifSome(vertex => vertex.accept({
            visitPointerField: (field: PointerField) => field.fromJSON(value as JSONValue),
            visitPrimitiveField: (field: PrimitiveField) => YMapper.fromY(field, value)
        }))
    }

    static #invalidate(layers: ReadonlyArray<LayerState>): void {
        layers.forEach(layer => {
            YSync.#clearLayer(layer)
            layer.invalid.notify()
        })
    }

    #withoutLocal(updates: ReadonlyArray<Update>): ReadonlyArray<Update> {
        if (this.#activeLayer.isEmpty() && !this.#layers.some(YSync.#hasChanges)) {return updates}
        const open = new Set(updates)
        let changed = true
        while (changed) {
            changed = false
            for (const update of open) {
                const layer = this.#activeLayer.unwrapOrNull() ?? this.#layers.find(layer => this.#dependsOn(layer, update))
                if (layer === undefined) {continue}
                YSync.#hold(layer, update)
                open.delete(update)
                changed = true
            }
        }
        return updates.filter(update => open.has(update))
    }

    #dependsOn({boxes}: LayerState, update: Update): boolean {
        switch (update.type) {
            case "new":
                return this.#boxGraph.findBox(update.uuid).mapOr(box => box.outgoingEdges()
                    .some(([_, target]) => boxes.hasKey(target.uuid))
                    || box.incomingEdges().some(pointer => boxes.hasKey(pointer.address.uuid)), false)
            case "delete":
                return boxes.hasKey(update.uuid)
            case "primitive":
                return boxes.hasKey(update.address.uuid)
            case "pointer":
                return boxes.hasKey(update.address.uuid)
                    || update.newAddress.mapOr(address => boxes.hasKey(address.uuid), false)
        }
    }

    static #hold({boxes, hidden, fields}: LayerState, update: Update): void {
        if (update.type === "new") {
            boxes.add(update.uuid)
        } else if (update.type === "delete") {
            if (!boxes.hasKey(update.uuid)) {hidden.add(update.uuid)}
            boxes.removeByKeyIfExist(update.uuid)
        } else if (!boxes.hasKey(update.address.uuid)) {
            fields.add(update.address)
        }
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
                    const pending = this.#updates.splice(0)
                    const publishFrom = this.#publishFrom
                    this.#publishFrom = Option.None
                    if (rolledBack) {return}
                    const publishing: ReadonlyArray<Update> = publishFrom
                        .mapOr(index => pending.slice(index), this.#ignoreUpdates ? [] : pending)
                    const optimized = this.#withoutLocal(optimizeUpdates(publishing))
                    if (optimized.length === 0) {return}
                    const result = tryCatch(() => this.#getDoc()
                        .transact(() => optimized.forEach(update => this.#applyUpdate(update)),
                            "[openDAW] updates"))
                    if (result.status === "failure") {
                        console.error("[YSync] flush failed, dropping updates", {
                            count: optimized.length,
                            error: result.error
                        })
                        throw result.error
                    }
                }
            }),
            this.#boxGraph.subscribeToAllUpdatesImmediate({
                onUpdate: (update: Update): unknown => this.#updates.push(update)
            })
        )
    }

    /**
     * TRANSFER ONE CHANGE FROM OPENDAW TO YJS
     */
    #applyUpdate(update: Update): void {
        if (update.type === "new") {
            const uuid = update.uuid
            const key = UUID.toString(uuid)
            const optBox = this.#boxGraph.findBox(uuid)
            if (optBox.isEmpty()) {
                // Phantom box: created and removed in same transaction.
                // optimizeUpdates should have filtered this, but guard in case.
                return
            }
            this.#boxes.set(key, YMapper.createBoxMap(optBox.unwrap(), this.#generator.next()))
        } else if (update.type === "primitive") {
            const key = UUID.toString(update.address.uuid)
            const boxObject = this.#boxes.get(key)
            if (!isInstanceOf(boxObject, Y.Map)) {
                console.warn(`[YSync] primitive update skipped: box '${key}' missing`)
                return
            }
            const field = this.#resolveFieldMap(boxObject, key, update.address.fieldKeys)
            if (field === undefined) {return}
            const fieldKey = String(update.address.fieldKeys[update.address.fieldKeys.length - 1])
            if (update.newValue instanceof Int8Array) {
                YBytes.write(field, fieldKey, update.newValue, this.#generator.next())
            } else {
                field.set(fieldKey, YMapper.toY(update.newValue))
            }
        } else if (update.type === "pointer") {
            const key = UUID.toString(update.address.uuid)
            const boxObject = this.#boxes.get(key)
            if (!isInstanceOf(boxObject, Y.Map)) {
                console.warn(`[YSync] pointer update skipped: box '${key}' missing`)
                return
            }
            const field = this.#resolveFieldMap(boxObject, key, update.address.fieldKeys)
            if (field === undefined) {return}
            field.set(String(update.address.fieldKeys[update.address.fieldKeys.length - 1]),
                update.newAddress.mapOr(address => address.toString(), null))
        } else if (update.type === "delete") {
            this.#boxes.delete(UUID.toString(update.uuid))
        }
    }

    /**
     * Walks from the box map down to the Y.Map that owns `fieldKeys[last]`.
     * Returns `undefined` (with a warning) instead of throwing if the path
     * cannot be resolved — protects the yjs transaction from partial writes.
     */
    #resolveFieldMap(boxObject: Y.Map<unknown>,
                     key: string,
                     fieldKeys: ArrayLike<number>): Y.Map<unknown> | undefined {
        const fieldsValue = boxObject.get("fields")
        if (!isInstanceOf(fieldsValue, Y.Map)) {
            console.warn(`[YSync] box '${key}' missing 'fields' Y.Map; skipping update`)
            return undefined
        }
        let field = fieldsValue as Y.Map<unknown>
        for (let i = 0; i < fieldKeys.length - 1; i++) {
            const next = field.get(String(fieldKeys[i]))
            if (!isInstanceOf(next, Y.Map)) {
                console.warn(`[YSync] box '${key}' field path broken at '${fieldKeys[i]}'; skipping update`)
                return undefined
            }
            field = next as Y.Map<unknown>
        }
        return field
    }

    #getDoc(): Y.Doc {
        return asDefined(this.#boxes.doc, "Y.Map is not connect to Y.Doc")
    }
}