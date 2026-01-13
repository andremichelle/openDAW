import {Func, isDefined, Observer, Subscription, Terminable} from "@moises-ai/lib-std"
import {BoxGraph, Update} from "@moises-ai/lib-box"
import {Project} from "../project/Project"
import {Commit} from "./Commit"

export class SyncLogWriter implements Terminable {
    static attach(project: Project, observer: Observer<Commit>, lastCommit?: Commit): SyncLogWriter {
        console.debug("SyncLogWriter.attach", project.rootBox.created.getValue(), isDefined(lastCommit) ? "append" : "new")
        return project.own(new SyncLogWriter(project, observer, lastCommit))
    }

    readonly #observer: Observer<Commit>
    readonly #subscription: Subscription

    #transactionSubscription: Subscription = Terminable.Empty
    #lastPromise: Promise<Commit>

    private constructor(project: Project, observer: Observer<Commit>, lastCommit?: Commit) {
        this.#observer = observer

        this.#lastPromise = Promise.resolve<Commit>(lastCommit ?? Commit.createFirst(project).then(commit => {
            this.#observer(commit)
            return commit
        }))
        this.#appendCommit(previous => Commit.createOpen(previous.thisHash))
        this.#subscription = this.#listen(project.boxGraph)
    }

    terminate(): void {
        console.debug("SyncLogWriter.terminate")
        this.#subscription.terminate()
    }

    #appendCommit(factory: Func<Commit, Promise<Commit>>): Promise<Commit> {
        return this.#lastPromise = this.#lastPromise.then(async (previous) => {
            const commit = await factory(previous)
            this.#observer(commit)
            return commit
        })
    }

    #listen(boxGraph: BoxGraph): Subscription {
        let updates: Array<Update> = []
        return boxGraph.subscribeTransaction({
            onBeginTransaction: () =>
                this.#transactionSubscription =
                    boxGraph.subscribeToAllUpdatesImmediate({onUpdate: (update: Update) => updates.push(update)}),
            onEndTransaction: () => {
                this.#transactionSubscription.terminate()
                this.#transactionSubscription = Terminable.Empty
                if (updates.length === 0) {return}
                const ref = updates
                updates = []
                this.#appendCommit(previous => Commit.createUpdate(previous.thisHash, ref))
            }
        })
    }
}