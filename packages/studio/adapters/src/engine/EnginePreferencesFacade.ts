import {MutableObservableValue, Observer, Option, PathTuple, Subscription, Terminable, Terminator, ValueAtPath, VirtualObject} from "@opendaw/lib-std"
import {queueTask} from "@opendaw/lib-dom"
import {EnginePreferences, EngineSettings, EngineSettingsSchema} from "./EnginePreferencesSchema"
import {EnginePreferencesHost} from "./EnginePreferencesHost"

export class EnginePreferencesFacade implements EnginePreferences, Terminable {
    readonly #terminator = new Terminator()
    readonly #lifecycle = this.#terminator.own(new Terminator())
    readonly #object = this.#terminator.own(new VirtualObject<EngineSettings>(EngineSettingsSchema.parse({})))

    #host: Option<EnginePreferencesHost> = Option.None

    setHost(host: EnginePreferencesHost): void {
        this.#host = Option.wrap(host)
        this.#lifecycle.terminate()
        this.#object.update(host.settings())
        const queueHostUpdate = queueTask(() => host.update(this.#object.data))
        this.#lifecycle.ownAll(
            host.subscribeAll(() => this.#object.update(host.settings())),
            this.#object.subscribeAll(queueHostUpdate)
        )
    }

    releaseHost(): void {
        this.#lifecycle.terminate()
        this.#host = Option.None
    }

    settings(): EngineSettings {return this.#object.proxy}

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

    terminate(): void {this.#terminator.terminate()}
}
