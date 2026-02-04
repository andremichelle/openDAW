import {BoxGraph} from "./graph"
import {
    Arrays,
    assert,
    Editing,
    int,
    Maybe,
    Notifier,
    Observer,
    Option,
    Subscription,
    SyncProvider,
    UUID
} from "@opendaw/lib-std"
import {DeleteUpdate, NewUpdate, PointerUpdate, PrimitiveUpdate, Update} from "./updates"

// Removes updates for boxes that were created AND deleted in the same transaction.
const optimizeUpdates = (updates: ReadonlyArray<Update>): ReadonlyArray<Update> => {
    const createdUuids = UUID.newSet<UUID.Bytes>(uuid => uuid)
    const deletedUuids = UUID.newSet<UUID.Bytes>(uuid => uuid)
    for (const update of updates) {
        if (update instanceof NewUpdate) {
            createdUuids.add(update.uuid)
        } else if (update instanceof DeleteUpdate) {
            deletedUuids.add(update.uuid)
        }
    }
    const phantomUuids = UUID.newSet<UUID.Bytes>(uuid => uuid)
    for (const uuid of createdUuids.values()) {
        if (deletedUuids.hasKey(uuid)) {
            phantomUuids.add(uuid)
        }
    }
    if (phantomUuids.isEmpty()) {return updates}
    return updates.filter(update => {
        if (update instanceof NewUpdate || update instanceof DeleteUpdate) {
            return !phantomUuids.hasKey(update.uuid)
        } else if (update instanceof PointerUpdate || update instanceof PrimitiveUpdate) {
            return !phantomUuids.hasKey(update.address.uuid)
        }
        return true
    })
}

class Modification {
    readonly #updates: ReadonlyArray<Update>

    constructor(updates: ReadonlyArray<Update>) {this.#updates = updates}

    inverse(graph: BoxGraph): void {
        graph.beginTransaction()
        this.#updates.toReversed().forEach(update => update.inverse(graph))
        graph.endTransaction()
    }

    forward(graph: BoxGraph): void {
        graph.beginTransaction()
        this.#updates.forEach(update => update.forward(graph))
        graph.endTransaction()
    }
}

export interface ModificationProcess {
    approve(): void
    revert(): void
}

export class BoxEditing implements Editing {
    readonly #graph: BoxGraph
    readonly #pending: Array<Modification> = []
    readonly #marked: Array<ReadonlyArray<Modification>> = []
    readonly #notifier: Notifier<void>

    #modifying: boolean = false
    #inProcess: boolean = false
    #disabled: boolean = false
    #historyIndex: int = 0
    #savedHistoryIndex: int = 0 // -1 = saved state was spliced away, >= 0 = valid saved position

    constructor(graph: BoxGraph) {
        this.#graph = graph

        this.#notifier = new Notifier<void>()
    }

    get graph(): BoxGraph {return this.#graph}

    subscribe(observer: Observer<void>): Subscription {
        return this.#notifier.subscribe(observer)
    }

    markSaved(): void {
        if (this.#pending.length > 0) {this.mark()}
        this.#savedHistoryIndex = this.#historyIndex
    }

    hasUnsavedChanges(): boolean {
        if (this.#pending.length > 0) {return true}
        if (this.#savedHistoryIndex === -1) {return true}
        return this.#historyIndex !== this.#savedHistoryIndex
    }

    isEmpty(): boolean {return this.#marked.length === 0 && this.#pending.length === 0}

    clear(): void {
        assert(!this.#modifying, "Already modifying")
        Arrays.clear(this.#pending)
        Arrays.clear(this.#marked)
        this.#historyIndex = 0
        this.#savedHistoryIndex = 0
        this.#notifier.notify()
    }

    undo(): boolean {
        if (!this.canUndo()) {return false}
        if (this.#pending.length > 0) {this.mark()}
        console.debug("undo")
        const modifications = this.#marked[--this.#historyIndex]
        modifications.toReversed().forEach(step => step.inverse(this.#graph))
        this.#graph.edges().validateRequirements()
        this.#notifier.notify()
        return true
    }

    redo(): boolean {
        if (!this.canRedo()) {return false}
        console.debug("redo")
        this.#marked[this.#historyIndex++].forEach(step => step.forward(this.#graph))
        this.#graph.edges().validateRequirements()
        this.#notifier.notify()
        return true
    }

    canUndo(): boolean {
        if (this.#disabled) {return false}
        return this.#historyIndex !== 0 || this.#pending.length > 0
    }

    canRedo(): boolean {
        if (this.#disabled) {return false}
        if (this.#historyIndex === this.#marked.length) {return false}
        return this.#pending.length <= 0
    }

    // TODO This method exists to handle bidirectional sync between UI state and Box state.
    //  Problem: When a Box field changes (e.g., during undo/redo), reactive subscriptions may fire
    //  and attempt to call modify() to sync the UI state back to the Box. But since undo/redo
    //  already has a transaction open (via Modification.inverse/forward calling beginTransaction
    //  directly), calling modify() would fail with "Transaction already in progress".
    //  Current workaround: Callers check mustModify() before calling modify(). If false (transaction
    //  already open), they either skip the call or call setValue directly without recording history.
    //  See: EditWrapper.forValue, EditWrapper.forAutomatableParameter, TransportGroup loop sync.
    //  Better solution: Consider having Modification.inverse/forward use the same #modifying flag
    //  as modify(), or introduce a unified "modification context" that both undo/redo and user
    //  actions share. This would allow modify() to detect it's being called reactively during
    //  undo/redo and handle it internally, rather than requiring all callers to guard with mustModify().
    mustModify(): boolean {return !this.#graph.inTransaction()}

    modify<R>(modifier: SyncProvider<Maybe<R>>, mark: boolean = true): Option<R> {
        assert(!this.#inProcess, "Cannot call modify while a modification process is running")
        if (this.#modifying) {
            // Nested modify call - just execute without separate recording
            this.#notifier.notify()
            return Option.wrap(modifier())
        }
        if (mark && this.#pending.length > 0) {this.mark()}
        this.#modifying = true
        const updates: Array<Update> = []
        const subscription = this.#graph.subscribeToAllUpdates({
            onUpdate: (update: Update) => updates.push(update)
        })
        this.#graph.beginTransaction()
        const result = modifier()
        this.#graph.endTransaction()
        subscription.terminate()
        const optimized = optimizeUpdates(updates)
        if (optimized.length > 0) {
            this.#pending.push(new Modification(optimized))
        }
        this.#modifying = false
        this.#graph.edges().validateRequirements()
        if (mark) {this.mark()}
        this.#notifier.notify()
        return Option.wrap(result)
    }

    beginModification(): ModificationProcess {
        assert(!this.#modifying && !this.#inProcess, "Cannot begin modification while another is in progress")
        this.#modifying = true
        this.#inProcess = true
        const updates: Array<Update> = []
        const subscription = this.#graph.subscribeToAllUpdates({
            onUpdate: (update: Update) => updates.push(update)
        })
        this.#graph.beginTransaction()
        return {
            approve: () => {
                this.#graph.endTransaction()
                subscription.terminate()
                const optimized = optimizeUpdates(updates)
                if (optimized.length > 0) {
                    this.#pending.push(new Modification(optimized))
                }
                this.#modifying = false
                this.#inProcess = false
                this.#graph.edges().validateRequirements()
                this.mark()
                this.#notifier.notify()
            },
            revert: () => {
                this.#graph.endTransaction()
                subscription.terminate()
                this.#modifying = false
                this.#inProcess = false
                this.#graph.edges().validateRequirements()
                if (updates.length > 0) {
                    new Modification(updates).inverse(this.#graph)
                }
            }
        }
    }

    mark(): void {
        if (this.#pending.length === 0) {return}
        if (this.#marked.length - this.#historyIndex > 0) {
            if (this.#savedHistoryIndex > this.#historyIndex) {
                this.#savedHistoryIndex = -1
            }
            this.#marked.splice(this.#historyIndex)
        }
        this.#marked.push(this.#pending.splice(0))
        this.#historyIndex = this.#marked.length
    }

    clearPending(): void {
        if (this.#pending.length === 0) {return}
        this.#pending.reverse().forEach(modification => modification.inverse(this.#graph))
        this.#pending.length = 0
        this.#notifier.notify()
    }

    disable(): void {
        this.#disabled = true
    }
}