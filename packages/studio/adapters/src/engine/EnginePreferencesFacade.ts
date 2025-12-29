import {Observer, Option, PathTuple, Subscription, Terminable, Terminator, ValueAtPath, VirtualObject} from "@opendaw/lib-std"
import {queueTask} from "@opendaw/lib-dom"
import {EnginePreferences, EngineSettings, EngineSettingsSchema} from "./EnginePreferencesSchema"
import {EnginePreferencesHost} from "./EnginePreferencesHost"

export class EnginePreferencesFacade implements EnginePreferences, Terminable {
    readonly #terminator = new Terminator()
    readonly #lifecycle = this.#terminator.own(new Terminator())
    readonly #observer = this.#terminator.own(new VirtualObject<EngineSettings>(EngineSettingsSchema.parse({})))

    #host: Option<EnginePreferencesHost> = Option.None

    setHost(host: EnginePreferencesHost): void {
        this.#host = Option.wrap(host)
        this.#lifecycle.terminate()
        this.#observer.update(host.settings())
        const queueHostUpdate = queueTask(() => host.update(this.#observer.data))
        this.#lifecycle.ownAll(
            host.subscribeAll(() => this.#observer.update(host.settings())),
            this.#observer.subscribeAll(queueHostUpdate)
        )
    }

    releaseHost(): void {
        this.#lifecycle.terminate()
        this.#host = Option.None
    }

    settings(): EngineSettings {return this.#observer.proxy}

    subscribe<P extends PathTuple<EngineSettings>>(
        observer: Observer<ValueAtPath<EngineSettings, P>>, ...path: P): Subscription {
        return this.#observer.subscribe(observer, ...path)
    }

    catchupAndSubscribe<P extends PathTuple<EngineSettings>>(
        observer: Observer<ValueAtPath<EngineSettings, P>>, ...path: P): Subscription {
        return this.#observer.catchupAndSubscribe(observer, ...path)
    }

    terminate(): void {this.#terminator.terminate()}
}
