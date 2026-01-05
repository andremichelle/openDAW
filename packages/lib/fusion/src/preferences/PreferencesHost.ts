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

    constructor(settings: SETTINGS) {this.#object = this.#terminator.own(new VirtualObject(settings))}

    get settings(): SETTINGS {return this.#object.proxy}

    syncWith(messenger: Messenger): Subscription {
        const client = Communicator.sender<PreferencesProtocol<SETTINGS>>(messenger,
            ({dispatchAndForget}) => new class implements PreferencesProtocol<SETTINGS> {
                updateSettings(preferences: SETTINGS): void {
                    dispatchAndForget(this.updateSettings, preferences)
                }
            })
        const queue = queueTask(() => client.updateSettings(this.#object.data))
        client.updateSettings(this.#object.data)
        return this.#object.subscribeAll(queue)
    }

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
