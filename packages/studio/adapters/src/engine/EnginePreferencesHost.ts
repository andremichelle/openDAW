import {Observer, PathTuple, Subscription, Terminable, Terminator, ValueAtPath, VirtualObject} from "@opendaw/lib-std"
import {queueTask} from "@opendaw/lib-dom"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {EnginePreferences, EngineSettings, EngineSettingsSchema} from "./EnginePreferencesSchema"
import {EnginePreferencesProtocol} from "./EnginePreferencesProtocol"

export class EnginePreferencesHost implements EnginePreferences, Terminable {
    readonly #terminator = new Terminator()
    readonly #observer: VirtualObject<EngineSettings>
    readonly #client: EnginePreferencesProtocol

    readonly #queueTask = queueTask(() => this.#client.updatePreferences(this.#observer.data))

    constructor(messenger: Messenger) {
        this.#observer = this.#terminator.own(new VirtualObject(EngineSettingsSchema.parse({})))
        this.#client = Communicator.sender<EnginePreferencesProtocol>(messenger,
            ({dispatchAndForget}) => new class implements EnginePreferencesProtocol {
                updatePreferences(preferences: EngineSettings): void {
                    dispatchAndForget(this.updatePreferences, preferences)
                }
            })
        this.#terminator.own(this.#observer.subscribeAll(this.#queueTask))
        this.#client.updatePreferences(this.#observer.data)
    }

    settings(): EngineSettings {return this.#observer.proxy}

    update(data: EngineSettings): void {this.#observer.update(data)}

    subscribe<P extends PathTuple<EngineSettings>>(
        observer: Observer<ValueAtPath<EngineSettings, P>>, ...path: P): Subscription {
        return this.#observer.subscribe(observer, ...path)
    }

    catchupAndSubscribe<P extends PathTuple<EngineSettings>>(
        observer: Observer<ValueAtPath<EngineSettings, P>>, ...path: P): Subscription {
        return this.#observer.catchupAndSubscribe(observer, ...path)
    }

    subscribeAll(observer: Observer<keyof EngineSettings>): Subscription {
        return this.#observer.subscribeAll(observer)
    }

    terminate(): void {this.#terminator.terminate()}
}
