import {Observer, PathTuple, Subscription, Terminable, Terminator, ValueAtPath, VirtualObject} from "@moises-ai/lib-std"
import {Communicator, Messenger} from "@moises-ai/lib-runtime"
import {PreferencesProtocol} from "./PreferencesProtocol"

export class PreferencesClient<SETTINGS extends object> implements Terminable {
    readonly #terminator = new Terminator()
    readonly #object: VirtualObject<SETTINGS>

    constructor(messenger: Messenger, settings: SETTINGS) {
        this.#object = this.#terminator.own(new VirtualObject<SETTINGS>(settings))
        this.#terminator.own(Communicator.executor<PreferencesProtocol<SETTINGS>>(messenger, {
            updateSettings: (preferences: SETTINGS): void => this.#object.update(preferences)
        }))
    }

    get settings(): Readonly<SETTINGS> {return this.#object.data}

    catchupAndSubscribe<P extends PathTuple<SETTINGS>>(
        observer: Observer<ValueAtPath<SETTINGS, P>>, ...path: P): Subscription {
        return this.#object.catchupAndSubscribe(observer, ...path)
    }

    terminate(): void {
        this.#terminator.terminate()
        this.#object.terminate()
    }
}
