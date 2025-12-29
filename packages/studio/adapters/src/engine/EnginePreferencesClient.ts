import {Notifier, Observer, Subscription, Terminable, Terminator} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {EnginePreferences, EnginePreferencesSchema} from "./EnginePreferencesSchema"
import {EnginePreferencesProtocol} from "./EnginePreferencesProtocol"

type PathTuple<T> = T extends object
    ? { [K in keyof T]: [K] | [K, ...PathTuple<T[K]>] }[keyof T]
    : []

type ValueAtPath<T, P extends readonly unknown[]> = P extends readonly [infer K, ...infer Rest]
    ? K extends keyof T
        ? Rest extends [] ? T[K] : ValueAtPath<T[K], Rest>
        : never
    : T

export class EnginePreferencesClient implements Terminable {
    readonly #terminator = new Terminator()
    readonly #notifier = new Notifier<keyof EnginePreferences>()

    #values: EnginePreferences = EnginePreferencesSchema.parse({})

    get values(): Readonly<EnginePreferences> {return this.#values}

    connect(messenger: Messenger): Terminable {
        const executor = this.#terminator.own(Communicator.executor<EnginePreferencesProtocol>(messenger, {
            updatePreferences: (preferences: EnginePreferences): void => {
                const changedKeys = this.#detectChangedKeys(preferences)
                this.#values = preferences
                for (const key of changedKeys) {
                    this.#notifier.notify(key)
                }
            }
        }))
        return executor
    }

    catchupAndSubscribe<P extends PathTuple<EnginePreferences>>(
        observer: Observer<ValueAtPath<EnginePreferences, P>>, ...path: P): Subscription {
        const getValue = (): ValueAtPath<EnginePreferences, P> =>
            path.reduce((object: any, key) => object[key], this.#values)
        observer(getValue())
        return this.#notifier.subscribe(key => {
            if (key === path[0]) {observer(getValue())}
        })
    }

    terminate(): void {
        this.#terminator.terminate()
        this.#notifier.terminate()
    }

    readonly #detectChangedKeys = (newValues: EnginePreferences): Array<keyof EnginePreferences> => {
        const changed: Array<keyof EnginePreferences> = []
        for (const key of Object.keys(newValues) as Array<keyof EnginePreferences>) {
            if (JSON.stringify(this.#values[key]) !== JSON.stringify(newValues[key])) {
                changed.push(key)
            }
        }
        return changed
    }
}
