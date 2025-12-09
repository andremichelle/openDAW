import {BoxGraph} from "./graph"
import {Arrays, assert, Editing, int, Maybe, Option, Provider, SyncProvider} from "@opendaw/lib-std"
import {Update} from "./updates"

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

    #modifying: boolean = false
    #disabled: boolean = false
    #historyIndex: int = 0
    #savedHistoryIndex: int = 0 // -1 = saved state was spliced away, >= 0 = valid saved position

    constructor(graph: BoxGraph) {
        this.#graph = graph
    }

    get graph(): BoxGraph {return this.#graph}

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
    }

    undo(): boolean {
        if (this.#disabled) {return false}
        if (this.#pending.length > 0) {this.mark()}
        if (this.#historyIndex === 0) {return false}
        const modifications = this.#marked[--this.#historyIndex]
        modifications.toReversed().forEach(step => step.inverse(this.#graph))
        this.#graph.edges().validateRequirements()
        return true
    }

    redo(): boolean {
        if (this.#disabled) {return false}
        if (this.#historyIndex === this.#marked.length) {return false}
        if (this.#pending.length > 0) {
            console.warn("redo while having pending updates?")
            return false
        }
        this.#marked[this.#historyIndex++].forEach(step => step.forward(this.#graph))
        this.#graph.edges().validateRequirements()
        return true
    }

    // TODO This is an option to clarify, if user actions meant to be run by a modifier or not.
    //  See ParameterWrapper. Not the nicest solution. Probably coming back to this sooner or later.
    mustModify(): boolean {return !this.#graph.inTransaction()}

    modify<R>(modifier: SyncProvider<Maybe<R>>, mark: boolean = true): Option<R> {
        if (this.#modifying) {
            // we just keep adding new pending updates
            return Option.wrap(modifier())
        }
        if (mark && this.#pending.length > 0) {this.mark()}
        const result = Option.wrap(this.#modify(modifier))
        if (mark) {this.mark()}
        return result
    }

    beginModification(): ModificationProcess {
        const alreadyIntransaction = this.#graph.inTransaction()
        if (!alreadyIntransaction) {
            this.#graph.beginTransaction()
        }
        this.#modifying = true
        const complete = () => {
            this.#modifying = false
            if (!alreadyIntransaction) {
                this.#graph.endTransaction()
                this.#graph.edges().validateRequirements()
            }
        }
        return {
            approve: complete,
            revert: () => {
                this.clearPending()
                complete()
            }
        }
    }

    #modify<R>(modifier: Provider<Maybe<R>>): Maybe<R> {
        assert(!this.#modifying, "Already modifying")
        this.#modifying = true
        const updates: Array<Update> = []
        const subscription = this.#graph.subscribeToAllUpdates({onUpdate: (update: Update) => {updates.push(update)}})
        this.#graph.beginTransaction()
        const result = modifier()
        this.#graph.endTransaction()
        if (updates.length > 0) {
            this.#pending.push(new Modification(updates))
        }
        subscription.terminate()
        this.#modifying = false
        this.#graph.edges().validateRequirements()
        return result
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
    }

    disable(): void {
        this.#disabled = true
    }
}