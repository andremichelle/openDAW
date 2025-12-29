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

export class EnginePreferencesMain implements Terminable {
    readonly #terminator = new Terminator()
    readonly #notifier = new Notifier<keyof EnginePreferences>()
    readonly #connections: Array<EnginePreferencesProtocol> = []
    readonly #data: EnginePreferences
    readonly #values: EnginePreferences

    #pendingBroadcast = false

    constructor() {
        this.#data = EnginePreferencesSchema.parse({})
        this.#values = this.#watch(this.#data)
    }

    get values(): EnginePreferences {return this.#values}

    connect(messenger: Messenger): Terminable {
        const sender = Communicator.sender<EnginePreferencesProtocol>(messenger,
            ({dispatchAndForget}) => new class implements EnginePreferencesProtocol {
                updatePreferences(preferences: EnginePreferences): void {
                    dispatchAndForget(this.updatePreferences, preferences)
                }
            })
        this.#connections.push(sender)
        sender.updatePreferences(structuredClone(this.#data))
        return {
            terminate: () => {
                const index = this.#connections.indexOf(sender)
                if (index !== -1) {this.#connections.splice(index, 1)}
            }
        }
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

    readonly #watch = (target: EnginePreferences): EnginePreferences => {
        const createProxy = <T extends object>(object: T, rootKey?: keyof EnginePreferences): T =>
            new Proxy(object, {
                get(target, property) {
                    const value = target[property as keyof T]
                    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
                        return createProxy(value as object, rootKey ?? property as keyof EnginePreferences) as T[keyof T]
                    }
                    return value
                },
                set: (object, property, value) => {
                    const key = rootKey ?? property as keyof EnginePreferences
                    ;(object as any)[property] = value
                    this.#notifier.notify(key)
                    this.#scheduleBroadcast()
                    return true
                },
                preventExtensions: () => false
            })
        return createProxy(target)
    }

    readonly #scheduleBroadcast = (): void => {
        if (this.#pendingBroadcast) {return}
        this.#pendingBroadcast = true
        queueMicrotask(() => {
            this.#pendingBroadcast = false
            this.#broadcast()
        })
    }

    readonly #broadcast = (): void => {
        const snapshot = structuredClone(this.#data)
        for (const connection of this.#connections) {
            connection.updatePreferences(snapshot)
        }
    }
}
