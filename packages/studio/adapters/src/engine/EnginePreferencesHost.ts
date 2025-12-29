import {MutableObservableValue, Observer, PathTuple, Subscription, Terminable, Terminator, ValueAtPath, VirtualObject} from "@opendaw/lib-std"
import {queueTask} from "@opendaw/lib-dom"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {EngineSettings, EngineSettingsSchema} from "./EnginePreferencesSchema"
import {EnginePreferencesProtocol} from "./EnginePreferencesProtocol"
import {EnginePreferences} from "./EnginePreferences"

export class EnginePreferencesHost implements EnginePreferences, Terminable {
    readonly #terminator = new Terminator()
    readonly #object: VirtualObject<EngineSettings>
    readonly #client: EnginePreferencesProtocol

    readonly #queueTask = queueTask(() => this.#client.updatePreferences(this.#object.data))

    constructor(messenger: Messenger) {
        this.#object = this.#terminator.own(new VirtualObject(EngineSettingsSchema.parse({})))
        this.#client = Communicator.sender<EnginePreferencesProtocol>(messenger,
            ({dispatchAndForget}) => new class implements EnginePreferencesProtocol {
                updatePreferences(preferences: EngineSettings): void {
                    dispatchAndForget(this.updatePreferences, preferences)
                }
            })
        this.#terminator.own(this.#object.subscribeAll(this.#queueTask))
        this.#client.updatePreferences(this.#object.data)
    }

    get settings(): EngineSettings {return this.#object.proxy}

    update(data: EngineSettings): void {this.#object.update(data)}

    subscribe<P extends PathTuple<EngineSettings>>(
        observer: Observer<ValueAtPath<EngineSettings, P>>, ...path: P): Subscription {
        return this.#object.subscribe(observer, ...path)
    }

    catchupAndSubscribe<P extends PathTuple<EngineSettings>>(
        observer: Observer<ValueAtPath<EngineSettings, P>>, ...path: P): Subscription {
        return this.#object.catchupAndSubscribe(observer, ...path)
    }

    createMutableObservableValue<P extends PathTuple<EngineSettings>>(...path: P): MutableObservableValue<ValueAtPath<EngineSettings, P>> & Terminable {
        return this.#object.createMutableObservableValue(...path)
    }

    subscribeAll(observer: Observer<keyof EngineSettings>): Subscription {
        return this.#object.subscribeAll(observer)
    }

    terminate(): void {this.#terminator.terminate()}
}
