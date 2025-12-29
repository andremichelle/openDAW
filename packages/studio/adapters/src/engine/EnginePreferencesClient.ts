import {Observer, PathTuple, Subscription, Terminable, Terminator, ValueAtPath, VirtualObject} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {EngineSettings, EngineSettingsSchema} from "./EnginePreferencesSchema"
import {EnginePreferencesProtocol} from "./EnginePreferencesProtocol"

export class EnginePreferencesClient implements Terminable {
    readonly #terminator = new Terminator()
    readonly #object = new VirtualObject<EngineSettings>(EngineSettingsSchema.parse({}))

    constructor(messenger: Messenger) {
        this.#terminator.own(Communicator.executor<EnginePreferencesProtocol>(messenger, {
            updatePreferences: (preferences: EngineSettings): void => this.#object.update(preferences)
        }))
    }

    settings(): Readonly<EngineSettings> {return this.#object.data}

    catchupAndSubscribe<P extends PathTuple<EngineSettings>>(
        observer: Observer<ValueAtPath<EngineSettings, P>>, ...path: P): Subscription {
        return this.#object.catchupAndSubscribe(observer, ...path)
    }

    terminate(): void {
        this.#terminator.terminate()
        this.#object.terminate()
    }
}
