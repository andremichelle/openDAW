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

export class EnginePreferencesClient implements Terminable {
    readonly #terminator = new Terminator()
    readonly #observer = new PropertyObserver<EnginePreferences>(EnginePreferencesSchema.parse({}))

    get values(): Readonly<EnginePreferences> {return this.#observer.data}

    connect(messenger: Messenger): Terminable {
        return this.#terminator.own(Communicator.executor<EnginePreferencesProtocol>(messenger, {
            updatePreferences: (preferences: EnginePreferences): void => {
                for (const key of Object.keys(preferences) as Array<keyof EnginePreferences>) {
                    if (JSON.stringify(this.#observer.data[key]) !== JSON.stringify(preferences[key])) {
                        (this.#observer.data as any)[key] = preferences[key]
                        this.#observer.notify(key)
                    }
                }
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
