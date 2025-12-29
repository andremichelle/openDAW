import {
    Observer,
    PathTuple,
    PropertyObserver,
    Subscription,
    Terminable,
    Terminator,
    ValueAtPath
} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {EnginePreferences, EnginePreferencesSchema} from "./EnginePreferencesSchema"
import {EnginePreferencesProtocol} from "./EnginePreferencesProtocol"

export class EnginePreferencesMain implements Terminable {
    readonly #terminator = new Terminator()
    readonly #connections: Array<EnginePreferencesProtocol> = []
    readonly #observer: PropertyObserver<EnginePreferences>

    #pendingBroadcast = false

    constructor() {
        this.#observer = this.#terminator.own(new PropertyObserver(EnginePreferencesSchema.parse({})))
        this.#terminator.own(this.#observer.subscribe(() => this.#scheduleBroadcast()))
    }

    get values(): EnginePreferences {return this.#observer.proxy}

    connect(messenger: Messenger): Terminable {
        const sender = Communicator.sender<EnginePreferencesProtocol>(messenger,
            ({dispatchAndForget}) => new class implements EnginePreferencesProtocol {
                updatePreferences(preferences: EnginePreferences): void {
                    dispatchAndForget(this.updatePreferences, preferences)
                }
            })
        this.#connections.push(sender)
        sender.updatePreferences(structuredClone(this.#observer.data))
        return {
            terminate: () => {
                const index = this.#connections.indexOf(sender)
                if (index !== -1) {this.#connections.splice(index, 1)}
            }
        }
    }

    catchupAndSubscribe<P extends PathTuple<EnginePreferences>>(
        observer: Observer<ValueAtPath<EnginePreferences, P>>, ...path: P): Subscription {
        return this.#observer.catchupAndSubscribe(observer, ...path)
    }

    terminate(): void {
        this.#terminator.terminate()
    }

    readonly #scheduleBroadcast = (): void => {
        if (this.#pendingBroadcast) {return}
        this.#pendingBroadcast = true
        queueMicrotask(() => {
            this.#pendingBroadcast = false
            this.#broadcast()
        })
    }

    readonly #broadcast = (): void => {
        const snapshot = structuredClone(this.#observer.data)
        for (const connection of this.#connections) {
            connection.updatePreferences(snapshot)
        }
    }
}
