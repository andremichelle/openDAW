import {
    MutableObservableValue,
    Observer,
    PathTuple,
    Subscription,
    Terminable,
    Terminator,
    ValueAtPath,
    VirtualObject
} from "@opendaw/lib-std"
import {queueTask} from "@opendaw/lib-dom"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {Preferences} from "./Preferences"
import {PreferencesProtocol} from "./PreferencesProtocol"

export class PreferencesHost<SETTINGS extends object> implements Preferences<SETTINGS>, Terminable {
    readonly #terminator = new Terminator()
    readonly #object: VirtualObject<SETTINGS>
    readonly #client: PreferencesProtocol<SETTINGS>

    readonly #queueTask = queueTask(() => this.#client.updateSettings(this.#object.data))

    constructor(messenger: Messenger, settings: SETTINGS) {
        this.#object = this.#terminator.own(new VirtualObject(settings))
        this.#client = Communicator.sender<PreferencesProtocol<SETTINGS>>(messenger,
            ({dispatchAndForget}) => new class implements PreferencesProtocol<SETTINGS> {
                updateSettings(preferences: SETTINGS): void {
                    dispatchAndForget(this.updateSettings, preferences)
                }
            })
        this.#terminator.own(this.#object.subscribeAll(this.#queueTask))
        this.#client.updateSettings(this.#object.data)
    }

    get settings(): SETTINGS {return this.#object.proxy}

    update(data: SETTINGS): void {this.#object.update(data)}

    subscribe<P extends PathTuple<SETTINGS>>(
        observer: Observer<ValueAtPath<SETTINGS, P>>, ...path: P): Subscription {
        return this.#object.subscribe(observer, ...path)
    }

    catchupAndSubscribe<P extends PathTuple<SETTINGS>>(
        observer: Observer<ValueAtPath<SETTINGS, P>>, ...path: P): Subscription {
        return this.#object.catchupAndSubscribe(observer, ...path)
    }

    createMutableObservableValue<P extends PathTuple<SETTINGS>>(...path: P): MutableObservableValue<ValueAtPath<SETTINGS, P>> & Terminable {
        return this.#object.createMutableObservableValue(...path)
    }

    subscribeAll(observer: Observer<keyof SETTINGS>): Subscription {
        return this.#object.subscribeAll(observer)
    }

    terminate(): void {this.#terminator.terminate()}
}
