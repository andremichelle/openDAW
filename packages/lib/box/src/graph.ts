import {
    asDefined,
    assert,
    ByteArrayInput,
    ByteArrayOutput,
    Checksum,
    Exec,
    int,
    isDefined,
    JSONValue,
    Listeners,
    Option,
    panic,
    Predicate,
    Predicates,
    Procedure,
    SortedSet,
    Subscription,
    UUID
} from "@opendaw/lib-std"
import {Address} from "./address"
import {Vertex} from "./vertex"
import {PointerField} from "./pointer"
import {PrimitiveField, PrimitiveValues} from "./primitive"
import {ObjectField} from "./object"
import {Box} from "./box"
import {Field} from "./field"
import {ArrayField} from "./array"
import {DeleteUpdate, FieldUpdate, NewUpdate, PointerUpdate, PrimitiveUpdate, Update} from "./updates"
import {Dispatchers, Propagation} from "./dispatchers"
import {GraphEdges} from "./graph-edges"

export type BoxFactory<BoxMap> = (name: keyof BoxMap,
                                  graph: BoxGraph<BoxMap>,
                                  uuid: UUID.Bytes,
                                  constructor: Procedure<Box>) => Box

export interface TransactionListener {
    onBeginTransaction(): void
    onEndTransaction(): void
}

export interface UpdateListener {
    onUpdate(update: Update): void
}

export type Dependencies = { boxes: Iterable<Box>, pointers: Iterable<PointerField> }

export class BoxGraph<BoxMap = any> {
    readonly #boxFactory: Option<BoxFactory<BoxMap>>
    readonly #boxes: SortedSet<Readonly<Uint8Array>, Box>
    readonly #deferredPointerUpdates: Array<{ pointerField: PointerField, update: PointerUpdate }>
    readonly #updateListeners: Listeners<UpdateListener>
    readonly #immediateUpdateListeners: Listeners<UpdateListener>
    readonly #transactionListeners: Listeners<TransactionListener>
    readonly #dispatchers: Dispatchers<FieldUpdate>
    readonly #edges: GraphEdges
    readonly #pointerTransactionState: SortedSet<Address, {
        pointer: PointerField,
        initial: Option<Address>,
        final: Option<Address>,
        index: int
    }>
    readonly #finalizeTransactionObservers: Array<Exec>
    readonly #deletionListeners: SortedSet<UUID.Bytes, { uuid: UUID.Bytes, listeners: Set<Exec> }>

    #inTransaction: boolean = false
    #constructingBox: boolean = false

    constructor(boxFactory: Option<BoxFactory<BoxMap>> = Option.None) {
        this.#boxFactory = boxFactory
        this.#boxes = UUID.newSet<Box>(box => box.address.uuid)
        this.#deferredPointerUpdates = []
        this.#dispatchers = Dispatchers.create()
        this.#updateListeners = new Listeners<UpdateListener>()
        this.#immediateUpdateListeners = new Listeners<UpdateListener>()
        this.#transactionListeners = new Listeners<TransactionListener>()
        this.#edges = new GraphEdges()
        this.#pointerTransactionState = Address.newSet(({pointer}) => pointer.address)
        this.#finalizeTransactionObservers = []
        this.#deletionListeners = UUID.newSet<{ uuid: UUID.Bytes, listeners: Set<Exec> }>(entry => entry.uuid)
    }

    beginTransaction(): void {
        assert(!this.#inTransaction, "Transaction already in progress")
        this.#inTransaction = true
        this.#transactionListeners.proxy.onBeginTransaction()
    }

    endTransaction(): void {
        assert(this.#inTransaction, "No transaction in progress")
        if (this.#deferredPointerUpdates.length > 0) {
            this.#deferredPointerUpdates.forEach(({pointerField, update}) =>
                this.#processPointerVertexUpdate(pointerField, update))
            this.#deferredPointerUpdates.length = 0
        }
        this.#pointerTransactionState.values()
            .toSorted((a, b) => a.index - b.index)
            .forEach(({pointer, initial, final}) => {
                if (!initial.equals(final)) {
                    initial.ifSome(address => this.findVertex(address).unwrapOrUndefined()?.pointerHub.onRemoved(pointer))
                    final.ifSome(address => this.findVertex(address).unwrapOrUndefined()?.pointerHub.onAdded(pointer))
                }
            })
        this.#pointerTransactionState.clear()
        this.#inTransaction = false
        // it is possible that new observers will be added while executing
        while (this.#finalizeTransactionObservers.length > 0) {
            this.#finalizeTransactionObservers.splice(0).forEach(observer => observer())
            if (this.#finalizeTransactionObservers.length > 0) {
                console.debug(`${this.#finalizeTransactionObservers.length} new observers while notifying`)
            }
        }
        this.#transactionListeners.proxy.onEndTransaction()
    }

    inTransaction(): boolean {return this.#inTransaction}
    constructingBox(): boolean {return this.#constructingBox}

    createBox(name: keyof BoxMap, uuid: UUID.Bytes, constructor: Procedure<Box>): Box {
        return this.#boxFactory.unwrap("No box-factory installed")(name as keyof BoxMap, this, uuid, constructor)
    }

    stageBox<B extends Box>(box: B, constructor?: Procedure<B>): B {
        this.#assertTransaction()
        assert(!this.#constructingBox, "Cannot construct box while other box is constructing")
        if (isDefined(constructor)) {
            this.#constructingBox = true
            constructor(box)
            this.#constructingBox = false
        }
        const added = this.#boxes.add(box)
        assert(added, () => `${box.name} ${box.address.toString()} already staged`)
        const update = new NewUpdate(box.address.uuid, box.name, box.toArrayBuffer())
        this.#updateListeners.proxy.onUpdate(update)
        this.#immediateUpdateListeners.proxy.onUpdate(update)
        return box
    }

    subscribeTransaction(listener: TransactionListener): Subscription {
        return this.#transactionListeners.subscribe(listener)
    }

    subscribeToAllUpdates(listener: UpdateListener): Subscription {
        return this.#updateListeners.subscribe(listener)
    }

    subscribeToAllUpdatesImmediate(listener: UpdateListener): Subscription {
        return this.#immediateUpdateListeners.subscribe(listener)
    }

    subscribeVertexUpdates(propagation: Propagation, address: Address, procedure: Procedure<Update>): Subscription {
        return this.#dispatchers.subscribe(propagation, address, procedure)
    }

    subscribeEndTransaction(observer: Exec): void {this.#finalizeTransactionObservers.push(observer)}

    subscribeDeletion(uuid: UUID.Bytes, listener: Exec): Subscription {
        const entry = this.#deletionListeners.getOrCreate(uuid, () => ({uuid, listeners: new Set()}))
        entry.listeners.add(listener)
        return {
            terminate: () => {
                entry.listeners.delete(listener)
                if (entry.listeners.size === 0) {
                    this.#deletionListeners.removeByKeyIfExist(uuid)
                }
            }
        }
    }

    unstageBox(box: Box): void {
        this.#assertTransaction()
        const deleted = this.#boxes.removeByKey(box.address.uuid)
        assert(deleted === box, `${box} could not be found to unstage`)
        this.#edges.unwatchVerticesOf(box)
        const update = new DeleteUpdate(box.address.uuid, box.name, box.toArrayBuffer())
        this.#deletionListeners.removeByKeyIfExist(box.address.uuid)?.listeners.forEach(listener => listener())
        this.#updateListeners.proxy.onUpdate(update)
        this.#immediateUpdateListeners.proxy.onUpdate(update)
    }

    findBox<B extends Box = Box>(uuid: UUID.Bytes): Option<B> {
        return this.#boxes.opt(uuid) as Option<B>
    }

    findVertex(address: Address): Option<Vertex> {
        return this.#boxes.opt(address.uuid).flatMap(box => box.searchVertex(address.fieldKeys))
    }

    boxes(): ReadonlyArray<Box> {return this.#boxes.values()}

    edges(): GraphEdges {return this.#edges}

    checksum(): Int8Array {
        const checksum = new Checksum()
        this.boxes().forEach(box => box.write(checksum))
        return checksum.result()
    }

    onPrimitiveValueUpdate<V extends PrimitiveValues>(field: PrimitiveField<V, any>, oldValue: V, newValue: V): void {
        this.#assertTransaction()
        if (field.isAttached() && !this.#constructingBox) {
            const update = new PrimitiveUpdate<V>(field.address, field.serialization(), oldValue, newValue)
            this.#dispatchers.dispatch(update)
            this.#updateListeners.proxy.onUpdate(update)
            this.#immediateUpdateListeners.proxy.onUpdate(update)
        }
    }

    onPointerAddressUpdated(pointerField: PointerField, oldValue: Option<Address>, newValue: Option<Address>): void {
        this.#assertTransaction()
        if (oldValue.nonEmpty()) {this.#edges.disconnect(pointerField)}
        if (newValue.nonEmpty()) {this.#edges.connect(pointerField, newValue.unwrap())}
        const update = new PointerUpdate(pointerField.address, oldValue, newValue)
        if (this.#constructingBox) {
            this.#deferredPointerUpdates.push({pointerField, update})
        } else {
            this.#processPointerVertexUpdate(pointerField, update)
            this.#immediateUpdateListeners.proxy.onUpdate(update)
        }
    }

    #processPointerVertexUpdate(pointerField: PointerField, update: PointerUpdate): void {
        const {oldAddress, newAddress} = update
        pointerField.resolvedTo(newAddress.flatMap(address => this.findVertex(address)))
        const optState = this.#pointerTransactionState.opt(pointerField.address)
        optState.match<unknown>({
            none: () => this.#pointerTransactionState.add({
                pointer: pointerField,
                initial: oldAddress,
                final: newAddress,
                index: this.#pointerTransactionState.size()
            }),
            some: state => state.final = newAddress
        })
        this.#dispatchers.dispatch(update)
        this.#updateListeners.proxy.onUpdate(update)
    }

    findOrphans(rootBox: Box): ReadonlyArray<Box> {
        const connectedBoxes = this.#collectAllConnectedBoxes(rootBox)
        return this.boxes().filter(box => !connectedBoxes.has(box))
    }

    #collectAllConnectedBoxes(rootBox: Box): Set<Box> {
        const visited = new Set<Box>()
        const queue: Array<Box> = [rootBox]
        while (queue.length > 0) {
            const box = queue.pop()!
            if (visited.has(box)) {continue}
            visited.add(box)
            this.#collectPointersFromBox(box).forEach(pointer => {
                pointer.targetAddress.ifSome(address => {
                    this.findBox(address.uuid).ifSome(targetBox => {
                        if (!visited.has(targetBox)) {
                            queue.push(targetBox)
                        }
                    })
                })
            })
            for (const pointer of box.incomingEdges()) {
                if (!visited.has(pointer.box)) {
                    queue.push(pointer.box)
                }
            }
        }
        return visited
    }

    #collectPointersFromBox(box: Box): Array<PointerField> {
        const pointers: Array<PointerField> = []
        const collectFromFields = (fields: ReadonlyArray<Field>): void => {
            for (const field of fields) {
                field.accept({
                    visitPointerField: (p: PointerField) => pointers.push(p),
                    visitObjectField: (o: ObjectField<any>) => collectFromFields(o.fields()),
                    visitArrayField: (a: ArrayField) => collectFromFields(a.fields())
                })
            }
        }
        collectFromFields(box.fields())
        return pointers
    }

    dependenciesOf(box: Box, options: {
        excludeBox?: Predicate<Box>
        alwaysFollowMandatory?: boolean
        stopAtResources?: boolean
    } = {}): Dependencies {
        const excludeBox = isDefined(options.excludeBox) ? options.excludeBox : Predicates.alwaysFalse
        const alwaysFollowMandatory = isDefined(options.alwaysFollowMandatory) ? options.alwaysFollowMandatory : false
        const stopAtResources = isDefined(options.stopAtResources) ? options.stopAtResources : false
        const boxes = new Set<Box>()
        const pointers = new Set<PointerField>()
        const trace = (box: Box, isStartingBox: boolean = false): void => {
            // Don't apply excludeBox to the starting box - only to its dependencies
            if (boxes.has(box) || (!isStartingBox && excludeBox(box))) {return}
            boxes.add(box)
            // Handle resource boxes especially when stopAtResources is enabled
            if (stopAtResources && isDefined(box.resource)) {
                // Resource boxes are endpoints, but we still need their "children"
                // Children = boxes that point to FIELDS within this box (not the box itself)
                box.incomingEdges()
                    .forEach(pointer => {
                        pointers.add(pointer)
                        // Only follow if a pointer targets a FIELD (child), not the BOX (user)
                        const targetsField = pointer.targetAddress.mapOr(address => !address.isBox(), false)
                        if (pointer.mandatory && targetsField) {
                            // For shared resources, skip pointers to mandatory (ownership) fields
                            if (box.resource === "shared") {
                                const isOwnershipField = pointer.targetAddress
                                    .flatMap(address => this.findVertex(address))
                                    .mapOr(vertex => vertex.pointerRules.mandatory, false)
                                if (isOwnershipField) {return}
                            }
                            trace(pointer.box)
                        }
                    })
                // Don't trace outgoing edges - resources are endpoints
                return
            }
            // Normal box traversal
            box.outgoingEdges()
                .filter(([pointer]) => !pointers.has(pointer))
                .forEach(([source, targetAddress]: [PointerField, Address]) => {
                    const targetVertex = this.findVertex(targetAddress)
                        .unwrap(`Could not find target of ${source.toString()}`)
                    pointers.add(source)
                    if (targetVertex.pointerRules.mandatory &&
                        (alwaysFollowMandatory || targetVertex.pointerHub.incoming()
                            // Only check pointers to this specific address, not to other fields in the box
                            .filter(p => p.targetAddress.mapOr(address => address.equals(targetAddress), false))
                            .every(pointer => pointers.has(pointer)))) {
                        return trace(targetVertex.box)
                    }
                })
            box.incomingEdges()
                .forEach(pointer => {
                    pointers.add(pointer)
                    if (pointer.mandatory) {
                        trace(pointer.box)
                    }
                })
        }
        trace(box, true)
        boxes.delete(box)
        return {boxes, pointers: Array.from(pointers).reverse()}
    }

    verifyPointers(): { count: int } {
        this.#edges.validateRequirements()
        let count = 0 | 0
        const verify = (vertex: Vertex) => {
            for (const field of vertex.fields()) {
                field.accept({
                    visitPointerField: (pointer: PointerField) => {
                        if (pointer.targetAddress.nonEmpty()) {
                            const isResolved = pointer.targetVertex.nonEmpty()
                            const inGraph = this.findVertex(pointer.targetAddress.unwrap()).nonEmpty()
                            assert(isResolved, `pointer ${pointer.address} is broken`)
                            assert(inGraph, `Cannot find target for pointer ${pointer.address}`)
                            count++
                        }
                    },
                    visitObjectField: (object: ObjectField<any>) => verify(object)
                })
            }
        }
        this.#boxes.forEach((box: Box): void => verify(box))
        console.debug("verification complete.")
        return {count}
    }

    debugBoxes(): void {
        console.table(this.#boxes.values().reduce((dict: any, box) => {
            dict[UUID.toString(box.address.uuid)] = {
                class: box.name,
                "incoming links": box.incomingEdges().length,
                "outgoing links": box.outgoingEdges().length,
                "est. memory (bytes)": box.estimateMemory()
            }
            return dict
        }, {}))
    }

    debugDependencies(): void {
        console.debug("Dependencies:")
        this.boxes().forEach(box => {
            console.debug(`\t${box}`)
            for (const dependency of this.dependenciesOf(box).boxes) {
                console.debug(`\t\t${dependency}`)
            }
        })
    }

    addressToDebugPath(address: Option<Address>): Option<string> {
        return address.flatMap(address =>
            address.isBox()
                ? this.findBox(address.uuid).map(box => box.name)
                : this.findBox(address.uuid)
                    .flatMap(box => box.searchVertex(address.fieldKeys)
                        .map(vertex => vertex.isField() ? vertex.debugPath : panic("Unknown address"))))
    }

    toArrayBuffer(): ArrayBufferLike {
        const output = ByteArrayOutput.create()
        const boxes = this.#boxes.values()
        output.writeInt(boxes.length)
        boxes.forEach(box => {
            const buffer = box.serialize()
            output.writeInt(buffer.byteLength)
            output.writeBytes(new Int8Array(buffer))
        })
        return output.toArrayBuffer()
    }

    fromArrayBuffer(arrayBuffer: ArrayBufferLike): void {
        assert(this.#boxes.isEmpty(), "Cannot call fromArrayBuffer if boxes is not empty")
        const input = new ByteArrayInput(arrayBuffer)
        const numBoxes = input.readInt()
        this.beginTransaction()
        const boxes: Array<{
            creationIndex: int,
            name: keyof BoxMap,
            uuid: UUID.Bytes,
            boxStream: ByteArrayInput
        }> = []
        for (let i = 0; i < numBoxes; i++) {
            const length = input.readInt()
            const int8Array = new Int8Array(length)
            input.readBytes(int8Array)
            const boxStream = new ByteArrayInput(int8Array.buffer)
            const creationIndex = boxStream.readInt()
            const name = boxStream.readString() as keyof BoxMap
            const uuid = UUID.fromDataInput(boxStream)
            boxes.push({creationIndex, name, uuid, boxStream})
        }
        boxes
            .sort((a, b) => a.creationIndex - b.creationIndex)
            .forEach(({name, uuid, boxStream}) => this.createBox(name, uuid, box => box.read(boxStream)))
        this.endTransaction()
    }

    toJSON(): JSONValue {
        const result: Record<string, { name: string, fields: JSONValue }> = {}
        for (const box of this.#boxes.values()) {
            result[box.address.toString()] = {
                name: box.name,
                fields: asDefined(box.toJSON())
            }
        }
        return result
    }

    fromJSON(value: JSONValue): void {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return panic("Expected object")
        }
        this.beginTransaction()
        const entries = Object.entries(value as Record<string, { name: string, fields: JSONValue }>)
        for (const [uuid, {name, fields}] of entries) {
            this.createBox(name as keyof BoxMap, UUID.parse(uuid), box => box.fromJSON(fields))
        }
        this.endTransaction()
    }

    #assertTransaction(): void {
        assert(this.#inTransaction, () => "Modification only prohibited in transaction mode.")
    }
}