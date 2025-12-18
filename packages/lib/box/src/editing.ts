import {BoxGraph} from "./graph"
import {Arrays, assert, Editing, int, Maybe, Option, SyncProvider} from "@opendaw/lib-std"
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
    #inProcess: boolean = false
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
        assert(!this.#inProcess, "Cannot call modify while a modification process is running")
        if (this.#modifying) {
            // Nested modify call - just execute without separate recording
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
        if (updates.length > 0) {
            this.#pending.push(new Modification(updates))
        }
        this.#modifying = false
        this.#graph.edges().validateRequirements()
        if (mark) {this.mark()}
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
                if (updates.length > 0) {
                    this.#pending.push(new Modification(updates))
                }
                this.#modifying = false
                this.#inProcess = false
                this.#graph.edges().validateRequirements()
                this.mark()
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
    }

    disable(): void {
        this.#disabled = true
    }
}