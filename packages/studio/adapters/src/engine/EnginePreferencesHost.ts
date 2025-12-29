import {
    Arrays,
    Observer,
    PathTuple,
    VirtualObject,
    Subscription,
    Terminable,
    Terminator,
    ValueAtPath
} from "@opendaw/lib-std"
import {queueTask} from "@opendaw/lib-dom"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {EnginePreferences, EnginePreferencesSchema} from "./EnginePreferencesSchema"
import {EnginePreferencesProtocol} from "./EnginePreferencesProtocol"

export class EnginePreferencesHost implements Terminable {
    readonly #terminator = new Terminator()
    readonly #clients: Array<EnginePreferencesProtocol> = []
    readonly #observer: VirtualObject<EnginePreferences>

    readonly #queueTask = queueTask(() =>
        this.#clients.forEach(connection => connection.updatePreferences(this.#observer.data)))

    constructor() {
        this.#observer = this.#terminator.own(new VirtualObject(EnginePreferencesSchema.parse({})))
        this.#terminator.own(this.#observer.subscribe(this.#queueTask))
    }

    get settings(): EnginePreferences {return this.#observer.proxy}

    connect(messenger: Messenger): Terminable {
        const client = Communicator.sender<EnginePreferencesProtocol>(messenger,
            ({dispatchAndForget}) => new class implements EnginePreferencesProtocol {
                updatePreferences(preferences: EnginePreferences): void {
                    dispatchAndForget(this.updatePreferences, preferences)
                }
            })
        this.#clients.push(client)
        client.updatePreferences(this.#observer.data)
        return {terminate: () => Arrays.remove(this.#clients, client)}
    }

    catchupAndSubscribe<P extends PathTuple<EnginePreferences>>(
        observer: Observer<ValueAtPath<EnginePreferences, P>>, ...path: P): Subscription {
        return this.#observer.catchupAndSubscribe(observer, ...path)
    }

    terminate(): void {this.#terminator.terminate()}
}