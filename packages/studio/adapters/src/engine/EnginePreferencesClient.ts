import {Observer, PathTuple, VirtualObject, Subscription, Terminable, Terminator, ValueAtPath} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {EnginePreferences, EnginePreferencesSchema} from "./EnginePreferencesSchema"
import {EnginePreferencesProtocol} from "./EnginePreferencesProtocol"

export class EnginePreferencesClient implements Terminable {
    readonly #terminator = new Terminator()
    readonly #observer = new VirtualObject<EnginePreferences>(EnginePreferencesSchema.parse({}))

    get settings(): Readonly<EnginePreferences> {return this.#observer.data}

    connect(messenger: Messenger): Terminable {
        return this.#terminator.own(Communicator.executor<EnginePreferencesProtocol>(messenger, {
            updatePreferences: (preferences: EnginePreferences): void => {
                this.#observer.update(preferences)
            }
        }))
    }

    catchupAndSubscribe<P extends PathTuple<EnginePreferences>>(
        observer: Observer<ValueAtPath<EnginePreferences, P>>, ...path: P): Subscription {
        return this.#observer.catchupAndSubscribe(observer, ...path)
    }

    terminate(): void {
        this.#terminator.terminate()
        this.#observer.terminate()
    }
}
