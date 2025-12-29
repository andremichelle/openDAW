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
import {Preferences} from "./Preferences"
import {PreferencesHost} from "./PreferencesHost"

export class PreferencesFacade<SETTINGS extends object> implements Preferences<SETTINGS>, Terminable {
    readonly #terminator = new Terminator()
    readonly #lifecycle = this.#terminator.own(new Terminator())
    readonly #object: VirtualObject<SETTINGS>

    constructor(settings: SETTINGS) {
        this.#object = this.#terminator.own(new VirtualObject<SETTINGS>(settings))
    }

    setHost(host: PreferencesHost<SETTINGS>): void {
        this.#lifecycle.terminate()
        host.update(this.#object.data)
        const queueHostUpdate = queueTask(() => host.update(this.#object.data))
        this.#lifecycle.ownAll(
            host.subscribeAll(() => this.#object.update(host.settings)),
            this.#object.subscribeAll(queueHostUpdate)
        )
    }

    releaseHost(): void {this.#lifecycle.terminate()}

    get settings(): SETTINGS {return this.#object.proxy}

    subscribe<P extends PathTuple<SETTINGS>>(
        observer: Observer<ValueAtPath<SETTINGS, P>>, ...path: P): Subscription {
        return this.#object.subscribe(observer, ...path)
    }

    catchupAndSubscribe<P extends PathTuple<SETTINGS>>(
        observer: Observer<ValueAtPath<SETTINGS, P>>, ...path: P): Subscription {
        return this.#object.catchupAndSubscribe(observer, ...path)
    }

    createMutableObservableValue<P extends PathTuple<SETTINGS>>(...path: P)
        : MutableObservableValue<ValueAtPath<SETTINGS, P>> & Terminable {
        return this.#object.createMutableObservableValue(...path)
    }

    terminate(): void {this.#terminator.terminate()}
}
